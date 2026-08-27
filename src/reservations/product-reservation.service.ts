import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { CreateProductReservationDto } from './dto/create-product-reservation.dto';
import {
  ProductReservationIdempotencyConflictError,
  ProductReservationInsufficientStockError,
  ProductReservationTargetNotFoundError,
} from './product-reservation.errors';
import { ProductReservationRepository } from './product-reservation.repository';

@Injectable()
export class ProductReservationService {
  constructor(private readonly reservations: ProductReservationRepository) {}

  async create(input: {
    tenantId: string;
    branchId: string;
    warehouseId: string;
    userId: string;
    idempotencyKey: string | undefined;
    dto: CreateProductReservationDto;
  }) {
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
    if (
      new Set(input.dto.lines.map(({ productId }) => productId)).size !==
      input.dto.lines.length
    ) {
      throw new BadRequestException({
        code: 'DUPLICATE_RESERVATION_PRODUCT',
        message: 'Cada producto debe aparecer una sola vez en la reserva.',
      });
    }
    try {
      const result = await this.reservations.create({
        ...input,
        idempotencyKey: input.idempotencyKey,
      });
      return {
        data: result.reservation,
        meta: { apiVersion: '1' as const, idempotentReplay: result.replay },
      };
    } catch (error) {
      if (error instanceof ProductReservationTargetNotFoundError)
        throw new NotFoundException();
      if (error instanceof ProductReservationInsufficientStockError) {
        throw new ConflictException({
          code: 'PRODUCT_RESERVATION_INSUFFICIENT_STOCK',
          message:
            'No hay stock disponible suficiente para completar la reserva.',
          productId: error.productId,
        });
      }
      if (error instanceof ProductReservationIdempotencyConflictError) {
        throw new ConflictException({
          code: 'IDEMPOTENCY_KEY_REUSED',
          message: 'La clave de idempotencia ya fue usada con otros datos.',
        });
      }
      throw error;
    }
  }

  async list(tenantId: string, branchId: string) {
    return {
      data: await this.reservations.list(tenantId, branchId),
      meta: { apiVersion: '1' as const },
    };
  }
}
