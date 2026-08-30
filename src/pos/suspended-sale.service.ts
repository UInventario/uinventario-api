import {
  BadRequestException,
  ConflictException,
  HttpException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { createHash } from 'node:crypto';
import { CreateSuspendedSaleDto } from './dto/create-suspended-sale.dto';
import {
  PosCustomerNotAvailableError,
  PosIdempotencyConflictError,
} from './pos.errors';
import { PosService } from './pos.service';
import { SuspendedSaleStateError } from './suspended-sale.errors';
import { SuspendedSaleRepository } from './suspended-sale.repository';
import type { SuspendedSaleConflict } from './suspended-sale.types';

export interface SuspendedSaleContext {
  tenantId: string;
  branchId: string;
  warehouseId: string;
  cashRegisterId: string;
  userId: string;
}

@Injectable()
export class SuspendedSaleService {
  constructor(
    private readonly repository: SuspendedSaleRepository,
    private readonly pos: PosService,
  ) {}

  async create(
    context: SuspendedSaleContext,
    dto: CreateSuspendedSaleDto,
    idempotencyKey?: string,
  ) {
    this.assertIdempotencyKey(idempotencyKey);
    if (
      dto.lines.some(
        (line) => line.note || line.manualUnitPrice || line.priceOverrideReason,
      )
    ) {
      throw new BadRequestException({
        code: 'SUSPENDED_SALE_LINE_CONTROLS_NOT_SUPPORTED',
        message:
          'Completa la venta en lÃ­nea para conservar notas y precios manuales.',
      });
    }
    const notes = dto.notes?.trim() || null;
    const fingerprint = createHash('sha256')
      .update(
        JSON.stringify({
          customerId: dto.customerId ?? null,
          notes,
          lines: [...dto.lines]
            .map((line) => ({
              productId: line.productId,
              quantity: line.quantity,
              lotId: line.lotId ?? null,
              serialNumbers: [...(line.serialNumbers ?? [])]
                .map((value) => value.trim().toUpperCase())
                .sort(),
            }))
            .sort((left, right) =>
              left.productId.localeCompare(right.productId),
            ),
        }),
      )
      .digest('hex');
    try {
      const quote = await this.pos.quoteCart({
        ...context,
        dto: { lines: dto.lines, customerId: dto.customerId },
      });
      const result = await this.repository.create({
        tenantId: context.tenantId,
        userId: context.userId,
        customerId: dto.customerId ?? null,
        notes,
        idempotencyKey: idempotencyKey!,
        fingerprint,
        quote: quote.data,
      });
      return {
        data: result.sale,
        meta: { apiVersion: '1' as const, idempotentReplay: result.replay },
      };
    } catch (error) {
      if (error instanceof PosIdempotencyConflictError) {
        throw new ConflictException({ code: 'IDEMPOTENCY_KEY_REUSED' });
      }
      if (error instanceof PosCustomerNotAvailableError) {
        throw new ConflictException({ code: 'POS_CUSTOMER_NOT_AVAILABLE' });
      }
      throw error;
    }
  }

  async list(context: SuspendedSaleContext) {
    return {
      data: await this.repository.list(context),
      meta: { apiVersion: '1' as const, expirationHours: 24 },
    };
  }

  async resume(context: SuspendedSaleContext, id: string) {
    const suspended = await this.repository.findOwned({ ...context, id });
    if (!suspended) throw new NotFoundException();
    if (suspended.status !== 'ACTIVE')
      throw this.stateException(suspended.status);
    const lines = suspended.lines.map((line) => ({
      productId: line.product.id,
      quantity: line.quantity,
      ...(line.lotId ? { lotId: line.lotId } : {}),
      ...(line.serialNumbers.length
        ? { serialNumbers: line.serialNumbers }
        : {}),
    }));
    try {
      const quote = await this.pos.quoteCart({
        ...context,
        dto: { lines, customerId: suspended.customer?.id },
      });
      const conflicts: SuspendedSaleConflict[] = [];
      for (const line of suspended.lines) {
        const current = quote.data.lines.find(
          (candidate) => candidate.product.id === line.product.id,
        );
        if (!current) continue;
        if (current.unitPrice !== line.unitPriceSnapshot) {
          conflicts.push({
            code: 'PRICE_CHANGED',
            productId: line.product.id,
            previous: line.unitPriceSnapshot,
            current: current.unitPrice,
          });
        }
        if (current.availableQuantity !== line.availableQuantitySnapshot) {
          conflicts.push({
            code: 'AVAILABILITY_CHANGED',
            productId: line.product.id,
            previous: line.availableQuantitySnapshot,
            current: current.availableQuantity,
          });
        }
      }
      return {
        data: { suspendedSale: suspended, quote: quote.data, conflicts },
        meta: {
          apiVersion: '1' as const,
          recalculatedAt: quote.meta.recalculatedAt,
        },
      };
    } catch (error) {
      if (error instanceof HttpException && error.getStatus() === 409) {
        const response = error.getResponse();
        const body =
          typeof response === 'object'
            ? (response as { code?: string; productId?: string })
            : {};
        if (
          (body.code === 'INSUFFICIENT_STOCK' ||
            body.code === 'PRODUCT_NOT_AVAILABLE') &&
          body.productId
        ) {
          return {
            data: {
              suspendedSale: suspended,
              quote: null,
              conflicts: [
                { code: body.code, productId: body.productId },
              ] as SuspendedSaleConflict[],
            },
            meta: {
              apiVersion: '1' as const,
              recalculatedAt: new Date().toISOString(),
            },
          };
        }
      }
      throw error;
    }
  }

  async cancel(context: SuspendedSaleContext, id: string) {
    try {
      const result = await this.repository.cancel({ ...context, id });
      if (!result) throw new NotFoundException();
      return {
        data: result.sale,
        meta: { apiVersion: '1' as const, idempotentReplay: result.replay },
      };
    } catch (error) {
      if (error instanceof SuspendedSaleStateError)
        throw this.stateException(error.status);
      throw error;
    }
  }

  private stateException(status: string) {
    return new ConflictException({
      code:
        status === 'EXPIRED'
          ? 'SUSPENDED_SALE_EXPIRED'
          : 'SUSPENDED_SALE_NOT_ACTIVE',
      status,
    });
  }

  private assertIdempotencyKey(value: string | undefined): void {
    if (!value || !/^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/.test(value)) {
      throw new BadRequestException({ code: 'INVALID_IDEMPOTENCY_KEY' });
    }
  }
}
