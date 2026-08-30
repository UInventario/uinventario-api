import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { createHash } from 'node:crypto';
import { AuditService } from '../audit/audit.service';
import type { DeliverAccountingEventDto } from './dto/deliver-accounting-event.dto';
import type { UpdateAccountingConfigDto } from './dto/update-accounting-config.dto';
import {
  AccountingEventNotFoundError,
  AccountingIdempotencyConflictError,
} from './accounting.errors';
import {
  AccountingRepository,
  type AccountingConfigData,
} from './accounting.repository';
import type {
  AccountingEntry,
  AccountingEventData,
  AccountingSourceCandidate,
} from './accounting.types';
import { SimulatedAccountingAdapter } from './simulated-accounting.adapter';

@Injectable()
export class AccountingService {
  constructor(
    private readonly repository: AccountingRepository,
    private readonly adapter: SimulatedAccountingAdapter,
    private readonly audit: AuditService,
  ) {}

  contract() {
    return {
      data: {
        name: 'UINVENTARIO_ACCOUNTING_CANDIDATES',
        version: '1',
        provider: { key: 'SIMULATOR', mode: 'SIMULATOR', production: false },
        journalStatus: 'CANDIDATE_NOT_POSTED',
        sources: ['SALE', 'SALE_VOID', 'SALE_RETURN', 'CASH_MOVEMENT'],
        fields: [
          'accountReference',
          'currency',
          'occurredAt',
          'reference',
          'debit',
          'credit',
        ],
        guarantees: {
          balancedCandidates: true,
          immutableSourceSnapshots: true,
          idempotentDelivery: true,
          reconcileBeforeRetry: true,
          sourceTransactionsUnaffected: true,
        },
      },
      meta: { apiVersion: '1' as const },
    };
  }

  async getConfig(tenantId: string) {
    return {
      data: await this.repository.config(tenantId),
      meta: { apiVersion: '1' as const },
    };
  }

  async saveConfig(input: {
    tenantId: string;
    userId: string;
    correlationId: string;
    dto: UpdateAccountingConfigDto;
  }) {
    const data = await this.repository.saveConfig(
      input.tenantId,
      input.userId,
      input.dto,
    );
    await this.audit.recordRequired({
      tenantId: input.tenantId,
      actorUserId: input.userId,
      action: 'ACCOUNTING_CONFIG_UPDATED',
      entityType: 'ACCOUNTING_CONFIG',
      entityId: input.tenantId,
      correlationId: input.correlationId,
      after: { provider: data.provider, contractVersion: data.contractVersion },
    });
    return { data, meta: { apiVersion: '1' as const } };
  }

  async generate(input: {
    tenantId: string;
    userId: string;
    correlationId: string;
  }) {
    const config = await this.repository.config(input.tenantId);
    if (!config)
      throw new BadRequestException({ code: 'ACCOUNTING_CONFIG_REQUIRED' });
    const candidates = await this.repository.sourceCandidates(input.tenantId);
    const generated: AccountingEventData[] = [];
    for (const candidate of candidates) {
      const journal = this.journal(candidate, config);
      const fingerprint = this.hash({
        source: candidate,
        contractVersion: config.contractVersion,
        entries: journal.entries,
      });
      const result = await this.repository.createEvent({
        ...input,
        candidate,
        entries: journal.entries,
        debitTotal: journal.debitTotal,
        creditTotal: journal.creditTotal,
        fingerprint,
      });
      if (result.created) generated.push(result.event);
    }
    if (generated.length > 0) {
      await this.audit.recordRequired({
        tenantId: input.tenantId,
        actorUserId: input.userId,
        action: 'ACCOUNTING_CANDIDATES_GENERATED',
        entityType: 'ACCOUNTING_BATCH',
        entityId: this.hash(generated.map(({ eventKey }) => eventKey)).slice(
          0,
          36,
        ),
        correlationId: input.correlationId,
        after: { events: generated.length },
      });
    }
    return {
      data: generated,
      meta: {
        apiVersion: '1' as const,
        discovered: candidates.length,
        created: generated.length,
      },
    };
  }

  async list(tenantId: string) {
    return {
      data: await this.repository.list(tenantId),
      meta: { apiVersion: '1' as const },
    };
  }

  deliver(input: ActionInput & { dto: DeliverAccountingEventDto }) {
    return this.action(input, 'DELIVER', input.dto.scenario, (event) => {
      if (event.status === 'INDETERMINATE') {
        throw new ConflictException({
          code: 'ACCOUNTING_RECONCILIATION_REQUIRED',
        });
      }
      if (event.status === 'EXPORTED') {
        throw new ConflictException({ code: 'ACCOUNTING_ALREADY_EXPORTED' });
      }
      return this.adapter.deliver(event, input.dto.scenario);
    });
  }

  reconcile(input: ActionInput) {
    return this.action(input, 'RECONCILE', 'QUERY', (event) => {
      if (event.status !== 'INDETERMINATE') {
        throw new ConflictException({
          code: 'ACCOUNTING_NOT_INDETERMINATE',
        });
      }
      return this.adapter.reconcile(event);
    });
  }

  private async action(
    input: ActionInput,
    action: 'DELIVER' | 'RECONCILE',
    scenario: 'SUCCESS' | 'REJECT' | 'TIMEOUT' | 'QUERY',
    execute: Parameters<AccountingRepository['attempt']>[0]['execute'],
  ) {
    this.key(input.idempotencyKey);
    const fingerprint = this.hash({ eventId: input.eventId, action, scenario });
    try {
      const result = await this.repository.attempt({
        ...input,
        action,
        scenario,
        fingerprint,
        execute,
      });
      if (!result.replay) {
        await this.audit.recordRequired({
          tenantId: input.tenantId,
          actorUserId: input.userId,
          action: `ACCOUNTING_${action}`,
          entityType: 'ACCOUNTING_EVENT',
          entityId: input.eventId,
          correlationId: input.correlationId,
          after: {
            status: result.event.status,
            attemptCount: result.event.attemptCount,
          },
        });
      }
      return {
        data: result.event,
        meta: { apiVersion: '1' as const, idempotentReplay: result.replay },
      };
    } catch (error) {
      this.mapError(error);
    }
  }

  private journal(
    candidate: AccountingSourceCandidate,
    config: AccountingConfigData,
  ) {
    const subtotal = this.money(candidate.subtotal);
    const tax = this.money(candidate.tax_total);
    const total = this.money(candidate.total);
    const cost = this.money(candidate.cost_total);
    let entries: AccountingEntry[];
    if (candidate.source_type === 'SALE') {
      entries = [
        this.entry(
          config.paymentClearingAccount,
          total,
          '0.00',
          'Cobro/por cobrar',
        ),
        this.entry(config.salesRevenueAccount, '0.00', subtotal, 'Venta neta'),
        this.entry(config.taxPayableAccount, '0.00', tax, 'Impuesto de venta'),
        this.entry(
          config.costOfGoodsSoldAccount,
          cost,
          '0.00',
          'Costo de venta',
        ),
        this.entry(
          config.inventoryAssetAccount,
          '0.00',
          cost,
          'Salida de inventario',
        ),
      ];
    } else if (candidate.source_type === 'SALE_VOID') {
      entries = [
        this.entry(
          config.salesRevenueAccount,
          subtotal,
          '0.00',
          'Reverso de venta',
        ),
        this.entry(
          config.taxPayableAccount,
          tax,
          '0.00',
          'Reverso de impuesto',
        ),
        this.entry(
          config.paymentClearingAccount,
          '0.00',
          total,
          'Reverso de cobro',
        ),
        this.entry(
          config.inventoryAssetAccount,
          cost,
          '0.00',
          'Retorno de inventario',
        ),
        this.entry(
          config.costOfGoodsSoldAccount,
          '0.00',
          cost,
          'Reverso de costo',
        ),
      ];
    } else if (candidate.source_type === 'SALE_RETURN') {
      entries = [
        this.entry(
          config.salesReturnsAccount,
          subtotal,
          '0.00',
          'Devolución de venta',
        ),
        this.entry(config.taxPayableAccount, tax, '0.00', 'Impuesto devuelto'),
        this.entry(
          config.paymentClearingAccount,
          '0.00',
          total,
          'Reembolso/abono',
        ),
        this.entry(
          config.inventoryAssetAccount,
          cost,
          '0.00',
          'Inventario devuelto',
        ),
        this.entry(
          config.costOfGoodsSoldAccount,
          '0.00',
          cost,
          'Reverso de costo',
        ),
      ];
    } else {
      const effective =
        candidate.cash_type === 'REVERSAL'
          ? candidate.reversed_cash_type === 'INCOME'
            ? 'WITHDRAWAL'
            : 'INCOME'
          : candidate.cash_type;
      entries =
        effective === 'INCOME'
          ? [
              this.entry(config.cashAccount, total, '0.00', 'Entrada de caja'),
              this.entry(
                config.cashClearingAccount,
                '0.00',
                total,
                'Contrapartida de caja',
              ),
            ]
          : [
              this.entry(
                config.cashClearingAccount,
                total,
                '0.00',
                'Salida de caja',
              ),
              this.entry(
                config.cashAccount,
                '0.00',
                total,
                'Contrapartida de caja',
              ),
            ];
    }
    entries = entries.filter(
      ({ debit, credit }) => debit !== '0.00' || credit !== '0.00',
    );
    const debitTotal = this.sum(entries.map(({ debit }) => debit));
    const creditTotal = this.sum(entries.map(({ credit }) => credit));
    if (debitTotal !== creditTotal)
      throw new Error('ACCOUNTING_CANDIDATE_UNBALANCED');
    return { entries, debitTotal, creditTotal };
  }

  private entry(
    accountReference: string,
    debit: string,
    credit: string,
    memo: string,
  ): AccountingEntry {
    return { accountReference, debit, credit, memo };
  }

  private money(value: string): string {
    return this.fromCents(this.cents(value));
  }

  private sum(values: string[]): string {
    return this.fromCents(
      values.reduce((total, value) => total + this.cents(value), 0n),
    );
  }

  private cents(value: string): bigint {
    const [whole, fraction = ''] = value.split('.');
    return BigInt(whole) * 100n + BigInt(fraction.padEnd(2, '0'));
  }

  private fromCents(value: bigint): string {
    return `${value / 100n}.${String(value % 100n).padStart(2, '0')}`;
  }

  private hash(value: unknown): string {
    return createHash('sha256').update(JSON.stringify(value)).digest('hex');
  }

  private key(value: string): void {
    if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/.test(value)) {
      throw new BadRequestException({ code: 'INVALID_IDEMPOTENCY_KEY' });
    }
  }

  private mapError(error: unknown): never {
    if (error instanceof AccountingIdempotencyConflictError) {
      throw new ConflictException({ code: 'ACCOUNTING_IDEMPOTENCY_CONFLICT' });
    }
    if (error instanceof AccountingEventNotFoundError) {
      throw new NotFoundException({ code: 'ACCOUNTING_EVENT_NOT_FOUND' });
    }
    throw error;
  }
}

interface ActionInput {
  tenantId: string;
  userId: string;
  correlationId: string;
  eventId: string;
  idempotencyKey: string;
}
