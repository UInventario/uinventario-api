import type { DataSource } from 'typeorm';
import { PosProfitabilityReportRepository } from './pos-profitability-report.repository';

describe('PosProfitabilityReportRepository', () => {
  it('reconciles discounts, returns, credit and historical costs without double counting', async () => {
    const query = jest
      .fn()
      .mockResolvedValueOnce([
        { id: 'branch-1', name: 'Centro', timezone: 'America/Mexico_City' },
      ])
      .mockResolvedValueOnce([
        {
          currency: 'MXN',
          sales_count: 1,
          gross_revenue: '130.00',
          discounts: '10.00',
          sales_subtotal: '103.45',
          sales_tax: '16.55',
          sales_total: '120.00',
          historical_cost: '60.00',
          payment_obligations: '120.00',
          credit_sales: '40.00',
        },
      ])
      .mockResolvedValueOnce([
        {
          currency: 'MXN',
          return_count: 1,
          return_subtotal: '17.24',
          return_tax: '2.76',
          return_total: '20.00',
          returned_cost: '10.00',
          refunds_settled: '20.00',
        },
      ])
      .mockResolvedValueOnce([{ currency: 'MXN', count: 1, amount: '50.00' }])
      .mockResolvedValueOnce([
        {
          product_id: 'product-1',
          product_name: 'Producto',
          product_sku: 'SKU-1',
          currency: 'MXN',
          sold_quantity: '2.000',
          returned_quantity: '0.500',
          gross_revenue: '130.00',
          discounts: '10.00',
          net_revenue: '86.21',
          taxes: '13.79',
          net_cost: '50.00',
        },
      ])
      .mockResolvedValueOnce([
        {
          id: 'sale-1',
          type: 'SALE',
          sale_id: 'sale-1',
          receipt_number: 'V-1',
          branch_name: 'Centro',
          cash_register_name: 'Principal',
          currency: 'MXN',
          revenue: '103.45',
          taxes: '16.55',
          cost: '60.00',
          payment_amount: '120.00',
          activity_at: '2026-08-29T12:00:00.000Z',
        },
        {
          id: 'return-1',
          type: 'RETURN',
          sale_id: 'sale-1',
          receipt_number: 'V-1',
          branch_name: 'Centro',
          cash_register_name: 'Principal',
          currency: 'MXN',
          revenue: '-17.24',
          taxes: '-2.76',
          cost: '-10.00',
          payment_amount: '0.00',
          activity_at: '2026-08-29T13:00:00.000Z',
        },
      ])
      .mockResolvedValueOnce([{ total: 2 }]);
    const repository = new PosProfitabilityReportRepository({
      query,
    } as unknown as DataSource);

    const report = await repository.report({
      tenantId: 'tenant-1',
      userId: 'user-1',
      administrator: true,
      query: { page: 1, pageSize: 20 },
    });

    expect(report).not.toBeNull();
    expect(report?.currencies).toEqual([
      expect.objectContaining({
        currency: 'MXN',
        grossRevenue: '130.00',
        discounts: '10.00',
        returnTotal: '20.00',
        netRevenue: '86.21',
        taxes: '13.79',
        netCost: '50.00',
        margin: '36.21',
        creditSales: '40.00',
        refundsSettled: '20.00',
        salesMatchPayments: true,
      }),
    ]);
    expect(report?.products[0]).toMatchObject({
      soldQuantity: '2.000',
      returnedQuantity: '0.500',
      margin: '36.21',
    });
    expect(report?.activities[0]).toMatchObject({
      type: 'SALE',
      historicalCost: '60.00',
      marginImpact: '43.45',
      reconciles: true,
    });
    expect(report?.activities[1]).toMatchObject({
      type: 'RETURN',
      marginImpact: '-7.24',
      reconciles: false,
    });
    expect(report?.formulas.returnsAndRefunds).toContain('not deducted again');
    expect(report?.total).toBe(2);
    expect(query).toHaveBeenCalledTimes(7);
    for (const [sql, parameters] of query.mock.calls.slice(1)) {
      expect(String(sql)).toContain('tenant_id');
      expect(parameters).toContain('tenant-1');
    }
  });
});
