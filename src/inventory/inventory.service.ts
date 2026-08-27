import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { CreateInventoryMovementDto } from './dto/create-inventory-movement.dto';
import { ListInventoryStockDto } from './dto/list-inventory-stock.dto';
import { ListInventoryMovementsDto } from './dto/list-inventory-movements.dto';
import {
  IdempotencyConflictError,
  InitialStockAlreadyExistsError,
  InsufficientStockError,
  InventoryTargetNotFoundError,
} from './inventory.errors';
import { InventoryRepository } from './inventory.repository';
import {
  InventoryBalanceResponse,
  InventoryLocationsResponse,
  InventoryMovementResponse,
  InventoryMovementListResponse,
  InventoryStockListResponse,
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
        meta: { apiVersion: '1' },
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
      throw error;
    }
  }
}
