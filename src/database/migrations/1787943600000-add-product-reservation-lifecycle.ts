import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddProductReservationLifecycle1787943600000 implements MigrationInterface {
  name = 'AddProductReservationLifecycle1787943600000';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE product_reservations
      DROP CHECK ck_product_reservations_status,
      ADD closed_by_user_id CHAR(36) NULL AFTER created_by_user_id,
      ADD closed_at DATETIME(6) NULL AFTER created_at,
      ADD closure_reason VARCHAR(160) NULL AFTER closed_at,
      ADD closed_idempotency_key VARCHAR(128) NULL AFTER idempotency_key,
      ADD closed_request_fingerprint CHAR(64) NULL AFTER request_fingerprint,
      ADD sale_id CHAR(36) NULL AFTER customer_id,
      ADD UNIQUE KEY uq_product_reservations_closed_key (tenant_id, closed_idempotency_key),
      ADD UNIQUE KEY uq_product_reservations_sale (tenant_id, sale_id),
      ADD CONSTRAINT fk_product_reservations_closed_user FOREIGN KEY (closed_by_user_id)
        REFERENCES users(id) ON DELETE RESTRICT,
      ADD CONSTRAINT fk_product_reservations_sale FOREIGN KEY (sale_id, tenant_id)
        REFERENCES sales(id, tenant_id) ON DELETE RESTRICT,
      ADD CONSTRAINT ck_product_reservations_status
        CHECK (status IN ('ACTIVE', 'RELEASED', 'EXPIRED', 'CONSUMED')),
      ADD CONSTRAINT ck_product_reservations_closure CHECK (
        (status = 'ACTIVE' AND closed_by_user_id IS NULL AND closed_at IS NULL
          AND closure_reason IS NULL AND closed_idempotency_key IS NULL
          AND closed_request_fingerprint IS NULL AND sale_id IS NULL)
        OR
        (status IN ('RELEASED', 'EXPIRED') AND closed_by_user_id IS NOT NULL
          AND closed_at IS NOT NULL AND closure_reason IS NOT NULL
          AND closed_idempotency_key IS NOT NULL AND closed_request_fingerprint IS NOT NULL
          AND sale_id IS NULL)
        OR
        (status = 'CONSUMED' AND closed_by_user_id IS NOT NULL AND closed_at IS NOT NULL
          AND closure_reason IS NOT NULL AND closed_idempotency_key IS NOT NULL
          AND closed_request_fingerprint IS NOT NULL AND sale_id IS NOT NULL)
      )
    `);
    await queryRunner.query(`
      ALTER TABLE sales
      ADD reservation_id CHAR(36) NULL AFTER customer_id,
      ADD UNIQUE KEY uq_sales_reservation (tenant_id, reservation_id),
      ADD CONSTRAINT fk_sales_reservation FOREIGN KEY (reservation_id, tenant_id)
        REFERENCES product_reservations(id, tenant_id) ON DELETE RESTRICT
    `);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    const [closed] = (await queryRunner.query(
      "SELECT COUNT(*) AS total FROM product_reservations WHERE status <> 'ACTIVE'",
    )) as Array<{ total: number | string }>;
    if (Number(closed?.total ?? 0) > 0)
      throw new Error(
        'Cannot revert reservation lifecycle while closed reservations exist',
      );
    await queryRunner.query(`
      ALTER TABLE sales
      DROP FOREIGN KEY fk_sales_reservation,
      DROP KEY uq_sales_reservation,
      DROP COLUMN reservation_id
    `);
    await queryRunner.query(`
      ALTER TABLE product_reservations
      DROP FOREIGN KEY fk_product_reservations_sale,
      DROP FOREIGN KEY fk_product_reservations_closed_user,
      DROP CHECK ck_product_reservations_closure,
      DROP CHECK ck_product_reservations_status,
      DROP KEY uq_product_reservations_sale,
      DROP KEY uq_product_reservations_closed_key,
      DROP COLUMN sale_id,
      DROP COLUMN closed_request_fingerprint,
      DROP COLUMN closed_idempotency_key,
      DROP COLUMN closure_reason,
      DROP COLUMN closed_at,
      DROP COLUMN closed_by_user_id,
      ADD CONSTRAINT ck_product_reservations_status CHECK (status IN ('ACTIVE'))
    `);
  }
}
