import { Injectable } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { DataSource, EntityManager } from 'typeorm';
import {
  CashRegisterAlreadyClosedError,
  CashRegisterClosureIdempotencyConflictError,
  CashRegisterClosureNotFoundError,
  CashRegisterClosureReasonRequiredError,
} from './cash-register-closure.errors';
import type { CashRegisterClosureData } from './cash-register-closure.types';

interface ClosureContext {
  tenantId: string;
  branchId: string;
  cashRegisterId: string;
  userId: string;
}

interface ClosureRow {
  id: string;
  status: 'CLOSED';
  branch_id: string;
  branch_name: string;
  cash_register_id: string;
  cash_register_name: string;
  cash_register_code: string;
  opened_by_id: string;
  opened_by_email: string;
  closed_by_id: string;
  closed_by_email: string;
  currency: string;
  opening_amount: string;
  closing_counted_amount: string;
  expected_cash_at_close: string;
  difference_at_close: string;
  closing_reason: string | null;
  closing_denominations:
    string | Array<{ denomination: string; quantity: number }> | null;
  opening_idempotency_key: string;
  closing_idempotency_key: string;
  closing_request_fingerprint: string;
  opened_at: Date | string;
  closed_at: Date | string;
  sales_count: number | string;
  cash_sales: string;
  movements_count: number | string;
  movements_net: string;
}

@Injectable()
export class CashRegisterClosureRepository {
  constructor(private readonly dataSource: DataSource) {}

  async close(
    input: ClosureContext & {
      countedAmount: string;
      differenceReason: string | null;
      denominations: Array<{ denomination: string; quantity: number }>;
      idempotencyKey: string;
    },
  ): Promise<{ closure: CashRegisterClosureData; replay: boolean }> {
    return this.dataSource.transaction('READ COMMITTED', async (manager) => {
      const rows = await manager.query<
        Array<{
          id: string;
          status: 'OPEN' | 'CLOSED';
          closing_idempotency_key: string | null;
          closing_request_fingerprint: string | null;
        }>
      >(
        `SELECT id, status, closing_idempotency_key, closing_request_fingerprint
         FROM cash_register_shifts
         WHERE tenant_id = ? AND branch_id = ? AND cash_register_id = ?
           AND opened_by_user_id = ?
           AND (status = 'OPEN' OR closing_idempotency_key = ?)
         ORDER BY (closing_idempotency_key = ?) DESC, (status = 'OPEN') DESC, opened_at DESC
         LIMIT 1 FOR UPDATE`,
        [
          input.tenantId,
          input.branchId,
          input.cashRegisterId,
          input.userId,
          input.idempotencyKey,
          input.idempotencyKey,
        ],
      );
      const shift = rows[0];
      if (!shift) {
        const closed = await manager.query<Array<{ id: string }>>(
          `SELECT id FROM cash_register_shifts
           WHERE tenant_id = ? AND branch_id = ? AND cash_register_id = ?
             AND opened_by_user_id = ? AND status = 'CLOSED'
           ORDER BY closed_at DESC LIMIT 1`,
          [input.tenantId, input.branchId, input.cashRegisterId, input.userId],
        );
        if (closed[0]) throw new CashRegisterAlreadyClosedError();
        throw new CashRegisterClosureNotFoundError();
      }
      const fingerprint = this.fingerprint(input, shift.id);
      if (shift.status === 'CLOSED') {
        if (shift.closing_request_fingerprint !== fingerprint)
          throw new CashRegisterClosureIdempotencyConflictError();
        const replay = await this.findById(manager, input.tenantId, shift.id);
        if (!replay) throw new CashRegisterClosureNotFoundError();
        return { closure: replay, replay: true };
      }
      const summary = await this.summary(manager, input.tenantId, shift.id);
      const expectedCents =
        this.cents(summary.openingAmount) +
        this.cents(summary.cashSales) +
        this.cents(summary.movementsNet);
      const countedCents = this.cents(input.countedAmount);
      const differenceCents = countedCents - expectedCents;
      if (differenceCents !== 0n && !input.differenceReason) {
        throw new CashRegisterClosureReasonRequiredError();
      }
      await manager.query(
        `UPDATE cash_register_shifts SET
           status = 'CLOSED', closed_by_user_id = ?, closing_counted_amount = ?,
           expected_cash_at_close = ?, difference_at_close = ?, closing_reason = ?,
           closing_denominations = ?, closing_idempotency_key = ?,
           closing_request_fingerprint = ?, closed_at = CURRENT_TIMESTAMP(6)
         WHERE id = ? AND tenant_id = ? AND status = 'OPEN'`,
        [
          input.userId,
          this.money(input.countedAmount),
          this.fromCents(expectedCents),
          this.fromSignedCents(differenceCents),
          input.differenceReason,
          JSON.stringify(input.denominations),
          input.idempotencyKey,
          fingerprint,
          shift.id,
          input.tenantId,
        ],
      );
      const closure = await this.findById(manager, input.tenantId, shift.id);
      if (!closure) throw new CashRegisterClosureNotFoundError();
      return { closure, replay: false };
    });
  }

  async latest(
    context: ClosureContext,
  ): Promise<CashRegisterClosureData | null> {
    const [row] = await this.dataSource.query<ClosureRow[]>(
      `${this.selectClosure()}
       WHERE crs.tenant_id = ? AND crs.branch_id = ? AND crs.cash_register_id = ?
         AND crs.status = 'CLOSED'
       ORDER BY crs.closed_at DESC LIMIT 1`,
      [context.tenantId, context.branchId, context.cashRegisterId],
    );
    return row ? this.toData(row) : null;
  }

  private async summary(
    manager: EntityManager,
    tenantId: string,
    shiftId: string,
  ) {
    const [row] = await manager.query<
      Array<{
        opening_amount: string;
        sales_count: number | string;
        cash_sales: string;
        movements_count: number | string;
        movements_net: string;
      }>
    >(
      `SELECT crs.opening_amount,
         (SELECT COUNT(*) FROM sales s
           WHERE s.tenant_id = crs.tenant_id AND s.cash_register_shift_id = crs.id
             AND s.status = 'COMPLETED') AS sales_count,
         COALESCE((SELECT SUM(sp.amount_applied) FROM sales s
           INNER JOIN sale_payments sp ON sp.sale_id = s.id AND sp.tenant_id = s.tenant_id
           WHERE s.tenant_id = crs.tenant_id AND s.cash_register_shift_id = crs.id
             AND s.status = 'COMPLETED'), 0) AS cash_sales,
         (SELECT COUNT(*) FROM cash_register_movements cm
           WHERE cm.tenant_id = crs.tenant_id
             AND cm.cash_register_shift_id = crs.id) AS movements_count,
         COALESCE((SELECT SUM(CASE
           WHEN cm.type = 'INCOME' THEN cm.amount
           WHEN cm.type = 'WITHDRAWAL' THEN -cm.amount
           WHEN original.type = 'INCOME' THEN -cm.amount
           ELSE cm.amount END)
           FROM cash_register_movements cm
           LEFT JOIN cash_register_movements original
             ON original.id = cm.reversal_of_id AND original.tenant_id = cm.tenant_id
           WHERE cm.tenant_id = crs.tenant_id
             AND cm.cash_register_shift_id = crs.id), 0) AS movements_net
       FROM cash_register_shifts crs
       WHERE crs.tenant_id = ? AND crs.id = ? LIMIT 1`,
      [tenantId, shiftId],
    );
    if (!row) throw new CashRegisterClosureNotFoundError();
    return {
      openingAmount: this.money(row.opening_amount),
      salesCount: Number(row.sales_count),
      cashSales: this.money(row.cash_sales),
      movementsCount: Number(row.movements_count),
      movementsNet: this.money(row.movements_net),
    };
  }

  private async findById(manager: EntityManager, tenantId: string, id: string) {
    const [row] = await manager.query<ClosureRow[]>(
      `${this.selectClosure()} WHERE crs.tenant_id = ? AND crs.id = ? LIMIT 1`,
      [tenantId, id],
    );
    return row ? this.toData(row) : null;
  }

  private selectClosure(): string {
    return `SELECT crs.id, crs.status, crs.currency, crs.opening_amount,
                   crs.closing_counted_amount, crs.expected_cash_at_close,
                   crs.difference_at_close, crs.closing_reason,
                   crs.closing_denominations, crs.opening_idempotency_key,
                   crs.closing_idempotency_key, crs.closing_request_fingerprint,
                   crs.opened_at, crs.closed_at,
                   b.id AS branch_id, b.name AS branch_name,
                   cr.id AS cash_register_id, cr.name AS cash_register_name,
                   cr.code AS cash_register_code,
                   opener.id AS opened_by_id, opener.email AS opened_by_email,
                   closer.id AS closed_by_id, closer.email AS closed_by_email,
                   (SELECT COUNT(*) FROM sales s WHERE s.tenant_id = crs.tenant_id
                     AND s.cash_register_shift_id = crs.id AND s.status = 'COMPLETED') AS sales_count,
                   COALESCE((SELECT SUM(sp.amount_applied) FROM sales s
                     INNER JOIN sale_payments sp
                       ON sp.sale_id = s.id AND sp.tenant_id = s.tenant_id
                     WHERE s.tenant_id = crs.tenant_id
                       AND s.cash_register_shift_id = crs.id AND s.status = 'COMPLETED'), 0)
                     AS cash_sales,
                   (SELECT COUNT(*) FROM cash_register_movements cm
                     WHERE cm.tenant_id = crs.tenant_id
                       AND cm.cash_register_shift_id = crs.id) AS movements_count,
                   COALESCE((SELECT SUM(CASE
                     WHEN cm.type = 'INCOME' THEN cm.amount
                     WHEN cm.type = 'WITHDRAWAL' THEN -cm.amount
                     WHEN original.type = 'INCOME' THEN -cm.amount
                     ELSE cm.amount END)
                     FROM cash_register_movements cm
                     LEFT JOIN cash_register_movements original
                       ON original.id = cm.reversal_of_id AND original.tenant_id = cm.tenant_id
                     WHERE cm.tenant_id = crs.tenant_id
                       AND cm.cash_register_shift_id = crs.id), 0) AS movements_net
            FROM cash_register_shifts crs
            INNER JOIN branches b ON b.id = crs.branch_id AND b.tenant_id = crs.tenant_id
            INNER JOIN cash_registers cr ON cr.id = crs.cash_register_id
              AND cr.tenant_id = crs.tenant_id
            INNER JOIN users opener ON opener.id = crs.opened_by_user_id
              AND opener.tenant_id = crs.tenant_id
            INNER JOIN users closer ON closer.id = crs.closed_by_user_id
              AND closer.tenant_id = crs.tenant_id`;
  }

  private toData(row: ClosureRow): CashRegisterClosureData {
    const denominations =
      typeof row.closing_denominations === 'string'
        ? (JSON.parse(row.closing_denominations) as Array<{
            denomination: string;
            quantity: number;
          }>)
        : (row.closing_denominations ?? []);
    return {
      id: row.id,
      status: 'CLOSED',
      branch: { id: row.branch_id, name: row.branch_name },
      cashRegister: {
        id: row.cash_register_id,
        name: row.cash_register_name,
        code: row.cash_register_code,
      },
      openedBy: { id: row.opened_by_id, email: row.opened_by_email },
      closedBy: { id: row.closed_by_id, email: row.closed_by_email },
      currency: row.currency,
      openingAmount: this.money(row.opening_amount),
      salesCount: Number(row.sales_count),
      cashSales: this.money(row.cash_sales),
      movementsCount: Number(row.movements_count),
      movementsNet: this.money(row.movements_net),
      expectedCash: this.money(row.expected_cash_at_close),
      countedCash: this.money(row.closing_counted_amount),
      difference: this.money(row.difference_at_close),
      differenceReason: row.closing_reason,
      denominations,
      openedAt: new Date(row.opened_at).toISOString(),
      closedAt: new Date(row.closed_at).toISOString(),
    };
  }

  private fingerprint(
    input: {
      countedAmount: string;
      differenceReason: string | null;
      denominations: Array<{ denomination: string; quantity: number }>;
    },
    shiftId: string,
  ): string {
    return createHash('sha256')
      .update(
        JSON.stringify({
          shiftId,
          countedAmount: this.money(input.countedAmount),
          differenceReason: input.differenceReason,
          denominations: [...input.denominations]
            .map(({ denomination, quantity }) => ({
              denomination: this.money(denomination),
              quantity,
            }))
            .sort((left, right) =>
              left.denomination.localeCompare(right.denomination),
            ),
        }),
      )
      .digest('hex');
  }

  private cents(value: string): bigint {
    const negative = value.startsWith('-');
    const normalized = negative ? value.slice(1) : value;
    const [whole, fraction = ''] = normalized.split('.');
    const cents = BigInt(whole) * 100n + BigInt(fraction.padEnd(2, '0'));
    return negative ? -cents : cents;
  }

  private money(value: string): string {
    return this.fromSignedCents(this.cents(value));
  }

  private fromCents(value: bigint): string {
    return `${value / 100n}.${String(value % 100n).padStart(2, '0')}`;
  }

  private fromSignedCents(value: bigint): string {
    return value < 0n ? `-${this.fromCents(-value)}` : this.fromCents(value);
  }
}
