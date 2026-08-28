import { Injectable } from '@nestjs/common';
import { HealthIndicatorService } from '@nestjs/terminus';
import { DataSource } from 'typeorm';

@Injectable()
export class DatabaseReadinessIndicator {
  constructor(
    private readonly dataSource: DataSource,
    private readonly healthIndicator: HealthIndicatorService,
  ) {}

  async check() {
    const database = this.healthIndicator.check('database');
    try {
      await this.dataSource.query('SELECT 1');
      return database.up();
    } catch {
      return database.down();
    }
  }
}
