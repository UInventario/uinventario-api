import { Injectable } from '@nestjs/common';
import { createHash, randomUUID } from 'node:crypto';
import { DataSource, EntityManager, QueryFailedError } from 'typeorm';
import {
  IdempotencyConflictError,
  InventoryTargetNotFoundError,
} from './inventory.errors';
import { applyInventoryValuation } from './inventory-valuation';
import { applyInventoryLotTracking } from './inventory-lot-tracking';
import {
  InventoryCountAttemptConflictError,
  InventoryCountSessionClosedError,
  InventoryCountSessionIncompleteError,
  InventoryCountSessionNotFoundError,
  InventoryCountStockChangedError,
} from './inventory-count.errors';
import type { InventoryCountSessionData } from './inventory-count.types';

interface SessionRow {
  id: string;
  status: 'OPEN' | 'CLOSED';
  blind: number | boolean;
  branch_id: string;
  branch_name: string;
  warehouse_id: string;
  warehouse_name: string;
  location_id: string;
  location_name: string;
  location_code: string;
  created_by_id: string;
  created_by_email: string;
  closed_by_id: string | null;
  closed_by_email: string | null;
  created_at: Date | string;
  closed_at: Date | string | null;
  request_fingerprint: string;
}

interface LineRow {
  id: string;
  product_id: string;
  product_name: string;
  product_sku: string;
  snapshot_quantity: string;
  counted_quantity: string | null;
  variance_quantity: string | null;
  attempt_count: number | string;
  counted_by_id: string | null;
  counted_by_email: string | null;
  counted_at: Date | string | null;
  movement_id: string | null;
}

interface AttemptRow {
  line_id: string;
  attempt_number: number | string;
  counted_quantity: string;
  user_id: string;
  user_email: string;
  created_at: Date | string;
}

@Injectable()
export class InventoryCountRepository {
  constructor(private readonly dataSource: DataSource) {}

  async createSession(input: {
    tenantId: string;
    branchId: string;
    warehouseId: string;
    userId: string;
    idempotencyKey: string;
    locationId: string;
    productIds: string[];
    blind: boolean;
  }): Promise<{ session: InventoryCountSessionData; replay: boolean }> {
    const productIds = [...input.productIds].sort();
    const fingerprint = this.fingerprint({
      branchId: input.branchId,
      warehouseId: input.warehouseId,
      locationId: input.locationId,
      productIds,
      blind: input.blind,
    });

    try {
      const result = await this.dataSource.transaction(
        'READ COMMITTED',
        async (manager) => {
          const existing = await this.findByIdempotency(
            manager,
            input.tenantId,
            input.idempotencyKey,
          );
          if (existing) {
            if (existing.request_fingerprint !== fingerprint)
              throw new IdempotencyConflictError();
            return { id: existing.id, replay: true };
          }

          const [location] = await manager.query<Array<{ id: string }>>(
            `SELECT l.id FROM locations l
           INNER JOIN warehouses w ON w.id = l.warehouse_id AND w.tenant_id = l.tenant_id
           WHERE l.id = ? AND l.tenant_id = ? AND l.warehouse_id = ? AND w.branch_id = ?
             AND l.active = TRUE AND w.active = TRUE`,
            [
              input.locationId,
              input.tenantId,
              input.warehouseId,
              input.branchId,
            ],
          );
          if (!location) throw new InventoryTargetNotFoundError();

          const products = await manager.query<Array<{ id: string }>>(
            `SELECT id FROM products
           WHERE tenant_id = ? AND active = TRUE
             AND id IN (${productIds.map(() => '?').join(',')})
           ORDER BY id`,
            [input.tenantId, ...productIds],
          );
          if (products.length !== productIds.length)
            throw new InventoryTargetNotFoundError();

          const sessionId = randomUUID();
          await manager.query(
            `INSERT INTO inventory_count_sessions
            (id, tenant_id, branch_id, warehouse_id, location_id, status, blind,
             idempotency_key, request_fingerprint, created_by_user_id)
           VALUES (?, ?, ?, ?, ?, 'OPEN', ?, ?, ?, ?)`,
            [
              sessionId,
              input.tenantId,
              input.branchId,
              input.warehouseId,
              input.locationId,
              input.blind,
              input.idempotencyKey,
              fingerprint,
              input.userId,
            ],
          );

          for (const product of products) {
            await manager.query(
              `INSERT INTO inventory_balances (tenant_id, product_id, location_id, quantity)
             VALUES (?, ?, ?, 0) ON DUPLICATE KEY UPDATE quantity = quantity`,
              [input.tenantId, product.id, input.locationId],
            );
            const [balance] = await manager.query<
              Array<{ available_quantity: string }>
            >(
              `SELECT available_quantity FROM inventory_balances
             WHERE tenant_id = ? AND product_id = ? AND location_id = ? FOR UPDATE`,
              [input.tenantId, product.id, input.locationId],
            );
            await manager.query(
              `INSERT INTO inventory_count_session_lines
              (id, tenant_id, session_id, product_id, snapshot_quantity)
             VALUES (?, ?, ?, ?, ?)`,
              [
                randomUUID(),
                input.tenantId,
                sessionId,
                product.id,
                balance.available_quantity,
              ],
            );
          }
          return { id: sessionId, replay: false };
        },
      );
      const session = await this.getSession(
        input.tenantId,
        input.warehouseId,
        result.id,
      );
      if (!session) throw new InventoryCountSessionNotFoundError();
      return { session, replay: result.replay };
    } catch (error) {
      if (!this.isDuplicate(error)) throw error;
      const existing = await this.findByIdempotency(
        this.dataSource.manager,
        input.tenantId,
        input.idempotencyKey,
      );
      if (!existing || existing.request_fingerprint !== fingerprint) {
        throw new IdempotencyConflictError();
      }
      const session = await this.getSession(
        input.tenantId,
        input.warehouseId,
        existing.id,
      );
      if (!session) throw new InventoryCountSessionNotFoundError();
      return { session, replay: true };
    }
  }

  async listSessions(
    tenantId: string,
    warehouseId: string,
  ): Promise<InventoryCountSessionData[]> {
    const rows = await this.dataSource.query<Array<{ id: string }>>(
      `SELECT id FROM inventory_count_sessions
       WHERE tenant_id = ? AND warehouse_id = ?
       ORDER BY (status = 'OPEN') DESC, created_at DESC LIMIT 20`,
      [tenantId, warehouseId],
    );
    const sessions = await Promise.all(
      rows.map(({ id }) => this.getSession(tenantId, warehouseId, id)),
    );
    return sessions.filter(
      (session): session is InventoryCountSessionData => session !== null,
    );
  }

  async getSession(
    tenantId: string,
    warehouseId: string,
    sessionId: string,
  ): Promise<InventoryCountSessionData | null> {
    return this.readSession(
      this.dataSource.manager,
      tenantId,
      warehouseId,
      sessionId,
    );
  }

  async recordCount(input: {
    tenantId: string;
    warehouseId: string;
    sessionId: string;
    productId: string;
    userId: string;
    countedQuantity: string;
    expectedAttempt: number;
  }): Promise<InventoryCountSessionData> {
    const quantity = this.fromUnits(this.toUnits(input.countedQuantity));
    await this.dataSource.transaction('READ COMMITTED', async (manager) => {
      const [session] = await manager.query<
        Array<{ status: 'OPEN' | 'CLOSED' }>
      >(
        `SELECT status FROM inventory_count_sessions
         WHERE id = ? AND tenant_id = ? AND warehouse_id = ? FOR UPDATE`,
        [input.sessionId, input.tenantId, input.warehouseId],
      );
      if (!session) throw new InventoryCountSessionNotFoundError();
      if (session.status !== 'OPEN')
        throw new InventoryCountSessionClosedError();

      const [line] = await manager.query<
        Array<{ id: string; attempt_count: number | string }>
      >(
        `SELECT id, attempt_count FROM inventory_count_session_lines
         WHERE tenant_id = ? AND session_id = ? AND product_id = ? FOR UPDATE`,
        [input.tenantId, input.sessionId, input.productId],
      );
      if (!line) throw new InventoryCountSessionNotFoundError();
      const currentAttempt = Number(line.attempt_count);
      if (currentAttempt !== input.expectedAttempt) {
        throw new InventoryCountAttemptConflictError(currentAttempt);
      }
      const nextAttempt = currentAttempt + 1;
      await manager.query(
        `INSERT INTO inventory_count_attempts
          (id, tenant_id, session_id, line_id, attempt_number, counted_quantity, counted_by_user_id)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [
          randomUUID(),
          input.tenantId,
          input.sessionId,
          line.id,
          nextAttempt,
          quantity,
          input.userId,
        ],
      );
      await manager.query(
        `UPDATE inventory_count_session_lines
         SET counted_quantity = ?, attempt_count = ?, counted_by_user_id = ?, counted_at = CURRENT_TIMESTAMP(6)
         WHERE id = ? AND tenant_id = ?`,
        [quantity, nextAttempt, input.userId, line.id, input.tenantId],
      );
    });
    const session = await this.getSession(
      input.tenantId,
      input.warehouseId,
      input.sessionId,
    );
    if (!session) throw new InventoryCountSessionNotFoundError();
    return session;
  }

  async closeSession(input: {
    tenantId: string;
    warehouseId: string;
    sessionId: string;
    userId: string;
    reason: string;
    reference: string;
  }): Promise<InventoryCountSessionData> {
    await this.dataSource.transaction('READ COMMITTED', async (manager) => {
      const [session] = await manager.query<
        Array<{ status: 'OPEN' | 'CLOSED'; location_id: string }>
      >(
        `SELECT status, location_id FROM inventory_count_sessions
         WHERE id = ? AND tenant_id = ? AND warehouse_id = ? FOR UPDATE`,
        [input.sessionId, input.tenantId, input.warehouseId],
      );
      if (!session) throw new InventoryCountSessionNotFoundError();
      if (session.status === 'CLOSED') return;

      const lines = await manager.query<
        Array<{
          id: string;
          product_id: string;
          snapshot_quantity: string;
          counted_quantity: string | null;
        }>
      >(
        `SELECT id, product_id, snapshot_quantity, counted_quantity
         FROM inventory_count_session_lines
         WHERE tenant_id = ? AND session_id = ? ORDER BY product_id FOR UPDATE`,
        [input.tenantId, input.sessionId],
      );
      if (
        lines.length === 0 ||
        lines.some(({ counted_quantity }) => counted_quantity === null)
      ) {
        throw new InventoryCountSessionIncompleteError();
      }

      const balances = new Map<string, { total: bigint; available: bigint }>();
      for (const line of lines) {
        const [balance] = await manager.query<
          Array<{ quantity: string; available_quantity: string }>
        >(
          `SELECT quantity, available_quantity FROM inventory_balances
           WHERE tenant_id = ? AND product_id = ? AND location_id = ? FOR UPDATE`,
          [input.tenantId, line.product_id, session.location_id],
        );
        const current = this.toUnits(balance.available_quantity);
        if (current !== this.toUnits(line.snapshot_quantity)) {
          throw new InventoryCountStockChangedError(
            line.product_id,
            this.fromUnits(current),
          );
        }
        balances.set(line.product_id, {
          total: this.toUnits(balance.quantity),
          available: current,
        });
      }

      for (const line of lines) {
        const balance = balances.get(line.product_id)!;
        const counted = this.toUnits(line.counted_quantity!);
        const variance = counted - balance.available;
        let movementId: string | null = null;
        if (variance !== 0n) {
          movementId = randomUUID();
          const resultingTotal = balance.total + variance;
          const idempotencyKey = `count-session:${input.sessionId}:${line.product_id}`;
          const movementFingerprint = this.fingerprint({
            sessionId: input.sessionId,
            productId: line.product_id,
            variance: this.fromUnits(variance),
            counted: this.fromUnits(counted),
          });
          await manager.query(
            `UPDATE inventory_balances SET quantity = ?, available_quantity = ?
             WHERE tenant_id = ? AND product_id = ? AND location_id = ?`,
            [
              this.fromUnits(resultingTotal),
              this.fromUnits(counted),
              input.tenantId,
              line.product_id,
              session.location_id,
            ],
          );
          await manager.query(
            `INSERT INTO inventory_movements
              (id, tenant_id, product_id, location_id, type, quantity_change,
               resulting_quantity, reason, reference, idempotency_key,
               request_fingerprint, created_by_user_id)
             VALUES (?, ?, ?, ?, 'ADJUSTMENT', ?, ?, ?, ?, ?, ?, ?)`,
            [
              movementId,
              input.tenantId,
              line.product_id,
              session.location_id,
              this.fromUnits(variance),
              this.fromUnits(resultingTotal),
              input.reason,
              input.reference,
              idempotencyKey,
              movementFingerprint,
              input.userId,
            ],
          );
          await applyInventoryValuation(manager, movementId);
          await applyInventoryLotTracking(manager, movementId);
        }
        await manager.query(
          `UPDATE inventory_count_session_lines
           SET variance_quantity = ?, movement_id = ?
           WHERE id = ? AND tenant_id = ?`,
          [this.fromUnits(variance), movementId, line.id, input.tenantId],
        );
      }

      await manager.query(
        `UPDATE inventory_count_sessions
         SET status = 'CLOSED', closed_by_user_id = ?, closed_at = CURRENT_TIMESTAMP(6)
         WHERE id = ? AND tenant_id = ?`,
        [input.userId, input.sessionId, input.tenantId],
      );
    });
    const session = await this.getSession(
      input.tenantId,
      input.warehouseId,
      input.sessionId,
    );
    if (!session) throw new InventoryCountSessionNotFoundError();
    return session;
  }

  private async readSession(
    manager: EntityManager,
    tenantId: string,
    warehouseId: string,
    sessionId: string,
  ): Promise<InventoryCountSessionData | null> {
    const [session] = await manager.query<SessionRow[]>(
      `SELECT s.id, s.status, s.blind, s.branch_id, b.name AS branch_name,
              s.warehouse_id, w.name AS warehouse_name, s.location_id,
              l.name AS location_name, l.code AS location_code,
              creator.id AS created_by_id, creator.email AS created_by_email,
              closer.id AS closed_by_id, closer.email AS closed_by_email,
              s.created_at, s.closed_at, s.request_fingerprint
       FROM inventory_count_sessions s
       INNER JOIN branches b ON b.id = s.branch_id AND b.tenant_id = s.tenant_id
       INNER JOIN warehouses w ON w.id = s.warehouse_id AND w.tenant_id = s.tenant_id
       INNER JOIN locations l ON l.id = s.location_id AND l.tenant_id = s.tenant_id
       INNER JOIN users creator ON creator.id = s.created_by_user_id
       LEFT JOIN users closer ON closer.id = s.closed_by_user_id
       WHERE s.id = ? AND s.tenant_id = ? AND s.warehouse_id = ?`,
      [sessionId, tenantId, warehouseId],
    );
    if (!session) return null;

    const lines = await manager.query<LineRow[]>(
      `SELECT line.id, line.product_id, p.name AS product_name, p.sku AS product_sku,
              line.snapshot_quantity, line.counted_quantity, line.variance_quantity,
              line.attempt_count, counter.id AS counted_by_id,
              counter.email AS counted_by_email, line.counted_at, line.movement_id
       FROM inventory_count_session_lines line
       INNER JOIN products p ON p.id = line.product_id AND p.tenant_id = line.tenant_id
       LEFT JOIN users counter ON counter.id = line.counted_by_user_id
       WHERE line.tenant_id = ? AND line.session_id = ?
       ORDER BY p.name, p.id`,
      [tenantId, sessionId],
    );
    const attempts = await manager.query<AttemptRow[]>(
      `SELECT a.line_id, a.attempt_number, a.counted_quantity,
              u.id AS user_id, u.email AS user_email, a.created_at
       FROM inventory_count_attempts a
       INNER JOIN users u ON u.id = a.counted_by_user_id
       WHERE a.tenant_id = ? AND a.session_id = ?
       ORDER BY a.line_id, a.attempt_number`,
      [tenantId, sessionId],
    );
    const hidden = Boolean(session.blind) && session.status === 'OPEN';
    return {
      id: session.id,
      status: session.status,
      blind: Boolean(session.blind),
      branch: { id: session.branch_id, name: session.branch_name },
      warehouse: { id: session.warehouse_id, name: session.warehouse_name },
      location: {
        id: session.location_id,
        name: session.location_name,
        code: session.location_code,
      },
      createdBy: { id: session.created_by_id, email: session.created_by_email },
      closedBy:
        session.closed_by_id && session.closed_by_email
          ? { id: session.closed_by_id, email: session.closed_by_email }
          : null,
      createdAt: new Date(session.created_at).toISOString(),
      closedAt: session.closed_at
        ? new Date(session.closed_at).toISOString()
        : null,
      lines: lines.map((line) => ({
        product: {
          id: line.product_id,
          name: line.product_name,
          sku: line.product_sku,
        },
        snapshotQuantity: hidden
          ? null
          : this.normalize(line.snapshot_quantity),
        countedQuantity:
          line.counted_quantity === null
            ? null
            : this.normalize(line.counted_quantity),
        varianceQuantity:
          hidden || line.variance_quantity === null
            ? null
            : this.normalize(line.variance_quantity),
        attemptCount: Number(line.attempt_count),
        countedBy:
          line.counted_by_id && line.counted_by_email
            ? { id: line.counted_by_id, email: line.counted_by_email }
            : null,
        countedAt: line.counted_at
          ? new Date(line.counted_at).toISOString()
          : null,
        movementId: line.movement_id,
        attempts: attempts
          .filter(({ line_id }) => line_id === line.id)
          .map((attempt) => ({
            attempt: Number(attempt.attempt_number),
            countedQuantity: this.normalize(attempt.counted_quantity),
            responsible: { id: attempt.user_id, email: attempt.user_email },
            createdAt: new Date(attempt.created_at).toISOString(),
          })),
      })),
    };
  }

  private async findByIdempotency(
    manager: EntityManager,
    tenantId: string,
    idempotencyKey: string,
  ): Promise<{ id: string; request_fingerprint: string } | null> {
    const [row] = await manager.query<
      Array<{ id: string; request_fingerprint: string }>
    >(
      `SELECT id, request_fingerprint FROM inventory_count_sessions
       WHERE tenant_id = ? AND idempotency_key = ? LIMIT 1`,
      [tenantId, idempotencyKey],
    );
    return row ?? null;
  }

  private fingerprint(value: object): string {
    return createHash('sha256').update(JSON.stringify(value)).digest('hex');
  }

  private toUnits(value: string): bigint {
    const [whole, fraction = ''] = value.split('.');
    return BigInt(whole) * 1000n + BigInt(fraction.padEnd(3, '0'));
  }

  private fromUnits(value: bigint): string {
    const sign = value < 0n ? '-' : '';
    const absolute = value < 0n ? -value : value;
    return `${sign}${absolute / 1000n}.${(absolute % 1000n).toString().padStart(3, '0')}`;
  }

  private normalize(value: string): string {
    return this.fromUnits(this.toUnits(value));
  }

  private isDuplicate(error: unknown): boolean {
    return (
      error instanceof QueryFailedError &&
      Number((error.driverError as { errno?: number }).errno) === 1062
    );
  }
}
