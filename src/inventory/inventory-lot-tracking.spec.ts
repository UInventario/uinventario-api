import { EntityManager } from 'typeorm';
import {
  applyInventoryLotTracking,
  inventoryLocalDate,
} from './inventory-lot-tracking';
import {
  ExpiredInventoryLotError,
  InventoryLotExpirationRequiredError,
} from './inventory.errors';

jest.mock('./inventory-valuation-policy', () => ({
  finalizeSpecificLotMovementValuation: jest.fn(),
}));

const movement = {
  id: 'movement',
  tenant_id: 'tenant',
  product_id: 'product',
  location_id: 'location',
  type: 'SALE',
  quantity_change: '-6.000',
  created_by_user_id: 'user',
  purchase_receipt_line_id: null,
  purchase_return_line_id: null,
  sale_id: 'sale',
  sale_line_id: 'line',
  source_sale_movement_id: null,
  transfer_line_id: null,
  track_lots: true,
  lot_expiration_policy: 'OPTIONAL',
  unit_cost: '1.0000',
  country_code: 'MX',
  timezone: 'America/Mexico_City',
};

describe('inventory lot expiration and FEFO', () => {
  it('uses the branch timezone when the UTC day differs', () => {
    expect(
      inventoryLocalDate(
        'America/Mexico_City',
        new Date('2026-08-30T03:00:00.000Z'),
      ),
    ).toBe('2026-08-29');
  });

  it('filters expired stock and locks automatic allocations in FEFO order', async () => {
    const allocations: string[] = [];
    const manager = {
      query: jest.fn((sql: string, parameters: unknown[]) => {
        if (sql.includes('FROM inventory_movements im')) return [movement];
        if (sql.includes('COUNT(*) AS total')) return [{ total: 0 }];
        if (sql.includes('ORDER BY il.expires_on IS NULL')) {
          expect(sql).toContain('il.expires_on >= ?');
          expect(parameters.at(-1)).toMatch(/^\d{4}-\d{2}-\d{2}$/);
          return [
            { lot_id: 'nearest', quantity: '4.000', expires_on: '2026-09-01' },
            { lot_id: 'later', quantity: '4.000', expires_on: '2026-10-01' },
          ];
        }
        if (sql.includes('SELECT unit_cost, currency FROM inventory_lots')) {
          allocations.push(String(parameters[0]));
          return [{ unit_cost: '1.0000', currency: 'MXN' }];
        }
        if (sql.includes('SELECT quantity FROM inventory_lot_balances'))
          return [{ quantity: '4.000' }];
        return [];
      }),
    } as unknown as EntityManager;

    await applyInventoryLotTracking(manager, movement.id);

    expect(allocations).toEqual(['nearest', 'later']);
  });

  it('rejects a manually selected expired lot without an explicit override', async () => {
    const manager = {
      query: jest.fn((sql: string) => {
        if (sql.includes('FROM inventory_movements im')) return [movement];
        if (sql.includes('COUNT(*) AS total')) return [{ total: 0 }];
        if (sql.includes('il.normalized_code')) {
          return [
            { lot_id: 'expired', quantity: '8.000', expires_on: '2000-01-01' },
          ];
        }
        return [];
      }),
    } as unknown as EntityManager;

    await expect(
      applyInventoryLotTracking(manager, movement.id, { lotCode: 'OLD-1' }),
    ).rejects.toBeInstanceOf(ExpiredInventoryLotError);
  });

  it('requires an expiration date for products configured as REQUIRED', async () => {
    const manager = {
      query: jest.fn((sql: string) => {
        if (sql.includes('FROM inventory_movements im')) {
          return [
            {
              ...movement,
              type: 'ENTRY',
              quantity_change: '1.000',
              lot_expiration_policy: 'REQUIRED',
            },
          ];
        }
        if (sql.includes('COUNT(*) AS total')) return [{ total: 0 }];
        if (sql.includes('SELECT lot_expiration_policy FROM products')) {
          return [{ lot_expiration_policy: 'REQUIRED' }];
        }
        return [];
      }),
    } as unknown as EntityManager;

    await expect(
      applyInventoryLotTracking(manager, movement.id, { lotCode: 'NEW-1' }),
    ).rejects.toBeInstanceOf(InventoryLotExpirationRequiredError);
  });
});
