import { MigrationInterface, QueryRunner } from 'typeorm';

export class CreateCustomerOrders1788055200000 implements MigrationInterface {
  name = 'CreateCustomerOrders1788055200000';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE customer_orders (
        id CHAR(36) NOT NULL, tenant_id CHAR(36) NOT NULL,
        branch_id CHAR(36) NOT NULL, warehouse_id CHAR(36) NOT NULL,
        cash_register_id CHAR(36) NOT NULL, location_id CHAR(36) NOT NULL,
        customer_id CHAR(36) NOT NULL, reservation_id CHAR(36) NULL, sale_id CHAR(36) NULL,
        order_number VARCHAR(24) NOT NULL, channel VARCHAR(16) NOT NULL,
        priority VARCHAR(16) NOT NULL, status VARCHAR(24) NOT NULL,
        currency CHAR(3) NOT NULL, subtotal DECIMAL(18,2) NOT NULL,
        tax DECIMAL(18,2) NOT NULL, total DECIMAL(18,2) NOT NULL,
        expires_in_hours INT NOT NULL, version INT NOT NULL DEFAULT 1,
        idempotency_key VARCHAR(128) NOT NULL, request_fingerprint CHAR(64) NOT NULL,
        created_by_user_id CHAR(36) NOT NULL,
        confirmed_at DATETIME(6) NULL, preparing_at DATETIME(6) NULL,
        ready_at DATETIME(6) NULL, delivered_at DATETIME(6) NULL,
        cancelled_at DATETIME(6) NULL, cancellation_reason VARCHAR(240) NULL,
        created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
        updated_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
        PRIMARY KEY (id), UNIQUE KEY uq_customer_orders_id_tenant (id, tenant_id),
        UNIQUE KEY uq_customer_orders_number (tenant_id, order_number),
        UNIQUE KEY uq_customer_orders_key (tenant_id, idempotency_key),
        UNIQUE KEY uq_customer_orders_reservation (tenant_id, reservation_id),
        UNIQUE KEY uq_customer_orders_sale (tenant_id, sale_id),
        KEY ix_customer_orders_queue (tenant_id, branch_id, status, priority, created_at),
        CONSTRAINT fk_customer_orders_tenant FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE RESTRICT,
        CONSTRAINT fk_customer_orders_branch FOREIGN KEY (branch_id, tenant_id) REFERENCES branches(id, tenant_id) ON DELETE RESTRICT,
        CONSTRAINT fk_customer_orders_warehouse FOREIGN KEY (warehouse_id, tenant_id) REFERENCES warehouses(id, tenant_id) ON DELETE RESTRICT,
        CONSTRAINT fk_customer_orders_register FOREIGN KEY (cash_register_id, tenant_id) REFERENCES cash_registers(id, tenant_id) ON DELETE RESTRICT,
        CONSTRAINT fk_customer_orders_location FOREIGN KEY (location_id, tenant_id) REFERENCES locations(id, tenant_id) ON DELETE RESTRICT,
        CONSTRAINT fk_customer_orders_customer FOREIGN KEY (customer_id, tenant_id) REFERENCES customers(id, tenant_id) ON DELETE RESTRICT,
        CONSTRAINT fk_customer_orders_reservation FOREIGN KEY (reservation_id, tenant_id) REFERENCES product_reservations(id, tenant_id) ON DELETE RESTRICT,
        CONSTRAINT fk_customer_orders_sale FOREIGN KEY (sale_id, tenant_id) REFERENCES sales(id, tenant_id) ON DELETE RESTRICT,
        CONSTRAINT fk_customer_orders_user FOREIGN KEY (created_by_user_id) REFERENCES users(id) ON DELETE RESTRICT,
        CONSTRAINT ck_customer_orders_channel CHECK (channel IN ('POS', 'WEB', 'MOBILE', 'DESKTOP')),
        CONSTRAINT ck_customer_orders_priority CHECK (priority IN ('LOW', 'NORMAL', 'HIGH', 'URGENT')),
        CONSTRAINT ck_customer_orders_status CHECK (status IN ('DRAFT', 'CONFIRMED', 'PREPARING', 'READY', 'DELIVERED', 'CANCELLED')),
        CONSTRAINT ck_customer_orders_amounts CHECK (subtotal >= 0 AND tax >= 0 AND total > 0),
        CONSTRAINT ck_customer_orders_expiry CHECK (expires_in_hours BETWEEN 1 AND 720)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);
    await queryRunner.query(`
      CREATE TABLE customer_order_lines (
        id CHAR(36) NOT NULL, tenant_id CHAR(36) NOT NULL, order_id CHAR(36) NOT NULL,
        line_number INT NOT NULL, product_id CHAR(36) NOT NULL, lot_id CHAR(36) NULL,
        quantity DECIMAL(18,3) NOT NULL, serial_numbers JSON NOT NULL,
        unit_price DECIMAL(18,2) NOT NULL, gross_total DECIMAL(18,2) NOT NULL,
        discount_total DECIMAL(18,2) NOT NULL, subtotal DECIMAL(18,2) NOT NULL,
        tax DECIMAL(18,2) NOT NULL, total DECIMAL(18,2) NOT NULL,
        PRIMARY KEY (id), UNIQUE KEY uq_customer_order_lines_id_tenant (id, tenant_id),
        UNIQUE KEY uq_customer_order_lines_number (order_id, line_number),
        CONSTRAINT fk_customer_order_lines_order FOREIGN KEY (order_id, tenant_id) REFERENCES customer_orders(id, tenant_id) ON DELETE RESTRICT,
        CONSTRAINT fk_customer_order_lines_product FOREIGN KEY (product_id, tenant_id) REFERENCES products(id, tenant_id) ON DELETE RESTRICT,
        CONSTRAINT fk_customer_order_lines_lot FOREIGN KEY (lot_id, tenant_id) REFERENCES inventory_lots(id, tenant_id) ON DELETE RESTRICT,
        CONSTRAINT ck_customer_order_lines_quantity CHECK (quantity > 0)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);
    await queryRunner.query(`
      CREATE TABLE customer_order_payments (
        id CHAR(36) NOT NULL, tenant_id CHAR(36) NOT NULL, order_id CHAR(36) NOT NULL,
        line_number INT NOT NULL, method VARCHAR(16) NOT NULL, amount DECIMAL(18,2) NOT NULL,
        amount_received DECIMAL(18,2) NOT NULL, reference VARCHAR(120) NULL,
        status VARCHAR(16) NOT NULL, sale_payment_id CHAR(36) NULL,
        PRIMARY KEY (id), UNIQUE KEY uq_customer_order_payments_id_tenant (id, tenant_id),
        UNIQUE KEY uq_customer_order_payments_number (order_id, line_number),
        CONSTRAINT fk_customer_order_payments_order FOREIGN KEY (order_id, tenant_id) REFERENCES customer_orders(id, tenant_id) ON DELETE RESTRICT,
        CONSTRAINT fk_customer_order_payments_sale_payment FOREIGN KEY (sale_payment_id, tenant_id) REFERENCES sale_payments(id, tenant_id) ON DELETE RESTRICT,
        CONSTRAINT ck_customer_order_payments_method CHECK (method IN ('CASH', 'CARD', 'TRANSFER', 'VOUCHER')),
        CONSTRAINT ck_customer_order_payments_status CHECK (status IN ('PLANNED', 'COMPLETED', 'CANCELLED')),
        CONSTRAINT ck_customer_order_payments_amount CHECK (amount > 0 AND amount_received >= amount)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);
    await queryRunner.query(`
      CREATE TABLE customer_order_transitions (
        id CHAR(36) NOT NULL, tenant_id CHAR(36) NOT NULL, order_id CHAR(36) NOT NULL,
        from_status VARCHAR(24) NOT NULL, to_status VARCHAR(24) NOT NULL,
        reason VARCHAR(240) NULL, actor_user_id CHAR(36) NOT NULL,
        idempotency_key VARCHAR(128) NOT NULL, request_fingerprint CHAR(64) NOT NULL,
        created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
        PRIMARY KEY (id), UNIQUE KEY uq_customer_order_transitions_key (tenant_id, idempotency_key),
        KEY ix_customer_order_transitions_order (tenant_id, order_id, created_at),
        CONSTRAINT fk_customer_order_transitions_order FOREIGN KEY (order_id, tenant_id) REFERENCES customer_orders(id, tenant_id) ON DELETE RESTRICT,
        CONSTRAINT fk_customer_order_transitions_user FOREIGN KEY (actor_user_id) REFERENCES users(id) ON DELETE RESTRICT
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('DROP TABLE customer_order_transitions');
    await queryRunner.query('DROP TABLE customer_order_payments');
    await queryRunner.query('DROP TABLE customer_order_lines');
    await queryRunner.query('DROP TABLE customer_orders');
  }
}
