import { DataSource, EntityManager } from 'typeorm';
import { AccessControlRepository } from './access-control.repository';
import { InvalidAccessAssignmentError } from './access-control.errors';

describe('AccessControlRepository', () => {
  it('retires only the requested tenant user and revokes that user sessions', async () => {
    const calls: Array<{ sql: string; parameters?: unknown[] }> = [];
    const query = jest.fn((sql: string, parameters?: unknown[]) => {
      calls.push({ sql, parameters });
      if (sql.includes('SELECT u.email')) {
        return Promise.resolve([
          {
            email: 'operator@example.com',
            normalizedEmail: 'operator@example.com',
            administrator: 0,
          },
        ]);
      }
      return Promise.resolve([]);
    });
    const manager = { query } as unknown as EntityManager;
    const dataSource = {
      transaction: jest.fn(
        (operation: (entityManager: EntityManager) => unknown) =>
          operation(manager),
      ),
    } as unknown as DataSource;
    const repository = new AccessControlRepository(dataSource);

    const retired = await repository.retireUser({
      tenantId: 'tenant-1',
      actorUserId: 'admin-1',
      userId: 'user-1',
      confirmationEmail: 'operator@example.com',
    });

    expect(retired).toMatchObject({
      id: 'user-1',
      active: false,
      roles: [],
      branches: [],
    });
    const mutations = calls.filter(({ sql }) => !sql.includes('SELECT'));
    expect(mutations).toHaveLength(5);
    expect(
      mutations.every(({ parameters }) => parameters?.includes('tenant-1')),
    ).toBe(true);
    expect(calls.some(({ sql }) => sql.includes('UPDATE sessions'))).toBe(true);
  });

  it('never lets an actor retire their own access', async () => {
    const transaction = jest.fn();
    const dataSource = { transaction } as unknown as DataSource;
    const repository = new AccessControlRepository(dataSource);

    await expect(
      repository.retireUser({
        tenantId: 'tenant-1',
        actorUserId: 'user-1',
        userId: 'user-1',
        confirmationEmail: 'admin@example.com',
      }),
    ).rejects.toBeInstanceOf(InvalidAccessAssignmentError);
    expect(transaction).not.toHaveBeenCalled();
  });

  it('exposes retired users without granting them assignments', async () => {
    const scopedQuery = jest.fn().mockResolvedValue([]);
    const dataSource = {
      manager: { query: scopedQuery },
      query: jest.fn().mockResolvedValue([
        {
          id: 'user-1',
          email: 'retired@example.com',
          accessRevokedAt: new Date(),
          administrator: 0,
        },
      ]),
    } as unknown as DataSource;
    const repository = new AccessControlRepository(dataSource);

    await expect(repository.listUsers('tenant-1', 'admin-1')).resolves.toEqual([
      {
        id: 'user-1',
        email: 'retired@example.com',
        active: false,
        roles: [],
        branches: [],
        cashRegisters: [],
        manageable: true,
      },
    ]);
  });
});
