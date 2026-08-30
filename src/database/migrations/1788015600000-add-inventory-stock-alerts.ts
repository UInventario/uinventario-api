import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddInventoryStockAlerts1788015600000 implements MigrationInterface {
  name = 'AddInventoryStockAlerts1788015600000';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE inventory_stock_thresholds (
        tenant_id CHAR(36) NOT NULL,
        product_id CHAR(36) NOT NULL,
        location_id CHAR(36) NOT NULL,
        low_stock_threshold DECIMAL(18,3) NOT NULL,
        created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
        updated_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6)
          ON UPDATE CURRENT_TIMESTAMP(6),
        PRIMARY KEY (tenant_id, product_id, location_id),
        CONSTRAINT fk_stock_threshold_tenant FOREIGN KEY (tenant_id)
          REFERENCES tenants(id) ON DELETE CASCADE,
        CONSTRAINT fk_stock_threshold_product_tenant
          FOREIGN KEY (product_id, tenant_id)
          REFERENCES products(id, tenant_id) ON DELETE CASCADE,
        CONSTRAINT fk_stock_threshold_location_tenant
          FOREIGN KEY (location_id, tenant_id)
          REFERENCES locations(id, tenant_id) ON DELETE CASCADE,
        CONSTRAINT ck_stock_threshold_nonnegative CHECK (low_stock_threshold >= 0)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);
    await queryRunner.query(`
      CREATE TABLE inventory_stock_alert_states (
        tenant_id CHAR(36) NOT NULL,
        product_id CHAR(36) NOT NULL,
        location_id CHAR(36) NOT NULL,
        status ENUM('HEALTHY', 'LOW', 'OUT_OF_STOCK', 'RECOVERED') NOT NULL,
        available_quantity DECIMAL(18,3) NOT NULL,
        low_stock_threshold DECIMAL(18,3) NOT NULL,
        transitioned_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
        updated_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6)
          ON UPDATE CURRENT_TIMESTAMP(6),
        PRIMARY KEY (tenant_id, product_id, location_id),
        KEY ix_stock_alert_operational
          (tenant_id, status, transitioned_at, product_id, location_id),
        CONSTRAINT fk_stock_alert_tenant FOREIGN KEY (tenant_id)
          REFERENCES tenants(id) ON DELETE CASCADE,
        CONSTRAINT fk_stock_alert_product_tenant
          FOREIGN KEY (product_id, tenant_id)
          REFERENCES products(id, tenant_id) ON DELETE CASCADE,
        CONSTRAINT fk_stock_alert_location_tenant
          FOREIGN KEY (location_id, tenant_id)
          REFERENCES locations(id, tenant_id) ON DELETE CASCADE,
        CONSTRAINT ck_stock_alert_quantity CHECK (available_quantity >= 0),
        CONSTRAINT ck_stock_alert_threshold CHECK (low_stock_threshold >= 0)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);
    await queryRunner.query(`
      INSERT INTO inventory_stock_alert_states
        (tenant_id, product_id, location_id, status, available_quantity,
         low_stock_threshold)
      SELECT ib.tenant_id, ib.product_id, ib.location_id,
             CASE WHEN ib.available_quantity <= 0 THEN 'OUT_OF_STOCK'
                  WHEN ib.available_quantity <= COALESCE(t.low_stock_threshold, 5)
                    THEN 'LOW'
                  ELSE 'HEALTHY' END,
             ib.available_quantity, COALESCE(t.low_stock_threshold, 5)
      FROM inventory_balances ib
      LEFT JOIN inventory_stock_thresholds t
        ON t.tenant_id = ib.tenant_id AND t.product_id = ib.product_id
       AND t.location_id = ib.location_id
    `);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('DROP TABLE inventory_stock_alert_states');
    await queryRunner.query('DROP TABLE inventory_stock_thresholds');
  }
}
