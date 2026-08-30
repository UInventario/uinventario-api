import {
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { DataSource, EntityManager, QueryFailedError } from 'typeorm';
import type { FiscalSimulatorDocumentData } from '../integrations/fiscal-simulator.types';
import type { FiscalDocumentType } from '../integrations/fiscal-contract.types';
import type { FiscalSimulatorScenario } from '../integrations/fiscal-provider-adapter.types';
import type {
  SaleFiscalDocumentInternal,
  SaleFiscalWorkflowStatus,
} from './sale-fiscal-document.types';

interface FiscalRow {
  id: string;
  sale_id: string;
  receipt_number: string;
  document_type: FiscalDocumentType;
  scenario: FiscalSimulatorScenario;
  status: SaleFiscalDocumentInternal['status'];
  simulator_document_id: string | null;
  provider_reference: string | null;
  error_code: string | null;
  provider_idempotency_key: string;
  request_fingerprint: string;
  created_at: Date | string;
  updated_at: Date | string;
}

@Injectable()
export class SaleFiscalDocumentRepository {
  constructor(private readonly dataSource: DataSource) {}

  async start(input: {
    tenantId: string;
    branchId: string;
    saleId: string;
    receiptNumber: string;
    documentType: FiscalDocumentType;
    scenario: FiscalSimulatorScenario;
    providerIdempotencyKey: string;
    fingerprint: string;
  }): Promise<{ document: SaleFiscalDocumentInternal; replay: boolean }> {
    const existing = await this.get(
      input.tenantId,
      input.branchId,
      input.saleId,
    );
    if (existing) return this.replay(existing, input.fingerprint);
    const id = randomUUID();
    try {
      await this.dataSource.transaction(async (manager) => {
        const result = await manager.query<{ affectedRows?: number }>(
          `INSERT INTO sale_fiscal_documents
            (id, tenant_id, branch_id, sale_id, receipt_number, document_type, scenario,
             status, provider_idempotency_key, request_fingerprint)
           SELECT ?, sale.tenant_id, sale.branch_id, sale.id, ?, ?, ?, 'PENDING', ?, ?
           FROM sales sale
           WHERE sale.id = ? AND sale.tenant_id = ? AND sale.branch_id = ?
             AND sale.status = 'COMPLETED'`,
          [
            id,
            input.receiptNumber,
            input.documentType,
            input.scenario,
            input.providerIdempotencyKey,
            input.fingerprint,
            input.saleId,
            input.tenantId,
            input.branchId,
          ],
        );
        if (Number(result.affectedRows ?? 0) !== 1) {
          throw new NotFoundException();
        }
        await manager.query(
          `INSERT INTO sale_fiscal_document_events (id, tenant_id, document_id, status)
           VALUES (?, ?, ?, 'PENDING')`,
          [randomUUID(), input.tenantId, id],
        );
      });
    } catch (error) {
      if (error instanceof NotFoundException) throw error;
      if (!(error instanceof QueryFailedError)) throw error;
      const raced = await this.get(
        input.tenantId,
        input.branchId,
        input.saleId,
      );
      if (!raced) throw error;
      return this.replay(raced, input.fingerprint);
    }
    return {
      document: (await this.get(input.tenantId, input.branchId, input.saleId))!,
      replay: false,
    };
  }

  async get(
    tenantId: string,
    branchId: string,
    saleId: string,
  ): Promise<SaleFiscalDocumentInternal | null> {
    const [row] = await this.dataSource.query<FiscalRow[]>(
      `${this.select()} WHERE tenant_id = ? AND branch_id = ? AND sale_id = ? LIMIT 1`,
      [tenantId, branchId, saleId],
    );
    return row ? this.withEvents(this.dataSource.manager, tenantId, row) : null;
  }

  async sync(input: {
    tenantId: string;
    branchId: string;
    saleId: string;
    simulator: FiscalSimulatorDocumentData;
  }): Promise<SaleFiscalDocumentInternal> {
    return this.dataSource.transaction(async (manager) => {
      const row = await this.lock(manager, input);
      if (!row) throw new NotFoundException();
      if (
        row.simulator_document_id &&
        row.simulator_document_id !== input.simulator.id
      ) {
        throw new ConflictException('FISCAL_DOCUMENT_PROVIDER_CONFLICT');
      }
      await this.event(manager, input.tenantId, row.id, 'SENT');
      await manager.query(
        `UPDATE sale_fiscal_documents
         SET simulator_document_id = ?, provider_reference = ?, status = ?, error_code = ?
         WHERE id = ? AND tenant_id = ? AND branch_id = ?`,
        [
          input.simulator.id,
          input.simulator.providerReference,
          input.simulator.status,
          input.simulator.errorCode,
          row.id,
          input.tenantId,
          input.branchId,
        ],
      );
      if (row.status !== input.simulator.status) {
        await this.event(
          manager,
          input.tenantId,
          row.id,
          input.simulator.status,
        );
      }
      return (await this.getWith(
        manager,
        input.tenantId,
        input.branchId,
        input.saleId,
      ))!;
    });
  }

  private async getWith(
    manager: EntityManager,
    tenantId: string,
    branchId: string,
    saleId: string,
  ) {
    const [row] = await manager.query<FiscalRow[]>(
      `${this.select()} WHERE tenant_id = ? AND branch_id = ? AND sale_id = ? LIMIT 1`,
      [tenantId, branchId, saleId],
    );
    return row ? this.withEvents(manager, tenantId, row) : null;
  }

  private lock(
    manager: EntityManager,
    input: { tenantId: string; branchId: string; saleId: string },
  ) {
    return manager
      .query<FiscalRow[]>(
        `${this.select()} WHERE tenant_id = ? AND branch_id = ? AND sale_id = ?
         LIMIT 1 FOR UPDATE`,
        [input.tenantId, input.branchId, input.saleId],
      )
      .then(([row]) => row);
  }

  private async withEvents(
    manager: Pick<EntityManager, 'query'>,
    tenantId: string,
    row: FiscalRow,
  ): Promise<SaleFiscalDocumentInternal> {
    const events = await manager.query<
      Array<{ status: SaleFiscalWorkflowStatus; occurred_at: Date | string }>
    >(
      `SELECT status, occurred_at FROM sale_fiscal_document_events
       WHERE tenant_id = ? AND document_id = ? ORDER BY occurred_at, id`,
      [tenantId, row.id],
    );
    const artifacts = ['ACCEPTED', 'CANCELLED'].includes(row.status)
      ? (['PDF', 'XML'] as const).map((kind) => ({
          kind,
          path: `/pos/sales/${row.sale_id}/fiscal-document/artifacts/${kind}`,
        }))
      : [];
    return {
      id: row.id,
      saleId: row.sale_id,
      receiptNumber: row.receipt_number,
      category: 'FISCAL_DOCUMENT',
      documentType: row.document_type,
      provider: 'SIMULATOR',
      providerVersion: '1',
      providerReference: row.provider_reference,
      scenario: row.scenario,
      status: row.status,
      errorCode: row.error_code,
      artifacts,
      events: events.map((event) => ({
        status: event.status,
        occurredAt: new Date(event.occurred_at).toISOString(),
      })),
      simulatorDocumentId: row.simulator_document_id,
      providerIdempotencyKey: row.provider_idempotency_key,
      requestFingerprint: row.request_fingerprint,
      createdAt: new Date(row.created_at).toISOString(),
      updatedAt: new Date(row.updated_at).toISOString(),
    };
  }

  private event(
    manager: EntityManager,
    tenantId: string,
    documentId: string,
    status: SaleFiscalWorkflowStatus,
  ) {
    return manager.query(
      `INSERT IGNORE INTO sale_fiscal_document_events
        (id, tenant_id, document_id, status) VALUES (?, ?, ?, ?)`,
      [randomUUID(), tenantId, documentId, status],
    );
  }

  private replay(document: SaleFiscalDocumentInternal, fingerprint: string) {
    if (document.requestFingerprint !== fingerprint) {
      throw new ConflictException('FISCAL_DOCUMENT_IDEMPOTENCY_CONFLICT');
    }
    return { document, replay: true };
  }

  private select(): string {
    return `SELECT id, sale_id, receipt_number, document_type, scenario, status,
      simulator_document_id, provider_reference, error_code, provider_idempotency_key,
      request_fingerprint, created_at, updated_at FROM sale_fiscal_documents`;
  }
}
