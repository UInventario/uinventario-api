import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddProductQuantityPolicy1788080400000 implements MigrationInterface {
  name = 'AddProductQuantityPolicy1788080400000';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE products
        ADD COLUMN base_unit ENUM('UNIT','KILOGRAM','GRAM','LITER','MILLILITER','METER','CENTIMETER')
          NOT NULL DEFAULT 'UNIT' AFTER barcode,
        ADD COLUMN quantity_precision TINYINT UNSIGNED NOT NULL DEFAULT 3 AFTER base_unit,
        ADD COLUMN quantity_rounding ENUM('HALF_UP','DOWN','UP')
          NOT NULL DEFAULT 'HALF_UP' AFTER quantity_precision,
        ADD COLUMN minimum_quantity DECIMAL(15,3) NOT NULL DEFAULT 0.001 AFTER quantity_rounding,
        ADD CONSTRAINT ck_products_quantity_precision CHECK (quantity_precision <= 3),
        ADD CONSTRAINT ck_products_minimum_quantity CHECK (minimum_quantity > 0)
    `);
    await queryRunner.query(`
      UPDATE products SET quantity_precision = 0, minimum_quantity = 1.000
      WHERE track_serials = TRUE
    `);
    await queryRunner.query(`
      ALTER TABLE products
        ADD CONSTRAINT ck_products_serial_quantity_policy CHECK (
          track_serials = FALSE OR
          (base_unit = 'UNIT' AND quantity_precision = 0 AND minimum_quantity = 1.000)
        )
    `);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE products
        DROP CHECK ck_products_serial_quantity_policy,
        DROP CHECK ck_products_minimum_quantity,
        DROP CHECK ck_products_quantity_precision,
        DROP COLUMN minimum_quantity,
        DROP COLUMN quantity_rounding,
        DROP COLUMN quantity_precision,
        DROP COLUMN base_unit
    `);
  }
}
