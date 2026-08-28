import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { CreateInventoryTransferDto } from './dto/create-inventory-transfer.dto';
import { ReceiveInventoryTransferDto } from './dto/receive-inventory-transfer.dto';
import {
  DuplicateInventoryTransferLineError,
  InvalidInventoryTransferTargetError,
  InventoryTransferIdempotencyConflictError,
  InventoryTransferInsufficientStockError,
  InventoryTransferNotFoundError,
  InventoryTransferStatusConflictError,
  InvalidInventoryTransferReceiptError,
  InventoryTransferDiscrepancyReasonRequiredError,
  InventoryTransferReceiptExceedsPendingError,
} from './inventory-transfer.errors';
import {
  InventoryFifoCurrencyMismatchError,
  InventoryFifoLayerShortageError,
} from './inventory.errors';
import { InventoryTransferRepository } from './inventory-transfer.repository';
import {
  InventoryTransferListResponse,
  InventoryTransferResponse,
} from './inventory-transfer.types';

@Injectable()
export class InventoryTransferService {
  constructor(private readonly transfers: InventoryTransferRepository) {}

  async list(
    tenantId: string,
    branchId: string,
  ): Promise<InventoryTransferListResponse> {
    return {
      data: await this.transfers.list(tenantId, branchId),
      meta: { apiVersion: '1' },
    };
  }

  async get(
    tenantId: string,
    branchId: string,
    transferId: string,
  ): Promise<InventoryTransferResponse> {
    const transfer = await this.transfers.findById(tenantId, transferId);
    if (
      !transfer ||
      ![
        transfer.originWarehouse.branch.id,
        transfer.destinationWarehouse.branch.id,
      ].includes(branchId)
    )
      throw new NotFoundException();
    return { data: transfer, meta: { apiVersion: '1' } };
  }

  async create(input: {
    tenantId: string;
    originWarehouseId: string;
    userId: string;
    idempotencyKey: string | undefined;
    dto: CreateInventoryTransferDto;
  }): Promise<InventoryTransferResponse> {
    const idempotencyKey = this.idempotencyKey(input.idempotencyKey);
    return this.mapErrors(async () => {
      const result = await this.transfers.create({
        ...input,
        idempotencyKey,
      });
      return {
        data: result.transfer,
        meta: { apiVersion: '1', idempotentReplay: result.replay },
      };
    });
  }

  async dispatch(input: {
    tenantId: string;
    transferId: string;
    originWarehouseId: string;
    userId: string;
    idempotencyKey: string | undefined;
  }): Promise<InventoryTransferResponse> {
    const idempotencyKey = this.idempotencyKey(input.idempotencyKey);
    return this.mapErrors(async () => {
      const result = await this.transfers.dispatch({
        ...input,
        idempotencyKey,
      });
      return {
        data: result.transfer,
        meta: { apiVersion: '1', idempotentReplay: result.replay },
      };
    });
  }

  async cancel(
    tenantId: string,
    transferId: string,
    originWarehouseId: string,
    userId: string,
  ): Promise<InventoryTransferResponse> {
    return this.mapErrors(async () => ({
      data: await this.transfers.cancel(
        tenantId,
        transferId,
        originWarehouseId,
        userId,
      ),
      meta: { apiVersion: '1' },
    }));
  }

  async receive(input: {
    tenantId: string;
    transferId: string;
    destinationWarehouseId: string;
    userId: string;
    idempotencyKey: string | undefined;
    dto: ReceiveInventoryTransferDto;
  }): Promise<InventoryTransferResponse> {
    const idempotencyKey = this.idempotencyKey(input.idempotencyKey);
    return this.mapErrors(async () => {
      const result = await this.transfers.receive({ ...input, idempotencyKey });
      return {
        data: result.transfer,
        meta: { apiVersion: '1', idempotentReplay: result.replay },
      };
    });
  }

  private idempotencyKey(value: string | undefined): string {
    if (!value || !/^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/.test(value)) {
      throw new BadRequestException({
        code: 'INVALID_IDEMPOTENCY_KEY',
        message:
          'Idempotency-Key es obligatorio y debe tener entre 8 y 128 caracteres.',
      });
    }
    return value;
  }

  private async mapErrors<T>(operation: () => Promise<T>): Promise<T> {
    try {
      return await operation();
    } catch (error) {
      if (error instanceof InventoryFifoLayerShortageError) {
        throw new ConflictException({ code: 'INVENTORY_FIFO_LAYER_SHORTAGE' });
      }
      if (error instanceof InventoryFifoCurrencyMismatchError) {
        throw new ConflictException({
          code: 'INVENTORY_FIFO_CURRENCY_MISMATCH',
        });
      }
      if (error instanceof InventoryTransferNotFoundError)
        throw new NotFoundException();
      if (error instanceof InvalidInventoryTransferTargetError) {
        throw new BadRequestException({
          code: 'INVALID_TRANSFER_TARGET',
          message: 'El origen, destino, producto o ubicaciones no son válidos.',
        });
      }
      if (error instanceof DuplicateInventoryTransferLineError) {
        throw new BadRequestException({
          code: 'DUPLICATE_TRANSFER_LINE',
          message: 'La transferencia contiene líneas duplicadas.',
        });
      }
      if (error instanceof InventoryTransferIdempotencyConflictError) {
        throw new ConflictException({
          code: 'IDEMPOTENCY_KEY_REUSED',
          message: 'La clave de idempotencia ya fue usada con otros datos.',
        });
      }
      if (error instanceof InventoryTransferInsufficientStockError) {
        throw new ConflictException({
          code: 'INSUFFICIENT_AVAILABLE_STOCK',
          message: 'El origen no tiene stock disponible suficiente.',
        });
      }
      if (error instanceof InventoryTransferStatusConflictError) {
        throw new ConflictException({
          code: 'TRANSFER_STATUS_CONFLICT',
          message: 'La transferencia ya no permite esta operación.',
        });
      }
      if (error instanceof InvalidInventoryTransferReceiptError) {
        throw new BadRequestException({
          code: 'INVALID_TRANSFER_RECEIPT',
          message: 'La recepción contiene líneas o cantidades no válidas.',
        });
      }
      if (error instanceof InventoryTransferDiscrepancyReasonRequiredError) {
        throw new BadRequestException({
          code: 'TRANSFER_DISCREPANCY_REASON_REQUIRED',
          message: 'Las diferencias de recepción requieren un motivo.',
        });
      }
      if (error instanceof InventoryTransferReceiptExceedsPendingError) {
        throw new ConflictException({
          code: 'TRANSFER_RECEIPT_EXCEEDS_PENDING',
          message: 'La cantidad supera lo pendiente de recibir.',
        });
      }
      throw error;
    }
  }
}
