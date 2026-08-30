import { DataSource } from 'typeorm';
import { SessionRepository } from './session.repository';

describe('SessionRepository access retirement', () => {
  it('excludes retired users from login and active session resolution', async () => {
    const queries: string[] = [];
    const query = jest.fn((sql: string) => {
      queries.push(sql);
      return Promise.resolve([]);
    });
    const repository = new SessionRepository({
      query,
    } as unknown as DataSource);

    await repository.findLoginIdentity('retired@example.com');
    await repository.findActiveSession(
      'token-hash',
      new Date('2026-08-30T12:00:00Z'),
    );

    expect(query).toHaveBeenCalledTimes(2);
    expect(queries[0]).toContain('u.access_revoked_at IS NULL');
    expect(queries[1]).toContain('u.access_revoked_at IS NULL');
  });
});
