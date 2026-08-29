import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { CreateInventoryKitOperationDto } from './dto/create-inventory-kit-operation.dto';
import {
  InventoryKitIdempotencyConflictError,
  InventoryKitInsufficientStockError,
  InventoryKitNotAssembledError,
  InventoryKitNotFoundError,
} from './inventory-kit.errors';
import { InventoryKitRepository } from './inventory-kit.repository';

@Injectable()
export class InventoryKitService {
  constructor(private readonly kits: InventoryKitRepository) {}

  async operate(input: {
    tenantId: string;
    warehouseId: string;
    userId: string;
    productId: string;
    idempotencyKey: string | undefined;
    dto: CreateInventoryKitOperationDto;
  }) {
    if (!input.idempotencyKey || input.idempotencyKey.length > 128) {
      throw new BadRequestException({ code: 'IDEMPOTENCY_KEY_REQUIRED' });
    }
    try {
      const result = await this.kits.operate({
        ...input,
        idempotencyKey: input.idempotencyKey,
      });
      return {
        data: result.operation,
        meta: { apiVersion: '1' as const, idempotentReplay: result.replay },
      };
    } catch (error) {
      if (error instanceof InventoryKitNotFoundError) {
        throw new NotFoundException({ code: 'INVENTORY_KIT_NOT_FOUND' });
      }
      if (error instanceof InventoryKitNotAssembledError) {
        throw new BadRequestException({
          code: 'INVENTORY_KIT_REQUIRES_ASSEMBLED_MODE',
        });
      }
      if (error instanceof InventoryKitInsufficientStockError) {
        throw new ConflictException({
          code: 'INSUFFICIENT_STOCK',
          productId: error.productId,
        });
      }
      if (error instanceof InventoryKitIdempotencyConflictError) {
        throw new ConflictException({ code: 'IDEMPOTENCY_KEY_REUSED' });
      }
      throw error;
    }
  }
}
