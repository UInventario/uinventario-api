import { Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { DataSource, EntityManager } from 'typeorm';
import type { UpdateAccountingConfigDto } from './dto/update-accounting-config.dto';
import {
  AccountingEventNotFoundError,
  AccountingIdempotencyConflictError,
} from './accounting.errors';
import type {
  AccountingEntry,
  AccountingEventData,
  AccountingEventStatus,
  AccountingSourceCandidate,
  AccountingSourceType,
} from './accounting.types';

export interface AccountingConfigData extends UpdateAccountingConfigDto {
  provider: 'SIMULATOR';
  contractVersion: '1';
  updatedAt: string;
}

interface ConfigRow {
  provider: 'SIMULATOR';
  contract_version: '1';
  payment_clearing_account: string;
  sales_revenue_account: string;
  sales_returns_account: string;
  tax_payable_account: string;
  inventory_asset_account: string;
  cost_of_goods_sold_account: string;
  cash_account: string;
  cash_clearing_account: string;
  updated_at: Date | string;
}

interface EventRow {
  id: string;
  event_key: string;
  source_type: AccountingSourceType;
  source_id: string;
  provider: 'SIMULATOR';
  contract_version: '1';
  currency: string;
  occurred_at: Date | string;
  reference_key: string;
  journal:
    | string
    | { journalStatus: 'CANDIDATE_NOT_POSTED'; entries: AccountingEntry[] };
  debit_total: string;
  credit_total: string;
  content_fingerprint: string;
  status: AccountingEventStatus;
  attempt_count: number | string;
  error_code: string | null;
  provider_reference: string | null;
  created_at: Date | string;
  updated_at: Date | string;
}

interface AttemptRow {
  event_id: string;
  action: 'DELIVER' | 'RECONCILE';
  request_fingerprint: string;
  result: string | AccountingEventData;
}

@Injectable()
export class AccountingRepository {
  constructor(private readonly dataSource: DataSource) {}

  async config(tenantId: string): Promise<AccountingConfigData | null> {
    const [row] = await this.dataSource.query<ConfigRow[]>(
      'SELECT * FROM accounting_configs WHERE tenant_id = ? LIMIT 1',
      [tenantId],
    );
    return row ? this.mapConfig(row) : null;
  }

  async saveConfig(
    tenantId: string,
    userId: string,
    dto: UpdateAccountingConfigDto,
  ) {
    await this.dataSource.query(
      `INSERT INTO accounting_configs
        (tenant_id, provider, contract_version, payment_clearing_account,
         sales_revenue_account, sales_returns_account, tax_payable_account,
         inventory_asset_account, cost_of_goods_sold_account, cash_account,
         cash_clearing_account, updated_by_user_id)
       VALUES (?, 'SIMULATOR', '1', ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE payment_clearing_account = VALUES(payment_clearing_account),
         sales_revenue_account = VALUES(sales_revenue_account),
         sales_returns_account = VALUES(sales_returns_account),
         tax_payable_account = VALUES(tax_payable_account),
         inventory_asset_account = VALUES(inventory_asset_account),
         cost_of_goods_sold_account = VALUES(cost_of_goods_sold_account),
         cash_account = VALUES(cash_account), cash_clearing_account = VALUES(cash_clearing_account),
         updated_by_user_id = VALUES(updated_by_user_id)`,
      [
        tenantId,
        dto.paymentClearingAccount,
        dto.salesRevenueAccount,
        dto.salesReturnsAccount,
        dto.taxPayableAccount,
        dto.inventoryAssetAccount,
        dto.costOfGoodsSoldAccount,
        dto.cashAccount,
        dto.cashClearingAccount,
        userId,
      ],
    );
    return (await this.config(tenantId))!;
  }

  sourceCandidates(tenantId: string): Promise<AccountingSourceCandidate[]> {
    return this.dataSource.query<AccountingSourceCandidate[]>(
      `SELECT candidate.* FROM (
         SELECT CONCAT('SALE:', sale.id) event_key, 'SALE' source_type,
           sale.id source_id, sale.created_at occurred_at, sale.currency,
           sale.receipt_number reference_key, sale.subtotal, sale.tax_total, sale.total,
           ROUND(COALESCE(SUM(line.quantity * line.unit_cost), 0), 2) cost_total,
           NULL cash_type, NULL reversed_cash_type
         FROM sales sale JOIN sale_lines line
           ON line.tenant_id = sale.tenant_id AND line.sale_id = sale.id
         WHERE sale.tenant_id = ?
         GROUP BY sale.id, sale.created_at, sale.currency, sale.receipt_number,
           sale.subtotal, sale.tax_total, sale.total
         UNION ALL
         SELECT CONCAT('SALE_VOID:', sale.id), 'SALE_VOID', sale.id, sale.voided_at,
           sale.currency, sale.receipt_number, sale.subtotal, sale.tax_total, sale.total,
           ROUND(COALESCE(SUM(line.quantity * line.unit_cost), 0), 2), NULL, NULL
         FROM sales sale JOIN sale_lines line
           ON line.tenant_id = sale.tenant_id AND line.sale_id = sale.id
         WHERE sale.tenant_id = ? AND sale.status = 'VOIDED'
         GROUP BY sale.id, sale.voided_at, sale.currency, sale.receipt_number,
           sale.subtotal, sale.tax_total, sale.total
         UNION ALL
         SELECT CONCAT('SALE_RETURN:', sale_return.id), 'SALE_RETURN', sale_return.id,
           sale_return.created_at, sale.currency,
           CONCAT(sale.receipt_number, '-RETURN-', LEFT(sale_return.id, 8)),
           sale_return.subtotal, sale_return.tax_total, sale_return.total,
           ROUND(COALESCE(SUM(return_line.quantity * sale_line.unit_cost), 0), 2), NULL, NULL
         FROM sale_returns sale_return
         JOIN sales sale ON sale.tenant_id = sale_return.tenant_id
           AND sale.id = sale_return.sale_id
         JOIN sale_return_lines return_line ON return_line.tenant_id = sale_return.tenant_id
           AND return_line.sale_return_id = sale_return.id
         JOIN sale_lines sale_line ON sale_line.tenant_id = return_line.tenant_id
           AND sale_line.id = return_line.sale_line_id
         WHERE sale_return.tenant_id = ?
         GROUP BY sale_return.id, sale_return.created_at, sale.currency, sale.receipt_number,
           sale_return.subtotal, sale_return.tax_total, sale_return.total
         UNION ALL
         SELECT CONCAT('CASH_MOVEMENT:', movement.id), 'CASH_MOVEMENT', movement.id,
           movement.created_at, shift.currency, movement.id,
           0, 0, movement.amount, 0, movement.type, original.type
         FROM cash_register_movements movement
         JOIN cash_register_shifts shift ON shift.tenant_id = movement.tenant_id
           AND shift.id = movement.cash_register_shift_id
         LEFT JOIN cash_register_movements original ON original.tenant_id = movement.tenant_id
           AND original.id = movement.reversal_of_id
         WHERE movement.tenant_id = ?
       ) candidate
       WHERE NOT EXISTS (
         SELECT 1 FROM accounting_events event
         WHERE event.tenant_id = ? AND event.event_key = candidate.event_key)
       ORDER BY candidate.occurred_at, candidate.source_id LIMIT 1000`,
      [tenantId, tenantId, tenantId, tenantId, tenantId],
    );
  }

  async createEvent(input: {
    tenantId: string;
    userId: string;
    candidate: AccountingSourceCandidate;
    entries: AccountingEntry[];
    debitTotal: string;
    creditTotal: string;
    fingerprint: string;
  }): Promise<{ event: AccountingEventData; created: boolean }> {
    const id = randomUUID();
    const result = await this.dataSource.query<{ affectedRows?: number }>(
      `INSERT IGNORE INTO accounting_events
        (id, tenant_id, event_key, source_type, source_id, provider, contract_version,
         currency, occurred_at, reference_key, journal, debit_total, credit_total,
         content_fingerprint, status, generated_by_user_id)
       VALUES (?, ?, ?, ?, ?, 'SIMULATOR', '1', ?, ?, ?, ?, ?, ?, ?, 'PENDING', ?)`,
      [
        id,
        input.tenantId,
        input.candidate.event_key,
        input.candidate.source_type,
        input.candidate.source_id,
        input.candidate.currency,
        input.candidate.occurred_at,
        input.candidate.reference_key,
        JSON.stringify({
          journalStatus: 'CANDIDATE_NOT_POSTED',
          entries: input.entries,
        }),
        input.debitTotal,
        input.creditTotal,
        input.fingerprint,
        input.userId,
      ],
    );
    const event = await this.byKey(input.tenantId, input.candidate.event_key);
    if (!event) throw new Error('ACCOUNTING_EVENT_CREATE_FAILED');
    if (event.fingerprint !== input.fingerprint) {
      throw new AccountingIdempotencyConflictError();
    }
    return {
      event: event.data,
      created: Number(result.affectedRows ?? 0) === 1,
    };
  }

  async list(tenantId: string): Promise<AccountingEventData[]> {
    const rows = await this.dataSource.query<EventRow[]>(
      `SELECT * FROM accounting_events WHERE tenant_id = ?
       ORDER BY occurred_at DESC, id DESC LIMIT 200`,
      [tenantId],
    );
    return rows.map((row) => this.mapEvent(row));
  }

  async attempt(input: {
    tenantId: string;
    eventId: string;
    action: 'DELIVER' | 'RECONCILE';
    scenario: 'SUCCESS' | 'REJECT' | 'TIMEOUT' | 'QUERY';
    idempotencyKey: string;
    fingerprint: string;
    correlationId: string;
    execute: (event: AccountingEventData) => {
      status: AccountingEventStatus;
      providerReference: string | null;
      errorCode: string | null;
    };
  }): Promise<{ event: AccountingEventData; replay: boolean }> {
    return this.dataSource.transaction(async (manager) => {
      await manager.query('SELECT id FROM tenants WHERE id = ? FOR UPDATE', [
        input.tenantId,
      ]);
      const replay = await this.attemptReplay(manager, input);
      if (replay) return { event: replay, replay: true };
      const current = await this.lock(manager, input.tenantId, input.eventId);
      if (!current) throw new AccountingEventNotFoundError();
      const next = input.execute(this.mapEvent(current));
      await manager.query(
        `UPDATE accounting_events SET status = ?, provider_reference = ?, error_code = ?,
           attempt_count = attempt_count + 1 WHERE tenant_id = ? AND id = ?`,
        [
          next.status,
          next.providerReference,
          next.errorCode,
          input.tenantId,
          input.eventId,
        ],
      );
      const event = this.mapEvent(
        await this.lock(manager, input.tenantId, input.eventId),
      );
      await manager.query(
        `INSERT INTO accounting_delivery_attempts
          (id, tenant_id, event_id, action, scenario, idempotency_key,
           request_fingerprint, result, correlation_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          randomUUID(),
          input.tenantId,
          input.eventId,
          input.action,
          input.scenario,
          input.idempotencyKey,
          input.fingerprint,
          JSON.stringify(event),
          input.correlationId,
        ],
      );
      return { event, replay: false };
    });
  }

  private async attemptReplay(
    manager: EntityManager,
    input: {
      tenantId: string;
      eventId: string;
      action: string;
      idempotencyKey: string;
      fingerprint: string;
    },
  ) {
    const [row] = await manager.query<AttemptRow[]>(
      `SELECT event_id, action, request_fingerprint, result
       FROM accounting_delivery_attempts WHERE tenant_id = ? AND idempotency_key = ? LIMIT 1`,
      [input.tenantId, input.idempotencyKey],
    );
    if (!row) return null;
    if (
      row.event_id !== input.eventId ||
      row.action !== input.action ||
      row.request_fingerprint !== input.fingerprint
    ) {
      throw new AccountingIdempotencyConflictError();
    }
    return this.json<AccountingEventData>(row.result);
  }

  private async byKey(tenantId: string, eventKey: string) {
    const [row] = await this.dataSource.query<EventRow[]>(
      'SELECT * FROM accounting_events WHERE tenant_id = ? AND event_key = ? LIMIT 1',
      [tenantId, eventKey],
    );
    return row
      ? { data: this.mapEvent(row), fingerprint: row.content_fingerprint }
      : null;
  }

  private lock(manager: EntityManager, tenantId: string, eventId: string) {
    return manager
      .query<EventRow[]>(
        'SELECT * FROM accounting_events WHERE tenant_id = ? AND id = ? LIMIT 1 FOR UPDATE',
        [tenantId, eventId],
      )
      .then(([row]) => row);
  }

  private mapConfig(row: ConfigRow): AccountingConfigData {
    return {
      provider: row.provider,
      contractVersion: row.contract_version,
      paymentClearingAccount: row.payment_clearing_account,
      salesRevenueAccount: row.sales_revenue_account,
      salesReturnsAccount: row.sales_returns_account,
      taxPayableAccount: row.tax_payable_account,
      inventoryAssetAccount: row.inventory_asset_account,
      costOfGoodsSoldAccount: row.cost_of_goods_sold_account,
      cashAccount: row.cash_account,
      cashClearingAccount: row.cash_clearing_account,
      updatedAt: new Date(row.updated_at).toISOString(),
    };
  }

  private mapEvent(row: EventRow): AccountingEventData {
    const journal = this.json<{
      journalStatus: 'CANDIDATE_NOT_POSTED';
      entries: AccountingEntry[];
    }>(row.journal);
    return {
      id: row.id,
      eventKey: row.event_key,
      sourceType: row.source_type,
      sourceId: row.source_id,
      provider: row.provider,
      contractVersion: row.contract_version,
      currency: row.currency,
      occurredAt: new Date(row.occurred_at).toISOString(),
      reference: row.reference_key,
      journalStatus: journal.journalStatus,
      entries: journal.entries,
      debitTotal: this.money(row.debit_total),
      creditTotal: this.money(row.credit_total),
      status: row.status,
      attemptCount: Number(row.attempt_count),
      errorCode: row.error_code,
      providerReference: row.provider_reference,
      createdAt: new Date(row.created_at).toISOString(),
      updatedAt: new Date(row.updated_at).toISOString(),
    };
  }

  private money(value: string): string {
    return Number(value).toFixed(2);
  }

  private json<T>(value: string | T): T {
    return typeof value === 'string' ? (JSON.parse(value) as T) : value;
  }
}
