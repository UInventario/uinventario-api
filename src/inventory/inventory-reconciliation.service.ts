import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { DataSource, EntityManager, QueryFailedError } from 'typeorm';
import { AuditService } from '../audit/audit.service';
import type {
  InventoryReconciliationFindingData,
  InventoryReconciliationRunData,
  InventoryReconciliationSeverity,
} from './inventory-reconciliation.types';
import type { InventoryValuationMethod } from './inventory-valuation-policy.types';

interface FindingInput {
  code: string;
  severity: InventoryReconciliationSeverity;
  scopeType: InventoryReconciliationFindingData['scopeType'];
  productId?: string | null;
  locationId?: string | null;
  subjectReference?: string | null;
  expectedValue?: string | number | null;
  actualValue?: string | number | null;
  differenceValue?: string | number | null;
  message: string;
  recommendedAction: string;
  blocksOperations: boolean;
}

interface QuantityMismatchRow {
  product_id: string;
  location_id: string | null;
  product_name: string;
  product_sku: string;
  location_code: string | null;
  expected_value: string;
  actual_value: string;
  difference_value: string;
}

@Injectable()
export class InventoryReconciliationService {
  private readonly logger = new Logger(InventoryReconciliationService.name);

  constructor(
    private readonly dataSource: DataSource,
    private readonly audit: AuditService,
  ) {}

  async run(input: {
    tenantId: string;
    userId: string;
    idempotencyKey: string | undefined;
    correlationId: string;
  }) {
    this.assertIdempotencyKey(input.idempotencyKey);
    try {
      const result = await this.dataSource.transaction(async (manager) => {
        const [replay] = await manager.query<Array<{ id: string }>>(
          `SELECT id FROM inventory_reconciliation_runs
           WHERE tenant_id = ? AND idempotency_key = ? LIMIT 1`,
          [input.tenantId, input.idempotencyKey],
        );
        if (replay) {
          return {
            data: await this.load(manager, input.tenantId, replay.id),
            replay: true,
          };
        }

        const runId = randomUUID();
        await manager.query(
          `INSERT INTO inventory_reconciliation_runs
            (id, tenant_id, idempotency_key, status, correlation_id,
             created_by_user_id)
           VALUES (?, ?, ?, 'RUNNING', ?, ?)`,
          [
            runId,
            input.tenantId,
            input.idempotencyKey,
            input.correlationId,
            input.userId,
          ],
        );

        const findings = await this.collect(manager, input.tenantId);
        await this.persistFindings(manager, input.tenantId, runId, findings);

        const warnings = findings.filter(
          ({ severity }) => severity === 'WARNING',
        ).length;
        const critical = findings.length - warnings;
        const operationsBlocked = findings.some(
          ({ blocksOperations }) => blocksOperations,
        );
        const overallStatus =
          critical > 0 ? 'CRITICAL' : warnings > 0 ? 'WARNING' : 'HEALTHY';
        await manager.query(
          `UPDATE inventory_reconciliation_runs
           SET status = 'COMPLETED', overall_status = ?, finding_count = ?,
               warning_count = ?, critical_count = ?, operations_blocked = ?,
               finished_at = CURRENT_TIMESTAMP(6)
           WHERE id = ? AND tenant_id = ?`,
          [
            overallStatus,
            findings.length,
            warnings,
            critical,
            operationsBlocked,
            runId,
            input.tenantId,
          ],
        );
        await manager.query(
          `INSERT INTO inventory_reconciliation_guards
            (tenant_id, latest_run_id, operations_blocked)
           VALUES (?, ?, ?)
           ON DUPLICATE KEY UPDATE latest_run_id = VALUES(latest_run_id),
             operations_blocked = VALUES(operations_blocked)`,
          [input.tenantId, runId, operationsBlocked],
        );
        await this.audit.recordInTransaction(manager, {
          tenantId: input.tenantId,
          actorUserId: input.userId,
          action: 'INVENTORY_RECONCILIATION_COMPLETED',
          entityType: 'INVENTORY_RECONCILIATION_RUN',
          entityId: runId,
          correlationId: input.correlationId,
          deduplicate: true,
          after: {
            overallStatus,
            findings: findings.length,
            warnings,
            critical,
            operationsBlocked,
          },
        });
        return {
          data: await this.load(manager, input.tenantId, runId),
          replay: false,
        };
      });
      this.logCompleted(input.tenantId, result.data);
      return {
        data: result.data,
        meta: { apiVersion: '1' as const, idempotentReplay: result.replay },
      };
    } catch (error) {
      if (this.isDuplicate(error)) {
        const [run] = await this.dataSource.query<Array<{ id: string }>>(
          `SELECT id FROM inventory_reconciliation_runs
           WHERE tenant_id = ? AND idempotency_key = ? LIMIT 1`,
          [input.tenantId, input.idempotencyKey],
        );
        if (run)
          return {
            data: await this.load(
              this.dataSource.manager,
              input.tenantId,
              run.id,
            ),
            meta: { apiVersion: '1' as const, idempotentReplay: true },
          };
      }
      throw error;
    }
  }

  async latest(tenantId: string) {
    const [run] = await this.dataSource.query<Array<{ id: string }>>(
      `SELECT id FROM inventory_reconciliation_runs
       WHERE tenant_id = ? AND status = 'COMPLETED'
       ORDER BY started_at DESC, id DESC LIMIT 1`,
      [tenantId],
    );
    return {
      data: run
        ? await this.load(this.dataSource.manager, tenantId, run.id)
        : null,
      meta: { apiVersion: '1' as const },
    };
  }

  async get(tenantId: string, runId: string) {
    return {
      data: await this.load(this.dataSource.manager, tenantId, runId),
      meta: { apiVersion: '1' as const },
    };
  }

  private async collect(
    manager: EntityManager,
    tenantId: string,
  ): Promise<FindingInput[]> {
    const [policy] = await manager.query<
      Array<{ method: InventoryValuationMethod }>
    >(
      'SELECT method FROM inventory_valuation_policies WHERE tenant_id = ? LIMIT 1',
      [tenantId],
    );
    if (!policy)
      throw new NotFoundException('Inventory valuation policy not found.');
    const findings: FindingInput[] = [];

    const movementRows = await manager.query<QuantityMismatchRow[]>(
      `SELECT scope_keys.product_id, scope_keys.location_id, p.name AS product_name,
              p.sku AS product_sku, l.code AS location_code,
              COALESCE(m.quantity, 0) AS expected_value,
              COALESCE(ib.quantity, 0) AS actual_value,
              COALESCE(ib.quantity, 0) - COALESCE(m.quantity, 0) AS difference_value
       FROM (
         SELECT tenant_id, product_id, location_id FROM inventory_balances WHERE tenant_id = ?
         UNION
         SELECT tenant_id, product_id, location_id FROM inventory_movements WHERE tenant_id = ?
       ) scope_keys
       INNER JOIN products p ON p.id = scope_keys.product_id AND p.tenant_id = scope_keys.tenant_id
       INNER JOIN locations l ON l.id = scope_keys.location_id AND l.tenant_id = scope_keys.tenant_id
       LEFT JOIN inventory_balances ib ON ib.tenant_id = scope_keys.tenant_id
         AND ib.product_id = scope_keys.product_id AND ib.location_id = scope_keys.location_id
       LEFT JOIN (
         SELECT tenant_id, product_id, location_id, SUM(quantity_change) AS quantity
         FROM inventory_movements WHERE tenant_id = ?
         GROUP BY tenant_id, product_id, location_id
       ) m ON m.tenant_id = scope_keys.tenant_id AND m.product_id = scope_keys.product_id
         AND m.location_id = scope_keys.location_id
       WHERE ABS(COALESCE(ib.quantity, 0) - COALESCE(m.quantity, 0)) > 0.0005`,
      [tenantId, tenantId, tenantId],
    );
    this.addQuantityRows(findings, movementRows, {
      code: 'BALANCE_MOVEMENT_MISMATCH',
      scopeType: 'LOCATION',
      message: (row) =>
        `El saldo de ${row.product_sku} en ${row.location_code} no coincide con sus movimientos.`,
      action:
        'Revisar la secuencia de movimientos y restaurar el saldo mediante un ajuste autorizado.',
      severity: 'CRITICAL',
      blocksOperations: true,
    });

    const stateRows = await manager.query<QuantityMismatchRow[]>(
      `SELECT ib.product_id, ib.location_id, p.name AS product_name,
              p.sku AS product_sku, l.code AS location_code,
              ib.quantity AS expected_value,
              ib.available_quantity + ib.reserved_quantity + ib.damaged_quantity
                + ib.in_transit_quantity AS actual_value,
              (ib.available_quantity + ib.reserved_quantity + ib.damaged_quantity
                + ib.in_transit_quantity) - ib.quantity AS difference_value
       FROM inventory_balances ib
       INNER JOIN products p ON p.id = ib.product_id AND p.tenant_id = ib.tenant_id
       INNER JOIN locations l ON l.id = ib.location_id AND l.tenant_id = ib.tenant_id
       WHERE ib.tenant_id = ? AND ABS(ib.quantity - ib.available_quantity
         - ib.reserved_quantity - ib.damaged_quantity - ib.in_transit_quantity) > 0.0005`,
      [tenantId],
    );
    this.addQuantityRows(findings, stateRows, {
      code: 'BALANCE_STATE_MISMATCH',
      scopeType: 'LOCATION',
      message: (row) =>
        `Los estados de stock de ${row.product_sku} en ${row.location_code} no suman el saldo total.`,
      action:
        'Revisar los estados disponible, reservado, dañado y en tránsito antes de operar.',
      severity: 'CRITICAL',
      blocksOperations: true,
    });

    const valuationRows = await manager.query<
      Array<
        QuantityMismatchRow & {
          movement_value: string;
          valuation_value: string;
          value_difference: string;
        }
      >
    >(
      `SELECT p.id AS product_id, NULL AS location_id, p.name AS product_name,
              p.sku AS product_sku, NULL AS location_code,
              COALESCE(b.quantity, 0) AS expected_value,
              COALESCE(iv.quantity, 0) AS actual_value,
              COALESCE(iv.quantity, 0) - COALESCE(b.quantity, 0) AS difference_value,
              COALESCE(m.inventory_value, 0) AS movement_value,
              COALESCE(iv.inventory_value, 0) AS valuation_value,
              COALESCE(iv.inventory_value, 0) - COALESCE(m.inventory_value, 0)
                AS value_difference
       FROM products p
       LEFT JOIN (
         SELECT tenant_id, product_id, SUM(quantity) AS quantity
         FROM inventory_balances WHERE tenant_id = ? GROUP BY tenant_id, product_id
       ) b ON b.tenant_id = p.tenant_id AND b.product_id = p.id
       LEFT JOIN (
         SELECT tenant_id, product_id, SUM(value_change) AS inventory_value
         FROM inventory_movements WHERE tenant_id = ? GROUP BY tenant_id, product_id
       ) m ON m.tenant_id = p.tenant_id AND m.product_id = p.id
       LEFT JOIN inventory_valuations iv ON iv.tenant_id = p.tenant_id
         AND iv.product_id = p.id
       WHERE p.tenant_id = ? AND (
         ABS(COALESCE(iv.quantity, 0) - COALESCE(b.quantity, 0)) > 0.0005 OR
         ABS(COALESCE(iv.inventory_value, 0) - COALESCE(m.inventory_value, 0)) > 0.00005
       )`,
      [tenantId, tenantId, tenantId],
    );
    for (const row of valuationRows) {
      if (Math.abs(Number(row.difference_value)) > 0.0005)
        findings.push(
          this.findingFromRow(row, {
            code: 'VALUATION_QUANTITY_MISMATCH',
            scopeType: 'VALUATION',
            severity: 'CRITICAL',
            blocksOperations: true,
            message: `La valorización de ${row.product_sku} no coincide con la existencia agregada.`,
            action:
              'Revisar movimientos y proyección de valorización; no sobrescribir importes manualmente.',
          }),
        );
      if (Math.abs(Number(row.value_difference)) > 0.00005)
        findings.push({
          ...this.findingFromRow(row, {
            code: 'VALUATION_VALUE_MISMATCH',
            scopeType: 'VALUATION',
            severity: 'CRITICAL',
            blocksOperations: true,
            message: `El valor acumulado de ${row.product_sku} no coincide con el historial valorizado.`,
            action:
              'Revisar costos y movimientos valorizados antes de vender o reportar.',
          }),
          expectedValue: row.movement_value,
          actualValue: row.valuation_value,
          differenceValue: row.value_difference,
        });
    }

    await this.collectFifo(manager, tenantId, policy.method, findings);
    await this.collectLots(manager, tenantId, findings);
    await this.collectSerials(manager, tenantId, findings);
    return findings;
  }

  private async collectFifo(
    manager: EntityManager,
    tenantId: string,
    method: InventoryValuationMethod,
    findings: FindingInput[],
  ): Promise<void> {
    const rows = await manager.query<QuantityMismatchRow[]>(
      `SELECT scope_keys.product_id, scope_keys.location_id, p.name AS product_name,
              p.sku AS product_sku, l.code AS location_code,
              COALESCE(ib.quantity, 0) AS expected_value,
              COALESCE(f.quantity, 0) AS actual_value,
              COALESCE(f.quantity, 0) - COALESCE(ib.quantity, 0) AS difference_value
       FROM (
         SELECT tenant_id, product_id, location_id FROM inventory_balances WHERE tenant_id = ?
         UNION
         SELECT tenant_id, product_id, location_id FROM inventory_fifo_layers WHERE tenant_id = ?
       ) scope_keys
       INNER JOIN products p ON p.id = scope_keys.product_id AND p.tenant_id = scope_keys.tenant_id
       INNER JOIN locations l ON l.id = scope_keys.location_id AND l.tenant_id = scope_keys.tenant_id
       LEFT JOIN inventory_balances ib ON ib.tenant_id = scope_keys.tenant_id
         AND ib.product_id = scope_keys.product_id AND ib.location_id = scope_keys.location_id
       LEFT JOIN (
         SELECT tenant_id, product_id, location_id, SUM(remaining_quantity) AS quantity
         FROM inventory_fifo_layers WHERE tenant_id = ?
         GROUP BY tenant_id, product_id, location_id
       ) f ON f.tenant_id = scope_keys.tenant_id AND f.product_id = scope_keys.product_id
         AND f.location_id = scope_keys.location_id
       WHERE ABS(COALESCE(f.quantity, 0) - COALESCE(ib.quantity, 0)) > 0.0005`,
      [tenantId, tenantId, tenantId],
    );
    const active = method === 'FIFO';
    this.addQuantityRows(findings, rows, {
      code: 'FIFO_LAYER_MISMATCH',
      scopeType: 'VALUATION',
      message: (row) =>
        `Las capas FIFO de ${row.product_sku} en ${row.location_code} no coinciden con el saldo.`,
      action:
        'Revisar asignaciones y capas FIFO antes de usar esa valorización.',
      severity: active ? 'CRITICAL' : 'WARNING',
      blocksOperations: active,
    });
  }

  private async collectLots(
    manager: EntityManager,
    tenantId: string,
    findings: FindingInput[],
  ): Promise<void> {
    const rows = await manager.query<QuantityMismatchRow[]>(
      `SELECT scope_keys.product_id, scope_keys.location_id, p.name AS product_name,
              p.sku AS product_sku, l.code AS location_code,
              COALESCE(ib.quantity, 0) AS expected_value,
              COALESCE(lb.quantity, 0) AS actual_value,
              COALESCE(lb.quantity, 0) - COALESCE(ib.quantity, 0) AS difference_value
       FROM (
         SELECT tenant_id, product_id, location_id FROM inventory_balances WHERE tenant_id = ?
         UNION
         SELECT il.tenant_id, il.product_id, ilb.location_id
         FROM inventory_lots il INNER JOIN inventory_lot_balances ilb
           ON ilb.tenant_id = il.tenant_id AND ilb.lot_id = il.id
         WHERE il.tenant_id = ?
       ) scope_keys
       INNER JOIN products p ON p.id = scope_keys.product_id AND p.tenant_id = scope_keys.tenant_id
         AND p.track_lots = TRUE
       INNER JOIN locations l ON l.id = scope_keys.location_id AND l.tenant_id = scope_keys.tenant_id
       LEFT JOIN inventory_balances ib ON ib.tenant_id = scope_keys.tenant_id
         AND ib.product_id = scope_keys.product_id AND ib.location_id = scope_keys.location_id
       LEFT JOIN (
         SELECT il.tenant_id, il.product_id, ilb.location_id, SUM(ilb.quantity) AS quantity
         FROM inventory_lots il INNER JOIN inventory_lot_balances ilb
           ON ilb.tenant_id = il.tenant_id AND ilb.lot_id = il.id
         WHERE il.tenant_id = ? GROUP BY il.tenant_id, il.product_id, ilb.location_id
       ) lb ON lb.tenant_id = scope_keys.tenant_id AND lb.product_id = scope_keys.product_id
         AND lb.location_id = scope_keys.location_id
       WHERE ABS(COALESCE(lb.quantity, 0) - COALESCE(ib.quantity, 0)) > 0.0005`,
      [tenantId, tenantId, tenantId],
    );
    this.addQuantityRows(findings, rows, {
      code: 'LOT_BALANCE_MISMATCH',
      scopeType: 'LOT',
      message: (row) =>
        `Los lotes de ${row.product_sku} en ${row.location_code} no coinciden con el saldo.`,
      action: 'Revisar los movimientos y saldos de lote del producto.',
      severity: 'CRITICAL',
      blocksOperations: true,
    });

    const ledgerRows = await manager.query<
      Array<QuantityMismatchRow & { lot_code: string }>
    >(
      `SELECT il.product_id, ilb.location_id, p.name AS product_name,
              p.sku AS product_sku, l.code AS location_code, il.code AS lot_code,
              COALESCE(SUM(iml.quantity_change), 0) AS expected_value,
              ilb.quantity AS actual_value,
              ilb.quantity - COALESCE(SUM(iml.quantity_change), 0) AS difference_value
       FROM inventory_lot_balances ilb
       INNER JOIN inventory_lots il ON il.id = ilb.lot_id AND il.tenant_id = ilb.tenant_id
       INNER JOIN products p ON p.id = il.product_id AND p.tenant_id = il.tenant_id
       INNER JOIN locations l ON l.id = ilb.location_id AND l.tenant_id = ilb.tenant_id
       LEFT JOIN inventory_movement_lots iml ON iml.tenant_id = ilb.tenant_id
         AND iml.lot_id = ilb.lot_id AND iml.location_id = ilb.location_id
       WHERE ilb.tenant_id = ?
       GROUP BY il.product_id, ilb.location_id, p.name, p.sku, l.code,
                il.code, ilb.quantity
       HAVING ABS(ilb.quantity - COALESCE(SUM(iml.quantity_change), 0)) > 0.0005`,
      [tenantId],
    );
    for (const row of ledgerRows)
      findings.push({
        ...this.findingFromRow(row, {
          code: 'LOT_LEDGER_MISMATCH',
          scopeType: 'LOT',
          severity: 'CRITICAL',
          blocksOperations: true,
          message: `El lote ${row.lot_code} de ${row.product_sku} no coincide con su historial.`,
          action: 'Revisar la cadena de asignaciones de este lote.',
        }),
        subjectReference: row.lot_code,
      });
  }

  private async collectSerials(
    manager: EntityManager,
    tenantId: string,
    findings: FindingInput[],
  ): Promise<void> {
    const rows = await manager.query<
      Array<{
        product_id: string;
        location_id: string;
        product_name: string;
        product_sku: string;
        location_code: string;
        available_quantity: string;
        reserved_quantity: string;
        damaged_quantity: string;
        in_transit_quantity: string;
        serial_available: number | string;
        serial_reserved: number | string;
        serial_damaged: number | string;
        serial_in_transit: number | string;
      }>
    >(
      `SELECT ib.product_id, ib.location_id, p.name AS product_name,
              p.sku AS product_sku, l.code AS location_code,
              ib.available_quantity, ib.reserved_quantity, ib.damaged_quantity,
              ib.in_transit_quantity,
              SUM(CASE WHEN s.status = 'AVAILABLE' THEN 1 ELSE 0 END) AS serial_available,
              SUM(CASE WHEN s.status = 'RESERVED' THEN 1 ELSE 0 END) AS serial_reserved,
              SUM(CASE WHEN s.status = 'DAMAGED' THEN 1 ELSE 0 END) AS serial_damaged,
              SUM(CASE WHEN s.status = 'IN_TRANSIT' THEN 1 ELSE 0 END) AS serial_in_transit
       FROM inventory_balances ib
       INNER JOIN products p ON p.id = ib.product_id AND p.tenant_id = ib.tenant_id
         AND p.track_serials = TRUE
       INNER JOIN locations l ON l.id = ib.location_id AND l.tenant_id = ib.tenant_id
       LEFT JOIN inventory_serials s ON s.tenant_id = ib.tenant_id
         AND s.product_id = ib.product_id AND s.current_location_id = ib.location_id
         AND s.status IN ('AVAILABLE', 'RESERVED', 'DAMAGED', 'IN_TRANSIT')
       WHERE ib.tenant_id = ?
       GROUP BY ib.product_id, ib.location_id, p.name, p.sku, l.code,
                ib.available_quantity, ib.reserved_quantity,
                ib.damaged_quantity, ib.in_transit_quantity`,
      [tenantId],
    );
    const states = [
      ['AVAILABLE', 'available_quantity', 'serial_available'],
      ['RESERVED', 'reserved_quantity', 'serial_reserved'],
      ['DAMAGED', 'damaged_quantity', 'serial_damaged'],
      ['IN_TRANSIT', 'in_transit_quantity', 'serial_in_transit'],
    ] as const;
    for (const row of rows) {
      for (const [state, balanceKey, serialKey] of states) {
        const expected = Number(row[balanceKey]);
        const actual = Number(row[serialKey]);
        if (Math.abs(expected - actual) <= 0.0005) continue;
        findings.push({
          code: 'SERIAL_STATE_MISMATCH',
          severity: 'CRITICAL',
          scopeType: 'SERIAL',
          productId: row.product_id,
          locationId: row.location_id,
          subjectReference: state,
          expectedValue: row[balanceKey],
          actualValue: row[serialKey],
          differenceValue: actual - expected,
          message: `Las series ${state} de ${row.product_sku} en ${row.location_code} no coinciden con el saldo.`,
          recommendedAction:
            'Revisar el estado y la ubicación de cada serie antes de operar.',
          blocksOperations: true,
        });
      }
    }

    const custodyRows = await manager.query<
      Array<{
        serial_id: string;
        serial_number: string;
        product_id: string;
        product_name: string;
        product_sku: string;
        current_location_id: string | null;
        location_code: string | null;
        status: string;
        event_id: string | null;
        event_status: string | null;
        event_location_id: string | null;
        balance_product_id: string | null;
      }>
    >(
      `SELECT s.id AS serial_id, s.serial_number, s.product_id,
              p.name AS product_name, p.sku AS product_sku,
              s.current_location_id, l.code AS location_code, s.status,
              e.id AS event_id, e.to_status AS event_status,
              e.to_location_id AS event_location_id,
              ib.product_id AS balance_product_id
       FROM inventory_serials s
       INNER JOIN products p ON p.id = s.product_id AND p.tenant_id = s.tenant_id
       LEFT JOIN locations l ON l.id = s.current_location_id AND l.tenant_id = s.tenant_id
       LEFT JOIN inventory_serial_events e ON e.tenant_id = s.tenant_id
         AND e.serial_id = s.id
         AND NOT EXISTS (
           SELECT 1 FROM inventory_serial_events newer
           WHERE newer.tenant_id = e.tenant_id AND newer.serial_id = e.serial_id
             AND (newer.created_at > e.created_at OR
               (newer.created_at = e.created_at AND newer.id > e.id))
         )
       LEFT JOIN inventory_balances ib ON ib.tenant_id = s.tenant_id
         AND ib.product_id = s.product_id AND ib.location_id = s.current_location_id
       WHERE s.tenant_id = ? AND (
         (s.status IN ('AVAILABLE', 'RESERVED', 'DAMAGED', 'IN_TRANSIT')
           AND (s.current_location_id IS NULL OR ib.product_id IS NULL)) OR
         (s.status IN ('SOLD', 'RETURNED_TO_SUPPLIER', 'REMOVED')
           AND s.current_location_id IS NOT NULL) OR
         e.id IS NULL OR e.to_status <> s.status OR
         NOT (e.to_location_id <=> s.current_location_id)
       )`,
      [tenantId],
    );
    for (const row of custodyRows) {
      const currentLocationInvalid =
        (['AVAILABLE', 'RESERVED', 'DAMAGED', 'IN_TRANSIT'].includes(
          row.status,
        ) &&
          (row.current_location_id === null ||
            row.balance_product_id === null)) ||
        (['SOLD', 'RETURNED_TO_SUPPLIER', 'REMOVED'].includes(row.status) &&
          row.current_location_id !== null);
      const historyInvalid =
        row.event_id === null ||
        row.event_status !== row.status ||
        row.event_location_id !== row.current_location_id;
      findings.push({
        code: currentLocationInvalid
          ? 'SERIAL_CUSTODY_INVALID'
          : 'SERIAL_HISTORY_MISMATCH',
        severity: 'CRITICAL',
        scopeType: 'SERIAL',
        productId: row.product_id,
        locationId: row.current_location_id,
        subjectReference: row.serial_number,
        message: historyInvalid
          ? `La serie ${row.serial_number} de ${row.product_sku} no coincide con su último evento de custodia.`
          : `La serie ${row.serial_number} de ${row.product_sku} tiene una ubicación incompatible con su estado.`,
        recommendedAction:
          'Revisar la cadena de custodia de la serie y su movimiento de origen.',
        blocksOperations: true,
      });
    }
  }

  private addQuantityRows(
    findings: FindingInput[],
    rows: QuantityMismatchRow[],
    config: {
      code: string;
      scopeType: FindingInput['scopeType'];
      message: (row: QuantityMismatchRow) => string;
      action: string;
      severity: InventoryReconciliationSeverity;
      blocksOperations: boolean;
    },
  ): void {
    for (const row of rows)
      findings.push(
        this.findingFromRow(row, {
          code: config.code,
          scopeType: config.scopeType,
          severity: config.severity,
          blocksOperations: config.blocksOperations,
          message: config.message(row),
          action: config.action,
        }),
      );
  }

  private async persistFindings(
    manager: EntityManager,
    tenantId: string,
    runId: string,
    findings: FindingInput[],
  ): Promise<void> {
    const batchSize = 200;
    for (let offset = 0; offset < findings.length; offset += batchSize) {
      const batch = findings.slice(offset, offset + batchSize);
      const values = batch
        .map(() => '(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
        .join(', ');
      const parameters = batch.flatMap((finding) => [
        randomUUID(),
        tenantId,
        runId,
        finding.code,
        finding.severity,
        finding.scopeType,
        finding.productId ?? null,
        finding.locationId ?? null,
        finding.subjectReference ?? null,
        finding.expectedValue ?? null,
        finding.actualValue ?? null,
        finding.differenceValue ?? null,
        finding.message,
        finding.recommendedAction,
        finding.blocksOperations,
      ]);
      await manager.query(
        `INSERT INTO inventory_reconciliation_findings
          (id, tenant_id, run_id, code, severity, scope_type,
           product_id, location_id, subject_reference, expected_value,
           actual_value, difference_value, message, recommended_action,
           blocks_operations)
         VALUES ${values}`,
        parameters,
      );
    }
  }

  private findingFromRow(
    row: QuantityMismatchRow,
    input: {
      code: string;
      scopeType: FindingInput['scopeType'];
      severity: InventoryReconciliationSeverity;
      blocksOperations: boolean;
      message: string;
      action: string;
    },
  ): FindingInput {
    return {
      code: input.code,
      severity: input.severity,
      scopeType: input.scopeType,
      productId: row.product_id,
      locationId: row.location_id,
      expectedValue: row.expected_value,
      actualValue: row.actual_value,
      differenceValue: row.difference_value,
      message: input.message,
      recommendedAction: input.action,
      blocksOperations: input.blocksOperations,
    };
  }

  private async load(
    manager: EntityManager,
    tenantId: string,
    runId: string,
  ): Promise<InventoryReconciliationRunData> {
    const [run] = await manager.query<
      Array<{
        id: string;
        status: 'RUNNING' | 'COMPLETED';
        overall_status: InventoryReconciliationRunData['overallStatus'];
        finding_count: number | string;
        warning_count: number | string;
        critical_count: number | string;
        operations_blocked: number | boolean;
        correlation_id: string;
        started_at: Date | string;
        finished_at: Date | string | null;
        user_id: string;
        user_email: string;
      }>
    >(
      `SELECT r.id, r.status, r.overall_status, r.finding_count,
              r.warning_count, r.critical_count, r.operations_blocked,
              r.correlation_id, r.started_at, r.finished_at,
              u.id AS user_id, u.email AS user_email
       FROM inventory_reconciliation_runs r
       INNER JOIN users u ON u.id = r.created_by_user_id AND u.tenant_id = r.tenant_id
       WHERE r.id = ? AND r.tenant_id = ? LIMIT 1`,
      [runId, tenantId],
    );
    if (!run)
      throw new NotFoundException('Inventory reconciliation not found.');
    const rows = await manager.query<
      Array<{
        id: string;
        code: string;
        severity: InventoryReconciliationSeverity;
        scope_type: InventoryReconciliationFindingData['scopeType'];
        subject_reference: string | null;
        expected_value: string | null;
        actual_value: string | null;
        difference_value: string | null;
        message: string;
        recommended_action: string;
        blocks_operations: number | boolean;
        product_id: string | null;
        product_name: string | null;
        product_sku: string | null;
        location_id: string | null;
        location_name: string | null;
        location_code: string | null;
      }>
    >(
      `SELECT f.id, f.code, f.severity, f.scope_type, f.subject_reference,
              f.expected_value, f.actual_value, f.difference_value,
              f.message, f.recommended_action, f.blocks_operations,
              p.id AS product_id, p.name AS product_name, p.sku AS product_sku,
              l.id AS location_id, l.name AS location_name, l.code AS location_code
       FROM inventory_reconciliation_findings f
       LEFT JOIN products p ON p.id = f.product_id AND p.tenant_id = f.tenant_id
       LEFT JOIN locations l ON l.id = f.location_id AND l.tenant_id = f.tenant_id
       WHERE f.run_id = ? AND f.tenant_id = ?
       ORDER BY FIELD(f.severity, 'CRITICAL', 'WARNING'), f.code, f.id`,
      [runId, tenantId],
    );
    const blocked = Boolean(run.operations_blocked);
    return {
      id: run.id,
      status: run.status,
      overallStatus: run.overall_status,
      summary: {
        findings: Number(run.finding_count),
        warnings: Number(run.warning_count),
        critical: Number(run.critical_count),
      },
      policy: {
        releaseBlocked: Number(run.critical_count) > 0,
        operationsBlocked: blocked,
      },
      correlationId: run.correlation_id,
      responsible: { id: run.user_id, email: run.user_email },
      startedAt: this.iso(run.started_at),
      finishedAt: run.finished_at ? this.iso(run.finished_at) : null,
      findings: rows.map((row) => ({
        id: row.id,
        code: row.code,
        severity: row.severity,
        scopeType: row.scope_type,
        product: row.product_id
          ? {
              id: row.product_id,
              name: row.product_name!,
              sku: row.product_sku!,
            }
          : null,
        location: row.location_id
          ? {
              id: row.location_id,
              name: row.location_name!,
              code: row.location_code!,
            }
          : null,
        subjectReference: row.subject_reference,
        expectedValue: row.expected_value,
        actualValue: row.actual_value,
        differenceValue: row.difference_value,
        message: row.message,
        recommendedAction: row.recommended_action,
        blocksOperations: Boolean(row.blocks_operations),
      })),
    };
  }

  private assertIdempotencyKey(
    value: string | undefined,
  ): asserts value is string {
    if (!value || !/^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/.test(value))
      throw new BadRequestException({
        code: 'INVALID_IDEMPOTENCY_KEY',
        message:
          'Envía una clave idempotente válida para ejecutar la reconciliación.',
      });
  }

  private isDuplicate(error: unknown): boolean {
    return (
      error instanceof QueryFailedError &&
      Number((error.driverError as { errno?: number }).errno) === 1062
    );
  }

  private iso(value: Date | string): string {
    return value instanceof Date
      ? value.toISOString()
      : new Date(value).toISOString();
  }

  private logCompleted(
    tenantId: string,
    run: InventoryReconciliationRunData,
  ): void {
    this.logger.log(
      JSON.stringify({
        event: 'inventory_reconciliation_completed',
        tenantId,
        runId: run.id,
        status: run.overallStatus,
        ...run.summary,
        operationsBlocked: run.policy.operationsBlocked,
      }),
    );
  }
}
