import { MigrationInterface, QueryRunner } from 'typeorm';

export class LinkSalesToInventory1787846400000 implements MigrationInterface {
  name = 'LinkSalesToInventory1787846400000';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      'ALTER TABLE sale_lines ADD UNIQUE KEY uq_sale_lines_id_tenant (id, tenant_id)',
    );
    await queryRunner.query(`
      ALTER TABLE inventory_movements
      DROP CHECK ck_inventory_movements_type,
      ADD sale_id CHAR(36) NULL AFTER created_by_user_id,
      ADD sale_line_id CHAR(36) NULL AFTER sale_id,
      ADD KEY ix_inventory_movements_sale (tenant_id, sale_id),
      ADD CONSTRAINT fk_inventory_movements_sale_tenant
        FOREIGN KEY (sale_id, tenant_id) REFERENCES sales(id, tenant_id) ON DELETE RESTRICT,
      ADD CONSTRAINT fk_inventory_movements_sale_line_tenant
        FOREIGN KEY (sale_line_id, tenant_id) REFERENCES sale_lines(id, tenant_id) ON DELETE RESTRICT,
      ADD CONSTRAINT ck_inventory_movements_type
        CHECK (type IN ('INITIAL', 'ENTRY', 'ADJUSTMENT', 'SALE')),
      ADD CONSTRAINT ck_inventory_movements_sale_link
        CHECK ((type = 'SALE' AND sale_id IS NOT NULL AND sale_line_id IS NOT NULL)
          OR (type <> 'SALE' AND sale_id IS NULL AND sale_line_id IS NULL))
    `);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE inventory_movements
      DROP CHECK ck_inventory_movements_sale_link,
      DROP CHECK ck_inventory_movements_type,
      DROP FOREIGN KEY fk_inventory_movements_sale_line_tenant,
      DROP FOREIGN KEY fk_inventory_movements_sale_tenant,
      DROP KEY ix_inventory_movements_sale,
      DROP COLUMN sale_line_id,
      DROP COLUMN sale_id,
      ADD CONSTRAINT ck_inventory_movements_type
        CHECK (type IN ('INITIAL', 'ENTRY', 'ADJUSTMENT'))
    `);
    await queryRunner.query(
      'ALTER TABLE sale_lines DROP KEY uq_sale_lines_id_tenant',
    );
  }
}
