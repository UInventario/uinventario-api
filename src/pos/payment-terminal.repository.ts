import { Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { DataSource, EntityManager, QueryFailedError } from 'typeorm';
import {
  PaymentTerminalIdempotencyConflictError,
  PaymentTerminalOperationError,
} from './payment-terminal.errors';
import type {
  PaymentTerminalAdapterState,
  PaymentTerminalOperationData,
  PaymentTerminalScenario,
  PaymentTerminalStatus,
} from './payment-terminal.types';

interface PaymentTerminalRow {
  id: string;
  tenant_id: string;
  branch_id: string;
  cash_register_id: string;
  provider_key: string;
  adapter_version: string;
  provider_reference: string | null;
  amount: string;
  currency: string;
  status: PaymentTerminalStatus;
  scenario: PaymentTerminalScenario;
  error_code: string | null;
  authorization_code: string | null;
  idempotency_key: string;
  request_fingerprint: string;
  correlation_id: string;
  query_count: number | string;
  sale_id: string | null;
  created_at: Date | string;
  updated_at: Date | string;
}

@Injectable()
export class PaymentTerminalRepository {
  constructor(private readonly dataSource: DataSource) {}

  async createPending(input: {
    tenantId: string;
    branchId: string;
    cashRegisterId: string;
    userId: string;
    provider: string;
    adapterVersion: string;
    amount: string;
    currency: string;
    scenario: PaymentTerminalScenario;
    idempotencyKey: string;
    fingerprint: string;
    correlationId: string;
  }): Promise<{ operation: PaymentTerminalOperationData; replay: boolean }> {
    try {
      const id = randomUUID();
      await this.dataSource.query(
        `INSERT INTO payment_terminal_operations
          (id, tenant_id, branch_id, cash_register_id, created_by_user_id,
           provider_key, adapter_version, amount, currency, scenario,
           idempotency_key, request_fingerprint, correlation_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          id,
          input.tenantId,
          input.branchId,
          input.cashRegisterId,
          input.userId,
          input.provider,
          input.adapterVersion,
          input.amount,
          input.currency,
          input.scenario,
          input.idempotencyKey,
          input.fingerprint,
          input.correlationId,
        ],
      );
      const created = await this.find(input.tenantId, id);
      if (!created) throw new Error('PAYMENT_TERMINAL_CREATE_FAILED');
      return { operation: created, replay: false };
    } catch (error) {
      if (!this.isDuplicate(error)) throw error;
      const existing = await this.findByIdempotency(
        input.tenantId,
        input.idempotencyKey,
      );
      if (
        !existing ||
        existing.requestFingerprint !== input.fingerprint ||
        existing.branchId !== input.branchId ||
        existing.cashRegisterId !== input.cashRegisterId
      ) {
        throw new PaymentTerminalIdempotencyConflictError();
      }
      return { operation: existing.operation, replay: true };
    }
  }

  async find(
    tenantId: string,
    id: string,
  ): Promise<PaymentTerminalOperationData | null> {
    const row = await this.findRow(this.dataSource.manager, tenantId, id);
    return row ? this.map(row) : null;
  }

  async findDetails(tenantId: string, id: string) {
    const row = await this.findRow(this.dataSource.manager, tenantId, id);
    return row
      ? {
          operation: this.map(row),
          scenario: row.scenario,
          state: this.adapterState(row),
        }
      : null;
  }

  async updateState(
    tenantId: string,
    id: string,
    state: PaymentTerminalAdapterState,
    incrementQuery = false,
  ): Promise<PaymentTerminalOperationData> {
    await this.dataSource.query(
      `UPDATE payment_terminal_operations
       SET provider_reference = ?, status = ?, authorization_code = ?,
           error_code = ?, query_count = query_count + ?
       WHERE id = ? AND tenant_id = ? AND sale_id IS NULL`,
      [
        state.providerReference,
        state.status,
        state.authorizationCode,
        state.errorCode,
        incrementQuery ? 1 : 0,
        id,
        tenantId,
      ],
    );
    const updated = await this.find(tenantId, id);
    if (!updated) throw new PaymentTerminalOperationError('NOT_FOUND');
    return updated;
  }

  async listForReconciliation(tenantId: string, branchId: string) {
    const rows = await this.dataSource.query<PaymentTerminalRow[]>(
      `SELECT * FROM payment_terminal_operations
       WHERE tenant_id = ? AND branch_id = ?
       ORDER BY updated_at DESC, id DESC LIMIT 100`,
      [tenantId, branchId],
    );
    return rows.map((row) => ({
      operation: this.map(row),
      scenario: row.scenario,
      state: this.adapterState(row),
    }));
  }

  async reserveCaptured(
    manager: EntityManager,
    input: {
      tenantId: string;
      branchId: string;
      cashRegisterId: string;
      operationId: string;
      amount: string;
      currency: string;
    },
  ): Promise<{
    provider: string;
    providerReference: string;
    authorizationCode: string;
  }> {
    const rows = await manager.query<PaymentTerminalRow[]>(
      `SELECT * FROM payment_terminal_operations
       WHERE id = ? AND tenant_id = ? LIMIT 1 FOR UPDATE`,
      [input.operationId, input.tenantId],
    );
    const row = rows[0];
    if (!row) throw new PaymentTerminalOperationError('NOT_FOUND');
    if (
      row.branch_id !== input.branchId ||
      row.cash_register_id !== input.cashRegisterId
    ) {
      throw new PaymentTerminalOperationError('CONTEXT_MISMATCH');
    }
    if (row.sale_id) throw new PaymentTerminalOperationError('ALREADY_USED');
    if (row.status !== 'CAPTURED')
      throw new PaymentTerminalOperationError('NOT_CAPTURED');
    if (row.amount !== input.amount || row.currency !== input.currency)
      throw new PaymentTerminalOperationError('AMOUNT_MISMATCH');
    if (!row.provider_reference || !row.authorization_code)
      throw new PaymentTerminalOperationError('NOT_CAPTURED');
    return {
      provider: row.provider_key,
      providerReference: row.provider_reference,
      authorizationCode: row.authorization_code,
    };
  }

  async linkSale(
    manager: EntityManager,
    tenantId: string,
    operationId: string,
    saleId: string,
  ): Promise<void> {
    const result = await manager.query<{ affectedRows?: number }>(
      `UPDATE payment_terminal_operations SET sale_id = ?
       WHERE id = ? AND tenant_id = ? AND status = 'CAPTURED' AND sale_id IS NULL`,
      [saleId, operationId, tenantId],
    );
    if (Number(result.affectedRows ?? 0) !== 1)
      throw new PaymentTerminalOperationError('ALREADY_USED');
  }

  private async findByIdempotency(tenantId: string, idempotencyKey: string) {
    const rows = await this.dataSource.query<PaymentTerminalRow[]>(
      `SELECT * FROM payment_terminal_operations
       WHERE tenant_id = ? AND idempotency_key = ? LIMIT 1`,
      [tenantId, idempotencyKey],
    );
    const row = rows[0];
    return row
      ? {
          operation: this.map(row),
          requestFingerprint: row.request_fingerprint,
          branchId: row.branch_id,
          cashRegisterId: row.cash_register_id,
        }
      : null;
  }

  private async findRow(manager: EntityManager, tenantId: string, id: string) {
    const rows = await manager.query<PaymentTerminalRow[]>(
      'SELECT * FROM payment_terminal_operations WHERE tenant_id = ? AND id = ? LIMIT 1',
      [tenantId, id],
    );
    return rows[0] ?? null;
  }

  private adapterState(row: PaymentTerminalRow): PaymentTerminalAdapterState {
    return {
      providerReference: row.provider_reference ?? `PENDING-${row.id}`,
      status: row.status,
      authorizationCode: row.authorization_code,
      errorCode: row.error_code,
    };
  }

  private map(row: PaymentTerminalRow): PaymentTerminalOperationData {
    return {
      id: row.id,
      provider: row.provider_key,
      adapterVersion: row.adapter_version,
      providerReference: row.provider_reference,
      amount: this.money(row.amount),
      currency: row.currency,
      status: row.status,
      errorCode: row.error_code,
      authorizationCode: row.authorization_code,
      correlationId: row.correlation_id,
      saleId: row.sale_id,
      queryCount: Number(row.query_count),
      createdAt: new Date(row.created_at).toISOString(),
      updatedAt: new Date(row.updated_at).toISOString(),
    };
  }

  private money(value: string): string {
    return Number(value).toFixed(2);
  }

  private isDuplicate(error: unknown): boolean {
    return (
      error instanceof QueryFailedError &&
      (error.driverError as { errno?: number }).errno === 1062
    );
  }
}
