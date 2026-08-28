import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { createHash } from 'node:crypto';
import { CreateSaleReturnDto } from './dto/create-sale-return.dto';
import { PosIdempotencyConflictError } from './pos.errors';
import { SaleReturnRepository } from './sale-return.repository';
import {
  SaleReturnExchangeError,
  SaleReturnNotAllowedError,
  SaleReturnQuantityError,
  SaleReturnSerialError,
} from './sale-return.types';

@Injectable()
export class SaleReturnService {
  constructor(private readonly returns: SaleReturnRepository) {}

  async list(tenantId: string, branchId: string, saleId: string) {
    const returns = await this.returns.listBySale(tenantId, branchId, saleId);
    if (!returns) throw new NotFoundException();
    return { data: returns, meta: { apiVersion: '1' as const } };
  }

  async create(input: {
    tenantId: string;
    branchId: string;
    userId: string;
    saleId: string;
    idempotencyKey: string | undefined;
    correlationId: string;
    dto: CreateSaleReturnDto;
  }) {
    if (
      !input.idempotencyKey ||
      !/^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/.test(input.idempotencyKey)
    ) {
      throw new BadRequestException({
        code: 'INVALID_IDEMPOTENCY_KEY',
        message: 'Se requiere una clave de idempotencia válida.',
      });
    }
    const fingerprint = createHash('sha256')
      .update(
        JSON.stringify({
          saleId: input.saleId,
          reason: input.dto.reason.trim(),
          exchangeSaleId: input.dto.exchangeSaleId ?? null,
          lines: [...input.dto.lines]
            .map((line) => ({
              saleLineId: line.saleLineId,
              quantity: line.quantity,
              condition: line.condition,
              serialNumbers: [...(line.serialNumbers ?? [])]
                .map((value) => value.trim().toUpperCase())
                .sort(),
            }))
            .sort((left, right) =>
              left.saleLineId.localeCompare(right.saleLineId),
            ),
        }),
      )
      .digest('hex');
    try {
      const result = await this.returns.create({
        ...input,
        idempotencyKey: input.idempotencyKey,
        fingerprint,
      });
      if (!result) throw new NotFoundException();
      return {
        data: result.saleReturn,
        meta: { apiVersion: '1' as const, idempotentReplay: result.replay },
      };
    } catch (error) {
      if (error instanceof PosIdempotencyConflictError) {
        throw new ConflictException({
          code: 'IDEMPOTENCY_KEY_REUSED',
          message: 'La clave de idempotencia ya fue usada con otros datos.',
        });
      }
      if (error instanceof SaleReturnQuantityError) {
        throw new ConflictException({
          code: 'SALE_RETURN_QUANTITY_EXCEEDED',
          message:
            'La cantidad supera lo vendido menos las devoluciones anteriores.',
        });
      }
      if (error instanceof SaleReturnNotAllowedError) {
        throw new ConflictException({
          code: 'SALE_RETURN_NOT_ALLOWED',
          message: 'Sólo se admiten devoluciones de ventas completadas.',
        });
      }
      if (error instanceof SaleReturnExchangeError) {
        throw new ConflictException({
          code: 'SALE_RETURN_EXCHANGE_INVALID',
          message:
            'La venta de cambio debe estar completada, pertenecer a esta sucursal y no estar enlazada.',
        });
      }
      if (error instanceof SaleReturnSerialError) {
        throw new BadRequestException({
          code: 'SALE_RETURN_SERIALS_INVALID',
          message:
            'Los números de serie deben corresponder a las unidades vendidas que se devuelven.',
        });
      }
      throw error;
    }
  }
}
