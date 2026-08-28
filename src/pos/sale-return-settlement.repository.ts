import { Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { DataSource, EntityManager, QueryFailedError } from 'typeorm';
import { AuditService } from '../audit/audit.service';
import {
  type CreateSaleReturnSettlementDto,
  SaleReturnSettlementModeDto,
} from './dto/create-sale-return-settlement.dto';
import type { PaymentMethod } from './dto/create-sale.dto';
import {
  PaymentRefundService,
  type PaymentRefundResult,
} from './payment-refund.service';
import { PosIdempotencyConflictError } from './pos.errors';
import {
  SaleReturnSettlementAmountError,
  SaleReturnSettlementCashError,
  SaleReturnSettlementCustomerError,
  type SaleReturnSettlementData,
  SaleReturnSettlementPaymentError,
  SaleReturnSettlementShiftError,
} from './sale-return.types';

interface SettlementRow {
  id: string;
  tenant_id: string;
  sale_return_id: string;
  source_sale_id: string;
  source_branch_id: string;
  original_payment_id: string | null;
  original_payment_method: PaymentMethod | null;
  mode: 'REFUND' | 'STORE_CREDIT';
  method: PaymentMethod | 'STORE_CREDIT';
  status: 'COMPLETED' | 'FAILED';
  currency: string;
  amount: string;
  provider: string;
  provider_reference: string | null;
  failure_code: string | null;
  request_fingerprint: string;
  processed_by_user_id: string;
  processed_by_email: string;
  created_at: Date | string;
}

@Injectable()
export class SaleReturnSettlementRepository {
  constructor(
    private readonly dataSource: DataSource,
    private readonly audit: AuditService,
    private readonly refunds: PaymentRefundService,
  ) {}

  async create(input: {
    tenantId: string;
    branchId: string;
    cashRegisterId: string;
    cashRegisterShiftId: string | null;
    userId: string;
    saleId: string;
    returnId: string;
    idempotencyKey: string;
    fingerprint: string;
    correlationId: string;
    dto: CreateSaleReturnSettlementDto;
  }): Promise<{
    settlement: SaleReturnSettlementData;
    replay: boolean;
  } | null> {
    try {
      return await this.dataSource.transaction(
        'READ COMMITTED',
        async (manager) => {
          const existing = await this.findByKey(
            manager,
            input.tenantId,
            input.idempotencyKey,
          );
          if (existing) return this.replay(existing, input);

          const [saleReturn] = await manager.query<
            Array<{
              id: string;
              total: string;
              settlement_status: string;
              currency: string;
              customer_id: string | null;
            }>
          >(
            `SELECT sr.id, sr.total, sr.settlement_status, s.currency, s.customer_id
             FROM sale_returns sr
             INNER JOIN sales s ON s.id = sr.sale_id AND s.tenant_id = sr.tenant_id
             WHERE sr.id = ? AND sr.tenant_id = ? AND sr.sale_id = ?
               AND s.branch_id = ? LIMIT 1 FOR UPDATE`,
            [input.returnId, input.tenantId, input.saleId, input.branchId],
          );
          if (!saleReturn) return null;

          const concurrentReplay = await this.findByKey(
            manager,
            input.tenantId,
            input.idempotencyKey,
          );
          if (concurrentReplay) return this.replay(concurrentReplay, input);

          const amount = this.toMoney(input.dto.amount);
          const [settled] = await manager.query<Array<{ amount: string }>>(
            `SELECT COALESCE(SUM(amount), 0) AS amount
             FROM sale_return_settlements
             WHERE tenant_id = ? AND sale_return_id = ? AND status = 'COMPLETED'`,
            [input.tenantId, saleReturn.id],
          );
          const settledAmount = this.toMoney(settled.amount);
          const returnTotal = this.toMoney(saleReturn.total);
          if (amount <= 0n || settledAmount + amount > returnTotal) {
            throw new SaleReturnSettlementAmountError();
          }

          let method: PaymentMethod | 'STORE_CREDIT' = 'STORE_CREDIT';
          let originalPaymentId: string | null = null;
          let shiftId: string | null = null;
          let outcome: PaymentRefundResult = {
            status: 'COMPLETED' as const,
            provider: 'STORE_CREDIT',
            providerReference: null as string | null,
            failureCode: null as string | null,
          };

          if (input.dto.mode === SaleReturnSettlementModeDto.STORE_CREDIT) {
            if (input.dto.originalPaymentId || !saleReturn.customer_id) {
              throw new SaleReturnSettlementCustomerError();
            }
          } else {
            if (!input.dto.originalPaymentId) {
              throw new SaleReturnSettlementPaymentError();
            }
            const [payment] = await manager.query<
              Array<{
                id: string;
                method: PaymentMethod;
                status: 'COMPLETED' | 'REVERSED';
                currency: string;
                amount_applied: string;
                external_reference: string | null;
                provider_reference: string | null;
              }>
            >(
              `SELECT sp.id, sp.method, sp.status, sp.currency, sp.amount_applied,
                      sp.external_reference, sp.provider_reference
               FROM sale_payments sp
               WHERE sp.id = ? AND sp.tenant_id = ? AND sp.sale_id = ?
               LIMIT 1 FOR UPDATE`,
              [input.dto.originalPaymentId, input.tenantId, input.saleId],
            );
            if (!payment || payment.status !== 'COMPLETED') {
              throw new SaleReturnSettlementPaymentError();
            }
            const [refunded] = await manager.query<Array<{ amount: string }>>(
              `SELECT COALESCE(SUM(amount), 0) AS amount
               FROM sale_return_settlements
               WHERE tenant_id = ? AND original_payment_id = ?
                 AND status = 'COMPLETED'`,
              [input.tenantId, payment.id],
            );
            if (
              this.toMoney(refunded.amount) + amount >
              this.toMoney(payment.amount_applied)
            ) {
              throw new SaleReturnSettlementPaymentError();
            }
            if (payment.method === 'CASH') {
              if (!input.cashRegisterShiftId) {
                throw new SaleReturnSettlementShiftError();
              }
              const [shift] = await manager.query<Array<{ id: string }>>(
                `SELECT id FROM cash_register_shifts
                 WHERE id = ? AND tenant_id = ? AND branch_id = ?
                   AND cash_register_id = ? AND opened_by_user_id = ?
                   AND status = 'OPEN' LIMIT 1 FOR UPDATE`,
                [
                  input.cashRegisterShiftId,
                  input.tenantId,
                  input.branchId,
                  input.cashRegisterId,
                  input.userId,
                ],
              );
              if (!shift) throw new SaleReturnSettlementShiftError();
              shiftId = shift.id;
              const [cash] = await manager.query<
                Array<{ expected_cash: string }>
              >(
                `SELECT crs.opening_amount
                   + COALESCE((SELECT SUM(sp.amount_applied) FROM sales current_sale
                       INNER JOIN sale_payments sp
                         ON sp.sale_id = current_sale.id
                        AND sp.tenant_id = current_sale.tenant_id
                        AND sp.method = 'CASH'
                       WHERE current_sale.tenant_id = crs.tenant_id
                         AND current_sale.cash_register_shift_id = crs.id
                         AND current_sale.status = 'COMPLETED'), 0)
                   - COALESCE((SELECT SUM(previous.amount)
                       FROM sale_return_settlements previous
                       WHERE previous.tenant_id = crs.tenant_id
                         AND previous.cash_register_shift_id = crs.id
                         AND previous.method = 'CASH'
                         AND previous.status = 'COMPLETED'), 0)
                   + COALESCE((SELECT SUM(CASE
                       WHEN movement.type = 'INCOME' THEN movement.amount
                       WHEN movement.type = 'WITHDRAWAL' THEN -movement.amount
                       WHEN original.type = 'INCOME' THEN -movement.amount
                       ELSE movement.amount END)
                       FROM cash_register_movements movement
                       LEFT JOIN cash_register_movements original
                         ON original.id = movement.reversal_of_id
                        AND original.tenant_id = movement.tenant_id
                       WHERE movement.tenant_id = crs.tenant_id
                         AND movement.cash_register_shift_id = crs.id), 0)
                     AS expected_cash
                 FROM cash_register_shifts crs
                 WHERE crs.id = ? AND crs.tenant_id = ? LIMIT 1`,
                [shift.id, input.tenantId],
              );
              if (!cash || this.toMoney(cash.expected_cash) < amount) {
                throw new SaleReturnSettlementCashError();
              }
            }
            method = payment.method;
            originalPaymentId = payment.id;
            outcome = this.refunds.refund({
              method: payment.method,
              originalExternalReference: payment.external_reference,
              originalProviderReference: payment.provider_reference,
              amount: this.money(amount),
              currency: payment.currency,
              idempotencyKey: input.idempotencyKey,
            });
          }

          const settlementId = randomUUID();
          await manager.query(
            `INSERT INTO sale_return_settlements
              (id, tenant_id, sale_return_id, original_payment_id,
               cash_register_shift_id, mode, method, status, currency, amount,
               provider, provider_reference, failure_code, idempotency_key,
               request_fingerprint, processed_by_user_id)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [
              settlementId,
              input.tenantId,
              saleReturn.id,
              originalPaymentId,
              shiftId,
              input.dto.mode,
              method,
              outcome.status,
              saleReturn.currency,
              this.money(amount),
              outcome.provider,
              outcome.providerReference,
              outcome.failureCode,
              input.idempotencyKey,
              input.fingerprint,
              input.userId,
            ],
          );

          if (
            outcome.status === 'COMPLETED' &&
            input.dto.mode === SaleReturnSettlementModeDto.STORE_CREDIT
          ) {
            await manager.query(
              `INSERT INTO customer_credit_ledger
                (id, tenant_id, customer_id, sale_return_settlement_id,
                 entry_type, currency, amount, created_by_user_id)
               VALUES (?, ?, ?, ?, 'CREDIT', ?, ?, ?)`,
              [
                randomUUID(),
                input.tenantId,
                saleReturn.customer_id,
                settlementId,
                saleReturn.currency,
                this.money(amount),
                input.userId,
              ],
            );
          }

          if (outcome.status === 'COMPLETED') {
            const totalSettled = settledAmount + amount;
            await manager.query(
              `UPDATE sale_returns SET settlement_status = ?
               WHERE id = ? AND tenant_id = ?`,
              [
                totalSettled === returnTotal ? 'SETTLED' : 'PARTIALLY_SETTLED',
                saleReturn.id,
                input.tenantId,
              ],
            );
          }

          await this.audit.recordInTransaction(manager, {
            tenantId: input.tenantId,
            actorUserId: input.userId,
            action:
              outcome.status === 'COMPLETED'
                ? 'SALE_RETURN_SETTLED'
                : 'SALE_RETURN_SETTLEMENT_FAILED',
            entityType: 'SALE_RETURN_SETTLEMENT',
            entityId: settlementId,
            correlationId: input.correlationId,
            deduplicate: true,
            after: {
              saleId: input.saleId,
              saleReturnId: saleReturn.id,
              mode: input.dto.mode,
              method,
              status: outcome.status,
              amount: this.money(amount),
              failureCode: outcome.failureCode,
            },
          });
          const created = await this.findById(
            manager,
            input.tenantId,
            settlementId,
          );
          if (!created) throw new Error('SALE_RETURN_SETTLEMENT_NOT_FOUND');
          return { settlement: this.toData(created), replay: false };
        },
      );
    } catch (error) {
      if (!this.isDuplicate(error)) throw error;
      const existing = await this.findByKey(
        this.dataSource.manager,
        input.tenantId,
        input.idempotencyKey,
      );
      if (!existing) throw error;
      return this.replay(existing, input);
    }
  }

  async list(
    manager: EntityManager,
    tenantId: string,
    returnId: string,
  ): Promise<SaleReturnSettlementData[]> {
    const rows = await manager.query<SettlementRow[]>(
      `${this.select()} WHERE settlement.tenant_id = ?
       AND settlement.sale_return_id = ?
       ORDER BY settlement.created_at, settlement.id`,
      [tenantId, returnId],
    );
    return rows.map((row) => this.toData(row));
  }

  private replay(
    existing: SettlementRow,
    input: {
      branchId: string;
      saleId: string;
      returnId: string;
      fingerprint: string;
    },
  ) {
    if (
      existing.source_branch_id !== input.branchId ||
      existing.source_sale_id !== input.saleId ||
      existing.sale_return_id !== input.returnId ||
      existing.request_fingerprint !== input.fingerprint
    ) {
      throw new PosIdempotencyConflictError();
    }
    return { settlement: this.toData(existing), replay: true as const };
  }

  private async findByKey(
    manager: EntityManager,
    tenantId: string,
    key: string,
  ): Promise<SettlementRow | null> {
    const [row] = await manager.query<SettlementRow[]>(
      `${this.select()} WHERE settlement.tenant_id = ?
       AND settlement.idempotency_key = ? LIMIT 1`,
      [tenantId, key],
    );
    return row ?? null;
  }

  private async findById(
    manager: EntityManager,
    tenantId: string,
    id: string,
  ): Promise<SettlementRow | null> {
    const [row] = await manager.query<SettlementRow[]>(
      `${this.select()} WHERE settlement.tenant_id = ?
       AND settlement.id = ? LIMIT 1`,
      [tenantId, id],
    );
    return row ?? null;
  }

  private select(): string {
    return `SELECT settlement.*, source_return.sale_id AS source_sale_id,
                   source_sale.branch_id AS source_branch_id,
                   payment.method AS original_payment_method,
                   processor.email AS processed_by_email
            FROM sale_return_settlements settlement
            INNER JOIN sale_returns source_return
              ON source_return.id = settlement.sale_return_id
             AND source_return.tenant_id = settlement.tenant_id
            INNER JOIN sales source_sale
              ON source_sale.id = source_return.sale_id
             AND source_sale.tenant_id = source_return.tenant_id
            INNER JOIN users processor
              ON processor.id = settlement.processed_by_user_id
             AND processor.tenant_id = settlement.tenant_id
            LEFT JOIN sale_payments payment
              ON payment.id = settlement.original_payment_id
             AND payment.tenant_id = settlement.tenant_id`;
  }

  private toData(row: SettlementRow): SaleReturnSettlementData {
    return {
      id: row.id,
      mode: row.mode,
      method: row.method,
      status: row.status,
      currency: row.currency,
      amount: this.decimal(row.amount),
      originalPayment:
        row.original_payment_id && row.original_payment_method
          ? { id: row.original_payment_id, method: row.original_payment_method }
          : null,
      provider: row.provider,
      providerReference: row.provider_reference,
      failureCode: row.failure_code,
      processedBy: {
        id: row.processed_by_user_id,
        email: row.processed_by_email,
      },
      createdAt: new Date(row.created_at).toISOString(),
    };
  }

  private toMoney(value: string): bigint {
    const [whole, fraction = ''] = String(value).split('.');
    return BigInt(whole) * 100n + BigInt(fraction.padEnd(2, '0').slice(0, 2));
  }

  private money(value: bigint): string {
    return `${value / 100n}.${String(value % 100n).padStart(2, '0')}`;
  }

  private decimal(value: string): string {
    const [whole, fraction = ''] = String(value).split('.');
    return `${whole}.${fraction.padEnd(2, '0').slice(0, 2)}`;
  }

  private isDuplicate(error: unknown): boolean {
    if (!(error instanceof QueryFailedError)) return false;
    const driver = error.driverError as { code?: string; errno?: number };
    return driver.code === 'ER_DUP_ENTRY' || driver.errno === 1062;
  }
}
