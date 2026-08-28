import { MigrationInterface, QueryRunner } from 'typeorm';

export class ExpandInventoryMovementTypes1787860800000 implements MigrationInterface {
  name = 'ExpandInventoryMovementTypes1787860800000';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE inventory_movements
      DROP CHECK ck_inventory_movements_type,
      ADD CONSTRAINT ck_inventory_movements_type
        CHECK (type IN ('INITIAL', 'ENTRY', 'EXIT', 'RETURN', 'LOSS', 'DAMAGE', 'ADJUSTMENT', 'SALE'))
    `);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      UPDATE inventory_movements
      SET type = CASE
        WHEN type = 'RETURN' THEN 'ENTRY'
        WHEN type IN ('EXIT', 'LOSS', 'DAMAGE') THEN 'ADJUSTMENT'
        ELSE type
      END
      WHERE type IN ('EXIT', 'RETURN', 'LOSS', 'DAMAGE')
    `);
    await queryRunner.query(`
      ALTER TABLE inventory_movements
      DROP CHECK ck_inventory_movements_type,
      ADD CONSTRAINT ck_inventory_movements_type
        CHECK (type IN ('INITIAL', 'ENTRY', 'ADJUSTMENT', 'SALE'))
    `);
  }
}
