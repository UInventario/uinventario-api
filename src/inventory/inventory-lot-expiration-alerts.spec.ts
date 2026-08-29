import { DataSource } from 'typeorm';
import { InventoryRepository } from './inventory.repository';

describe('InventoryRepository lot expiration alerts', () => {
  it('returns one current-stock alert per lot/location and omits exhausted lots', async () => {
    const query = jest
      .fn()
      .mockResolvedValueOnce([{ timezone: 'America/Mexico_City' }])
      .mockResolvedValueOnce([
        {
          lot_id: 'lot-expired',
          lot_code: 'OLD',
          expires_on: '2000-01-01',
          product_id: 'product',
          product_name: 'Leche',
          product_sku: 'LECHE',
          location_id: 'location',
          location_name: 'Piso',
          location_code: 'PISO',
          quantity: '2.000',
        },
        {
          lot_id: 'lot-soon',
          lot_code: 'SOON',
          expires_on: '2099-01-01',
          product_id: 'product',
          product_name: 'Leche',
          product_sku: 'LECHE',
          location_id: 'location',
          location_name: 'Piso',
          location_code: 'PISO',
          quantity: '1.000',
        },
      ]);
    const repository = new InventoryRepository({
      query,
    } as unknown as DataSource);

    const result = await repository.listLotExpirationAlerts(
      'tenant',
      'warehouse',
    );

    const alertSql = String((query.mock.calls as unknown[][])[1][0]);
    expect(alertSql).toContain('ilb.quantity > 0');
    expect(alertSql).toContain('lot_expiration_alert_days');
    expect(result.items.map((item) => item.id)).toEqual([
      'lot-expired:location',
      'lot-soon:location',
    ]);
    expect(result.items[0].status).toBe('EXPIRED');
    expect(result.items[1].status).toBe('EXPIRING');
  });
});
