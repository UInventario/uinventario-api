import { ConflictException } from '@nestjs/common';
import type { EntityManager } from 'typeorm';

export async function assertInventoryReconciliationOperational(
  manager: EntityManager,
  tenantId: string,
): Promise<void> {
  const [guard] = await manager.query<
    Array<{ latest_run_id: string; operations_blocked: number | boolean }>
  >(
    `SELECT latest_run_id, operations_blocked
     FROM inventory_reconciliation_guards
     WHERE tenant_id = ?`,
    [tenantId],
  );
  if (guard && Boolean(guard.operations_blocked)) {
    throw new ConflictException({
      code: 'INVENTORY_RECONCILIATION_BLOCKED',
      reconciliationRunId: guard.latest_run_id,
      message:
        'El inventario tiene hallazgos críticos. Resuélvelos y ejecuta una reconciliación limpia antes de operar.',
    });
  }
}
