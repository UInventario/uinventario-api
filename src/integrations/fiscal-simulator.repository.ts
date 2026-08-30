import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { createHash, randomUUID } from 'node:crypto';
import { DataSource, EntityManager, QueryFailedError } from 'typeorm';
import type { IssueSimulatedFiscalDocumentDto } from './dto/issue-simulated-fiscal-document.dto';
import { FiscalSimulatorIdempotencyConflictError } from './fiscal-simulator.errors';
import type { FiscalSimulatorDocumentData } from './fiscal-simulator.types';
import type {
  FiscalArtifactKind,
  FiscalDocumentStatus,
  FiscalSimulatorScenario,
} from './fiscal-provider-adapter.types';
import { SimulatedFiscalAdapter } from './simulated-fiscal.adapter';

interface DocumentRow {
  id: string;
  country_code: string;
  contract_version: string;
  document_type: FiscalSimulatorDocumentData['documentType'];
  reference_key: string;
  provider_reference: string;
  scenario: FiscalSimulatorScenario;
  status: FiscalDocumentStatus;
  poll_count: number | string;
  error_code: string | null;
  pdf_base64: string | null;
  xml_base64: string | null;
  request_fingerprint: string;
  created_at: Date | string;
  updated_at: Date | string;
}

@Injectable()
export class FiscalSimulatorRepository {
  constructor(
    private readonly dataSource: DataSource,
    private readonly adapter: SimulatedFiscalAdapter,
  ) {}

  async list(tenantId: string): Promise<FiscalSimulatorDocumentData[]> {
    const rows = await this.dataSource.query<DocumentRow[]>(
      `${this.select()} WHERE tenant_id = ? ORDER BY updated_at DESC LIMIT 100`,
      [tenantId],
    );
    return rows.map((row) => this.toData(row));
  }

  async issue(input: {
    tenantId: string;
    countryCode: string;
    contractVersion: string;
    idempotencyKey: string;
    dto: IssueSimulatedFiscalDocumentDto;
  }): Promise<{ document: FiscalSimulatorDocumentData; replay: boolean }> {
    const fingerprint = this.fingerprint(input.dto);
    const existing = await this.byIdempotency(
      input.tenantId,
      input.idempotencyKey,
    );
    if (existing) return this.replay(existing, fingerprint);
    const result = await this.adapter.issue({
      countryCode: input.countryCode,
      documentType: input.dto.documentType,
      reference: input.dto.reference,
      scenario: input.dto.scenario,
    });
    const id = randomUUID();
    try {
      await this.dataSource.query(
        `INSERT INTO fiscal_simulator_documents
          (id, tenant_id, country_code, contract_version, document_type,
           reference_key, provider_reference, scenario, status, error_code,
           pdf_base64, xml_base64, idempotency_key, request_fingerprint)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          id,
          input.tenantId,
          input.countryCode,
          input.contractVersion,
          input.dto.documentType,
          input.dto.reference,
          result.providerReference,
          input.dto.scenario,
          result.status,
          result.errorCode,
          result.artifacts?.PDF ?? null,
          result.artifacts?.XML ?? null,
          input.idempotencyKey,
          fingerprint,
        ],
      );
    } catch (error) {
      if (!(error instanceof QueryFailedError)) throw error;
      const raced = await this.byIdempotency(
        input.tenantId,
        input.idempotencyKey,
      );
      if (raced) return this.replay(raced, fingerprint);
      const duplicateReference = await this.byProviderReference(
        input.tenantId,
        result.providerReference,
      );
      if (!duplicateReference) throw error;
      if (duplicateReference.request_fingerprint !== fingerprint) {
        throw new FiscalSimulatorIdempotencyConflictError();
      }
      return { document: this.toData(duplicateReference), replay: true };
    }
    return {
      document: (await this.byId(input.tenantId, id))!.data,
      replay: false,
    };
  }

  async query(input: {
    tenantId: string;
    documentId: string;
    idempotencyKey: string;
  }) {
    return this.operation({ ...input, action: 'QUERY' });
  }

  async cancel(input: {
    tenantId: string;
    documentId: string;
    idempotencyKey: string;
  }) {
    return this.operation({ ...input, action: 'CANCEL' });
  }

  async callback(input: {
    tenantId: string;
    eventId: string;
    documentId: string;
    status: 'ACCEPTED' | 'REJECTED';
  }): Promise<{ document: FiscalSimulatorDocumentData; replay: boolean }> {
    return this.dataSource.transaction(async (manager) => {
      const event = await manager.query<{ affectedRows?: number }>(
        `INSERT IGNORE INTO fiscal_simulator_callbacks
          (event_id, tenant_id, document_id, status) VALUES (?, ?, ?, ?)`,
        [input.eventId, input.tenantId, input.documentId, input.status],
      );
      const existing = Number(event.affectedRows ?? 0) === 0;
      if (existing) {
        const [recorded] = await manager.query<
          Array<{ document_id: string; status: string }>
        >(
          `SELECT document_id, status FROM fiscal_simulator_callbacks
           WHERE tenant_id = ? AND event_id = ? LIMIT 1`,
          [input.tenantId, input.eventId],
        );
        if (
          !recorded ||
          recorded.document_id !== input.documentId ||
          recorded.status !== input.status
        ) {
          throw new FiscalSimulatorIdempotencyConflictError();
        }
      }
      const row = await this.lock(manager, input.tenantId, input.documentId);
      if (!row) throw new NotFoundException();
      if (!existing) {
        if (row.status === 'CANCELLED') {
          throw new BadRequestException('FISCAL_DOCUMENT_ALREADY_CANCELLED');
        }
        if (
          ['ACCEPTED', 'REJECTED'].includes(row.status) &&
          row.status !== input.status
        ) {
          throw new BadRequestException('FISCAL_DOCUMENT_STATE_CONFLICT');
        }
        const artifacts =
          input.status === 'ACCEPTED' && row.status !== 'ACCEPTED'
            ? await this.adapter.query({
                providerReference: row.provider_reference,
                countryCode: row.country_code,
                documentType: row.document_type,
                scenario: 'TIMEOUT',
                pollCount: 2,
                currentStatus: 'INDETERMINATE',
              })
            : null;
        if (row.status !== input.status) {
          await manager.query(
            `UPDATE fiscal_simulator_documents SET status = ?, error_code = ?,
               pdf_base64 = COALESCE(?, pdf_base64), xml_base64 = COALESCE(?, xml_base64)
             WHERE id = ? AND tenant_id = ?`,
            [
              input.status,
              input.status === 'REJECTED'
                ? 'SIMULATED_CALLBACK_REJECTION'
                : null,
              artifacts?.artifacts?.PDF ?? null,
              artifacts?.artifacts?.XML ?? null,
              input.documentId,
              input.tenantId,
            ],
          );
        }
      }
      return {
        document: (await this.byIdWith(
          manager,
          input.tenantId,
          input.documentId,
        ))!.data,
        replay: existing,
      };
    });
  }

  async download(
    tenantId: string,
    documentId: string,
    kind: FiscalArtifactKind,
  ) {
    const found = await this.byId(tenantId, documentId);
    if (!found) throw new NotFoundException();
    const row = found.row;
    return this.adapter.download({
      providerReference: row.provider_reference,
      status: row.status,
      kind,
      contentBase64: kind === 'PDF' ? row.pdf_base64 : row.xml_base64,
    });
  }

  private async operation(input: {
    tenantId: string;
    documentId: string;
    idempotencyKey: string;
    action: 'QUERY' | 'CANCEL';
  }): Promise<{ document: FiscalSimulatorDocumentData; replay: boolean }> {
    const fingerprint = this.fingerprint({
      documentId: input.documentId,
      action: input.action,
    });
    return this.dataSource.transaction(async (manager) => {
      const previous = await this.operationReplay(manager, input, fingerprint);
      if (previous) return previous;
      const row = await this.lock(manager, input.tenantId, input.documentId);
      if (!row) throw new NotFoundException();
      const concurrent = await this.operationReplay(
        manager,
        input,
        fingerprint,
      );
      if (concurrent) return concurrent;
      const result =
        input.action === 'QUERY'
          ? await this.adapter.query({
              providerReference: row.provider_reference,
              countryCode: row.country_code,
              documentType: row.document_type,
              scenario: row.scenario,
              pollCount: Number(row.poll_count) + 1,
              currentStatus: row.status,
            })
          : await this.adapter.cancel({
              providerReference: row.provider_reference,
              currentStatus: row.status,
            });
      await manager.query(
        `UPDATE fiscal_simulator_documents SET status = ?, error_code = ?,
           poll_count = poll_count + ?, pdf_base64 = COALESCE(?, pdf_base64),
           xml_base64 = COALESCE(?, xml_base64)
         WHERE id = ? AND tenant_id = ?`,
        [
          result.status,
          result.errorCode,
          input.action === 'QUERY' ? 1 : 0,
          result.artifacts?.PDF ?? null,
          result.artifacts?.XML ?? null,
          input.documentId,
          input.tenantId,
        ],
      );
      const document = (await this.byIdWith(
        manager,
        input.tenantId,
        input.documentId,
      ))!.data;
      await manager.query(
        `INSERT INTO fiscal_simulator_operations
          (id, tenant_id, document_id, action, idempotency_key, fingerprint, result)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [
          randomUUID(),
          input.tenantId,
          input.documentId,
          input.action,
          input.idempotencyKey,
          fingerprint,
          JSON.stringify(document),
        ],
      );
      return { document, replay: false };
    });
  }

  private byIdempotency(tenantId: string, key: string) {
    return this.dataSource
      .query<DocumentRow[]>(
        `${this.select()} WHERE tenant_id = ? AND idempotency_key = ? LIMIT 1`,
        [tenantId, key],
      )
      .then(([row]) => row);
  }

  private byProviderReference(tenantId: string, providerReference: string) {
    return this.dataSource
      .query<DocumentRow[]>(
        `${this.select()} WHERE tenant_id = ? AND provider_reference = ? LIMIT 1`,
        [tenantId, providerReference],
      )
      .then(([row]) => row);
  }

  private replay(row: DocumentRow, fingerprint: string) {
    if (row.request_fingerprint !== fingerprint) {
      throw new FiscalSimulatorIdempotencyConflictError();
    }
    return { document: this.toData(row), replay: true };
  }

  private async byId(tenantId: string, id: string) {
    const [row] = await this.dataSource.query<DocumentRow[]>(
      `${this.select()} WHERE tenant_id = ? AND id = ? LIMIT 1`,
      [tenantId, id],
    );
    return row ? { row, data: this.toData(row) } : null;
  }

  private async byIdWith(manager: EntityManager, tenantId: string, id: string) {
    const [row] = await manager.query<DocumentRow[]>(
      `${this.select()} WHERE tenant_id = ? AND id = ? LIMIT 1`,
      [tenantId, id],
    );
    return row ? { row, data: this.toData(row) } : null;
  }

  private lock(manager: EntityManager, tenantId: string, id: string) {
    return manager
      .query<DocumentRow[]>(
        `${this.select()} WHERE tenant_id = ? AND id = ? LIMIT 1 FOR UPDATE`,
        [tenantId, id],
      )
      .then(([row]) => row);
  }

  private async operationReplay(
    manager: EntityManager,
    input: { tenantId: string; idempotencyKey: string },
    fingerprint: string,
  ): Promise<{
    document: FiscalSimulatorDocumentData;
    replay: true;
  } | null> {
    const [previous] = await manager.query<
      Array<{
        fingerprint: string;
        result: string | FiscalSimulatorDocumentData;
      }>
    >(
      `SELECT fingerprint, result FROM fiscal_simulator_operations
       WHERE tenant_id = ? AND idempotency_key = ? LIMIT 1`,
      [input.tenantId, input.idempotencyKey],
    );
    if (!previous) return null;
    if (previous.fingerprint !== fingerprint) {
      throw new FiscalSimulatorIdempotencyConflictError();
    }
    return {
      document:
        typeof previous.result === 'string'
          ? (JSON.parse(previous.result) as FiscalSimulatorDocumentData)
          : previous.result,
      replay: true,
    };
  }

  private select() {
    return `SELECT id, country_code, contract_version, document_type, reference_key,
      provider_reference, scenario, status, poll_count, error_code, pdf_base64,
      xml_base64, request_fingerprint, created_at, updated_at
      FROM fiscal_simulator_documents`;
  }

  private toData(row: DocumentRow): FiscalSimulatorDocumentData {
    return {
      id: row.id,
      countryCode: row.country_code,
      contractVersion: row.contract_version,
      documentType: row.document_type,
      reference: row.reference_key,
      provider: 'SIMULATOR',
      providerVersion: '1',
      providerReference: row.provider_reference,
      scenario: row.scenario,
      status: row.status,
      pollCount: Number(row.poll_count),
      errorCode: row.error_code,
      createdAt: new Date(row.created_at).toISOString(),
      updatedAt: new Date(row.updated_at).toISOString(),
    };
  }

  private fingerprint(value: unknown): string {
    return createHash('sha256').update(JSON.stringify(value)).digest('hex');
  }
}
