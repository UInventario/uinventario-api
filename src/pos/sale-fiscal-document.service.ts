import {
  BadGatewayException,
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { createHash } from 'node:crypto';
import { AuditService } from '../audit/audit.service';
import { ExternalAdapterExecutionService } from '../integrations/external-adapter-execution.service';
import { FiscalSimulatorService } from '../integrations/fiscal-simulator.service';
import { TransactionalEmailTemplateService } from '../integrations/transactional-email-template.service';
import type { IssueSaleFiscalDocumentDto } from './dto/issue-sale-fiscal-document.dto';
import { SaleFiscalDocumentRepository } from './sale-fiscal-document.repository';
import type { SaleFiscalDocumentInternal } from './sale-fiscal-document.types';
import { SaleReceiptRepository } from './sale-receipt.repository';

@Injectable()
export class SaleFiscalDocumentService {
  constructor(
    private readonly documents: SaleFiscalDocumentRepository,
    private readonly receipts: SaleReceiptRepository,
    private readonly simulator: FiscalSimulatorService,
    private readonly adapters: ExternalAdapterExecutionService,
    private readonly templates: TransactionalEmailTemplateService,
    private readonly audit: AuditService,
  ) {}

  async get(tenantId: string, branchId: string, saleId: string) {
    const document = await this.documents.get(tenantId, branchId, saleId);
    return { data: document ? this.public(document) : null, meta: this.meta() };
  }

  async issue(input: {
    tenantId: string;
    branchId: string;
    saleId: string;
    userId: string;
    correlationId: string;
    idempotencyKey: string;
    dto: IssueSaleFiscalDocumentDto;
  }) {
    this.key(input.idempotencyKey);
    const receipt = await this.receipts.get(
      input.tenantId,
      input.branchId,
      input.saleId,
    );
    if (!receipt) throw new NotFoundException();
    if (receipt.saleStatus !== 'COMPLETED') {
      throw new BadRequestException('VOIDED_SALE_CANNOT_BE_FISCALIZED');
    }
    const fingerprint = this.hash({
      saleId: input.saleId,
      documentType: input.dto.documentType,
      scenario: input.dto.scenario,
    });
    const providerKey = `sale-fiscal-${this.hash({
      tenantId: input.tenantId,
      saleId: input.saleId,
      idempotencyKey: input.idempotencyKey,
    }).slice(0, 64)}`;
    const started = await this.documents.start({
      ...input,
      receiptNumber: receipt.receiptNumber,
      documentType: input.dto.documentType,
      scenario: input.dto.scenario,
      providerIdempotencyKey: providerKey,
      fingerprint,
    });
    let document = started.document;
    if (!document.simulatorDocumentId) {
      const issued = await this.simulator.issue({
        tenantId: input.tenantId,
        idempotencyKey: document.providerIdempotencyKey,
        dto: {
          documentType: document.documentType,
          reference: receipt.receiptNumber,
          scenario: document.scenario,
        },
      });
      document = await this.documents.sync({
        ...input,
        simulator: issued.data,
      });
    }
    await this.record(input, 'SALE_FISCAL_DOCUMENT_ISSUED', document);
    return {
      data: this.public(document),
      meta: { ...this.meta(), idempotentReplay: started.replay },
    };
  }

  async query(input: OperationInput) {
    const document = await this.require(input);
    const result = await this.simulator.query(
      input.tenantId,
      document.simulatorDocumentId!,
      this.operationKey('query', input),
    );
    const synced = await this.documents.sync({
      ...input,
      simulator: result.data,
    });
    await this.record(input, 'SALE_FISCAL_DOCUMENT_QUERIED', synced);
    return {
      data: this.public(synced),
      meta: { ...this.meta(), idempotentReplay: result.meta.idempotentReplay },
    };
  }

  async cancel(input: OperationInput) {
    const document = await this.require(input);
    const result = await this.simulator.cancel(
      input.tenantId,
      document.simulatorDocumentId!,
      this.operationKey('cancel', input),
    );
    const synced = await this.documents.sync({
      ...input,
      simulator: result.data,
    });
    await this.record(input, 'SALE_FISCAL_DOCUMENT_CANCELLED', synced);
    return {
      data: this.public(synced),
      meta: { ...this.meta(), idempotentReplay: result.meta.idempotentReplay },
    };
  }

  async callback(
    input: Omit<OperationInput, 'idempotencyKey'> & {
      eventId: string;
      status: 'ACCEPTED' | 'REJECTED';
    },
  ) {
    const document = await this.require(input);
    const result = await this.simulator.callback(input.tenantId, {
      eventId: input.eventId,
      documentId: document.simulatorDocumentId!,
      status: input.status,
    });
    const synced = await this.documents.sync({
      ...input,
      simulator: result.data,
    });
    await this.record(input, 'SALE_FISCAL_CALLBACK_RECEIVED', synced);
    return {
      data: this.public(synced),
      meta: { ...this.meta(), duplicate: result.meta.duplicate },
    };
  }

  async artifact(
    tenantId: string,
    branchId: string,
    saleId: string,
    kind: 'PDF' | 'XML',
  ) {
    const document = await this.require({ tenantId, branchId, saleId });
    return this.simulator.download(
      tenantId,
      document.simulatorDocumentId!,
      kind,
    );
  }

  async send(input: OperationInput & { recipient: string }) {
    this.key(input.idempotencyKey);
    const document = await this.require(input);
    if (document.status !== 'ACCEPTED') {
      throw new BadRequestException('FISCAL_DOCUMENT_NOT_DELIVERABLE');
    }
    const content = this.templates.operationalNotification({
      title: `Documento fiscal ${document.receiptNumber}`,
      body: [
        `Documento fiscal ${document.documentType}`,
        `Venta: ${document.receiptNumber}`,
        `Estado: ${document.status}`,
        `Referencia del proveedor: ${document.providerReference}`,
        '',
        'PDF y XML están disponibles mediante los enlaces autenticados de UInventario.',
        ...document.artifacts.map(
          (artifact) => `${artifact.kind}: ${artifact.path}`,
        ),
      ].join('\n'),
    });
    const execution = await this.adapters.execute({
      tenantId: input.tenantId,
      capability: 'NOTIFICATION_EMAIL',
      idempotencyKey: this.operationKey('email', input),
      correlationId: input.correlationId,
      payload: {
        recipient: input.recipient,
        title: content.title,
        body: content.body,
        template: content.template,
      },
    });
    if (execution.status !== 'SUCCEEDED') {
      throw new BadGatewayException({
        code: execution.errorCode ?? 'EMAIL_DELIVERY_FAILED',
        message: 'No fue posible aceptar el documento fiscal para entrega.',
      });
    }
    await this.audit.recordRequired({
      tenantId: input.tenantId,
      actorUserId: input.userId,
      action: 'SALE_FISCAL_DOCUMENT_SENT',
      entityType: 'SALE_FISCAL_DOCUMENT',
      entityId: document.id,
      correlationId: input.correlationId,
      after: {
        status: document.status,
        recipientHash: createHash('sha256')
          .update(input.recipient)
          .digest('hex'),
      },
    });
    return {
      data: {
        document: this.public(document),
        delivery: {
          mode: execution.provider === 'SIMULATOR' ? 'SIMULATED' : 'PROVIDER',
          channel: 'EMAIL',
          recipient: input.recipient,
          messageId: execution.providerReference!,
          acceptedAt: execution.updatedAt,
        },
      },
      meta: this.meta(),
    };
  }

  private async require(input: {
    tenantId: string;
    branchId: string;
    saleId: string;
  }) {
    const document = await this.documents.get(
      input.tenantId,
      input.branchId,
      input.saleId,
    );
    if (!document?.simulatorDocumentId) throw new NotFoundException();
    return document;
  }

  private operationKey(action: string, input: OperationInput): string {
    this.key(input.idempotencyKey);
    return `sale-fiscal-${action}-${this.hash({
      tenantId: input.tenantId,
      saleId: input.saleId,
      key: input.idempotencyKey,
    }).slice(0, 64)}`;
  }

  private public(document: SaleFiscalDocumentInternal) {
    return {
      id: document.id,
      saleId: document.saleId,
      receiptNumber: document.receiptNumber,
      category: document.category,
      documentType: document.documentType,
      provider: document.provider,
      providerVersion: document.providerVersion,
      providerReference: document.providerReference,
      scenario: document.scenario,
      status: document.status,
      errorCode: document.errorCode,
      artifacts: document.artifacts,
      events: document.events,
      createdAt: document.createdAt,
      updatedAt: document.updatedAt,
    };
  }

  private record(
    input: {
      tenantId: string;
      userId: string;
      correlationId: string;
    },
    action: string,
    document: SaleFiscalDocumentInternal,
  ) {
    return this.audit.recordRequired({
      tenantId: input.tenantId,
      actorUserId: input.userId,
      action,
      entityType: 'SALE_FISCAL_DOCUMENT',
      entityId: document.id,
      correlationId: input.correlationId,
      after: {
        saleId: document.saleId,
        documentType: document.documentType,
        status: document.status,
        errorCode: document.errorCode,
      },
    });
  }

  private key(value: string): void {
    if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/.test(value)) {
      throw new BadRequestException('IDEMPOTENCY_KEY_REQUIRED');
    }
  }

  private hash(value: unknown): string {
    return createHash('sha256').update(JSON.stringify(value)).digest('hex');
  }

  private meta() {
    return {
      apiVersion: '1' as const,
      provider: 'SIMULATOR' as const,
      production: false,
    };
  }
}

interface OperationInput {
  tenantId: string;
  branchId: string;
  saleId: string;
  userId: string;
  correlationId: string;
  idempotencyKey: string;
}
