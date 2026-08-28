import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { CloseInventoryCountSessionDto } from './dto/close-inventory-count-session.dto';
import { CreateInventoryCountSessionDto } from './dto/create-inventory-count-session.dto';
import { RecordInventoryCountDto } from './dto/record-inventory-count.dto';
import {
  InventoryCountAttemptConflictError,
  InventoryCountSessionClosedError,
  InventoryCountSessionIncompleteError,
  InventoryCountSessionNotFoundError,
  InventoryCountStockChangedError,
} from './inventory-count.errors';
import { InventoryCountRepository } from './inventory-count.repository';
import {
  InventorySerialQuantityError,
  InventorySerialRequiredError,
} from './inventory-serial-tracking';
import {
  IdempotencyConflictError,
  InventoryTargetNotFoundError,
} from './inventory.errors';

@Injectable()
export class InventoryCountService {
  constructor(private readonly counts: InventoryCountRepository) {}

  async create(input: {
    tenantId: string;
    branchId: string;
    warehouseId: string;
    userId: string;
    idempotencyKey: string | undefined;
    dto: CreateInventoryCountSessionDto;
  }) {
    this.assertIdempotencyKey(input.idempotencyKey);
    try {
      const result = await this.counts.createSession({
        ...input,
        idempotencyKey: input.idempotencyKey!,
        ...input.dto,
      });
      return {
        data: result.session,
        meta: { apiVersion: '1' as const, idempotentReplay: result.replay },
      };
    } catch (error) {
      this.mapError(error);
    }
  }

  async list(tenantId: string, warehouseId: string) {
    return {
      data: await this.counts.listSessions(tenantId, warehouseId),
      meta: { apiVersion: '1' as const },
    };
  }

  async get(tenantId: string, warehouseId: string, sessionId: string) {
    const session = await this.counts.getSession(
      tenantId,
      warehouseId,
      sessionId,
    );
    if (!session) throw new NotFoundException();
    return { data: session, meta: { apiVersion: '1' as const } };
  }

  async record(input: {
    tenantId: string;
    warehouseId: string;
    sessionId: string;
    productId: string;
    userId: string;
    dto: RecordInventoryCountDto;
  }) {
    try {
      return {
        data: await this.counts.recordCount({ ...input, ...input.dto }),
        meta: { apiVersion: '1' as const },
      };
    } catch (error) {
      this.mapError(error);
    }
  }

  async close(input: {
    tenantId: string;
    warehouseId: string;
    sessionId: string;
    userId: string;
    dto: CloseInventoryCountSessionDto;
  }) {
    try {
      return {
        data: await this.counts.closeSession({ ...input, ...input.dto }),
        meta: { apiVersion: '1' as const },
      };
    } catch (error) {
      this.mapError(error);
    }
  }

  private assertIdempotencyKey(value: string | undefined): void {
    if (!value || !/^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/.test(value)) {
      throw new BadRequestException({
        code: 'INVALID_IDEMPOTENCY_KEY',
        message:
          'Idempotency-Key es obligatorio y debe tener entre 8 y 128 caracteres.',
      });
    }
  }

  private mapError(error: unknown): never {
    if (
      error instanceof InventoryTargetNotFoundError ||
      error instanceof InventoryCountSessionNotFoundError
    ) {
      throw new NotFoundException();
    }
    if (error instanceof InventoryCountSessionClosedError) {
      throw new ConflictException({
        code: 'INVENTORY_COUNT_SESSION_CLOSED',
        message: 'La sesión de conteo ya está cerrada.',
      });
    }
    if (error instanceof InventoryCountSessionIncompleteError) {
      throw new ConflictException({
        code: 'INVENTORY_COUNT_SESSION_INCOMPLETE',
        message:
          'Todos los productos deben tener una captura antes del cierre.',
      });
    }
    if (error instanceof InventoryCountAttemptConflictError) {
      throw new ConflictException({
        code: 'INVENTORY_COUNT_ATTEMPT_CONFLICT',
        currentAttempt: error.currentAttempt,
        message: 'Otro usuario registró un conteo; recarga antes de reconteo.',
      });
    }
    if (error instanceof InventoryCountStockChangedError) {
      throw new ConflictException({
        code: 'INVENTORY_COUNT_STOCK_CHANGED',
        productId: error.productId,
        currentQuantity: error.currentQuantity,
        message:
          'El stock cambió desde la apertura; inicia una nueva sesión controlada.',
      });
    }
    if (error instanceof IdempotencyConflictError) {
      throw new ConflictException({
        code: 'IDEMPOTENCY_KEY_REUSED',
        message: 'La clave de idempotencia ya fue usada con otros datos.',
      });
    }
    if (
      error instanceof InventorySerialRequiredError ||
      error instanceof InventorySerialQuantityError
    ) {
      throw new BadRequestException({
        code: 'INVENTORY_SERIALS_REQUIRED',
        message:
          'El conteo de un producto serializado requiere identificar cada unidad.',
      });
    }
    throw error;
  }
}
