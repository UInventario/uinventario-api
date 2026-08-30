import { Injectable } from '@nestjs/common';
import { createHash, randomUUID } from 'node:crypto';
import { DataSource, QueryFailedError } from 'typeorm';
import { DemandForecastIdempotencyConflictError } from './demand-forecast.errors';
import { forecastDemand } from './demand-forecast.model';
import type {
  DemandForecastProductInput,
  DemandForecastResult,
} from './demand-forecast.types';

interface BranchRow {
  id: string;
  name: string;
  timezone: string;
}
interface ActivityRow {
  product_id: string;
  product_name: string;
  product_sku: string;
  activity_at: string | null;
  quantity: string | null;
  available_quantity: string;
}
interface RunRow {
  result: string | DemandForecastResult;
  request_fingerprint: string;
}

@Injectable()
export class DemandForecastRepository {
  constructor(private readonly dataSource: DataSource) {}

  async latest(
    tenantId: string,
    userId: string,
    branchId: string,
    administrator: boolean,
  ) {
    const branch = await this.branch(tenantId, userId, branchId, administrator);
    if (!branch) return null;
    const [row] = await this.dataSource.query<
      Array<{ result: string | DemandForecastResult }>
    >(
      `SELECT result FROM demand_forecast_runs
       WHERE tenant_id = ? AND branch_id = ? ORDER BY generated_at DESC, id DESC LIMIT 1`,
      [tenantId, branchId],
    );
    return row ? this.parseResult(row.result) : undefined;
  }

  async generate(input: {
    tenantId: string;
    userId: string;
    branchId: string;
    administrator: boolean;
    horizonDays: number;
    idempotencyKey: string;
  }): Promise<{ result: DemandForecastResult; replay: boolean } | null> {
    const fingerprint = createHash('sha256')
      .update(
        JSON.stringify({
          branchId: input.branchId,
          horizonDays: input.horizonDays,
        }),
      )
      .digest('hex');
    const [existing] = await this.dataSource.query<RunRow[]>(
      `SELECT result, request_fingerprint FROM demand_forecast_runs
       WHERE tenant_id = ? AND idempotency_key = ? LIMIT 1`,
      [input.tenantId, input.idempotencyKey],
    );
    if (existing) {
      if (existing.request_fingerprint !== fingerprint) {
        throw new DemandForecastIdempotencyConflictError();
      }
      return { result: this.parseResult(existing.result), replay: true };
    }

    const branch = await this.branch(
      input.tenantId,
      input.userId,
      input.branchId,
      input.administrator,
    );
    if (!branch) return null;
    const asOfDate = this.localDate(new Date(), branch.timezone);
    const rows = await this.activity(
      input.tenantId,
      input.branchId,
      asOfDate,
      branch.timezone,
    );
    const products = this.products(rows, branch.timezone);
    const items = products.map((product) =>
      forecastDemand({ asOfDate, horizonDays: input.horizonDays, product }),
    );
    const generatedAt = new Date().toISOString();
    const result: DemandForecastResult = {
      id: randomUUID(),
      branch,
      status: items.some(({ status }) => status === 'SUFFICIENT')
        ? 'READY'
        : 'INSUFFICIENT',
      asOfDate,
      horizonDays: input.horizonDays,
      model: 'WEEKDAY_BASELINE_V1',
      assumptions: [
        'Demanda neta = unidades vendidas completadas menos devoluciones registradas.',
        'La estacionalidad se estima por día de semana con los últimos 56 días.',
        'El intervalo es aproximado y usa el error absoluto del backtest; no es una garantía.',
        'La sugerencia usa el límite superior menos stock disponible y nunca crea una compra.',
      ],
      generatedAt,
      items,
      summary: {
        sufficient: items.filter(({ status }) => status === 'SUFFICIENT')
          .length,
        insufficient: items.filter(({ status }) => status === 'INSUFFICIENT')
          .length,
        driftWarnings: items.filter(
          ({ quality }) => quality.drift.status === 'WARNING',
        ).length,
      },
    };
    try {
      await this.dataSource.query(
        `INSERT INTO demand_forecast_runs
          (id, tenant_id, branch_id, created_by_user_id, idempotency_key,
           request_fingerprint, horizon_days, as_of_date, status, result, generated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          result.id,
          input.tenantId,
          input.branchId,
          input.userId,
          input.idempotencyKey,
          fingerprint,
          input.horizonDays,
          asOfDate,
          result.status,
          JSON.stringify(result),
          generatedAt.slice(0, 23).replace('T', ' '),
        ],
      );
    } catch (error) {
      if (!(error instanceof QueryFailedError)) throw error;
      const [replayed] = await this.dataSource.query<RunRow[]>(
        `SELECT result, request_fingerprint FROM demand_forecast_runs
         WHERE tenant_id = ? AND idempotency_key = ? LIMIT 1`,
        [input.tenantId, input.idempotencyKey],
      );
      if (!replayed) throw error;
      if (replayed.request_fingerprint !== fingerprint) {
        throw new DemandForecastIdempotencyConflictError();
      }
      return { result: this.parseResult(replayed.result), replay: true };
    }
    return { result, replay: false };
  }

  private branch(
    tenantId: string,
    userId: string,
    branchId: string,
    administrator: boolean,
  ) {
    return this.dataSource
      .query<BranchRow[]>(
        `SELECT b.id, b.name, b.timezone FROM branches b
         WHERE b.id = ? AND b.tenant_id = ? AND b.active = TRUE
           AND (? = TRUE OR EXISTS (SELECT 1 FROM user_branch_access uba
             WHERE uba.tenant_id = b.tenant_id AND uba.branch_id = b.id AND uba.user_id = ?))
         LIMIT 1`,
        [branchId, tenantId, administrator, userId],
      )
      .then(([row]) => row ?? null);
  }

  private activity(
    tenantId: string,
    branchId: string,
    asOfDate: string,
    timezone: string,
  ) {
    const historyStart = this.localBoundary(asOfDate, timezone, -56);
    const historyEnd = this.localBoundary(asOfDate, timezone, 0);
    return this.dataSource.query<ActivityRow[]>(
      `SELECT p.id AS product_id, p.name AS product_name, p.sku AS product_sku,
              activity.activity_at, activity.quantity,
              COALESCE(stock.available_quantity, 0) AS available_quantity
       FROM products p
       LEFT JOIN (
         SELECT sl.product_id,
                DATE_FORMAT(s.created_at, '%Y-%m-%d %H:00:00') AS activity_at,
                SUM(sl.quantity) AS quantity
         FROM sale_lines sl INNER JOIN sales s
           ON s.id = sl.sale_id AND s.tenant_id = sl.tenant_id
         WHERE s.tenant_id = ? AND s.branch_id = ? AND s.status = 'COMPLETED'
           AND s.created_at >= ? AND s.created_at < ?
         GROUP BY sl.product_id, DATE_FORMAT(s.created_at, '%Y-%m-%d %H:00:00')
         UNION ALL
         SELECT srl.product_id, DATE_FORMAT(sr.created_at, '%Y-%m-%d %H:00:00'),
                -SUM(srl.quantity)
         FROM sale_return_lines srl INNER JOIN sale_returns sr
           ON sr.id = srl.sale_return_id AND sr.tenant_id = srl.tenant_id
         INNER JOIN sales s ON s.id = sr.sale_id AND s.tenant_id = sr.tenant_id
         WHERE sr.tenant_id = ? AND s.branch_id = ?
           AND sr.created_at >= ? AND sr.created_at < ?
         GROUP BY srl.product_id, DATE_FORMAT(sr.created_at, '%Y-%m-%d %H:00:00')
       ) activity ON activity.product_id = p.id
       LEFT JOIN (
         SELECT ib.product_id, SUM(ib.available_quantity) AS available_quantity
         FROM inventory_balances ib INNER JOIN locations l
           ON l.id = ib.location_id AND l.tenant_id = ib.tenant_id
         INNER JOIN warehouses w ON w.id = l.warehouse_id AND w.tenant_id = l.tenant_id
         WHERE ib.tenant_id = ? AND w.branch_id = ? GROUP BY ib.product_id
       ) stock ON stock.product_id = p.id
       WHERE p.tenant_id = ? AND p.active = TRUE
       ORDER BY p.name, p.id, activity.activity_at`,
      [
        tenantId,
        branchId,
        historyStart,
        historyEnd,
        tenantId,
        branchId,
        historyStart,
        historyEnd,
        tenantId,
        branchId,
        tenantId,
      ],
    );
  }

  private products(
    rows: ActivityRow[],
    timezone: string,
  ): DemandForecastProductInput[] {
    const products = new Map<string, DemandForecastProductInput>();
    const observations = new Map<string, Map<string, number>>();
    for (const row of rows) {
      const product = products.get(row.product_id) ?? {
        product: {
          id: row.product_id,
          name: row.product_name,
          sku: row.product_sku,
        },
        availableQuantity: Number(row.available_quantity),
        observations: [],
      };
      if (row.activity_at) {
        const productDays =
          observations.get(row.product_id) ?? new Map<string, number>();
        const date = this.localDate(
          new Date(`${row.activity_at.replace(' ', 'T')}Z`),
          timezone,
        );
        productDays.set(
          date,
          (productDays.get(date) ?? 0) + Number(row.quantity ?? 0),
        );
        observations.set(row.product_id, productDays);
      }
      products.set(row.product_id, product);
    }
    return [...products.values()].map((product) => ({
      ...product,
      observations: [...(observations.get(product.product.id) ?? [])].map(
        ([date, quantity]) => ({ date, quantity }),
      ),
    }));
  }

  private localDate(date: Date, timezone: string): string {
    return new Intl.DateTimeFormat('en-CA', {
      timeZone: timezone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(date);
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

  private parseResult(
    value: string | DemandForecastResult,
  ): DemandForecastResult {
    return typeof value === 'string'
      ? (JSON.parse(value) as DemandForecastResult)
      : value;
  }
}
