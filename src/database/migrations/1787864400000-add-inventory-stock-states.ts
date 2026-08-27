import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddInventoryStockStates1787864400000 implements MigrationInterface {
  name = 'AddInventoryStockStates1787864400000';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE inventory_balances
      ADD available_quantity DECIMAL(18,3) NOT NULL DEFAULT 0 AFTER quantity,
      ADD reserved_quantity DECIMAL(18,3) NOT NULL DEFAULT 0 AFTER available_quantity,
      ADD damaged_quantity DECIMAL(18,3) NOT NULL DEFAULT 0 AFTER reserved_quantity,
      ADD in_transit_quantity DECIMAL(18,3) NOT NULL DEFAULT 0 AFTER damaged_quantity
    `);
    await queryRunner.query(
      'UPDATE inventory_balances SET available_quantity = quantity',
    );
    await queryRunner.query(`
      ALTER TABLE inventory_balances
      ADD CONSTRAINT ck_inventory_balance_states_nonnegative
        CHECK (available_quantity >= 0 AND reserved_quantity >= 0 AND damaged_quantity >= 0 AND in_transit_quantity >= 0),
      ADD CONSTRAINT ck_inventory_balance_states_reconcile
        CHECK (quantity = available_quantity + reserved_quantity + damaged_quantity + in_transit_quantity)
    `);
    await queryRunner.query(`
      ALTER TABLE inventory_movements
      DROP CHECK ck_inventory_movements_type,
      DROP CHECK ck_inventory_movements_quantity_nonzero,
      ADD from_state VARCHAR(20) NULL AFTER type,
      ADD to_state VARCHAR(20) NULL AFTER from_state,
      ADD state_quantity DECIMAL(18,3) NULL AFTER to_state,
      ADD CONSTRAINT ck_inventory_movements_type
        CHECK (type IN ('INITIAL', 'ENTRY', 'EXIT', 'RETURN', 'LOSS', 'DAMAGE', 'ADJUSTMENT', 'STATE_TRANSITION', 'SALE')),
      ADD CONSTRAINT ck_inventory_movements_quantity_kind CHECK (
        (type = 'STATE_TRANSITION' AND quantity_change = 0 AND state_quantity > 0
          AND from_state IN ('AVAILABLE', 'RESERVED', 'DAMAGED', 'IN_TRANSIT')
          AND to_state IN ('AVAILABLE', 'RESERVED', 'DAMAGED', 'IN_TRANSIT')
          AND from_state <> to_state)
        OR
        (type <> 'STATE_TRANSITION' AND quantity_change <> 0
          AND from_state IS NULL AND to_state IS NULL AND state_quantity IS NULL)
      )
    `);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    const history = (await queryRunner.query(
      "SELECT COUNT(*) AS total FROM inventory_movements WHERE type = 'STATE_TRANSITION'",
    )) as Array<{ total: number | string }>;
    const [summary] = history;
    if (Number(summary?.total ?? 0) > 0) {
      throw new Error(
        'Cannot revert inventory stock states while state-transition history exists',
      );
    }
    await queryRunner.query(`
      ALTER TABLE inventory_movements
      DROP CHECK ck_inventory_movements_quantity_kind,
      DROP CHECK ck_inventory_movements_type,
      DROP COLUMN state_quantity,
      DROP COLUMN to_state,
      DROP COLUMN from_state,
      ADD CONSTRAINT ck_inventory_movements_type
        CHECK (type IN ('INITIAL', 'ENTRY', 'EXIT', 'RETURN', 'LOSS', 'DAMAGE', 'ADJUSTMENT', 'SALE')),
      ADD CONSTRAINT ck_inventory_movements_quantity_nonzero CHECK (quantity_change <> 0)
    `);
    await queryRunner.query(`
      ALTER TABLE inventory_balances
      DROP CHECK ck_inventory_balance_states_reconcile,
      DROP CHECK ck_inventory_balance_states_nonnegative,
      DROP COLUMN in_transit_quantity,
      DROP COLUMN damaged_quantity,
      DROP COLUMN reserved_quantity,
      DROP COLUMN available_quantity
    `);
  }
}
