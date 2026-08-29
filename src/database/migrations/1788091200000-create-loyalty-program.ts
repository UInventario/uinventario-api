import { MigrationInterface, QueryRunner } from 'typeorm';

export class CreateLoyaltyProgram1788091200000 implements MigrationInterface {
  name = 'CreateLoyaltyProgram1788091200000';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE loyalty_rules (
        id CHAR(36) NOT NULL, tenant_id CHAR(36) NOT NULL,
        version INT UNSIGNED NOT NULL,
        active BOOLEAN NOT NULL DEFAULT TRUE,
        earn_amount DECIMAL(15,2) NOT NULL,
        earn_points INT UNSIGNED NOT NULL,
        redeem_points INT UNSIGNED NOT NULL,
        redeem_amount DECIMAL(15,2) NOT NULL,
        expiration_days SMALLINT UNSIGNED NULL,
        created_by_user_id CHAR(36) NOT NULL,
        created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
        PRIMARY KEY (id),
        UNIQUE KEY uq_loyalty_rules_id_tenant (id, tenant_id),
        UNIQUE KEY uq_loyalty_rules_version (tenant_id, version),
        CONSTRAINT fk_loyalty_rules_tenant FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE,
        CONSTRAINT fk_loyalty_rules_user FOREIGN KEY (created_by_user_id, tenant_id) REFERENCES users(id, tenant_id) ON DELETE RESTRICT,
        CONSTRAINT ck_loyalty_rules_values CHECK (
          earn_amount > 0 AND earn_points > 0 AND redeem_points > 0
          AND redeem_amount > 0
          AND (expiration_days IS NULL OR expiration_days BETWEEN 1 AND 3650)
        )
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);
    await queryRunner.query(`
      CREATE TABLE loyalty_point_entries (
        id CHAR(36) NOT NULL, tenant_id CHAR(36) NOT NULL,
        customer_id CHAR(36) NOT NULL, rule_id CHAR(36) NOT NULL,
        sale_id CHAR(36) NULL, sale_return_id CHAR(36) NULL,
        entry_type ENUM(
          'EARN','REDEEM','EXPIRE','VOID_EARN_REVERSAL','VOID_REDEEM_RESTORE',
          'RETURN_EARN_REVERSAL','RETURN_REDEEM_RESTORE'
        ) NOT NULL,
        points_delta INT NOT NULL, monetary_value DECIMAL(15,2) NOT NULL DEFAULT 0,
        idempotency_key VARCHAR(160) NOT NULL,
        rule_snapshot JSON NOT NULL, metadata JSON NULL,
        expires_at DATETIME(6) NULL,
        created_by_user_id CHAR(36) NOT NULL,
        created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
        PRIMARY KEY (id),
        UNIQUE KEY uq_loyalty_entries_key (tenant_id, idempotency_key),
        UNIQUE KEY uq_loyalty_entries_id_tenant (id, tenant_id),
        KEY ix_loyalty_entries_balance (tenant_id, customer_id, created_at, id),
        KEY ix_loyalty_entries_expiration (tenant_id, customer_id, expires_at),
        CONSTRAINT fk_loyalty_entries_tenant FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE,
        CONSTRAINT fk_loyalty_entries_customer FOREIGN KEY (customer_id, tenant_id) REFERENCES customers(id, tenant_id) ON DELETE RESTRICT,
        CONSTRAINT fk_loyalty_entries_rule FOREIGN KEY (rule_id, tenant_id) REFERENCES loyalty_rules(id, tenant_id) ON DELETE RESTRICT,
        CONSTRAINT fk_loyalty_entries_sale FOREIGN KEY (sale_id, tenant_id) REFERENCES sales(id, tenant_id) ON DELETE RESTRICT,
        CONSTRAINT fk_loyalty_entries_return FOREIGN KEY (sale_return_id, tenant_id) REFERENCES sale_returns(id, tenant_id) ON DELETE RESTRICT,
        CONSTRAINT fk_loyalty_entries_user FOREIGN KEY (created_by_user_id, tenant_id) REFERENCES users(id, tenant_id) ON DELETE RESTRICT,
        CONSTRAINT ck_loyalty_entries_delta CHECK (
          (entry_type IN ('EARN','VOID_REDEEM_RESTORE','RETURN_REDEEM_RESTORE') AND points_delta > 0)
          OR (entry_type IN ('REDEEM','EXPIRE','VOID_EARN_REVERSAL','RETURN_EARN_REVERSAL') AND points_delta < 0)
        ),
        CONSTRAINT ck_loyalty_entries_value CHECK (monetary_value >= 0)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);
    await queryRunner.query(`
      CREATE TABLE loyalty_point_allocations (
        id CHAR(36) NOT NULL, tenant_id CHAR(36) NOT NULL,
        debit_entry_id CHAR(36) NOT NULL, credit_entry_id CHAR(36) NOT NULL,
        points INT UNSIGNED NOT NULL,
        created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
        PRIMARY KEY (id),
        UNIQUE KEY uq_loyalty_allocation (tenant_id, debit_entry_id, credit_entry_id),
        KEY ix_loyalty_allocations_credit (tenant_id, credit_entry_id),
        CONSTRAINT fk_loyalty_allocations_debit FOREIGN KEY (debit_entry_id, tenant_id) REFERENCES loyalty_point_entries(id, tenant_id) ON DELETE RESTRICT,
        CONSTRAINT fk_loyalty_allocations_credit FOREIGN KEY (credit_entry_id, tenant_id) REFERENCES loyalty_point_entries(id, tenant_id) ON DELETE RESTRICT,
        CONSTRAINT ck_loyalty_allocation_points CHECK (points > 0)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);
    await queryRunner.query(`
      ALTER TABLE sales
      ADD COLUMN loyalty_points_redeemed INT UNSIGNED NOT NULL DEFAULT 0 AFTER promotion_discount_total,
      ADD COLUMN loyalty_value DECIMAL(15,2) NOT NULL DEFAULT 0 AFTER loyalty_points_redeemed,
      ADD COLUMN loyalty_points_earned INT UNSIGNED NOT NULL DEFAULT 0 AFTER loyalty_value,
      ADD COLUMN loyalty_rule_version INT UNSIGNED NULL AFTER loyalty_points_earned,
      ADD COLUMN loyalty_rule_snapshot JSON NULL AFTER loyalty_rule_version
    `);
    await queryRunner.query(`
      ALTER TABLE sale_receipt_snapshots
      ADD COLUMN loyalty_points_redeemed INT UNSIGNED NOT NULL DEFAULT 0 AFTER total,
      ADD COLUMN loyalty_value DECIMAL(15,2) NOT NULL DEFAULT 0 AFTER loyalty_points_redeemed,
      ADD COLUMN loyalty_points_earned INT UNSIGNED NOT NULL DEFAULT 0 AFTER loyalty_value
    `);
    await queryRunner.query(`
      ALTER TABLE sale_returns
      ADD COLUMN loyalty_value_restored DECIMAL(15,2) NOT NULL DEFAULT 0 AFTER total
    `);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      'ALTER TABLE sale_returns DROP COLUMN loyalty_value_restored',
    );
    await queryRunner.query(`ALTER TABLE sale_receipt_snapshots
      DROP COLUMN loyalty_points_earned, DROP COLUMN loyalty_value,
      DROP COLUMN loyalty_points_redeemed`);
    await queryRunner.query(`ALTER TABLE sales
      DROP COLUMN loyalty_rule_snapshot, DROP COLUMN loyalty_rule_version,
      DROP COLUMN loyalty_points_earned, DROP COLUMN loyalty_value,
      DROP COLUMN loyalty_points_redeemed`);
    await queryRunner.query('DROP TABLE loyalty_point_allocations');
    await queryRunner.query('DROP TABLE loyalty_point_entries');
    await queryRunner.query('DROP TABLE loyalty_rules');
  }
}
