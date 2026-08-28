import { HealthIndicatorService } from '@nestjs/terminus';
import { DataSource } from 'typeorm';
import { DatabaseReadinessIndicator } from './database-readiness.indicator';

describe('DatabaseReadinessIndicator', () => {
  const dataSource = { query: jest.fn() } as unknown as DataSource;
  const indicator = new DatabaseReadinessIndicator(
    dataSource,
    new HealthIndicatorService(),
  );

  beforeEach(() => jest.clearAllMocks());

  it('reports the database dependency as available', async () => {
    (dataSource.query as jest.Mock).mockResolvedValue([{ result: 1 }]);
    await expect(indicator.check()).resolves.toEqual({
      database: { status: 'up' },
    });
  });

  it('reports only a sanitized dependency state when the driver fails', async () => {
    (dataSource.query as jest.Mock).mockRejectedValue(
      new Error('mysql://admin:secret@database.example/private'),
    );
    const result = await indicator.check();

    expect(result).toEqual({ database: { status: 'down' } });
    expect(JSON.stringify(result)).not.toContain('secret');
    expect(JSON.stringify(result)).not.toContain('database.example');
  });
});
