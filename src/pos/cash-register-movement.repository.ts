import { Injectable } from '@nestjs/common';
import { createHash, randomUUID } from 'node:crypto';
import { DataSource, EntityManager, QueryFailedError } from 'typeorm';
import {
  CashRegisterMovementAlreadyReversedError,
  CashRegisterMovementIdempotencyConflictError,
  CashRegisterMovementInsufficientBalanceError,
  CashRegisterMovementNotFoundError,
} from './cash-register-movement.errors';
import type {
  CashRegisterMovementData,
  CashRegisterMovementType,
} from './cash-register-movement.types';

interface MovementRow {
  id: string;
  type: CashRegisterMovementType;
  amount: string;
  reason: string;
  user_id: string;
  user_email: string;
  reversal_of_id: string | null;
  original_type: 'INCOME' | 'WITHDRAWAL' | null;
  original_reason: string | null;
  reversed: number | string;
  request_fingerprint: string;
  created_at: Date | string;
}

interface MovementContext {
  tenantId: string;
  branchId: string;
  cashRegisterId: string;
  userId: string;
  shiftId: string;
}

@Injectable()
export class CashRegisterMovementRepository {
  constructor(private readonly dataSource: DataSource) {}

  async list(context: MovementContext): Promise<{
    movements: CashRegisterMovementData[];
    expectedCash: string;
  }> {
    const [rows, expectedCash] = await Promise.all([
      this.dataSource.query<MovementRow[]>(
        `${this.selectMovement()}
         WHERE cm.tenant_id = ? AND cm.cash_register_shift_id = ?
         ORDER BY cm.created_at DESC, cm.id DESC`,
        [context.tenantId, context.shiftId],
      ),
      this.expectedCash(
        this.dataSource.manager,
        context.tenantId,
        context.shiftId,
      ),
    ]);
    return { movements: rows.map((row) => this.toData(row)), expectedCash };
  }

  create(
    input: MovementContext & {
      type: 'INCOME' | 'WITHDRAWAL';
      amount: string;
      reason: string;
      idempotencyKey: string;
    },
  ): Promise<{
    movement: CashRegisterMovementData;
    expectedCash: string;
    replay: boolean;
  }> {
    return this.persist(input, null);
  }

  reverse(
    input: MovementContext & {
      movementId: string;
      reason: string;
      idempotencyKey: string;
    },
  ): Promise<{
    movement: CashRegisterMovementData;
    expectedCash: string;
    replay: boolean;
  }> {
    return this.persist(input, input.movementId);
  }

  private async persist(
    input:
      | (MovementContext & {
          type: 'INCOME' | 'WITHDRAWAL';
          amount: string;
          reason: string;
          idempotencyKey: string;
        })
      | (MovementContext & {
          movementId: string;
          reason: string;
          idempotencyKey: string;
        }),
    reversalOfId: string | null,
  ) {
    try {
      return await this.dataSource.transaction(
        'READ COMMITTED',
        async (manager) => {
          await this.lockShift(manager, input);
          let type: CashRegisterMovementType;
          let amount: string;
          let original: {
            amount: string;
            type: 'INCOME' | 'WITHDRAWAL';
          } | null = null;
          if (reversalOfId) {
            original = await this.findOriginal(
              manager,
              input.tenantId,
              input.shiftId,
              reversalOfId,
            );
            if (!original) throw new CashRegisterMovementNotFoundError();
            type = 'REVERSAL';
            amount = this.money(original.amount);
          } else {
            if (!('type' in input))
              throw new Error('CASH_REGISTER_MOVEMENT_INPUT_INVALID');
            type = input.type;
            amount = this.money(input.amount);
          }
          const fingerprint = this.fingerprint({
            shiftId: input.shiftId,
            type,
            amount,
            reason: input.reason,
            reversalOfId,
          });
          const replay = await this.findByKey(
            manager,
            input.tenantId,
            input.idempotencyKey,
          );
          if (replay) {
            if (replay.fingerprint !== fingerprint)
              throw new CashRegisterMovementIdempotencyConflictError();
            return {
              movement: replay.movement,
              expectedCash: await this.expectedCash(
                manager,
                input.tenantId,
                input.shiftId,
              ),
              replay: true,
            };
          }
          if (reversalOfId) {
            const reversed = await manager.query<Array<{ id: string }>>(
              `SELECT id FROM cash_register_movements
             WHERE tenant_id = ? AND reversal_of_id = ? LIMIT 1`,
              [input.tenantId, reversalOfId],
            );
            if (reversed[0])
              throw new CashRegisterMovementAlreadyReversedError();
            if (original?.type === 'INCOME') {
              await this.assertAvailable(manager, input, amount);
            }
          } else if (type === 'WITHDRAWAL') {
            await this.assertAvailable(manager, input, amount);
          }
          const id = randomUUID();
          await manager.query(
            `INSERT INTO cash_register_movements
            (id, tenant_id, cash_register_shift_id, created_by_user_id, type,
             amount, reason, reversal_of_id, idempotency_key, request_fingerprint)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [
              id,
              input.tenantId,
              input.shiftId,
              input.userId,
              type,
              amount,
              input.reason,
              reversalOfId,
              input.idempotencyKey,
              fingerprint,
            ],
          );
          const movement = await this.findById(manager, input.tenantId, id);
          if (!movement)
            throw new Error('CREATED_CASH_REGISTER_MOVEMENT_NOT_FOUND');
          return {
            movement,
            expectedCash: await this.expectedCash(
              manager,
              input.tenantId,
              input.shiftId,
            ),
            replay: false,
          };
        },
      );
    } catch (error) {
      if (!this.isDuplicate(error)) throw error;
      const replay = await this.findByKey(
        this.dataSource.manager,
        input.tenantId,
        input.idempotencyKey,
      );
      if (!replay) throw new CashRegisterMovementAlreadyReversedError();
      const fingerprint = this.fingerprint({
        shiftId: input.shiftId,
        type: reversalOfId || !('type' in input) ? 'REVERSAL' : input.type,
        amount:
          reversalOfId || !('amount' in input)
            ? replay.movement.amount
            : input.amount,
        reason: input.reason,
        reversalOfId,
      });
      if (replay.fingerprint !== fingerprint)
        throw new CashRegisterMovementIdempotencyConflictError();
      return {
        movement: replay.movement,
        expectedCash: await this.expectedCash(
          this.dataSource.manager,
          input.tenantId,
          input.shiftId,
        ),
        replay: true,
      };
    }
  }

  private async lockShift(
    manager: EntityManager,
    input: MovementContext,
  ): Promise<void> {
    const rows = await manager.query<Array<{ id: string }>>(
      `SELECT id FROM cash_register_shifts
       WHERE id = ? AND tenant_id = ? AND branch_id = ? AND cash_register_id = ?
         AND opened_by_user_id = ? AND status = 'OPEN' LIMIT 1 FOR UPDATE`,
      [
        input.shiftId,
        input.tenantId,
        input.branchId,
        input.cashRegisterId,
        input.userId,
      ],
    );
    if (!rows[0]) throw new CashRegisterMovementNotFoundError();
  }

  private async assertAvailable(
    manager: EntityManager,
    input: MovementContext,
    amount: string,
  ): Promise<void> {
    const expected = await this.expectedCash(
      manager,
      input.tenantId,
      input.shiftId,
    );
    if (this.cents(amount) > this.cents(expected)) {
      throw new CashRegisterMovementInsufficientBalanceError();
    }
  }

  private async expectedCash(
    manager: EntityManager,
    tenantId: string,
    shiftId: string,
  ): Promise<string> {
    const [row] = await manager.query<Array<{ expected_cash: string }>>(
      `SELECT crs.opening_amount
         + COALESCE((
             SELECT SUM(sp.amount_applied) FROM sales s
             INNER JOIN sale_payments sp ON sp.sale_id = s.id AND sp.tenant_id = s.tenant_id
               AND sp.method = 'CASH'
             WHERE s.tenant_id = crs.tenant_id
               AND s.cash_register_shift_id = crs.id AND s.status = 'COMPLETED'
           ), 0)
         - COALESCE((
             SELECT SUM(settlement.amount)
             FROM sale_return_settlements settlement
             WHERE settlement.tenant_id = crs.tenant_id
               AND settlement.cash_register_shift_id = crs.id
               AND settlement.method = 'CASH'
               AND settlement.status = 'COMPLETED'
           ), 0)
         + COALESCE((
             SELECT SUM(CASE
               WHEN cm.type = 'INCOME' THEN cm.amount
               WHEN cm.type = 'WITHDRAWAL' THEN -cm.amount
               WHEN original.type = 'INCOME' THEN -cm.amount
               ELSE cm.amount END)
             FROM cash_register_movements cm
             LEFT JOIN cash_register_movements original
               ON original.id = cm.reversal_of_id AND original.tenant_id = cm.tenant_id
             WHERE cm.tenant_id = crs.tenant_id
               AND cm.cash_register_shift_id = crs.id
           ), 0) AS expected_cash
       FROM cash_register_shifts crs
       WHERE crs.tenant_id = ? AND crs.id = ? LIMIT 1`,
      [tenantId, shiftId],
    );
    if (!row) throw new CashRegisterMovementNotFoundError();
    return this.money(row.expected_cash);
  }

  private async findOriginal(
    manager: EntityManager,
    tenantId: string,
    shiftId: string,
    id: string,
  ): Promise<{ amount: string; type: 'INCOME' | 'WITHDRAWAL' } | null> {
    const [row] = await manager.query<
      Array<{ amount: string; type: 'INCOME' | 'WITHDRAWAL' }>
    >(
      `SELECT amount, type FROM cash_register_movements
       WHERE id = ? AND tenant_id = ? AND cash_register_shift_id = ?
         AND type IN ('INCOME', 'WITHDRAWAL') LIMIT 1 FOR UPDATE`,
      [id, tenantId, shiftId],
    );
    return row ?? null;
  }

  private async findById(
    manager: EntityManager,
    tenantId: string,
    id: string,
  ): Promise<CashRegisterMovementData | null> {
    const [row] = await manager.query<MovementRow[]>(
      `${this.selectMovement()} WHERE cm.tenant_id = ? AND cm.id = ? LIMIT 1`,
      [tenantId, id],
    );
    return row ? this.toData(row) : null;
  }

  private async findByKey(
    manager: EntityManager,
    tenantId: string,
    key: string,
  ) {
    const [row] = await manager.query<MovementRow[]>(
      `${this.selectMovement()}
       WHERE cm.tenant_id = ? AND cm.idempotency_key = ? LIMIT 1`,
      [tenantId, key],
    );
    return row
      ? {
          movement: this.toData(row),
          fingerprint: row.request_fingerprint,
        }
      : null;
  }

  private selectMovement(): string {
    return `SELECT cm.id, cm.type, cm.amount, cm.reason, cm.reversal_of_id,
                   cm.request_fingerprint, cm.created_at,
                   u.id AS user_id, u.email AS user_email,
                   original.type AS original_type, original.reason AS original_reason,
                   EXISTS(SELECT 1 FROM cash_register_movements reversal
                     WHERE reversal.tenant_id = cm.tenant_id
                       AND reversal.reversal_of_id = cm.id) AS reversed
            FROM cash_register_movements cm
            INNER JOIN users u ON u.id = cm.created_by_user_id AND u.tenant_id = cm.tenant_id
            LEFT JOIN cash_register_movements original
              ON original.id = cm.reversal_of_id AND original.tenant_id = cm.tenant_id`;
  }

  private toData(row: MovementRow): CashRegisterMovementData {
    return {
      id: row.id,
      type: row.type,
      amount: this.money(row.amount),
      reason: row.reason,
      responsible: { id: row.user_id, email: row.user_email },
      reversalOf:
        row.reversal_of_id && row.original_type && row.original_reason
          ? {
              id: row.reversal_of_id,
              type: row.original_type,
              reason: row.original_reason,
            }
          : null,
      reversed: Boolean(Number(row.reversed)),
      createdAt: new Date(row.created_at).toISOString(),
    };
  }

  private fingerprint(input: {
    shiftId: string;
    type: CashRegisterMovementType;
    amount: string;
    reason: string;
    reversalOfId: string | null;
  }): string {
    return createHash('sha256')
      .update(JSON.stringify({ ...input, amount: this.money(input.amount) }))
      .digest('hex');
  }

  private money(value: string): string {
    const [whole, fraction = ''] = value.split('.');
    return `${whole}.${fraction.padEnd(2, '0')}`;
  }

  private cents(value: string): bigint {
    const [whole, fraction = ''] = value.split('.');
    return BigInt(whole) * 100n + BigInt(fraction.padEnd(2, '0'));
  }

  private isDuplicate(error: unknown): boolean {
    return (
      error instanceof QueryFailedError &&
      (error.driverError as { errno?: number }).errno === 1062
    );
  }
}
