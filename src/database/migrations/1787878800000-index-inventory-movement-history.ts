import { MigrationInterface, QueryRunner } from 'typeorm';

export class IndexInventoryMovementHistory1787878800000 implements MigrationInterface {
  name = 'IndexInventoryMovementHistory1787878800000';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE inventory_movements
      ADD KEY ix_inventory_movements_history (tenant_id, created_at, id),
      ADD KEY ix_inventory_movements_history_type (tenant_id, type, created_at, id),
      ADD KEY ix_inventory_movements_history_location (tenant_id, location_id, created_at, id),
      ADD KEY ix_inventory_movements_history_user (tenant_id, created_by_user_id, created_at, id)
    `);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE inventory_movements
      DROP KEY ix_inventory_movements_history_user,
      DROP KEY ix_inventory_movements_history_location,
      DROP KEY ix_inventory_movements_history_type,
      DROP KEY ix_inventory_movements_history
    `);
  }
}
