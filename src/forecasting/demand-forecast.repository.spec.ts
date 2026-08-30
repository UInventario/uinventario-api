import type { DataSource } from 'typeorm';
import { createHash } from 'node:crypto';
import { DemandForecastRepository } from './demand-forecast.repository';

describe('DemandForecastRepository', () => {
  it('scopes source data, stock and persisted run by tenant and replays safely', async () => {
    const query = jest
      .fn()
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([
        { id: 'branch-1', name: 'Centro', timezone: 'America/Mexico_City' },
      ])
      .mockResolvedValueOnce([
        {
          product_id: 'product-1',
          product_name: 'Producto',
          product_sku: 'SKU-1',
          activity_at: '2026-08-28 08:00:00',
          quantity: '2.000',
          available_quantity: '4.000',
        },
        {
          product_id: 'product-1',
          product_name: 'Producto',
          product_sku: 'SKU-1',
          activity_at: '2026-08-28 08:00:00',
          quantity: '-0.500',
          available_quantity: '4.000',
        },
      ])
      .mockResolvedValueOnce({ affectedRows: 1 });
    const repository = new DemandForecastRepository({
      query,
    } as unknown as DataSource);

    const first = await repository.generate({
      tenantId: 'tenant-1',
      userId: 'user-1',
      branchId: 'branch-1',
      administrator: false,
      horizonDays: 14,
      idempotencyKey: 'forecast-1',
    });

    expect(first?.replay).toBe(false);
    expect(first?.result.status).toBe('INSUFFICIENT');
    expect(first?.result.items[0].forecast).toBeNull();
    expect(first?.result.items[0].quality.totalDemand).toBe(1.5);
    expect(query).toHaveBeenCalledTimes(4);
    const calls = query.mock.calls as unknown as Array<[string, unknown[]]>;
    const activityCall = calls[2];
    expect(String(activityCall[0])).toContain('s.tenant_id = ?');
    expect(String(activityCall[0])).toContain('ib.tenant_id = ?');
    expect(
      activityCall[1].filter((value: unknown) => value === 'tenant-1'),
    ).toHaveLength(4);
    const insertCall = calls[3];
    expect(String(insertCall[0])).toContain('INSERT INTO demand_forecast_runs');
    expect(insertCall[1]).toContain('tenant-1');
  });

  it('returns an existing result for the same idempotency fingerprint', async () => {
    const result = {
      id: 'run-1',
      branch: { id: 'branch-1', name: 'Centro', timezone: 'UTC' },
      status: 'INSUFFICIENT',
      asOfDate: '2026-08-29',
      horizonDays: 14,
      model: 'WEEKDAY_BASELINE_V1',
      assumptions: [],
      generatedAt: '2026-08-29T00:00:00.000Z',
      items: [],
      summary: { sufficient: 0, insufficient: 0, driftWarnings: 0 },
    } as const;
    const fingerprint = createHash('sha256')
      .update(JSON.stringify({ branchId: 'branch-1', horizonDays: 14 }))
      .digest('hex');
    const query = jest
      .fn()
      .mockResolvedValueOnce([
        { result: JSON.stringify(result), request_fingerprint: fingerprint },
      ]);
    const repository = new DemandForecastRepository({
      query,
    } as unknown as DataSource);

    const replay = await repository.generate({
      tenantId: 'tenant-1',
      userId: 'user-1',
      branchId: 'branch-1',
      administrator: false,
      horizonDays: 14,
      idempotencyKey: 'forecast-1',
    });

    expect(replay).toEqual({ result, replay: true });
    expect(query).toHaveBeenCalledTimes(1);
  });
});
