import type { AuditService } from '../audit/audit.service';
import type { ExternalAdapterExecutionService } from '../integrations/external-adapter-execution.service';
import type { FiscalSimulatorService } from '../integrations/fiscal-simulator.service';
import type { TransactionalEmailTemplateService } from '../integrations/transactional-email-template.service';
import type { FiscalSimulatorDocumentData } from '../integrations/fiscal-simulator.types';
import type { SaleFiscalDocumentRepository } from './sale-fiscal-document.repository';
import { SaleFiscalDocumentService } from './sale-fiscal-document.service';
import type { SaleFiscalDocumentInternal } from './sale-fiscal-document.types';
import type { SaleReceiptRepository } from './sale-receipt.repository';

describe('SaleFiscalDocumentService', () => {
  const pending: SaleFiscalDocumentInternal = {
    id: 'fiscal-1',
    saleId: 'sale-1',
    receiptNumber: 'V-ABC123',
    category: 'FISCAL_DOCUMENT',
    documentType: 'INVOICE',
    provider: 'SIMULATOR',
    providerVersion: '1',
    providerReference: null,
    scenario: 'SUCCESS',
    status: 'PENDING',
    errorCode: null,
    artifacts: [],
    events: [{ status: 'PENDING', occurredAt: '2026-08-29T12:00:00.000Z' }],
    simulatorDocumentId: null,
    providerIdempotencyKey: 'sale-fiscal-provider-key',
    requestFingerprint: 'fingerprint',
    createdAt: '2026-08-29T12:00:00.000Z',
    updatedAt: '2026-08-29T12:00:00.000Z',
  };
  const simulatorDocument: FiscalSimulatorDocumentData = {
    id: 'simulator-1',
    countryCode: 'MX',
    contractVersion: '1',
    documentType: 'INVOICE',
    reference: 'V-ABC123',
    provider: 'SIMULATOR',
    providerVersion: '1',
    providerReference: 'SIM-1',
    scenario: 'SUCCESS',
    status: 'ACCEPTED',
    pollCount: 0,
    errorCode: null,
    createdAt: '2026-08-29T12:00:01.000Z',
    updatedAt: '2026-08-29T12:00:01.000Z',
  };

  it('persists the sale link before dispatch and then synchronizes the provider result', async () => {
    const accepted: SaleFiscalDocumentInternal = {
      ...pending,
      simulatorDocumentId: simulatorDocument.id,
      providerReference: simulatorDocument.providerReference,
      status: 'ACCEPTED',
      artifacts: [
        { kind: 'PDF', path: '/pdf' },
        { kind: 'XML', path: '/xml' },
      ],
      events: [
        ...pending.events,
        { status: 'SENT', occurredAt: '2026-08-29T12:00:01.000Z' },
        { status: 'ACCEPTED', occurredAt: '2026-08-29T12:00:01.000Z' },
      ],
    };
    const documents = {
      start: jest.fn().mockResolvedValue({ document: pending, replay: false }),
      sync: jest.fn().mockResolvedValue(accepted),
    };
    const receipts = {
      get: jest.fn().mockResolvedValue({
        receiptNumber: 'V-ABC123',
        saleStatus: 'COMPLETED',
      }),
    };
    const simulator = {
      issue: jest.fn().mockResolvedValue({
        data: simulatorDocument,
        meta: { idempotentReplay: false },
      }),
    };
    const audit = { recordRequired: jest.fn().mockResolvedValue(undefined) };
    const service = new SaleFiscalDocumentService(
      documents as unknown as SaleFiscalDocumentRepository,
      receipts as unknown as SaleReceiptRepository,
      simulator as unknown as FiscalSimulatorService,
      {} as ExternalAdapterExecutionService,
      {} as TransactionalEmailTemplateService,
      audit as unknown as AuditService,
    );

    const result = await service.issue({
      tenantId: 'tenant-1',
      branchId: 'branch-1',
      saleId: 'sale-1',
      userId: 'user-1',
      correlationId: 'request-1',
      idempotencyKey: 'web-fiscal-issue-1',
      dto: { documentType: 'INVOICE', scenario: 'SUCCESS' },
    });

    expect(documents.start.mock.invocationCallOrder[0]).toBeLessThan(
      simulator.issue.mock.invocationCallOrder[0],
    );
    const providerCalls = simulator.issue.mock.calls as unknown as Array<
      [{ idempotencyKey: string; dto: { reference: string } }]
    >;
    const providerInput = providerCalls[0][0];
    expect(providerInput.idempotencyKey).toBe(pending.providerIdempotencyKey);
    expect(providerInput.dto.reference).toBe('V-ABC123');
    expect(documents.sync).toHaveBeenCalledWith(
      expect.objectContaining({ simulator: simulatorDocument }),
    );
    expect(result.data).toMatchObject({ status: 'ACCEPTED', saleId: 'sale-1' });
    expect(result.data).not.toHaveProperty('simulatorDocumentId');
  });

  it('replays an already linked document without issuing blindly again', async () => {
    const linked = {
      ...pending,
      simulatorDocumentId: simulatorDocument.id,
      providerReference: simulatorDocument.providerReference,
      status: 'INDETERMINATE' as const,
    };
    const documents = {
      start: jest.fn().mockResolvedValue({ document: linked, replay: true }),
    };
    const simulator = { issue: jest.fn() };
    const service = new SaleFiscalDocumentService(
      documents as unknown as SaleFiscalDocumentRepository,
      {
        get: jest.fn().mockResolvedValue({
          receiptNumber: 'V-ABC123',
          saleStatus: 'COMPLETED',
        }),
      } as unknown as SaleReceiptRepository,
      simulator as unknown as FiscalSimulatorService,
      {} as ExternalAdapterExecutionService,
      {} as TransactionalEmailTemplateService,
      { recordRequired: jest.fn() } as unknown as AuditService,
    );

    const result = await service.issue({
      tenantId: 'tenant-1',
      branchId: 'branch-1',
      saleId: 'sale-1',
      userId: 'user-1',
      correlationId: 'request-2',
      idempotencyKey: 'web-fiscal-issue-1',
      dto: { documentType: 'INVOICE', scenario: 'SUCCESS' },
    });

    expect(simulator.issue).not.toHaveBeenCalled();
    expect(result.meta.idempotentReplay).toBe(true);
    expect(result.data.status).toBe('INDETERMINATE');
  });
});
