import type { AuditService } from '../audit/audit.service';
import type { AccountingRepository } from './accounting.repository';
import { AccountingService } from './accounting.service';
import type {
  AccountingEventData,
  AccountingSourceCandidate,
} from './accounting.types';
import { SimulatedAccountingAdapter } from './simulated-accounting.adapter';

const config = {
  provider: 'SIMULATOR' as const,
  contractVersion: '1' as const,
  paymentClearingAccount: '1100-CLEARING',
  salesRevenueAccount: '4100-SALES',
  salesReturnsAccount: '4110-RETURNS',
  taxPayableAccount: '2100-TAX',
  inventoryAssetAccount: '1200-INVENTORY',
  costOfGoodsSoldAccount: '5100-COGS',
  cashAccount: '1000-CASH',
  cashClearingAccount: '2190-CASH-CLEARING',
  updatedAt: '2026-08-29T12:00:00.000Z',
};

const source = (
  sourceType: AccountingSourceCandidate['source_type'],
  overrides: Partial<AccountingSourceCandidate> = {},
): AccountingSourceCandidate => ({
  event_key: `${sourceType}:source-${sourceType}`,
  source_type: sourceType,
  source_id: `source-${sourceType}`,
  occurred_at: '2026-08-29T12:00:00.000Z',
  currency: 'MXN',
  reference_key: `REF-${sourceType}`,
  subtotal: '100.00',
  tax_total: '16.00',
  total: '116.00',
  cost_total: '60.00',
  cash_type: null,
  reversed_cash_type: null,
  ...overrides,
});

describe('AccountingService', () => {
  const audit = { recordRequired: jest.fn().mockResolvedValue(undefined) };

  it('generates balanced candidate snapshots for sales, voids, returns and cash', async () => {
    const candidates = [
      source('SALE'),
      source('SALE_VOID'),
      source('SALE_RETURN'),
      source('CASH_MOVEMENT', {
        subtotal: '0.00',
        tax_total: '0.00',
        total: '25.00',
        cost_total: '0.00',
        cash_type: 'REVERSAL',
        reversed_cash_type: 'INCOME',
      }),
    ];
    const repository = {
      config: jest.fn().mockResolvedValue(config),
      sourceCandidates: jest.fn().mockResolvedValue(candidates),
      createEvent: jest.fn(
        (input: {
          candidate: AccountingSourceCandidate;
          entries: AccountingEventData['entries'];
          debitTotal: string;
          creditTotal: string;
        }) => ({
          created: true,
          event: {
            id: input.candidate.source_id,
            eventKey: input.candidate.event_key,
            sourceType: input.candidate.source_type,
            sourceId: input.candidate.source_id,
            provider: 'SIMULATOR',
            contractVersion: '1',
            currency: input.candidate.currency,
            occurredAt: String(input.candidate.occurred_at),
            reference: input.candidate.reference_key,
            journalStatus: 'CANDIDATE_NOT_POSTED',
            entries: input.entries,
            debitTotal: input.debitTotal,
            creditTotal: input.creditTotal,
            status: 'PENDING',
            attemptCount: 0,
            errorCode: null,
            providerReference: null,
            createdAt: '2026-08-29T12:00:00.000Z',
            updatedAt: '2026-08-29T12:00:00.000Z',
          } satisfies AccountingEventData,
        }),
      ),
    };
    const service = new AccountingService(
      repository as unknown as AccountingRepository,
      new SimulatedAccountingAdapter(),
      audit as unknown as AuditService,
    );

    const result = await service.generate({
      tenantId: 'tenant-1',
      userId: 'user-1',
      correlationId: 'request-1',
    });

    expect(result.data.map(({ sourceType }) => sourceType)).toEqual([
      'SALE',
      'SALE_VOID',
      'SALE_RETURN',
      'CASH_MOVEMENT',
    ]);
    result.data.forEach((event) => {
      expect(event.debitTotal).toBe(event.creditTotal);
      expect(event.journalStatus).toBe('CANDIDATE_NOT_POSTED');
      expect(event.entries.length).toBeGreaterThan(1);
    });
  });

  it('forces reconciliation after timeout before another delivery attempt', async () => {
    let current: AccountingEventData = {
      id: 'event-1',
      eventKey: 'SALE:sale-1',
      sourceType: 'SALE',
      sourceId: 'sale-1',
      provider: 'SIMULATOR',
      contractVersion: '1',
      currency: 'MXN',
      occurredAt: '2026-08-29T12:00:00.000Z',
      reference: 'S-1',
      journalStatus: 'CANDIDATE_NOT_POSTED',
      entries: [],
      debitTotal: '116.00',
      creditTotal: '116.00',
      status: 'PENDING',
      attemptCount: 0,
      errorCode: null,
      providerReference: null,
      createdAt: '2026-08-29T12:00:00.000Z',
      updatedAt: '2026-08-29T12:00:00.000Z',
    };
    const repository = {
      attempt: jest.fn(
        (input: {
          execute: (event: AccountingEventData) => {
            status: AccountingEventData['status'];
            providerReference: string | null;
            errorCode: string | null;
          };
        }) => {
          const next = input.execute(current);
          current = {
            ...current,
            ...next,
            attemptCount: current.attemptCount + 1,
          };
          return { event: current, replay: false };
        },
      ),
    };
    const service = new AccountingService(
      repository as unknown as AccountingRepository,
      new SimulatedAccountingAdapter(),
      audit as unknown as AuditService,
    );
    const input = {
      tenantId: 'tenant-1',
      userId: 'user-1',
      correlationId: 'request-1',
      eventId: current.id,
    };

    await expect(
      service.deliver({
        ...input,
        idempotencyKey: 'deliver-timeout',
        dto: { scenario: 'TIMEOUT' },
      }),
    ).resolves.toMatchObject({ data: { status: 'INDETERMINATE' } });
    await expect(
      service.deliver({
        ...input,
        idempotencyKey: 'deliver-retry',
        dto: { scenario: 'SUCCESS' },
      }),
    ).rejects.toMatchObject({
      response: { code: 'ACCOUNTING_RECONCILIATION_REQUIRED' },
    });
    await expect(
      service.reconcile({ ...input, idempotencyKey: 'reconcile-001' }),
    ).resolves.toMatchObject({ data: { status: 'EXPORTED' } });
    await expect(
      service.reconcile({ ...input, idempotencyKey: 'reconcile-002' }),
    ).rejects.toMatchObject({
      response: { code: 'ACCOUNTING_NOT_INDETERMINATE' },
    });
  });
});
