import {
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { createHash, randomUUID } from 'node:crypto';
import { DataSource, EntityManager, QueryFailedError } from 'typeorm';
import {
  POS_PERIPHERAL_ADAPTER,
  PosPeripheralAdapterError,
} from './pos-peripheral.adapter';
import type { PosPeripheralAdapter } from './pos-peripheral.adapter';
import type {
  PosPeripheralAction,
  PosPeripheralOperationData,
  PosPeripheralProfileData,
  PosPeripheralTrigger,
} from './pos-peripheral.types';

interface ProfileRow {
  id: string;
  cash_register_id: string;
  cash_register_name: string;
  cash_register_code: string;
  device_id: string;
  label: string;
  adapter: 'SIMULATOR';
  printer_enabled: number | boolean;
  drawer_enabled: number | boolean;
  auto_open_cash_sale: number | boolean;
  updated_at: Date | string;
}

interface OperationRow {
  id: string;
  action: PosPeripheralAction;
  trigger_event: PosPeripheralTrigger;
  status: 'COMPLETED' | 'FAILED';
  attempt_count: number | string;
  error_code: string | null;
  sale_id: string | null;
  device_id: string;
  request_fingerprint: string;
  created_at: Date | string;
  completed_at: Date | string | null;
}

@Injectable()
export class PosPeripheralRepository {
  constructor(
    private readonly dataSource: DataSource,
    @Inject(POS_PERIPHERAL_ADAPTER)
    private readonly adapter: PosPeripheralAdapter,
  ) {}

  async getProfile(input: {
    tenantId: string;
    branchId: string;
    cashRegisterId: string;
  }): Promise<PosPeripheralProfileData> {
    return this.dataSource.transaction(async (manager) => {
      const row = await this.ensureProfile(manager, input);
      return this.profile(row);
    });
  }

  async updateProfile(input: {
    tenantId: string;
    branchId: string;
    cashRegisterId: string;
    deviceId: string;
    label: string;
    adapter: 'SIMULATOR';
    printerEnabled: boolean;
    drawerEnabled: boolean;
    autoOpenCashSale: boolean;
  }): Promise<PosPeripheralProfileData> {
    try {
      return await this.dataSource.transaction(async (manager) => {
        const current = await this.ensureProfile(manager, input, true);
        await manager.query(
          `UPDATE pos_peripheral_profiles
           SET device_id = ?, label = ?, adapter = ?, printer_enabled = ?,
               drawer_enabled = ?, auto_open_cash_sale = ?
           WHERE id = ? AND tenant_id = ?`,
          [
            input.deviceId,
            input.label.trim(),
            input.adapter,
            input.printerEnabled,
            input.drawerEnabled,
            input.autoOpenCashSale,
            current.id,
            input.tenantId,
          ],
        );
        return this.profile((await this.findProfile(manager, input, false))!);
      });
    } catch (error) {
      if (
        error instanceof QueryFailedError &&
        (error.driverError as { code?: string }).code === 'ER_DUP_ENTRY'
      ) {
        throw new ConflictException({
          code: 'PERIPHERAL_DEVICE_ALREADY_ASSIGNED',
          message: 'El dispositivo ya esta asignado a otra caja.',
        });
      }
      throw error;
    }
  }

  async execute(input: {
    tenantId: string;
    branchId: string;
    cashRegisterId: string;
    userId: string;
    action: PosPeripheralAction;
    trigger: PosPeripheralTrigger;
    saleId: string | null;
    idempotencyKey: string;
  }): Promise<{ operation: PosPeripheralOperationData; replay: boolean }> {
    const fingerprint = createHash('sha256')
      .update(
        JSON.stringify({
          cashRegisterId: input.cashRegisterId,
          action: input.action,
          trigger: input.trigger,
          saleId: input.saleId,
        }),
      )
      .digest('hex');
    return this.dataSource.transaction(async (manager) => {
      const profile = await this.ensureProfile(manager, input, true);
      const replay = await this.findOperation(
        manager,
        input.tenantId,
        input.idempotencyKey,
      );
      if (replay) return this.replay(replay, fingerprint);

      await this.validateOperation(manager, input, profile);
      let status: 'COMPLETED' | 'FAILED' = 'COMPLETED';
      let errorCode: string | null = null;
      try {
        await this.adapter.execute({
          deviceId: profile.device_id,
          action: input.action,
          saleId: input.saleId,
        });
      } catch (error) {
        status = 'FAILED';
        errorCode =
          error instanceof PosPeripheralAdapterError
            ? error.code
            : 'DEVICE_OPERATION_FAILED';
      }
      const id = randomUUID();
      await manager.query(
        `INSERT INTO pos_peripheral_operations
          (id, tenant_id, cash_register_id, profile_id, device_id, sale_id, action,
           trigger_event, status, error_code, idempotency_key,
           request_fingerprint, requested_by_user_id, completed_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
           CASE WHEN ? = 'COMPLETED' THEN CURRENT_TIMESTAMP(6) ELSE NULL END)`,
        [
          id,
          input.tenantId,
          input.cashRegisterId,
          profile.id,
          profile.device_id,
          input.saleId,
          input.action,
          input.trigger,
          status,
          errorCode,
          input.idempotencyKey,
          fingerprint,
          input.userId,
          status,
        ],
      );
      const operation = await this.findOperation(
        manager,
        input.tenantId,
        input.idempotencyKey,
      );
      return { operation: this.operation(operation!), replay: false };
    });
  }

  private async validateOperation(
    manager: EntityManager,
    input: {
      tenantId: string;
      branchId: string;
      cashRegisterId: string;
      action: PosPeripheralAction;
      trigger: PosPeripheralTrigger;
      saleId: string | null;
    },
    profile: ProfileRow,
  ): Promise<void> {
    if (
      (input.action === 'PRINT_RECEIPT' && !profile.printer_enabled) ||
      (input.action === 'OPEN_DRAWER' && !profile.drawer_enabled)
    ) {
      throw new ConflictException({
        code: 'PERIPHERAL_CAPABILITY_DISABLED',
        message:
          'La capacidad esta desactivada; utiliza el procedimiento manual.',
      });
    }
    if (
      input.trigger === 'CASH_SALE_COMPLETED' &&
      !profile.auto_open_cash_sale
    ) {
      throw new ConflictException({
        code: 'PERIPHERAL_AUTO_OPEN_DISABLED',
        message: 'La apertura automatica esta desactivada para esta caja.',
      });
    }
    if (input.action === 'PRINT_RECEIPT' || input.saleId) {
      const rows = await manager.query<Array<{ id: string; has_cash: number }>>(
        `SELECT sale.id,
                EXISTS(SELECT 1 FROM sale_payments payment
                  WHERE payment.tenant_id = sale.tenant_id
                    AND payment.sale_id = sale.id
                    AND payment.method = 'CASH'
                    AND payment.status = 'COMPLETED') AS has_cash
         FROM sales sale
         WHERE sale.id = ? AND sale.tenant_id = ? AND sale.branch_id = ?
           AND (? = 'PRINT_RECEIPT' OR sale.cash_register_id = ?) LIMIT 1`,
        [
          input.saleId,
          input.tenantId,
          input.branchId,
          input.action,
          input.cashRegisterId,
        ],
      );
      if (!rows[0]) throw new NotFoundException();
      if (input.trigger === 'CASH_SALE_COMPLETED' && !rows[0].has_cash) {
        throw new ConflictException({
          code: 'DRAWER_EVENT_NOT_ALLOWED',
          message:
            'El cajon solo puede abrirse automaticamente para una venta en efectivo.',
        });
      }
    }
    if (input.action === 'OPEN_DRAWER') {
      const shifts = await manager.query<Array<{ id: string }>>(
        `SELECT id FROM cash_register_shifts
         WHERE tenant_id = ? AND branch_id = ? AND cash_register_id = ?
           AND status = 'OPEN' LIMIT 1`,
        [input.tenantId, input.branchId, input.cashRegisterId],
      );
      if (!shifts[0]) {
        throw new ConflictException({
          code: 'CASH_REGISTER_SHIFT_REQUIRED',
          message: 'Abre el turno de caja antes de operar el cajon.',
        });
      }
    }
  }

  private replay(
    row: OperationRow,
    fingerprint: string,
  ): { operation: PosPeripheralOperationData; replay: boolean } {
    if (row.request_fingerprint !== fingerprint) {
      throw new ConflictException({
        code: 'IDEMPOTENCY_KEY_REUSED',
        message: 'La clave de idempotencia ya se utilizo con otra operacion.',
      });
    }
    return { operation: this.operation(row), replay: true };
  }

  private async ensureProfile(
    manager: EntityManager,
    input: { tenantId: string; branchId: string; cashRegisterId: string },
    lock = false,
  ): Promise<ProfileRow> {
    let row = await this.findProfile(manager, input, lock);
    if (row) return row;
    const registers = await manager.query<
      Array<{ id: string; name: string; code: string }>
    >(
      `SELECT id, name, code FROM cash_registers
       WHERE id = ? AND tenant_id = ? AND branch_id = ? LIMIT 1`,
      [input.cashRegisterId, input.tenantId, input.branchId],
    );
    const register = registers[0];
    if (!register) throw new NotFoundException();
    await manager.query(
      `INSERT IGNORE INTO pos_peripheral_profiles
        (id, tenant_id, cash_register_id, device_id, label, adapter,
         printer_enabled, drawer_enabled, auto_open_cash_sale)
       VALUES (?, ?, ?, ?, ?, 'SIMULATOR', TRUE, TRUE, TRUE)`,
      [
        randomUUID(),
        input.tenantId,
        input.cashRegisterId,
        `SIM-${input.cashRegisterId}`,
        `Simulador ${register.name}`,
      ],
    );
    row = await this.findProfile(manager, input, lock);
    if (!row) throw new NotFoundException();
    return row;
  }

  private async findProfile(
    manager: EntityManager,
    input: { tenantId: string; branchId: string; cashRegisterId: string },
    lock: boolean,
  ): Promise<ProfileRow | undefined> {
    const rows = await manager.query<ProfileRow[]>(
      `SELECT profile.id, profile.cash_register_id, register.name AS cash_register_name,
              register.code AS cash_register_code, profile.device_id, profile.label,
              profile.adapter, profile.printer_enabled, profile.drawer_enabled,
              profile.auto_open_cash_sale, profile.updated_at
       FROM pos_peripheral_profiles profile
       INNER JOIN cash_registers register
         ON register.id = profile.cash_register_id
        AND register.tenant_id = profile.tenant_id
       WHERE profile.tenant_id = ? AND profile.cash_register_id = ?
         AND register.branch_id = ? LIMIT 1${lock ? ' FOR UPDATE' : ''}`,
      [input.tenantId, input.cashRegisterId, input.branchId],
    );
    return rows[0];
  }

  private async findOperation(
    manager: EntityManager,
    tenantId: string,
    idempotencyKey: string,
  ): Promise<OperationRow | undefined> {
    const rows = await manager.query<OperationRow[]>(
      `SELECT operation.id, operation.action, operation.trigger_event,
              operation.status, operation.attempt_count, operation.error_code,
              operation.sale_id, operation.device_id,
              operation.request_fingerprint, operation.created_at,
              operation.completed_at
       FROM pos_peripheral_operations operation
       WHERE operation.tenant_id = ? AND operation.idempotency_key = ? LIMIT 1`,
      [tenantId, idempotencyKey],
    );
    return rows[0];
  }

  private profile(row: ProfileRow): PosPeripheralProfileData {
    return {
      id: row.id,
      cashRegister: {
        id: row.cash_register_id,
        name: row.cash_register_name,
        code: row.cash_register_code,
      },
      deviceId: row.device_id,
      label: row.label,
      adapter: row.adapter,
      printerEnabled: Boolean(row.printer_enabled),
      drawerEnabled: Boolean(row.drawer_enabled),
      autoOpenCashSale: Boolean(row.auto_open_cash_sale),
      updatedAt: new Date(row.updated_at).toISOString(),
    };
  }

  private operation(row: OperationRow): PosPeripheralOperationData {
    return {
      id: row.id,
      action: row.action,
      trigger: row.trigger_event,
      status: row.status,
      attemptCount: Number(row.attempt_count),
      errorCode: row.error_code,
      saleId: row.sale_id,
      deviceId: row.device_id,
      createdAt: new Date(row.created_at).toISOString(),
      completedAt: row.completed_at
        ? new Date(row.completed_at).toISOString()
        : null,
    };
  }
}
