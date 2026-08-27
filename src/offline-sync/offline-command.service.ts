import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  HttpException,
  Injectable,
  UnprocessableEntityException,
} from '@nestjs/common';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { createHash } from 'node:crypto';
import type { SessionIdentity } from '../auth/session/session.types';
import type { AppPermission } from '../auth/authorization/authorization.types';
import { AuditService } from '../audit/audit.service';
import { InventoryService } from '../inventory/inventory.service';
import { PosService } from '../pos/pos.service';
import {
  OfflineCommandBatchDto,
  OfflineCommandDto,
} from './dto/offline-command-batch.dto';
import { OfflineCashSaleCommandDto } from './dto/offline-cash-sale-command.dto';
import { OfflineInventoryCountCommandDto } from './dto/offline-inventory-count-command.dto';
import { OfflineInventoryMovementCommandDto } from './dto/offline-inventory-movement-command.dto';
import {
  OfflineCommandConflictError,
  OfflineCommandSequenceError,
} from './offline-command.errors';
import { OfflineCommandRepository } from './offline-command.repository';
import {
  OfflineCommandExecution,
  OfflineCommandResult,
} from './offline-command.types';

@Injectable()
export class OfflineCommandService {
  constructor(
    private readonly repository: OfflineCommandRepository,
    private readonly inventory: InventoryService,
    private readonly pos: PosService,
    private readonly audit: AuditService,
  ) {}

  async executeBatch(
    principal: SessionIdentity,
    dto: OfflineCommandBatchDto,
    correlationId: string,
  ) {
    const results: OfflineCommandResult[] = [];
    for (const command of dto.commands) {
      this.assertEnvelope(principal, command);
      try {
        results.push(
          await this.repository.execute(
            command,
            this.fingerprint(command),
            () => this.apply(principal, command, correlationId),
          ),
        );
      } catch (error) {
        if (error instanceof OfflineCommandConflictError) {
          throw new ConflictException({
            code: 'OFFLINE_COMMAND_CONFLICT',
            message:
              'El ID o la clave idempotente ya se usaron con otro comando.',
          });
        }
        if (error instanceof OfflineCommandSequenceError) {
          throw new ConflictException({
            code: 'OFFLINE_COMMAND_SEQUENCE_GAP',
            expectedSequence: error.expectedSequence,
            message: 'Los comandos deben enviarse en orden causal.',
          });
        }
        throw error;
      }
    }
    return {
      data: { results },
      meta: { apiVersion: '1' as const },
    };
  }

  private async apply(
    principal: SessionIdentity,
    command: OfflineCommandDto,
    correlationId: string,
  ): Promise<OfflineCommandExecution> {
    try {
      if (command.kind === 'INVENTORY_MOVEMENT') {
        this.requirePermission(principal, 'INVENTORY_ADJUST');
        if (!principal.context.warehouse) throw new ForbiddenException();
        const payload = await this.payload(
          OfflineInventoryMovementCommandDto,
          command.payload,
        );
        const response = await this.inventory.createMovement({
          tenantId: principal.tenant.id,
          warehouseId: principal.context.warehouse.id,
          userId: principal.user.id,
          idempotencyKey: command.idempotencyKey,
          dto: payload,
        });
        await this.audit.record({
          tenantId: principal.tenant.id,
          actorUserId: principal.user.id,
          action: 'OFFLINE_INVENTORY_MOVEMENT_CONFIRMED',
          entityType: 'INVENTORY_MOVEMENT',
          entityId: response.data.id,
          correlationId,
          deduplicate: true,
          after: {
            commandId: command.commandId,
            deviceId: command.scope.deviceId,
          },
        });
        return { status: 'CONFIRMED', result: response };
      }
      if (command.kind === 'INVENTORY_COUNT') {
        this.requirePermission(principal, 'INVENTORY_COUNT');
        if (!principal.context.warehouse) throw new ForbiddenException();
        const payload = await this.payload(
          OfflineInventoryCountCommandDto,
          command.payload,
        );
        const response = await this.inventory.createCount({
          tenantId: principal.tenant.id,
          warehouseId: principal.context.warehouse.id,
          userId: principal.user.id,
          idempotencyKey: command.idempotencyKey,
          dto: payload,
        });
        await this.audit.record({
          tenantId: principal.tenant.id,
          actorUserId: principal.user.id,
          action: 'OFFLINE_INVENTORY_COUNT_CONFIRMED',
          entityType: 'INVENTORY_COUNT',
          entityId: response.data.id,
          correlationId,
          deduplicate: true,
          after: {
            commandId: command.commandId,
            deviceId: command.scope.deviceId,
            snapshotQuantity: payload.snapshotQuantity,
            countedQuantity: payload.countedQuantity,
            reference: payload.reference,
            capturedAt: payload.capturedAt,
          },
        });
        return { status: 'CONFIRMED', result: response };
      }
      if (command.kind === 'CASH_SALE') {
        this.requirePermission(principal, 'SALES_MANAGE');
        const { branch, warehouse, cashRegister } = principal.context;
        if (!branch || !warehouse || !cashRegister)
          throw new ForbiddenException();
        const payload = await this.payload(
          OfflineCashSaleCommandDto,
          command.payload,
        );
        const response = await this.pos.createCashSale({
          tenantId: principal.tenant.id,
          branchId: branch.id,
          warehouseId: warehouse.id,
          cashRegisterId: cashRegister.id,
          userId: principal.user.id,
          idempotencyKey: command.idempotencyKey,
          dto: payload,
          expectedSnapshot: payload.snapshot,
        });
        await this.audit.record({
          tenantId: principal.tenant.id,
          actorUserId: principal.user.id,
          action: 'OFFLINE_SALE_CONFIRMED',
          entityType: 'SALE',
          entityId: response.data.id,
          correlationId,
          deduplicate: true,
          after: {
            commandId: command.commandId,
            deviceId: command.scope.deviceId,
          },
        });
        return { status: 'CONFIRMED', result: response };
      }
      throw new UnprocessableEntityException({
        code: 'OFFLINE_COMMAND_NOT_SUPPORTED',
        message: 'Este tipo de comando todavía no puede aplicarse offline.',
      });
    } catch (error) {
      if (error instanceof HttpException && error.getStatus() < 500) {
        return {
          status: 'ERROR',
          error: { status: error.getStatus(), details: error.getResponse() },
        };
      }
      throw error;
    }
  }

  private assertEnvelope(
    principal: SessionIdentity,
    command: OfflineCommandDto,
  ): void {
    const { branch, cashRegister } = principal.context;
    if (
      command.scope.tenantId !== principal.tenant.id ||
      command.scope.userId !== principal.user.id ||
      command.scope.branchId !== (branch?.id ?? null) ||
      command.scope.cashRegisterId !== (cashRegister?.id ?? null)
    ) {
      throw new ForbiddenException({
        code: 'OFFLINE_COMMAND_SCOPE_DENIED',
        message: 'El comando no pertenece al alcance activo y autorizado.',
      });
    }
    const createdAt = new Date(command.createdAt).getTime();
    if (
      !Number.isFinite(createdAt) ||
      createdAt > Date.now() + 5 * 60_000 ||
      createdAt < Date.now() - 30 * 24 * 60 * 60_000
    ) {
      throw new BadRequestException({
        code: 'INVALID_OFFLINE_COMMAND_TIMESTAMP',
        message: 'La fecha del comando está fuera de la ventana permitida.',
      });
    }
  }

  private requirePermission(
    principal: SessionIdentity,
    permission: AppPermission,
  ): void {
    if (!principal.user.permissions.includes(permission)) {
      throw new ForbiddenException({
        code: 'OFFLINE_COMMAND_PERMISSION_DENIED',
        message: 'No tienes permiso para aplicar este comando.',
      });
    }
  }

  private async payload<T extends object>(
    type: new () => T,
    value: Record<string, unknown>,
  ): Promise<T> {
    const dto = plainToInstance(type, value);
    const errors = await validate(dto, {
      whitelist: true,
      forbidNonWhitelisted: true,
    });
    if (errors.length) {
      throw new BadRequestException({
        code: 'INVALID_OFFLINE_COMMAND_PAYLOAD',
        message: 'El payload del comando no es válido.',
      });
    }
    return dto;
  }

  private fingerprint(command: OfflineCommandDto): string {
    return createHash('sha256').update(this.canonical(command)).digest('hex');
  }

  private canonical(value: unknown): string {
    if (Array.isArray(value))
      return `[${value.map((item) => this.canonical(item)).join(',')}]`;
    if (value && typeof value === 'object') {
      return `{${Object.entries(value)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(
          ([key, child]) => `${JSON.stringify(key)}:${this.canonical(child)}`,
        )
        .join(',')}}`;
    }
    return JSON.stringify(value);
  }
}
