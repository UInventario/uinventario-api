import { MigrationInterface, QueryRunner } from 'typeorm';

export class CreateProductVariants1788040800000 implements MigrationInterface {
  name = 'CreateProductVariants1788040800000';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE products
      ADD COLUMN parent_product_id CHAR(36) NULL AFTER tenant_id,
      ADD COLUMN variant_schema JSON NULL AFTER barcode,
      ADD COLUMN variant_values JSON NULL AFTER variant_schema,
      ADD KEY ix_products_parent (parent_product_id, tenant_id),
      ADD CONSTRAINT fk_products_parent_tenant
        FOREIGN KEY (parent_product_id, tenant_id)
        REFERENCES products(id, tenant_id) ON DELETE RESTRICT,
      ADD CONSTRAINT ck_products_variant_shape CHECK (
        (parent_product_id IS NULL AND variant_values IS NULL)
        OR (parent_product_id IS NOT NULL AND variant_schema IS NULL AND variant_values IS NOT NULL)
      )
    `);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE products
      DROP FOREIGN KEY fk_products_parent_tenant,
      DROP CHECK ck_products_variant_shape,
      DROP INDEX ix_products_parent,
      DROP COLUMN variant_values,
      DROP COLUMN variant_schema,
      DROP COLUMN parent_product_id
    `);
  }
}
