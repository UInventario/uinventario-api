import { Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';
import type { SalesCashReportDto } from './dto/sales-cash-report.dto';
import type { PaymentMethod } from './dto/create-sale.dto';

export interface BranchScope {
  id: string;
  name: string;
  timezone: string;
}

@Injectable()
export class SalesCashReportRepository {
  constructor(private readonly dataSource: DataSource) {}

  async report(input: {
    tenantId: string;
    userId: string;
    administrator: boolean;
    query: SalesCashReportDto;
  }) {
    const branches = await this.allowedBranches(input);
    if (branches.length === 0) return null;
    const salesFilter = this.filter('s', 'created_at', branches, input.query);
    const shiftFilter = this.filter(
      'crs',
      'opened_at',
      branches,
      input.query,
      true,
    );
    const offset = (input.query.page - 1) * input.query.pageSize;
    const [sales, totals, paymentTotals, shifts, cashTotals, registers, users] =
      await Promise.all([
        this.dataSource.query<
          Array<{
            id: string;
            receipt_number: string;
            status: 'COMPLETED' | 'VOIDED';
            branch_id: string;
            branch_name: string;
            cash_register_id: string;
            cash_register_name: string;
            cash_register_code: string;
            user_id: string;
            user_email: string;
            currency: string;
            total: string;
            created_at: Date | string;
            voided_at: Date | string | null;
          }>
        >(
          `SELECT s.id, s.receipt_number, s.status, s.currency, s.total,
                s.created_at, s.voided_at, b.id AS branch_id, b.name AS branch_name,
                cr.id AS cash_register_id, cr.name AS cash_register_name,
                cr.code AS cash_register_code, u.id AS user_id, u.email AS user_email
         FROM sales s
         INNER JOIN branches b ON b.id = s.branch_id AND b.tenant_id = s.tenant_id
         INNER JOIN cash_registers cr ON cr.id = s.cash_register_id AND cr.tenant_id = s.tenant_id
         INNER JOIN users u ON u.id = s.created_by_user_id AND u.tenant_id = s.tenant_id
         WHERE s.tenant_id = ? AND ${salesFilter.sql}
         ORDER BY s.created_at DESC, s.id DESC LIMIT ? OFFSET ?`,
          [
            input.tenantId,
            ...salesFilter.parameters,
            input.query.pageSize,
            offset,
          ],
        ),
        this.dataSource.query<
          Array<{
            total_count: number | string;
            completed_count: number | string;
            voided_count: number | string;
            net_sales: string;
            voided_sales: string;
          }>
        >(
          `SELECT COUNT(*) AS total_count,
                SUM(s.status = 'COMPLETED') AS completed_count,
                SUM(s.status = 'VOIDED') AS voided_count,
                COALESCE(SUM(CASE WHEN s.status = 'COMPLETED' THEN s.total ELSE 0 END), 0) AS net_sales,
                COALESCE(SUM(CASE WHEN s.status = 'VOIDED' THEN s.total ELSE 0 END), 0) AS voided_sales
         FROM sales s WHERE s.tenant_id = ? AND ${salesFilter.sql}`,
          [input.tenantId, ...salesFilter.parameters],
        ),
        this.dataSource.query<
          Array<{
            method: PaymentMethod;
            status: 'COMPLETED' | 'REVERSED';
            amount: string;
            count: number | string;
          }>
        >(
          `SELECT sp.method, sp.status, SUM(sp.amount_applied) AS amount, COUNT(*) AS count
         FROM sales s
         INNER JOIN sale_payments sp ON sp.sale_id = s.id AND sp.tenant_id = s.tenant_id
         WHERE s.tenant_id = ? AND ${salesFilter.sql}
         GROUP BY sp.method, sp.status ORDER BY sp.method, sp.status`,
          [input.tenantId, ...salesFilter.parameters],
        ),
        this.dataSource.query<
          Array<{
            id: string;
            status: 'OPEN' | 'CLOSED';
            branch_id: string;
            branch_name: string;
            cash_register_id: string;
            cash_register_name: string;
            cash_register_code: string;
            opened_by_email: string;
            currency: string;
            opening_amount: string;
            expected_cash: string;
            counted_cash: string | null;
            difference_amount: string | null;
            opened_at: Date | string;
            closed_at: Date | string | null;
          }>
        >(
          `SELECT crs.id, crs.status, crs.currency, crs.opening_amount,
                COALESCE(crs.expected_cash_at_close,
                  crs.opening_amount +
                  COALESCE((SELECT SUM(sp.amount_applied) FROM sales s2
                    INNER JOIN sale_payments sp ON sp.sale_id = s2.id AND sp.tenant_id = s2.tenant_id
                      AND sp.method = 'CASH'
                    WHERE s2.tenant_id = crs.tenant_id AND s2.cash_register_shift_id = crs.id
                      AND s2.status = 'COMPLETED'), 0) -
                  COALESCE((SELECT SUM(settlement.amount)
                    FROM sale_return_settlements settlement
                    WHERE settlement.tenant_id = crs.tenant_id
                      AND settlement.cash_register_shift_id = crs.id
                      AND settlement.method = 'CASH'
                      AND settlement.status = 'COMPLETED'), 0) +
                  COALESCE((SELECT SUM(CASE WHEN cm.type = 'INCOME' THEN cm.amount
                    WHEN cm.type = 'WITHDRAWAL' THEN -cm.amount
                    WHEN original.type = 'INCOME' THEN -cm.amount ELSE cm.amount END)
                    FROM cash_register_movements cm LEFT JOIN cash_register_movements original
                      ON original.id = cm.reversal_of_id AND original.tenant_id = cm.tenant_id
                    WHERE cm.tenant_id = crs.tenant_id AND cm.cash_register_shift_id = crs.id), 0)
                ) AS expected_cash,
                crs.closing_counted_amount AS counted_cash,
                crs.difference_at_close AS difference_amount,
                crs.opened_at, crs.closed_at, b.id AS branch_id, b.name AS branch_name,
                cr.id AS cash_register_id, cr.name AS cash_register_name,
                cr.code AS cash_register_code, u.email AS opened_by_email
         FROM cash_register_shifts crs
         INNER JOIN branches b ON b.id = crs.branch_id AND b.tenant_id = crs.tenant_id
         INNER JOIN cash_registers cr ON cr.id = crs.cash_register_id AND cr.tenant_id = crs.tenant_id
         INNER JOIN users u ON u.id = crs.opened_by_user_id AND u.tenant_id = crs.tenant_id
         WHERE crs.tenant_id = ? AND ${shiftFilter.sql}
         ORDER BY crs.opened_at DESC, crs.id DESC LIMIT 100`,
          [input.tenantId, ...shiftFilter.parameters],
        ),
        this.dataSource.query<
          Array<{
            shift_count: number | string;
            open_count: number | string;
            closed_count: number | string;
            expected_cash: string;
            counted_cash: string;
            difference_amount: string;
          }>
        >(
          `SELECT COUNT(*) AS shift_count, SUM(report.status = 'OPEN') AS open_count,
                SUM(report.status = 'CLOSED') AS closed_count,
                COALESCE(SUM(report.expected_cash), 0) AS expected_cash,
                COALESCE(SUM(report.counted_cash), 0) AS counted_cash,
                COALESCE(SUM(report.difference_amount), 0) AS difference_amount
         FROM (SELECT crs.status, crs.closing_counted_amount AS counted_cash,
                      crs.difference_at_close AS difference_amount,
                      COALESCE(crs.expected_cash_at_close, crs.opening_amount +
                        COALESCE((SELECT SUM(sp.amount_applied) FROM sales s2
                          INNER JOIN sale_payments sp ON sp.sale_id = s2.id AND sp.tenant_id = s2.tenant_id
                            AND sp.method = 'CASH'
                          WHERE s2.tenant_id = crs.tenant_id AND s2.cash_register_shift_id = crs.id
                            AND s2.status = 'COMPLETED'), 0) -
                        COALESCE((SELECT SUM(settlement.amount)
                          FROM sale_return_settlements settlement
                          WHERE settlement.tenant_id = crs.tenant_id
                            AND settlement.cash_register_shift_id = crs.id
                            AND settlement.method = 'CASH'
                            AND settlement.status = 'COMPLETED'), 0) +
                        COALESCE((SELECT SUM(CASE WHEN cm.type = 'INCOME' THEN cm.amount
                          WHEN cm.type = 'WITHDRAWAL' THEN -cm.amount
                          WHEN original.type = 'INCOME' THEN -cm.amount ELSE cm.amount END)
                          FROM cash_register_movements cm LEFT JOIN cash_register_movements original
                            ON original.id = cm.reversal_of_id AND original.tenant_id = cm.tenant_id
                          WHERE cm.tenant_id = crs.tenant_id
                            AND cm.cash_register_shift_id = crs.id), 0)) AS expected_cash
               FROM cash_register_shifts crs
               WHERE crs.tenant_id = ? AND ${shiftFilter.sql}) report`,
          [input.tenantId, ...shiftFilter.parameters],
        ),
        this.options(
          'cash_registers',
          'id, name, code, branch_id',
          input.tenantId,
          branches,
        ),
        this.dataSource.query<Array<{ id: string; email: string }>>(
          `SELECT DISTINCT u.id, u.email FROM users u
         WHERE u.tenant_id = ? AND (EXISTS (SELECT 1 FROM sales s
           WHERE s.tenant_id = u.tenant_id AND s.created_by_user_id = u.id
             AND s.branch_id IN (${branches.map(() => '?').join(',')}))
           OR EXISTS (SELECT 1 FROM cash_register_shifts crs
             WHERE crs.tenant_id = u.tenant_id AND crs.opened_by_user_id = u.id
               AND crs.branch_id IN (${branches.map(() => '?').join(',')})))
         ORDER BY u.email`,
          [
            input.tenantId,
            ...branches.map(({ id }) => id),
            ...branches.map(({ id }) => id),
          ],
        ),
      ]);
    const saleIds = sales.map(({ id }) => id);
    const payments = saleIds.length
      ? await this.dataSource.query<
          Array<{
            sale_id: string;
            method: PaymentMethod;
            status: 'COMPLETED' | 'REVERSED';
            amount_applied: string;
            change_amount: string;
            external_reference: string | null;
          }>
        >(
          `SELECT sale_id, method, status, amount_applied, change_amount, external_reference
           FROM sale_payments WHERE tenant_id = ? AND sale_id IN (${saleIds.map(() => '?').join(',')})
           ORDER BY created_at, id`,
          [input.tenantId, ...saleIds],
        )
      : [];
    const total = totals[0];
    const cash = cashTotals[0];
    const paymentApplied = paymentTotals
      .filter(({ status }) => status === 'COMPLETED')
      .reduce((sum, payment) => sum + this.cents(payment.amount), 0n);
    return {
      scope: branches,
      options: { branches, registers, users },
      summary: {
        sales: {
          total: Number(total.total_count),
          completed: Number(total.completed_count),
          voided: Number(total.voided_count),
          net: this.money(total.net_sales),
          voidedAmount: this.money(total.voided_sales),
        },
        payments: paymentTotals.map((payment) => ({
          method: payment.method,
          status: payment.status,
          count: Number(payment.count),
          amount: this.money(payment.amount),
        })),
        cash: {
          shifts: Number(cash.shift_count),
          open: Number(cash.open_count),
          closed: Number(cash.closed_count),
          expected: this.money(cash.expected_cash),
          counted: this.money(cash.counted_cash),
          difference: this.money(cash.difference_amount),
        },
        reconciliation: {
          salesNet: this.money(total.net_sales),
          paymentsApplied: this.fromCents(paymentApplied),
          matches: this.cents(total.net_sales) === paymentApplied,
        },
      },
      sales: sales.map((sale) => ({
        id: sale.id,
        receiptNumber: sale.receipt_number,
        status: sale.status,
        branch: { id: sale.branch_id, name: sale.branch_name },
        cashRegister: {
          id: sale.cash_register_id,
          name: sale.cash_register_name,
          code: sale.cash_register_code,
        },
        user: { id: sale.user_id, email: sale.user_email },
        currency: sale.currency,
        total: this.money(sale.total),
        payments: payments
          .filter(({ sale_id }) => sale_id === sale.id)
          .map((payment) => ({
            method: payment.method,
            status: payment.status,
            amount: this.money(payment.amount_applied),
            change: this.money(payment.change_amount),
            reference: payment.external_reference,
          })),
        createdAt: new Date(sale.created_at).toISOString(),
        voidedAt: sale.voided_at
          ? new Date(sale.voided_at).toISOString()
          : null,
      })),
      shifts: shifts.map((shift) => ({
        id: shift.id,
        status: shift.status,
        branch: { id: shift.branch_id, name: shift.branch_name },
        cashRegister: {
          id: shift.cash_register_id,
          name: shift.cash_register_name,
          code: shift.cash_register_code,
        },
        openedByEmail: shift.opened_by_email,
        currency: shift.currency,
        opening: this.money(shift.opening_amount),
        expected: this.money(shift.expected_cash),
        counted:
          shift.counted_cash === null ? null : this.money(shift.counted_cash),
        difference:
          shift.difference_amount === null
            ? null
            : this.money(shift.difference_amount),
        openedAt: new Date(shift.opened_at).toISOString(),
        closedAt: shift.closed_at
          ? new Date(shift.closed_at).toISOString()
          : null,
      })),
      total: Number(total.total_count),
    };
  }

  private async allowedBranches(input: {
    tenantId: string;
    userId: string;
    administrator: boolean;
    query: SalesCashReportDto;
  }): Promise<BranchScope[]> {
    const parameters: unknown[] = [
      input.tenantId,
      input.administrator,
      input.userId,
    ];
    let branchFilter = '';
    if (input.query.branchId) {
      branchFilter = 'AND b.id = ?';
      parameters.push(input.query.branchId);
    }
    return this.dataSource.query<BranchScope[]>(
      `SELECT b.id, b.name, b.timezone FROM branches b
       WHERE b.tenant_id = ? AND b.active = TRUE
         AND (? = TRUE OR EXISTS (SELECT 1 FROM user_branch_access uba
           WHERE uba.tenant_id = b.tenant_id AND uba.branch_id = b.id AND uba.user_id = ?))
         ${branchFilter} ORDER BY b.name, b.id`,
      parameters,
    );
  }

  private filter(
    alias: string,
    dateField: string,
    branches: BranchScope[],
    query: SalesCashReportDto,
    shift = false,
  ) {
    const parameters: unknown[] = [];
    const branchSql = branches
      .map((branch) => {
        const clauses = [`${alias}.branch_id = ?`];
        parameters.push(branch.id);
        if (query.dateFrom) {
          clauses.push(`${alias}.${dateField} >= ?`);
          parameters.push(
            this.localBoundary(query.dateFrom, branch.timezone, 0),
          );
        }
        if (query.dateTo) {
          clauses.push(`${alias}.${dateField} < ?`);
          parameters.push(this.localBoundary(query.dateTo, branch.timezone, 1));
        }
        return `(${clauses.join(' AND ')})`;
      })
      .join(' OR ');
    const filters = [`(${branchSql})`];
    if (query.cashRegisterId) {
      filters.push(`${alias}.cash_register_id = ?`);
      parameters.push(query.cashRegisterId);
    }
    if (query.userId) {
      filters.push(
        `${alias}.${shift ? 'opened_by_user_id' : 'created_by_user_id'} = ?`,
      );
      parameters.push(query.userId);
    }
    if (!shift && query.status !== 'ALL') {
      filters.push(`${alias}.status = ?`);
      parameters.push(query.status);
    }
    return { sql: filters.join(' AND '), parameters };
  }

  private localBoundary(
    date: string,
    timezone: string,
    addDays: number,
  ): string {
    const [year, month, day] = date.split('-').map(Number);
    const target = Date.UTC(year, month - 1, day + addDays);
    let instant = target;
    const formatter = new Intl.DateTimeFormat('en-CA', {
      timeZone: timezone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hourCycle: 'h23',
    });
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const parts = Object.fromEntries(
        formatter
          .formatToParts(new Date(instant))
          .map((part) => [part.type, part.value]),
      );
      const represented = Date.UTC(
        Number(parts.year),
        Number(parts.month) - 1,
        Number(parts.day),
        Number(parts.hour),
        Number(parts.minute),
        Number(parts.second),
      );
      instant += target - represented;
    }
    return new Date(instant).toISOString().slice(0, 23).replace('T', ' ');
  }

  private async options(
    table: string,
    columns: string,
    tenantId: string,
    branches: BranchScope[],
  ) {
    return this.dataSource.query<
      Array<{ id: string; name: string; code: string; branch_id: string }>
    >(
      `SELECT ${columns} FROM ${table} WHERE tenant_id = ?
       AND branch_id IN (${branches.map(() => '?').join(',')}) ORDER BY name, id`,
      [tenantId, ...branches.map(({ id }) => id)],
    );
  }

  private money(value: string): string {
    const [whole, fraction = ''] = String(value).split('.');
    return `${whole}.${fraction.padEnd(2, '0').slice(0, 2)}`;
  }

  private cents(value: string): bigint {
    const [whole, fraction = ''] = this.money(value).split('.');
    return BigInt(whole) * 100n + BigInt(fraction);
  }

  private fromCents(value: bigint): string {
    const sign = value < 0n ? '-' : '';
    const absolute = value < 0n ? -value : value;
    return `${sign}${absolute / 100n}.${String(absolute % 100n).padStart(2, '0')}`;
  }
}
