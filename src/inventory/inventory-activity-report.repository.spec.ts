import type { DataSource } from 'typeorm';
import { InventoryActivityReportRepository } from './inventory-activity-report.repository';

describe('InventoryActivityReportRepository', () => {
  it('calculates rotation, explicit losses and slow products over an authorized scope', async () => {
    const query = jest
      .fn()
      .mockResolvedValueOnce([
        { id: 'branch-1', name: 'Centro', timezone: 'America/Mexico_City' },
      ])
      .mockResolvedValueOnce([
        {
          product_id: 'product-1',
          product_name: 'Producto lento',
          product_sku: 'SKU-1',
          category_id: 'category-1',
          category_name: 'General',
          opening_quantity: '10.000',
          closing_quantity: '8.000',
          net_sold_quantity: '0.000',
          loss_quantity: '2.000',
          activity_quantity: '4.000',
          last_movement_at: '2026-08-28T12:00:00.000Z',
        },
        {
          product_id: 'product-2',
          product_name: 'Producto activo',
          product_sku: 'SKU-2',
          category_id: null,
          category_name: null,
          opening_quantity: '10.000',
          closing_quantity: '6.000',
          net_sold_quantity: '8.000',
          loss_quantity: '0.000',
          activity_quantity: '12.000',
          last_movement_at: '2026-08-29T12:00:00.000Z',
        },
      ])
      .mockResolvedValueOnce([{ total: 2 }])
      .mockResolvedValueOnce([{ id: 'category-1', name: 'General' }])
      .mockResolvedValueOnce([
        {
          id: 'warehouse-1',
          name: 'Principal',
          branch_id: 'branch-1',
          branch_name: 'Centro',
        },
      ]);
    const repository = new InventoryActivityReportRepository({
      query,
    } as unknown as DataSource);

    const report = await repository.report({
      tenantId: 'tenant-1',
      userId: 'user-1',
      administrator: false,
      query: {
        dateFrom: '2026-08-01',
        dateTo: '2026-08-29',
        page: 1,
        pageSize: 20,
      },
    });

    expect(report?.items).toEqual([
      expect.objectContaining({
        status: 'SLOW',
        lossQuantity: '2.000',
        rotation: 0,
      }),
      expect.objectContaining({
        status: 'ACTIVE',
        averageQuantity: '8.000',
        netSoldQuantity: '8.000',
        rotation: 1,
      }),
    ]);
    expect(report?.definitions.returnsAndVoids).toContain('reducen');
    expect(report?.scope.warehouses[0]).toEqual({
      id: 'warehouse-1',
      name: 'Principal',
      branch: { id: 'branch-1', name: 'Centro' },
    });
    expect(report?.total).toBe(2);
    expect(query).toHaveBeenCalledTimes(5);
    for (const [sql] of query.mock.calls)
      expect(String(sql)).toContain('tenant_id');
  });

  it('rejects a branch outside the user scope without querying report data', async () => {
    const query = jest
      .fn()
      .mockResolvedValueOnce([
        { id: 'branch-1', name: 'Centro', timezone: 'America/Mexico_City' },
      ]);
    const repository = new InventoryActivityReportRepository({
      query,
    } as unknown as DataSource);

    await expect(
      repository.report({
        tenantId: 'tenant-1',
        userId: 'user-1',
        administrator: false,
        query: { branchId: 'branch-2', page: 1, pageSize: 20 },
      }),
    ).resolves.toBeNull();
    expect(query).toHaveBeenCalledTimes(1);
  });

  it('paginates movement drill-down within the same authorized period and warehouse', async () => {
    const query = jest
      .fn()
      .mockResolvedValueOnce([
        { id: 'branch-1', name: 'Centro', timezone: 'America/Mexico_City' },
      ])
      .mockResolvedValueOnce([
        {
          id: 'movement-1',
          type: 'SALE_RETURN',
          quantity_change: '1.000',
          resulting_quantity: '8.000',
          reason: 'Devolución',
          reference: 'DEV-1',
          created_at: '2026-08-29T12:00:00.000Z',
          branch_name: 'Centro',
          warehouse_name: 'Principal',
          location_name: 'General',
        },
      ])
      .mockResolvedValueOnce([{ total: 21 }]);
    const repository = new InventoryActivityReportRepository({
      query,
    } as unknown as DataSource);

    const result = await repository.movements({
      tenantId: 'tenant-1',
      userId: 'user-1',
      administrator: false,
      productId: 'product-1',
      query: {
        dateFrom: '2026-08-01',
        dateTo: '2026-08-29',
        warehouseId: 'warehouse-1',
        page: 2,
        pageSize: 10,
      },
    });

    expect(result).toEqual({
      items: [
        expect.objectContaining({
          type: 'SALE_RETURN',
          quantityChange: '1.000',
          branchName: 'Centro',
        }),
      ],
      total: 21,
    });
    const movementCall = query.mock.calls[1] as unknown as [string, unknown[]];
    expect(movementCall[0]).toContain('LIMIT ? OFFSET ?');
    expect(movementCall[1]).toEqual(
      expect.arrayContaining(['tenant-1', 'product-1', 'warehouse-1', 10]),
    );
  });
});
