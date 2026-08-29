import { Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';
import type { PosProfitabilityReportDto } from './dto/pos-profitability-report.dto';

export interface BranchScope {
  id: string;
  name: string;
  timezone: string;
}

interface CurrencyTotalsRow {
  currency: string;
  sales_count: number | string;
  gross_revenue: string;
  discounts: string;
  sales_subtotal: string;
  sales_tax: string;
  sales_total: string;
  historical_cost: string;
  payment_obligations: string;
  credit_sales: string;
}

interface ReturnTotalsRow {
  currency: string;
  return_count: number | string;
  return_subtotal: string;
  return_tax: string;
  return_total: string;
  returned_cost: string;
  refunds_settled: string;
}

@Injectable()
export class PosProfitabilityReportRepository {
  constructor(private readonly dataSource: DataSource) {}

  async report(input: {
    tenantId: string;
    userId: string;
    administrator: boolean;
    query: PosProfitabilityReportDto;
  }) {
    const branches = await this.allowedBranches(input);
    if (branches.length === 0) return null;
    const salesFilter = this.filter('s.created_at', branches, input.query);
    const returnsFilter = this.filter('sr.created_at', branches, input.query);
    const offset = (input.query.page - 1) * input.query.pageSize;

    const [
      salesTotals,
      returnTotals,
      cancellations,
      products,
      activities,
      count,
    ] = await Promise.all([
      this.dataSource.query<CurrencyTotalsRow[]>(
        `SELECT s.currency, COUNT(*) AS sales_count,
                  COALESCE(SUM(s.gross_total), 0) AS gross_revenue,
                  COALESCE(SUM(s.discount_total), 0) AS discounts,
                  COALESCE(SUM(s.subtotal), 0) AS sales_subtotal,
                  COALESCE(SUM(s.tax_total), 0) AS sales_tax,
                  COALESCE(SUM(s.total), 0) AS sales_total,
                  COALESCE(SUM((SELECT SUM(ROUND(sl.quantity * sl.unit_cost, 2))
                    FROM sale_lines sl WHERE sl.tenant_id = s.tenant_id
                      AND sl.sale_id = s.id)), 0) AS historical_cost,
                  COALESCE(SUM((SELECT SUM(sp.amount_applied)
                    FROM sale_payments sp WHERE sp.tenant_id = s.tenant_id
                      AND sp.sale_id = s.id AND sp.status <> 'REVERSED')), 0)
                    AS payment_obligations,
                  COALESCE(SUM((SELECT SUM(sp.amount_applied)
                    FROM sale_payments sp WHERE sp.tenant_id = s.tenant_id
                      AND sp.sale_id = s.id AND sp.method = 'CREDIT'
                      AND sp.status <> 'REVERSED')), 0) AS credit_sales
           FROM sales s WHERE s.tenant_id = ? AND s.status = 'COMPLETED'
             AND ${salesFilter.sql}
           GROUP BY s.currency ORDER BY s.currency`,
        [input.tenantId, ...salesFilter.parameters],
      ),
      this.dataSource.query<ReturnTotalsRow[]>(
        `SELECT s.currency, COUNT(*) AS return_count,
                  COALESCE(SUM(sr.subtotal), 0) AS return_subtotal,
                  COALESCE(SUM(sr.tax_total), 0) AS return_tax,
                  COALESCE(SUM(sr.total), 0) AS return_total,
                  COALESCE(SUM((SELECT SUM(ROUND(srl.quantity * sl.unit_cost, 2))
                    FROM sale_return_lines srl INNER JOIN sale_lines sl
                      ON sl.id = srl.sale_line_id AND sl.tenant_id = srl.tenant_id
                    WHERE srl.tenant_id = sr.tenant_id
                      AND srl.sale_return_id = sr.id)), 0) AS returned_cost,
                  COALESCE(SUM((SELECT SUM(settlement.amount)
                    FROM sale_return_settlements settlement
                    WHERE settlement.tenant_id = sr.tenant_id
                      AND settlement.sale_return_id = sr.id
                      AND settlement.status = 'COMPLETED')), 0) AS refunds_settled
           FROM sale_returns sr INNER JOIN sales s
             ON s.id = sr.sale_id AND s.tenant_id = sr.tenant_id
           WHERE sr.tenant_id = ? AND ${returnsFilter.sql}
           GROUP BY s.currency ORDER BY s.currency`,
        [input.tenantId, ...returnsFilter.parameters],
      ),
      this.dataSource.query<
        Array<{ currency: string; count: number | string; amount: string }>
      >(
        `SELECT s.currency, COUNT(*) AS count, COALESCE(SUM(s.total), 0) AS amount
           FROM sales s WHERE s.tenant_id = ? AND s.status = 'VOIDED'
             AND ${salesFilter.sql}
           GROUP BY s.currency ORDER BY s.currency`,
        [input.tenantId, ...salesFilter.parameters],
      ),
      this.productBreakdown(input.tenantId, salesFilter, returnsFilter),
      this.activities(
        input.tenantId,
        salesFilter,
        returnsFilter,
        input.query.pageSize,
        offset,
      ),
      this.dataSource.query<Array<{ total: number | string }>>(
        `SELECT COUNT(*) AS total FROM (
             SELECT s.id FROM sales s WHERE s.tenant_id = ? AND ${salesFilter.sql}
             UNION ALL
             SELECT sr.id FROM sale_returns sr INNER JOIN sales s
               ON s.id = sr.sale_id AND s.tenant_id = sr.tenant_id
             WHERE sr.tenant_id = ? AND ${returnsFilter.sql}
           ) report_activities`,
        [
          input.tenantId,
          ...salesFilter.parameters,
          input.tenantId,
          ...returnsFilter.parameters,
        ],
      ),
    ]);

    const currencies = new Set([
      ...salesTotals.map(({ currency }) => currency),
      ...returnTotals.map(({ currency }) => currency),
      ...cancellations.map(({ currency }) => currency),
    ]);
    return {
      scope: branches,
      formulas: {
        grossRevenue: 'SUM(completed sale line gross total)',
        discounts: 'SUM(completed sale line discount total)',
        netRevenue: 'sales subtotal - return subtotal (tax excluded)',
        taxes: 'sales tax - return tax',
        cost: 'historical sale-line unit cost x quantity - returned quantity at the same historical cost',
        margin: 'net revenue - net historical cost',
        returnsAndRefunds:
          'returns reduce revenue once when registered; completed settlements are cash-flow information and are not deducted again',
        credit:
          'credit sales are revenue and payment obligations; later collections are not counted as new revenue',
        cancellations:
          'voided sales are excluded from revenue, cost and payment obligations',
      },
      currencies: [...currencies].sort().map((currency) => {
        const sale = salesTotals.find((row) => row.currency === currency);
        const returned = returnTotals.find((row) => row.currency === currency);
        const voided = cancellations.find((row) => row.currency === currency);
        const salesSubtotal = this.cents(sale?.sales_subtotal ?? '0');
        const returnSubtotal = this.cents(returned?.return_subtotal ?? '0');
        const salesTax = this.cents(sale?.sales_tax ?? '0');
        const returnTax = this.cents(returned?.return_tax ?? '0');
        const historicalCost = this.cents(sale?.historical_cost ?? '0');
        const returnedCost = this.cents(returned?.returned_cost ?? '0');
        const netRevenue = salesSubtotal - returnSubtotal;
        const netCost = historicalCost - returnedCost;
        const paymentObligations = this.cents(sale?.payment_obligations ?? '0');
        const salesTotal = this.cents(sale?.sales_total ?? '0');
        return {
          currency,
          sales: Number(sale?.sales_count ?? 0),
          returns: Number(returned?.return_count ?? 0),
          cancellations: Number(voided?.count ?? 0),
          grossRevenue: this.money(sale?.gross_revenue ?? '0'),
          discounts: this.money(sale?.discounts ?? '0'),
          salesTotal: this.fromCents(salesTotal),
          returnTotal: this.money(returned?.return_total ?? '0'),
          netTotal: this.fromCents(
            salesTotal - this.cents(returned?.return_total ?? '0'),
          ),
          netRevenue: this.fromCents(netRevenue),
          taxes: this.fromCents(salesTax - returnTax),
          historicalCost: this.fromCents(historicalCost),
          returnedCost: this.fromCents(returnedCost),
          netCost: this.fromCents(netCost),
          margin: this.fromCents(netRevenue - netCost),
          marginRate:
            netRevenue === 0n
              ? null
              : Number(((netRevenue - netCost) * 10_000n) / netRevenue) / 100,
          paymentObligations: this.fromCents(paymentObligations),
          creditSales: this.money(sale?.credit_sales ?? '0'),
          refundsSettled: this.money(returned?.refunds_settled ?? '0'),
          voidedAmount: this.money(voided?.amount ?? '0'),
          salesMatchPayments: salesTotal === paymentObligations,
        };
      }),
      products,
      activities,
      total: Number(count[0]?.total ?? 0),
    };
  }

  private async productBreakdown(
    tenantId: string,
    salesFilter: { sql: string; parameters: unknown[] },
    returnsFilter: { sql: string; parameters: unknown[] },
  ) {
    const rows = await this.dataSource.query<
      Array<{
        product_id: string;
        product_name: string;
        product_sku: string;
        currency: string;
        sold_quantity: string;
        returned_quantity: string;
        gross_revenue: string;
        discounts: string;
        net_revenue: string;
        taxes: string;
        net_cost: string;
      }>
    >(
      `SELECT product_id, MAX(product_name) AS product_name,
              MAX(product_sku) AS product_sku, currency,
              SUM(sold_quantity) AS sold_quantity,
              SUM(returned_quantity) AS returned_quantity,
              SUM(gross_revenue) AS gross_revenue,
              SUM(discounts) AS discounts, SUM(net_revenue) AS net_revenue,
              SUM(taxes) AS taxes, SUM(net_cost) AS net_cost
       FROM (
         SELECT sl.product_id, sl.product_name, sl.product_sku, s.currency,
                sl.quantity AS sold_quantity, 0 AS returned_quantity,
                sl.gross_total AS gross_revenue, sl.discount_total AS discounts,
                sl.subtotal AS net_revenue, sl.tax AS taxes,
                ROUND(sl.quantity * sl.unit_cost, 2) AS net_cost
         FROM sale_lines sl INNER JOIN sales s
           ON s.id = sl.sale_id AND s.tenant_id = sl.tenant_id
         WHERE s.tenant_id = ? AND s.status = 'COMPLETED' AND ${salesFilter.sql}
         UNION ALL
         SELECT srl.product_id, sl.product_name, sl.product_sku, s.currency,
                0, srl.quantity, 0, 0, -srl.subtotal, -srl.tax,
                -ROUND(srl.quantity * sl.unit_cost, 2)
         FROM sale_return_lines srl INNER JOIN sale_returns sr
           ON sr.id = srl.sale_return_id AND sr.tenant_id = srl.tenant_id
         INNER JOIN sale_lines sl
           ON sl.id = srl.sale_line_id AND sl.tenant_id = srl.tenant_id
         INNER JOIN sales s ON s.id = sr.sale_id AND s.tenant_id = sr.tenant_id
         WHERE sr.tenant_id = ? AND ${returnsFilter.sql}
       ) product_activity
       GROUP BY product_id, currency
       ORDER BY ABS(SUM(net_revenue) - SUM(net_cost)) DESC, product_name`,
      [
        tenantId,
        ...salesFilter.parameters,
        tenantId,
        ...returnsFilter.parameters,
      ],
    );
    return rows.map((row) => {
      const revenue = this.cents(row.net_revenue);
      const cost = this.cents(row.net_cost);
      return {
        product: {
          id: row.product_id,
          name: row.product_name,
          sku: row.product_sku,
        },
        currency: row.currency,
        soldQuantity: this.quantity(row.sold_quantity),
        returnedQuantity: this.quantity(row.returned_quantity),
        grossRevenue: this.money(row.gross_revenue),
        discounts: this.money(row.discounts),
        netRevenue: this.fromCents(revenue),
        taxes: this.money(row.taxes),
        netCost: this.fromCents(cost),
        margin: this.fromCents(revenue - cost),
      };
    });
  }

  private async activities(
    tenantId: string,
    salesFilter: { sql: string; parameters: unknown[] },
    returnsFilter: { sql: string; parameters: unknown[] },
    limit: number,
    offset: number,
  ) {
    const rows = await this.dataSource.query<
      Array<{
        id: string;
        type: 'SALE' | 'RETURN' | 'VOID';
        sale_id: string;
        receipt_number: string;
        branch_name: string;
        cash_register_name: string;
        currency: string;
        revenue: string;
        taxes: string;
        cost: string;
        payment_amount: string;
        activity_at: Date | string;
      }>
    >(
      `SELECT * FROM (
         SELECT s.id, IF(s.status = 'VOIDED', 'VOID', 'SALE') AS type,
                s.id AS sale_id, s.receipt_number, b.name AS branch_name,
                cr.name AS cash_register_name, s.currency,
                IF(s.status = 'COMPLETED', s.subtotal, 0) AS revenue,
                IF(s.status = 'COMPLETED', s.tax_total, 0) AS taxes,
                IF(s.status = 'COMPLETED', COALESCE((SELECT SUM(ROUND(sl.quantity * sl.unit_cost, 2))
                  FROM sale_lines sl WHERE sl.tenant_id = s.tenant_id
                    AND sl.sale_id = s.id), 0), 0) AS cost,
                IF(s.status = 'COMPLETED', COALESCE((SELECT SUM(sp.amount_applied)
                  FROM sale_payments sp WHERE sp.tenant_id = s.tenant_id
                    AND sp.sale_id = s.id AND sp.status <> 'REVERSED'), 0), 0)
                  AS payment_amount,
                s.created_at AS activity_at
         FROM sales s INNER JOIN branches b
           ON b.id = s.branch_id AND b.tenant_id = s.tenant_id
         INNER JOIN cash_registers cr
           ON cr.id = s.cash_register_id AND cr.tenant_id = s.tenant_id
         WHERE s.tenant_id = ? AND ${salesFilter.sql}
         UNION ALL
         SELECT sr.id, 'RETURN', s.id, s.receipt_number, b.name, cr.name,
                s.currency, -sr.subtotal, -sr.tax_total,
                -COALESCE((SELECT SUM(ROUND(srl.quantity * sl.unit_cost, 2))
                  FROM sale_return_lines srl INNER JOIN sale_lines sl
                    ON sl.id = srl.sale_line_id AND sl.tenant_id = srl.tenant_id
                  WHERE srl.tenant_id = sr.tenant_id
                    AND srl.sale_return_id = sr.id), 0),
                COALESCE((SELECT SUM(settlement.amount)
                  FROM sale_return_settlements settlement
                  WHERE settlement.tenant_id = sr.tenant_id
                    AND settlement.sale_return_id = sr.id
                    AND settlement.status = 'COMPLETED'), 0), sr.created_at
         FROM sale_returns sr INNER JOIN sales s
           ON s.id = sr.sale_id AND s.tenant_id = sr.tenant_id
         INNER JOIN branches b ON b.id = s.branch_id AND b.tenant_id = s.tenant_id
         INNER JOIN cash_registers cr
           ON cr.id = s.cash_register_id AND cr.tenant_id = s.tenant_id
         WHERE sr.tenant_id = ? AND ${returnsFilter.sql}
       ) activities ORDER BY activity_at DESC, id DESC LIMIT ? OFFSET ?`,
      [
        tenantId,
        ...salesFilter.parameters,
        tenantId,
        ...returnsFilter.parameters,
        limit,
        offset,
      ],
    );
    return rows.map((row) => {
      const revenue = this.cents(row.revenue);
      const cost = this.cents(row.cost);
      const payment = this.cents(row.payment_amount);
      return {
        id: row.id,
        type: row.type,
        saleId: row.sale_id,
        receiptNumber: row.receipt_number,
        branchName: row.branch_name,
        cashRegisterName: row.cash_register_name,
        currency: row.currency,
        netRevenue: this.fromCents(revenue),
        taxes: this.money(row.taxes),
        historicalCost: this.fromCents(cost),
        marginImpact: this.fromCents(revenue - cost),
        paymentOrSettlement: this.fromCents(payment),
        reconciles:
          row.type === 'SALE'
            ? revenue + this.cents(row.taxes) === payment
            : row.type === 'VOID' ||
              payment === -(revenue + this.cents(row.taxes)),
        occurredAt: new Date(row.activity_at).toISOString(),
      };
    });
  }

  private async allowedBranches(input: {
    tenantId: string;
    userId: string;
    administrator: boolean;
    query: PosProfitabilityReportDto;
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
           WHERE uba.tenant_id = b.tenant_id AND uba.branch_id = b.id
             AND uba.user_id = ?))
         ${branchFilter} ORDER BY b.name, b.id`,
      parameters,
    );
  }

  private filter(
    dateField: string,
    branches: BranchScope[],
    query: PosProfitabilityReportDto,
  ) {
    const parameters: unknown[] = [];
    const branchSql = branches
      .map((branch) => {
        const clauses = ['s.branch_id = ?'];
        parameters.push(branch.id);
        if (query.dateFrom) {
          clauses.push(`${dateField} >= ?`);
          parameters.push(
            this.localBoundary(query.dateFrom, branch.timezone, 0),
          );
        }
        if (query.dateTo) {
          clauses.push(`${dateField} < ?`);
          parameters.push(this.localBoundary(query.dateTo, branch.timezone, 1));
        }
        return `(${clauses.join(' AND ')})`;
      })
      .join(' OR ');
    const filters = [`(${branchSql})`];
    if (query.cashRegisterId) {
      filters.push('s.cash_register_id = ?');
      parameters.push(query.cashRegisterId);
    }
    if (query.userId) {
      filters.push('s.created_by_user_id = ?');
      parameters.push(query.userId);
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

  private cents(value: string): bigint {
    const normalized = String(value ?? '0');
    const negative = normalized.startsWith('-');
    const [whole, fraction = ''] = (
      negative ? normalized.slice(1) : normalized
    ).split('.');
    const result =
      BigInt(whole || '0') * 100n + BigInt(fraction.padEnd(2, '0').slice(0, 2));
    return negative ? -result : result;
  }

  private money(value: string): string {
    return this.fromCents(this.cents(value));
  }

  private fromCents(value: bigint): string {
    const sign = value < 0n ? '-' : '';
    const absolute = value < 0n ? -value : value;
    return `${sign}${absolute / 100n}.${String(absolute % 100n).padStart(2, '0')}`;
  }

  private quantity(value: string): string {
    const [whole, fraction = ''] = String(value ?? '0').split('.');
    return `${whole}.${fraction.padEnd(3, '0').slice(0, 3)}`;
  }
}
