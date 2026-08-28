import {
  BadRequestException,
  ConflictException,
  Injectable,
} from '@nestjs/common';
import { createHash, randomUUID } from 'node:crypto';
import { DataSource, EntityManager } from 'typeorm';
import { AuditService } from '../audit/audit.service';
import { ChangeInventoryValuationPolicyDto } from './dto/change-inventory-valuation-policy.dto';
import { loadInventoryValuationPolicy } from './inventory-valuation-policy';
import type {
  InventoryValuationMethod,
  InventoryValuationMigrationPlan,
  InventoryValuationPolicyData,
} from './inventory-valuation-policy.types';

@Injectable()
export class InventoryValuationPolicyService {
  constructor(
    private readonly dataSource: DataSource,
    private readonly audit: AuditService,
  ) {}

  async current(tenantId: string) {
    const data = await loadInventoryValuationPolicy(
      this.dataSource.manager,
      tenantId,
    );
    return { data, meta: { apiVersion: '1' as const } };
  }

  async preview(tenantId: string, targetMethod: InventoryValuationMethod) {
    const plan = await this.plan(
      this.dataSource.manager,
      tenantId,
      targetMethod,
    );
    return { data: plan, meta: { apiVersion: '1' as const } };
  }

  async change(input: {
    tenantId: string;
    userId: string;
    idempotencyKey: string | undefined;
    correlationId: string;
    dto: ChangeInventoryValuationPolicyDto;
  }) {
    this.assertIdempotencyKey(input.idempotencyKey);
    return this.dataSource.transaction(async (manager) => {
      const [replay] = await manager.query<
        Array<{
          to_method: InventoryValuationMethod;
          from_version: number | string;
          to_version: number | string;
          effective_at: Date | string;
          migration_rule: 'FORWARD_ONLY_CUTOVER';
          plan_fingerprint: string;
        }>
      >(
        `SELECT to_method, from_version, to_version, effective_at,
                migration_rule, plan_fingerprint
         FROM inventory_valuation_policy_history
         WHERE tenant_id = ? AND idempotency_key = ?`,
        [input.tenantId, input.idempotencyKey],
      );
      if (replay) {
        if (
          replay.to_method !== input.dto.targetMethod ||
          Number(replay.from_version) !== input.dto.expectedVersion ||
          replay.plan_fingerprint !== input.dto.planFingerprint
        )
          throw new ConflictException({
            code: 'VALUATION_POLICY_IDEMPOTENCY_CONFLICT',
            message: 'La clave idempotente ya se usó para otro corte.',
          });
        const data: InventoryValuationPolicyData = {
          method: replay.to_method,
          version: Number(replay.to_version),
          effectiveAt: this.iso(replay.effective_at),
          migrationRule: replay.migration_rule,
        };
        return { data, meta: { apiVersion: '1' as const, replay: true } };
      }
      const current = await loadInventoryValuationPolicy(
        manager,
        input.tenantId,
        true,
      );
      if (current.version !== input.dto.expectedVersion)
        throw new ConflictException({
          code: 'VALUATION_POLICY_VERSION_CONFLICT',
          currentVersion: current.version,
          message: 'La configuración cambió; genera una prevalidación nueva.',
        });
      const plan = await this.plan(
        manager,
        input.tenantId,
        input.dto.targetMethod,
        current,
      );
      if (plan.planFingerprint !== input.dto.planFingerprint)
        throw new ConflictException({
          code: 'VALUATION_MIGRATION_PLAN_STALE',
          message: 'El inventario cambió; revisa un plan de migración nuevo.',
        });
      if (!plan.allowed)
        throw new ConflictException({
          code: 'VALUATION_METHOD_CHANGE_BLOCKED',
          blockingReasons: plan.blockingReasons,
          message:
            'El método no puede cambiar hasta resolver la prevalidación.',
        });
      const nextVersion = current.version + 1;
      const migrated =
        input.dto.targetMethod === 'SPECIFIC_LOT'
          ? await this.createOpeningLots(
              manager,
              input.tenantId,
              input.userId,
              nextVersion,
            )
          : { products: 0, locations: 0 };
      const [clock] = await manager.query<
        Array<{ effective_at: Date | string }>
      >('SELECT CURRENT_TIMESTAMP(6) AS effective_at');
      const effectiveAt = this.iso(clock.effective_at);
      await manager.query(
        `UPDATE inventory_valuation_policies
         SET method = ?, version = ?, effective_at = ?,
             migration_rule = 'FORWARD_ONLY_CUTOVER', changed_by_user_id = ?
         WHERE tenant_id = ?`,
        [
          input.dto.targetMethod,
          nextVersion,
          this.sqlDate(effectiveAt),
          input.userId,
          input.tenantId,
        ],
      );
      const historyId = randomUUID();
      await manager.query(
        `INSERT INTO inventory_valuation_policy_history
          (id, tenant_id, idempotency_key, from_method, to_method,
           from_version, to_version, effective_at, migration_rule,
           plan_fingerprint, migrated_products, migrated_locations,
           changed_by_user_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'FORWARD_ONLY_CUTOVER', ?, ?, ?, ?)`,
        [
          historyId,
          input.tenantId,
          input.idempotencyKey,
          current.method,
          input.dto.targetMethod,
          current.version,
          nextVersion,
          this.sqlDate(effectiveAt),
          plan.planFingerprint,
          migrated.products,
          migrated.locations,
          input.userId,
        ],
      );
      await manager.query(
        `UPDATE offline_devices
         SET bootstrap_required_at = ?, last_correlation_id = ?
         WHERE tenant_id = ? AND revoked_at IS NULL`,
        [this.sqlDate(effectiveAt), input.correlationId, input.tenantId],
      );
      const data: InventoryValuationPolicyData = {
        method: input.dto.targetMethod,
        version: nextVersion,
        effectiveAt,
        migrationRule: 'FORWARD_ONLY_CUTOVER',
      };
      await this.audit.recordInTransaction(manager, {
        tenantId: input.tenantId,
        actorUserId: input.userId,
        action: 'INVENTORY_VALUATION_METHOD_CHANGED',
        entityType: 'INVENTORY_VALUATION_POLICY',
        entityId: historyId,
        correlationId: input.correlationId,
        deduplicate: true,
        before: { ...current },
        after: {
          ...data,
          planFingerprint: plan.planFingerprint,
          migratedProducts: migrated.products,
          migratedLocations: migrated.locations,
          devicesToRebootstrap: plan.devicesToRebootstrap,
        },
      });
      return { data, meta: { apiVersion: '1' as const, replay: false } };
    });
  }

  async assertSnapshot(
    tenantId: string,
    snapshot: { method: InventoryValuationMethod; version: number },
  ): Promise<void> {
    const current = await loadInventoryValuationPolicy(
      this.dataSource.manager,
      tenantId,
    );
    if (
      current.method !== snapshot.method ||
      current.version !== snapshot.version
    ) {
      throw new ConflictException({
        code: 'OFFLINE_VALUATION_POLICY_STALE',
        currentPolicy: current,
        message:
          'El método de valorización cambió; descarga un bootstrap antes de operar.',
      });
    }
  }

  private async plan(
    manager: EntityManager,
    tenantId: string,
    targetMethod: InventoryValuationMethod,
    lockedCurrent?: InventoryValuationPolicyData,
  ): Promise<InventoryValuationMigrationPlan> {
    const current =
      lockedCurrent ??
      (await loadInventoryValuationPolicy(manager, tenantId, false));
    const [untracked] = await manager.query<
      Array<{ products: number | string; locations: number | string }>
    >(
      `SELECT COUNT(DISTINCT p.id) AS products,
                  COUNT(DISTINCT CASE WHEN ib.quantity > 0 THEN ib.location_id END) AS locations
           FROM products p
           LEFT JOIN inventory_balances ib
             ON ib.product_id = p.id AND ib.tenant_id = p.tenant_id
           WHERE p.tenant_id = ? AND p.active = TRUE AND p.track_lots = FALSE`,
      [tenantId],
    );
    const [lotIssues] = await manager.query<Array<{ total: number | string }>>(
      `SELECT COUNT(*) AS total FROM (
             SELECT ib.product_id, ib.location_id
             FROM inventory_balances ib
             INNER JOIN products p
               ON p.id = ib.product_id AND p.tenant_id = ib.tenant_id
             LEFT JOIN inventory_lots il
               ON il.tenant_id = ib.tenant_id AND il.product_id = ib.product_id
             LEFT JOIN inventory_lot_balances ilb
               ON ilb.tenant_id = il.tenant_id AND ilb.lot_id = il.id
              AND ilb.location_id = ib.location_id
             WHERE ib.tenant_id = ? AND p.track_lots = TRUE
             GROUP BY ib.product_id, ib.location_id, ib.quantity
             HAVING ABS(ib.quantity - COALESCE(SUM(ilb.quantity), 0)) > 0.0005
           ) mismatches`,
      [tenantId],
    );
    const [fifoIssues] = await manager.query<Array<{ total: number | string }>>(
      `SELECT COUNT(*) AS total FROM (
             SELECT ib.product_id, ib.location_id
             FROM inventory_balances ib
             LEFT JOIN inventory_fifo_layers ifl
               ON ifl.tenant_id = ib.tenant_id
              AND ifl.product_id = ib.product_id
              AND ifl.location_id = ib.location_id
             WHERE ib.tenant_id = ?
             GROUP BY ib.product_id, ib.location_id, ib.quantity
             HAVING ABS(ib.quantity - COALESCE(SUM(ifl.remaining_quantity), 0)) > 0.0005
           ) mismatches`,
      [tenantId],
    );
    const [devices] = await manager.query<Array<{ total: number | string }>>(
      `SELECT COUNT(*) AS total FROM offline_devices
           WHERE tenant_id = ? AND revoked_at IS NULL`,
      [tenantId],
    );
    const blockingReasons: string[] = [];
    if (targetMethod === current.method)
      blockingReasons.push('METHOD_ALREADY_ACTIVE');
    if (targetMethod === 'FIFO' && Number(fifoIssues.total) > 0)
      blockingReasons.push('FIFO_LAYER_RECONCILIATION_REQUIRED');
    if (targetMethod === 'SPECIFIC_LOT' && Number(lotIssues.total) > 0)
      blockingReasons.push('LOT_RECONCILIATION_REQUIRED');
    const strategy =
      targetMethod === 'MOVING_AVERAGE'
        ? ('USE_MAINTAINED_MOVING_AVERAGE' as const)
        : targetMethod === 'FIFO'
          ? ('USE_MAINTAINED_FIFO_LAYERS' as const)
          : ('OPENING_LOTS_AT_MOVING_AVERAGE' as const);
    const unsigned = {
      current,
      targetMethod,
      allowed: blockingReasons.length === 0,
      blockingReasons,
      strategy,
      productsToMigrate:
        targetMethod === 'SPECIFIC_LOT' ? Number(untracked.products) : 0,
      locationsToMigrate:
        targetMethod === 'SPECIFIC_LOT' ? Number(untracked.locations) : 0,
      devicesToRebootstrap: Number(devices.total),
    };
    return {
      ...unsigned,
      planFingerprint: createHash('sha256')
        .update(JSON.stringify(unsigned))
        .digest('hex'),
    };
  }

  private async createOpeningLots(
    manager: EntityManager,
    tenantId: string,
    userId: string,
    version: number,
  ): Promise<{ products: number; locations: number }> {
    const products = await manager.query<
      Array<{
        id: string;
        average_unit_cost: string;
        currency: string;
      }>
    >(
      `SELECT p.id,
              COALESCE(iv.average_unit_cost, CAST(p.cost AS DECIMAL(15,4)))
                AS average_unit_cost,
              CASE t.country_code WHEN 'MX' THEN 'MXN'
                WHEN 'CL' THEN 'CLP' ELSE 'USD' END AS currency
       FROM products p
       INNER JOIN tenants t ON t.id = p.tenant_id
       LEFT JOIN inventory_valuations iv
         ON iv.tenant_id = p.tenant_id AND iv.product_id = p.id
       WHERE p.tenant_id = ? AND p.active = TRUE AND p.track_lots = FALSE
       ORDER BY p.id FOR UPDATE`,
      [tenantId],
    );
    let locations = 0;
    for (const product of products) {
      const lotId = randomUUID();
      const code = `VALUATION-CUT-V${version}`;
      await manager.query(
        `INSERT INTO inventory_lots
          (id, tenant_id, product_id, code, normalized_code, unit_cost,
           currency, created_by_user_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          lotId,
          tenantId,
          product.id,
          code,
          code,
          product.average_unit_cost,
          product.currency,
          userId,
        ],
      );
      const result = await manager.query<{ affectedRows?: number }>(
        `INSERT INTO inventory_lot_balances
          (tenant_id, lot_id, location_id, quantity)
         SELECT tenant_id, ?, location_id, quantity
         FROM inventory_balances
         WHERE tenant_id = ? AND product_id = ? AND quantity > 0`,
        [lotId, tenantId, product.id],
      );
      locations += Number(result.affectedRows ?? 0);
      await manager.query(
        `UPDATE products SET track_lots = TRUE, version = version + 1
         WHERE id = ? AND tenant_id = ?`,
        [product.id, tenantId],
      );
    }
    return { products: products.length, locations };
  }

  private assertIdempotencyKey(
    value: string | undefined,
  ): asserts value is string {
    if (!value || !/^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/.test(value))
      throw new BadRequestException({
        code: 'INVALID_IDEMPOTENCY_KEY',
        message: 'Envía una clave idempotente válida para confirmar el cambio.',
      });
  }

  private iso(value: Date | string): string {
    if (value instanceof Date) {
      return new Date(
        Date.UTC(
          value.getFullYear(),
          value.getMonth(),
          value.getDate(),
          value.getHours(),
          value.getMinutes(),
          value.getSeconds(),
          value.getMilliseconds(),
        ),
      ).toISOString();
    }
    return new Date(value).toISOString();
  }

  private sqlDate(value: string): string {
    return value.slice(0, 23).replace('T', ' ').replace('Z', '');
  }
}
