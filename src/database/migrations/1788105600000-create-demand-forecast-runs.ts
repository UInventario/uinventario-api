import { MigrationInterface, QueryRunner } from 'typeorm';

export class CreateDemandForecastRuns1788105600000 implements MigrationInterface {
  name = 'CreateDemandForecastRuns1788105600000';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE demand_forecast_runs (
        id CHAR(36) NOT NULL, tenant_id CHAR(36) NOT NULL,
        branch_id CHAR(36) NOT NULL, created_by_user_id CHAR(36) NOT NULL,
        idempotency_key VARCHAR(128) NOT NULL, request_fingerprint CHAR(64) NOT NULL,
        horizon_days TINYINT UNSIGNED NOT NULL, as_of_date DATE NOT NULL,
        status VARCHAR(20) NOT NULL, result JSON NOT NULL,
        generated_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
        PRIMARY KEY (id),
        UNIQUE KEY uq_demand_forecast_key (tenant_id, idempotency_key),
        KEY ix_demand_forecast_latest (tenant_id, branch_id, generated_at, id),
        CONSTRAINT fk_demand_forecast_tenant FOREIGN KEY (tenant_id)
          REFERENCES tenants(id) ON DELETE CASCADE,
        CONSTRAINT fk_demand_forecast_branch FOREIGN KEY (branch_id, tenant_id)
          REFERENCES branches(id, tenant_id) ON DELETE CASCADE,
        CONSTRAINT fk_demand_forecast_user FOREIGN KEY (created_by_user_id, tenant_id)
          REFERENCES users(id, tenant_id) ON DELETE RESTRICT,
        CONSTRAINT ck_demand_forecast_horizon CHECK (horizon_days IN (7, 14, 30)),
        CONSTRAINT ck_demand_forecast_status CHECK (status IN ('READY', 'INSUFFICIENT'))
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('DROP TABLE demand_forecast_runs');
  }
}
