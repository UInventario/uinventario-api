import type { DataSource, EntityManager } from 'typeorm';
import { LoyaltyRepository } from './loyalty.repository';
import { LoyaltyInsufficientBalanceError } from './loyalty.types';

describe('LoyaltyRepository', () => {
  const ruleRow = {
    id: 'rule-1',
    version: 3,
    active: true,
    earn_amount: '1.00',
    earn_points: 1,
    redeem_points: 100,
    redeem_amount: '1.00',
    expiration_days: 365,
    created_at: '2026-08-29T00:00:00.000Z',
  };

  const setup = (balance = 250) => {
    const calls: Array<{ sql: string; parameters: unknown[] | undefined }> = [];
    const query = jest.fn((sql: string, parameters?: unknown[]) => {
      calls.push({ sql, parameters });
      if (sql.includes('SELECT id, name FROM customers'))
        return [{ id: 'customer-1', name: 'Ana' }];
      if (sql.includes('entry.expires_at <= CURRENT_TIMESTAMP')) return [];
      if (sql.includes('FROM loyalty_rules')) return [ruleRow];
      if (sql.includes('SUM(points_delta)')) return [{ balance }];
      if (sql.includes('HAVING available_points > 0'))
        return [
          {
            id: 'credit-1',
            available_points: balance,
            rule_id: ruleRow.id,
            rule_snapshot: JSON.stringify({ version: ruleRow.version }),
            expires_at: null,
          },
        ];
      return { affectedRows: 1 };
    });
    const manager = { query } as unknown as EntityManager;
    const dataSource = {
      manager,
      transaction: jest.fn(
        async (
          _isolation: string,
          work: (value: EntityManager) => Promise<unknown>,
        ) => work(manager),
      ),
    } as unknown as DataSource;
    return { repository: new LoyaltyRepository(dataSource), calls, manager };
  };

  it('quotes redemption in configured increments and earns only on the payable amount', async () => {
    const { repository } = setup();
    const quote = await repository.preview({
      tenantId: 'tenant-1',
      customerId: 'customer-1',
      userId: 'user-1',
      saleTotal: '10.00',
      pointsToRedeem: 200,
    });

    expect(quote).toMatchObject({
      balanceBefore: 250,
      pointsRedeemed: 200,
      redemptionValue: '2.00',
      pointsEarned: 8,
      balanceAfter: 58,
      rule: { id: 'rule-1', version: 3 },
    });
  });

  it('rejects a redemption that exceeds the locked customer balance', async () => {
    const { repository } = setup(50);
    await expect(
      repository.preview({
        tenantId: 'tenant-1',
        customerId: 'customer-1',
        userId: 'user-1',
        saleTotal: '10.00',
        pointsToRedeem: 100,
      }),
    ).rejects.toBeInstanceOf(LoyaltyInsufficientBalanceError);
  });

  it('writes one debit allocation and one earning entry in the sale transaction', async () => {
    const { repository, calls, manager } = setup();
    const quote = (await repository.preview({
      tenantId: 'tenant-1',
      customerId: 'customer-1',
      userId: 'user-1',
      saleTotal: '10.00',
      pointsToRedeem: 200,
    }))!;
    await repository.applySale(manager, {
      tenantId: 'tenant-1',
      customerId: 'customer-1',
      userId: 'user-1',
      saleId: 'sale-1',
      idempotencyKey: 'sale-key-1',
      saleTotal: '10.00',
      loyalty: quote,
    });

    const inserts = calls.filter(({ sql }) =>
      sql.includes('INSERT INTO loyalty_point_entries'),
    );
    expect(inserts).toHaveLength(2);
    expect(inserts[0].parameters).toContain('REDEEM');
    expect(inserts[1].parameters).toContain('EARN');
    expect(
      calls.some(({ sql }) =>
        sql.includes('INSERT INTO loyalty_point_allocations'),
      ),
    ).toBe(true);
  });

  it('materializes expired unspent points as an append-only debit', async () => {
    const calls: Array<{ sql: string; parameters: unknown[] | undefined }> = [];
    const expired = {
      id: 'credit-expired',
      available_points: 40,
      rule_id: ruleRow.id,
      rule_snapshot: JSON.stringify({ version: ruleRow.version }),
      expires_at: '2026-08-28T00:00:00.000Z',
    };
    const query = jest.fn((sql: string, parameters?: unknown[]) => {
      calls.push({ sql, parameters });
      if (sql.includes('SELECT id, name FROM customers'))
        return [{ id: 'customer-1', name: 'Ana' }];
      if (sql.includes('entry.expires_at <= CURRENT_TIMESTAMP'))
        return [expired];
      if (sql.includes('WHERE entry.id = ?')) return [expired];
      if (sql.includes('FROM loyalty_rules')) return [ruleRow];
      if (sql.includes('SUM(points_delta)')) return [{ balance: 0 }];
      return { affectedRows: 1 };
    });
    const manager = { query } as unknown as EntityManager;
    const dataSource = {
      manager,
      transaction: jest.fn(
        async (
          _isolation: string,
          work: (value: EntityManager) => Promise<unknown>,
        ) => work(manager),
      ),
    } as unknown as DataSource;

    await new LoyaltyRepository(dataSource).preview({
      tenantId: 'tenant-1',
      customerId: 'customer-1',
      userId: 'user-1',
      saleTotal: '10.00',
      pointsToRedeem: 0,
    });

    expect(
      calls.find(({ sql }) => sql.includes('INSERT INTO loyalty_point_entries'))
        ?.parameters,
    ).toContain('EXPIRE');
    expect(
      calls.some(({ sql }) =>
        sql.includes('INSERT INTO loyalty_point_allocations'),
      ),
    ).toBe(true);
  });
});
