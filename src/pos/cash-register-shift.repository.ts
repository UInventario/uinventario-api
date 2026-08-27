import { Injectable } from '@nestjs/common';
import { createHash, randomUUID } from 'node:crypto';
import { DataSource, EntityManager, QueryFailedError } from 'typeorm';
import {
  CashRegisterShiftConflictError,
  CashRegisterShiftContextError,
  CashRegisterShiftIdempotencyConflictError,
} from './cash-register-shift.errors';
import type { CashRegisterShiftData } from './cash-register-shift.types';

interface ShiftRow {
  id: string;
  status: 'OPEN';
  branch_id: string;
  branch_name: string;
  cash_register_id: string;
  cash_register_name: string;
  cash_register_code: string;
  user_id: string;
  user_email: string;
  opening_amount: string;
  currency: string;
  request_fingerprint: string;
  opened_at: Date | string;
}

@Injectable()
export class CashRegisterShiftRepository {
  constructor(private readonly dataSource: DataSource) {}

  current(input: {
    tenantId: string;
    branchId: string;
    cashRegisterId: string;
    userId: string;
  }): Promise<CashRegisterShiftData | null> {
    return this.findCurrent(this.dataSource.manager, input);
  }

  async open(input: {
    tenantId: string;
    branchId: string;
    cashRegisterId: string;
    userId: string;
    openingAmount: string;
    idempotencyKey: string;
  }): Promise<{ shift: CashRegisterShiftData; replay: boolean }> {
    try {
      return await this.dataSource.transaction(
        'READ COMMITTED',
        async (manager) => {
          const [context] = await manager.query<
            Array<{ country_code: string }>
          >(
            `SELECT t.country_code FROM cash_registers cr
           INNER JOIN branches b ON b.id = cr.branch_id AND b.tenant_id = cr.tenant_id
             AND b.active = TRUE
           INNER JOIN tenants t ON t.id = cr.tenant_id
           INNER JOIN users u ON u.id = ? AND u.tenant_id = t.id
           WHERE cr.id = ? AND cr.tenant_id = ? AND cr.branch_id = ?
           LIMIT 1 FOR UPDATE`,
            [
              input.userId,
              input.cashRegisterId,
              input.tenantId,
              input.branchId,
            ],
          );
          if (!context) throw new CashRegisterShiftContextError();
          const currency = this.currencyFor(context.country_code);
          const fingerprint = this.fingerprint(input, currency);
          const replay = await this.findByKey(
            manager,
            input.tenantId,
            input.idempotencyKey,
          );
          if (replay) {
            if (replay.fingerprint !== fingerprint)
              throw new CashRegisterShiftIdempotencyConflictError();
            return { shift: replay.shift, replay: true };
          }
          const conflicts = await manager.query<Array<{ id: string }>>(
            `SELECT id FROM cash_register_shifts
           WHERE tenant_id = ? AND status = 'OPEN'
             AND (cash_register_id = ? OR opened_by_user_id = ?)
           LIMIT 1 FOR UPDATE`,
            [input.tenantId, input.cashRegisterId, input.userId],
          );
          if (conflicts[0]) throw new CashRegisterShiftConflictError();
          const id = randomUUID();
          await manager.query(
            `INSERT INTO cash_register_shifts
            (id, tenant_id, branch_id, cash_register_id, opened_by_user_id,
             opening_amount, currency, status, opening_idempotency_key,
             request_fingerprint)
           VALUES (?, ?, ?, ?, ?, ?, ?, 'OPEN', ?, ?)`,
            [
              id,
              input.tenantId,
              input.branchId,
              input.cashRegisterId,
              input.userId,
              input.openingAmount,
              currency,
              input.idempotencyKey,
              fingerprint,
            ],
          );
          const shift = await this.findById(manager, input.tenantId, id);
          if (!shift) throw new Error('CREATED_CASH_REGISTER_SHIFT_NOT_FOUND');
          return { shift, replay: false };
        },
      );
    } catch (error) {
      if (!this.isDuplicate(error)) throw error;
      const replay = await this.findByKey(
        this.dataSource.manager,
        input.tenantId,
        input.idempotencyKey,
      );
      if (!replay) throw new CashRegisterShiftConflictError();
      const currency = replay.shift.currency;
      if (replay.fingerprint !== this.fingerprint(input, currency))
        throw new CashRegisterShiftIdempotencyConflictError();
      return { shift: replay.shift, replay: true };
    }
  }

  private async findCurrent(
    manager: EntityManager,
    input: {
      tenantId: string;
      branchId: string;
      cashRegisterId: string;
      userId: string;
    },
  ): Promise<CashRegisterShiftData | null> {
    const [row] = await manager.query<ShiftRow[]>(
      `${this.selectShift()}
       WHERE crs.tenant_id = ? AND crs.branch_id = ?
         AND crs.cash_register_id = ? AND crs.opened_by_user_id = ?
         AND crs.status = 'OPEN' LIMIT 1`,
      [input.tenantId, input.branchId, input.cashRegisterId, input.userId],
    );
    return row ? this.toData(row) : null;
  }

  private async findById(
    manager: EntityManager,
    tenantId: string,
    id: string,
  ): Promise<CashRegisterShiftData | null> {
    const [row] = await manager.query<ShiftRow[]>(
      `${this.selectShift()} WHERE crs.id = ? AND crs.tenant_id = ? LIMIT 1`,
      [id, tenantId],
    );
    return row ? this.toData(row) : null;
  }

  private async findByKey(
    manager: EntityManager,
    tenantId: string,
    key: string,
  ): Promise<{
    shift: CashRegisterShiftData;
    fingerprint: string;
  } | null> {
    const [row] = await manager.query<ShiftRow[]>(
      `${this.selectShift()}
       WHERE crs.tenant_id = ? AND crs.opening_idempotency_key = ? LIMIT 1`,
      [tenantId, key],
    );
    return row
      ? { shift: this.toData(row), fingerprint: row.request_fingerprint }
      : null;
  }

  private selectShift(): string {
    return `SELECT crs.id, crs.status, crs.opening_amount, crs.currency,
                   crs.request_fingerprint, crs.opened_at,
                   b.id AS branch_id, b.name AS branch_name,
                   cr.id AS cash_register_id, cr.name AS cash_register_name,
                   cr.code AS cash_register_code,
                   u.id AS user_id, u.email AS user_email
            FROM cash_register_shifts crs
            INNER JOIN branches b ON b.id = crs.branch_id AND b.tenant_id = crs.tenant_id
            INNER JOIN cash_registers cr ON cr.id = crs.cash_register_id
              AND cr.tenant_id = crs.tenant_id
            INNER JOIN users u ON u.id = crs.opened_by_user_id
              AND u.tenant_id = crs.tenant_id`;
  }

  private toData(row: ShiftRow): CashRegisterShiftData {
    return {
      id: row.id,
      status: row.status,
      branch: { id: row.branch_id, name: row.branch_name },
      cashRegister: {
        id: row.cash_register_id,
        name: row.cash_register_name,
        code: row.cash_register_code,
      },
      openedBy: { id: row.user_id, email: row.user_email },
      openingAmount: this.money(row.opening_amount),
      currency: row.currency,
      openedAt: new Date(row.opened_at).toISOString(),
    };
  }

  private fingerprint(
    input: {
      branchId: string;
      cashRegisterId: string;
      userId: string;
      openingAmount: string;
    },
    currency: string,
  ): string {
    return createHash('sha256')
      .update(
        JSON.stringify({
          branchId: input.branchId,
          cashRegisterId: input.cashRegisterId,
          userId: input.userId,
          openingAmount: this.money(input.openingAmount),
          currency,
        }),
      )
      .digest('hex');
  }

  private money(value: string): string {
    const [whole, fraction = ''] = value.split('.');
    return `${whole}.${fraction.padEnd(2, '0')}`;
  }

  private currencyFor(countryCode: string): string {
    if (countryCode === 'MX') return 'MXN';
    if (countryCode === 'CL') return 'CLP';
    return 'USD';
  }

  private isDuplicate(error: unknown): boolean {
    return (
      error instanceof QueryFailedError &&
      (error.driverError as { errno?: number }).errno === 1062
    );
  }
}
