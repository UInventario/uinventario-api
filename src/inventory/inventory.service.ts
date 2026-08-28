import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { CreateInventoryMovementDto } from './dto/create-inventory-movement.dto';
import { CreateInventoryStateTransitionDto } from './dto/create-inventory-state-transition.dto';
import { ListInventoryStockDto } from './dto/list-inventory-stock.dto';
import { ListInventoryMovementsDto } from './dto/list-inventory-movements.dto';
import {
  IdempotencyConflictError,
  InitialStockAlreadyExistsError,
  InsufficientStockError,
  InventoryTargetNotFoundError,
  InventoryCountConflictError,
  MovementReferenceRequiredError,
  InsufficientStockStateError,
  InvalidStockStateTransitionError,
  InsufficientInventoryLotStockError,
  InvalidInventoryLotCodeError,
  InventoryLotCurrencyMismatchError,
  InventoryLotNotFoundError,
  InventoryLotRequiredError,
  InventoryFifoCurrencyMismatchError,
  InventoryFifoLayerShortageError,
} from './inventory.errors';
import { InventoryRepository } from './inventory.repository';
import {
  InventorySerialDuplicateError,
  InventorySerialNotFoundError,
  InventorySerialQuantityError,
  InventorySerialRequiredError,
  InventorySerialStateConflictError,
} from './inventory-serial-tracking';
import {
  InventoryBalanceResponse,
  InventoryCountInput,
  InventoryCountResponse,
  InventoryLocationsResponse,
  InventoryMovementResponse,
  InventoryMovementListResponse,
  InventoryStockListResponse,
  InventoryStateTransitionResponse,
  InventoryLotsResponse,
  InventoryFifoLayersResponse,
  InventorySerialHistoryResponse,
  InventorySerialsResponse,
  INVENTORY_STOCK_POLICY,
} from './inventory.types';

@Injectable()
export class InventoryService {
  constructor(private readonly inventory: InventoryRepository) {}

  async listLocations(
    tenantId: string,
    warehouseId: string,
  ): Promise<InventoryLocationsResponse> {
    return {
      data: await this.inventory.listLocations(tenantId, warehouseId),
      meta: { apiVersion: '1' },
    };
  }

  async listLots(
    tenantId: string,
    warehouseId: string,
    productId: string,
  ): Promise<InventoryLotsResponse> {
    try {
      const result = await this.inventory.listLots(
        tenantId,
        warehouseId,
        productId,
      );
      return {
        data: result.items,
        meta: {
          apiVersion: '1',
          tracked: result.tracked,
          totalQuantity: result.totalQuantity,
          lotQuantity: result.lotQuantity,
          reconciled: result.totalQuantity === result.lotQuantity,
          currency: result.currency,
          inventoryValue: result.inventoryValue,
        },
      };
    } catch (error) {
      if (error instanceof InventoryTargetNotFoundError)
        throw new NotFoundException();
      throw error;
    }
  }

  async listFifoLayers(
    tenantId: string,
    warehouseId: string,
    productId: string,
  ): Promise<InventoryFifoLayersResponse> {
    try {
      const result = await this.inventory.listFifoLayers(
        tenantId,
        warehouseId,
        productId,
      );
      return {
        data: result.items,
        meta: {
          apiVersion: '1',
          method: 'FIFO',
          cutover: result.cutover,
          totalQuantity: result.totalQuantity,
          layerQuantity: result.layerQuantity,
          reconciled: result.totalQuantity === result.layerQuantity,
          currency: result.currency,
          inventoryValue: result.inventoryValue,
        },
      };
    } catch (error) {
      if (error instanceof InventoryTargetNotFoundError)
        throw new NotFoundException();
      throw error;
    }
  }

  async listMovements(
    tenantId: string,
    branchId: string,
    query: ListInventoryMovementsDto,
  ): Promise<InventoryMovementListResponse> {
    if (query.dateFrom && query.dateTo && query.dateFrom > query.dateTo) {
      throw new BadRequestException({
        code: 'INVALID_DATE_RANGE',
        message: 'La fecha inicial no puede ser posterior a la fecha final.',
      });
    }
    try {
      const result = await this.inventory.listMovements(
        tenantId,
        branchId,
        query,
      );
      return {
        data: result.items,
        meta: {
          apiVersion: '1',
          scope: result.scope,
          pagination: {
            page: query.page,
            pageSize: query.pageSize,
            total: result.total,
            totalPages: Math.ceil(result.total / query.pageSize),
          },
        },
      };
    } catch (error) {
      if (error instanceof InventoryTargetNotFoundError)
        throw new NotFoundException();
      throw error;
    }
  }

  async listStock(
    tenantId: string,
    branchId: string,
    warehouseId: string,
    query: ListInventoryStockDto,
  ): Promise<InventoryStockListResponse> {
    try {
      const result = await this.inventory.listStock(
        tenantId,
        branchId,
        warehouseId,
        query,
      );
      return {
        data: result.items,
        meta: {
          apiVersion: '1',
          policy: INVENTORY_STOCK_POLICY,
          scope: result.scope,
          valuation: result.valuation,
          pagination: {
            page: query.page,
            pageSize: query.pageSize,
            total: result.total,
            totalPages: Math.ceil(result.total / query.pageSize),
          },
        },
      };
    } catch (error) {
      if (error instanceof InventoryTargetNotFoundError)
        throw new NotFoundException();
      throw error;
    }
  }

  async getBalance(
    tenantId: string,
    warehouseId: string,
    productId: string,
    locationId: string,
  ): Promise<InventoryBalanceResponse> {
    try {
      return {
        data: await this.inventory.getBalance(
          tenantId,
          warehouseId,
          productId,
          locationId,
        ),
        meta: { apiVersion: '1', policy: INVENTORY_STOCK_POLICY },
      };
    } catch (error) {
      if (error instanceof InventoryTargetNotFoundError)
        throw new NotFoundException();
      throw error;
    }
  }

  async createMovement(input: {
    tenantId: string;
    warehouseId: string;
    userId: string;
    idempotencyKey: string | undefined;
    dto: CreateInventoryMovementDto;
  }): Promise<InventoryMovementResponse> {
    if (
      !input.idempotencyKey ||
      !/^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/.test(input.idempotencyKey)
    ) {
      throw new BadRequestException({
        code: 'INVALID_IDEMPOTENCY_KEY',
        message:
          'Idempotency-Key es obligatorio y debe tener entre 8 y 128 caracteres.',
      });
    }
    try {
      const result = await this.inventory.createMovement({
        ...input,
        idempotencyKey: input.idempotencyKey,
      });
      return {
        data: result.movement,
        meta: { apiVersion: '1', idempotentReplay: result.replay },
      };
    } catch (error) {
      if (error instanceof InventoryTargetNotFoundError)
        throw new NotFoundException();
      if (error instanceof InitialStockAlreadyExistsError) {
        throw new ConflictException({
          code: 'INITIAL_STOCK_ALREADY_EXISTS',
          message:
            'El stock inicial ya fue registrado para este producto y ubicación.',
        });
      }
      if (error instanceof MovementReferenceRequiredError) {
        throw new BadRequestException({
          code: 'MOVEMENT_REFERENCE_REQUIRED',
          message:
            'La referencia o evidencia es obligatoria para este tipo de movimiento.',
        });
      }
      if (error instanceof IdempotencyConflictError) {
        throw new ConflictException({
          code: 'IDEMPOTENCY_KEY_REUSED',
          message: 'La clave de idempotencia ya fue usada con otros datos.',
        });
      }
      if (error instanceof InsufficientStockError) {
        throw new ConflictException({
          code: 'INVALID_STOCK_QUANTITY',
          message: 'La cantidad es inválida o dejaría el saldo negativo.',
        });
      }
      this.rethrowLotError(error);
      this.rethrowSerialError(error);
      throw error;
    }
  }

  private rethrowLotError(error: unknown): void {
    if (error instanceof InventoryFifoLayerShortageError) {
      throw new ConflictException({
        code: 'INVENTORY_FIFO_LAYER_SHORTAGE',
        message:
          'Las capas FIFO no concilian con el inventario; la operaciÃ³n fue revertida.',
      });
    }
    if (error instanceof InventoryFifoCurrencyMismatchError) {
      throw new ConflictException({
        code: 'INVENTORY_FIFO_CURRENCY_MISMATCH',
        message: 'Las capas FIFO de un producto deben usar una sola moneda.',
      });
    }
    if (error instanceof InventoryLotRequiredError) {
      throw new BadRequestException({
        code: 'INVENTORY_LOT_REQUIRED',
        message: 'Indica el lote para este producto.',
      });
    }
    if (error instanceof InvalidInventoryLotCodeError) {
      throw new BadRequestException({
        code: 'INVALID_INVENTORY_LOT_CODE',
        message: 'El código de lote no tiene un formato válido.',
      });
    }
    if (error instanceof InventoryLotNotFoundError) {
      throw new NotFoundException({ code: 'INVENTORY_LOT_NOT_FOUND' });
    }
    if (error instanceof InsufficientInventoryLotStockError) {
      throw new ConflictException({
        code: 'INSUFFICIENT_INVENTORY_LOT_STOCK',
        message: 'El lote no tiene existencias suficientes.',
      });
    }
    if (error instanceof InventoryLotCurrencyMismatchError) {
      throw new ConflictException({
        code: 'INVENTORY_LOT_CURRENCY_MISMATCH',
        message: 'Los lotes de un producto deben usar una sola moneda.',
      });
    }
  }

  async listSerials(
    tenantId: string,
    warehouseId: string,
    productId: string,
  ): Promise<InventorySerialsResponse> {
    try {
      const result = await this.inventory.listSerials(
        tenantId,
        warehouseId,
        productId,
      );
      return {
        data: result.items,
        meta: { apiVersion: '1', tracked: result.tracked },
      };
    } catch (error) {
      if (error instanceof InventoryTargetNotFoundError)
        throw new NotFoundException();
      throw error;
    }
  }

  async serialHistory(
    tenantId: string,
    warehouseId: string,
    serialId: string,
  ): Promise<InventorySerialHistoryResponse> {
    try {
      return {
        data: await this.inventory.serialHistory(
          tenantId,
          warehouseId,
          serialId,
        ),
        meta: { apiVersion: '1' },
      };
    } catch (error) {
      if (error instanceof InventoryTargetNotFoundError)
        throw new NotFoundException();
      throw error;
    }
  }

  private rethrowSerialError(error: unknown): void {
    if (
      error instanceof InventorySerialRequiredError ||
      error instanceof InventorySerialQuantityError
    ) {
      throw new BadRequestException({
        code: 'INVENTORY_SERIALS_REQUIRED',
        message:
          'Indica un nÃºmero de serie Ãºnico por cada unidad del producto.',
      });
    }
    if (error instanceof InventorySerialNotFoundError) {
      throw new NotFoundException({ code: 'INVENTORY_SERIAL_NOT_FOUND' });
    }
    if (error instanceof InventorySerialDuplicateError) {
      throw new ConflictException({
        code: 'INVENTORY_SERIAL_ALREADY_EXISTS',
        message: 'Uno de los nÃºmeros de serie ya existe en la empresa.',
      });
    }
    if (error instanceof InventorySerialStateConflictError) {
      throw new ConflictException({
        code: 'INVENTORY_SERIAL_STATE_CONFLICT',
        message:
          'Una serie no pertenece al producto, ubicaciÃ³n o estado requerido.',
      });
    }
  }

  async createCount(input: {
    tenantId: string;
    warehouseId: string;
    userId: string;
    idempotencyKey: string | undefined;
    dto: InventoryCountInput;
  }): Promise<InventoryCountResponse> {
    if (
      !input.idempotencyKey ||
      !/^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/.test(input.idempotencyKey)
    ) {
      throw new BadRequestException({
        code: 'INVALID_IDEMPOTENCY_KEY',
        message:
          'Idempotency-Key es obligatorio y debe tener entre 8 y 128 caracteres.',
      });
    }
    try {
      const result = await this.inventory.createCount({
        ...input,
        idempotencyKey: input.idempotencyKey,
      });
      return {
        data: result.count,
        meta: { apiVersion: '1', idempotentReplay: result.replay },
      };
    } catch (error) {
      if (error instanceof InventoryTargetNotFoundError)
        throw new NotFoundException();
      if (error instanceof InventoryCountConflictError) {
        throw new ConflictException({
          code: 'INVENTORY_COUNT_CONFLICT',
          currentQuantity: error.currentQuantity,
          message:
            'El saldo cambió desde la captura; revisa el conteo antes de reintentarlo.',
        });
      }
      if (error instanceof IdempotencyConflictError) {
        throw new ConflictException({
          code: 'IDEMPOTENCY_KEY_REUSED',
          message: 'La clave de idempotencia ya fue usada con otros datos.',
        });
      }
      if (error instanceof InsufficientStockError) {
        throw new ConflictException({
          code: 'INVALID_STOCK_QUANTITY',
          message: 'El conteo produciría un saldo total inválido.',
        });
      }
      this.rethrowSerialError(error);
      throw error;
    }
  }

  async createStateTransition(input: {
    tenantId: string;
    warehouseId: string;
    userId: string;
    idempotencyKey: string | undefined;
    dto: CreateInventoryStateTransitionDto;
  }): Promise<InventoryStateTransitionResponse> {
    if (
      !input.idempotencyKey ||
      !/^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/.test(input.idempotencyKey)
    ) {
      throw new BadRequestException({
        code: 'INVALID_IDEMPOTENCY_KEY',
        message:
          'Idempotency-Key es obligatorio y debe tener entre 8 y 128 caracteres.',
      });
    }
    try {
      const result = await this.inventory.createStateTransition({
        ...input,
        idempotencyKey: input.idempotencyKey,
      });
      return {
        data: result.movement,
        meta: { apiVersion: '1', idempotentReplay: result.replay },
      };
    } catch (error) {
      if (error instanceof InventoryTargetNotFoundError)
        throw new NotFoundException();
      if (error instanceof InvalidStockStateTransitionError) {
        throw new BadRequestException({
          code: 'INVALID_STOCK_STATE_TRANSITION',
          message: 'La transición de estado solicitada no está permitida.',
        });
      }
      if (error instanceof InsufficientStockStateError) {
        throw new ConflictException({
          code: 'INSUFFICIENT_STOCK_STATE',
          message: 'El estado de origen no tiene cantidad suficiente.',
        });
      }
      if (error instanceof IdempotencyConflictError) {
        throw new ConflictException({
          code: 'IDEMPOTENCY_KEY_REUSED',
          message: 'La clave de idempotencia ya fue usada con otros datos.',
        });
      }
      this.rethrowSerialError(error);
      throw error;
    }
  }
}
