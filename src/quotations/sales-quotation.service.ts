import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { createHash } from 'node:crypto';
import { PosService } from '../pos/pos.service';
import type { QuoteCartDto } from '../pos/dto/quote-cart.dto';
import type { CreateSalesQuotationDto } from './dto/create-sales-quotation.dto';
import type { UpdateSalesQuotationDto } from './dto/update-sales-quotation.dto';
import type { ConvertSalesQuotationDto } from './dto/convert-sales-quotation.dto';
import type { ListSalesQuotationsDto } from './dto/list-sales-quotations.dto';
import {
  SalesQuotationIdempotencyConflictError,
  SalesQuotationNotFoundError,
  SalesQuotationReservationConflictError,
  SalesQuotationStateError,
  SalesQuotationVersionConflictError,
} from './sales-quotation.errors';
import { SalesQuotationRepository } from './sales-quotation.repository';
import type {
  QuotationDifference,
  SalesQuotationData,
  SalesQuotationPreview,
} from './sales-quotation.types';

interface Context {
  tenantId: string;
  branchId: string;
  warehouseId: string;
  cashRegisterId: string;
  userId: string;
}

@Injectable()
export class SalesQuotationService {
  constructor(
    private readonly quotations: SalesQuotationRepository,
    private readonly pos: PosService,
  ) {}

  async create(
    input: Context & {
      idempotencyKey: string | undefined;
      dto: CreateSalesQuotationDto;
      canDiscount: boolean;
    },
  ) {
    this.assertKey(input.idempotencyKey);
    this.assertValidity(input.dto.validUntil);
    const fingerprint = this.fingerprint({
      dto: input.dto,
      context: this.contextFingerprint(input),
    });
    const quote = await this.pos.quoteCart({
      ...input,
      dto: this.quoteDto(input.dto),
      canDiscount: input.canDiscount,
    });
    try {
      const result = await this.quotations.create({
        ...input,
        customerId: input.dto.customerId ?? null,
        reservationId: input.dto.reservationId ?? null,
        channel: input.dto.channel,
        validUntil: input.dto.validUntil,
        notes: input.dto.notes?.trim() || null,
        idempotencyKey: input.idempotencyKey!,
        fingerprint,
        quote: quote.data,
      });
      return {
        data: result.quotation,
        meta: { apiVersion: '1' as const, idempotentReplay: result.replay },
      };
    } catch (error) {
      this.rethrow(error);
    }
  }

  async update(
    input: Context & {
      quotationId: string;
      idempotencyKey: string | undefined;
      dto: UpdateSalesQuotationDto;
      canDiscount: boolean;
    },
  ) {
    this.assertKey(input.idempotencyKey);
    this.assertValidity(input.dto.validUntil);
    await this.require(input.tenantId, input.branchId, input.quotationId);
    const fingerprint = this.fingerprint({
      quotationId: input.quotationId,
      dto: input.dto,
    });
    const quote = await this.pos.quoteCart({
      ...input,
      dto: this.quoteDto(input.dto),
      canDiscount: input.canDiscount,
    });
    try {
      const result = await this.quotations.update({
        ...input,
        version: input.dto.version,
        customerId: input.dto.customerId ?? null,
        reservationId: input.dto.reservationId ?? null,
        channel: input.dto.channel,
        validUntil: input.dto.validUntil,
        notes: input.dto.notes?.trim() || null,
        idempotencyKey: input.idempotencyKey!,
        fingerprint,
        quote: quote.data,
      });
      return {
        data: result.quotation,
        meta: { apiVersion: '1' as const, idempotentReplay: result.replay },
      };
    } catch (error) {
      this.rethrow(error);
    }
  }

  async list(
    tenantId: string,
    branchId: string,
    query: ListSalesQuotationsDto,
  ) {
    const result = await this.quotations.list(tenantId, branchId, query);
    return {
      data: result.quotations,
      meta: {
        apiVersion: '1' as const,
        pagination: {
          page: query.page,
          pageSize: query.pageSize,
          total: result.total,
          totalPages: Math.ceil(result.total / query.pageSize),
        },
      },
    };
  }

  async get(tenantId: string, branchId: string, quotationId: string) {
    return {
      data: await this.require(tenantId, branchId, quotationId),
      meta: { apiVersion: '1' as const },
    };
  }

  async preview(
    input: Context & { quotationId: string; canDiscount: boolean },
  ): Promise<{
    data: SalesQuotationPreview;
    meta: { apiVersion: '1'; recalculatedAt: string };
  }> {
    const quotation = await this.require(
      input.tenantId,
      input.branchId,
      input.quotationId,
    );
    if (quotation.status !== 'ACTIVE') this.state(quotation.status);
    const current = await this.pos.quoteCart({
      ...input,
      dto: this.fromQuotation(quotation),
      canDiscount: input.canDiscount,
    });
    const differences = this.differences(quotation, current.data);
    return {
      data: {
        quotation,
        recalculated: current.data,
        differences,
        canConvert: !differences.some(({ blocking }) => blocking),
      },
      meta: { apiVersion: '1', recalculatedAt: current.meta.recalculatedAt },
    };
  }

  async convert(
    input: Context & {
      quotationId: string;
      idempotencyKey: string | undefined;
      dto: ConvertSalesQuotationDto;
      canDiscount: boolean;
      canCredit: boolean;
      canViewMargin: boolean;
    },
  ) {
    this.assertKey(input.idempotencyKey);
    let quotation = await this.require(
      input.tenantId,
      input.branchId,
      input.quotationId,
    );
    if (quotation.status === 'CONVERTED' && quotation.sale) {
      return {
        data: { quotation, sale: quotation.sale, differences: [] },
        meta: { apiVersion: '1' as const, idempotentReplay: true },
      };
    }
    if (quotation.status === 'CONVERTING') {
      if (!quotation.sale)
        throw new ConflictException({
          code: 'QUOTATION_CONVERSION_IN_PROGRESS',
        });
      quotation = await this.quotations.completeConversion(
        input.tenantId,
        input.branchId,
        input.quotationId,
      );
      return {
        data: { quotation, sale: quotation.sale!, differences: [] },
        meta: { apiVersion: '1' as const, idempotentReplay: true },
      };
    }
    if (quotation.status !== 'ACTIVE') this.state(quotation.status);
    const preview = await this.preview(input);
    const blocking = preview.data.differences.some(
      ({ blocking: value }) => value,
    );
    if (blocking)
      throw new ConflictException({
        code: 'QUOTATION_STOCK_CHANGED',
        preview: preview.data,
      });
    if (preview.data.differences.length > 0 && !input.dto.acceptDifferences)
      throw new ConflictException({
        code: 'QUOTATION_CHANGED',
        preview: preview.data,
      });
    const fingerprint = this.fingerprint({
      quotationId: input.quotationId,
      version: input.dto.version,
      payments: input.dto.payments,
    });
    try {
      const begun = await this.quotations.beginConversion({
        tenantId: input.tenantId,
        branchId: input.branchId,
        quotationId: input.quotationId,
        version: input.dto.version,
        idempotencyKey: input.idempotencyKey!,
        fingerprint,
      });
      quotation = begun.quotation;
      if (quotation.status === 'CONVERTED' && quotation.sale)
        return {
          data: {
            quotation,
            sale: quotation.sale,
            differences: preview.data.differences,
          },
          meta: { apiVersion: '1' as const, idempotentReplay: true },
        };
      if (quotation.status !== 'CONVERTING') this.state(quotation.status);
      const sale = await this.pos.createSale({
        ...input,
        idempotencyKey: `quotation-conversion:${input.quotationId}`,
        sourceQuotationId: input.quotationId,
        dto: {
          ...this.fromQuotation(preview.data.quotation),
          payments: input.dto.payments,
        },
      });
      quotation = await this.quotations.completeConversion(
        input.tenantId,
        input.branchId,
        input.quotationId,
      );
      return {
        data: {
          quotation,
          sale: { id: sale.data.id, receiptNumber: sale.data.receiptNumber },
          differences: preview.data.differences,
        },
        meta: {
          apiVersion: '1' as const,
          idempotentReplay: begun.replay || sale.meta.idempotentReplay,
        },
      };
    } catch (error) {
      await this.quotations.abortConversion(
        input.tenantId,
        input.branchId,
        input.quotationId,
        input.idempotencyKey!,
      );
      this.rethrow(error);
    }
  }

  private quoteDto(dto: CreateSalesQuotationDto): QuoteCartDto {
    return {
      customerId: dto.customerId,
      reservationId: dto.reservationId,
      channel: dto.channel,
      lines: dto.lines,
      discount: dto.discount,
    };
  }

  private fromQuotation(quotation: SalesQuotationData): QuoteCartDto {
    return {
      customerId: quotation.customer?.id,
      reservationId: quotation.reservation?.id,
      channel: quotation.channel,
      discount: quotation.discount
        ? {
            type: quotation.discount.type,
            value: quotation.discount.value,
            reason: quotation.discount.reason,
          }
        : undefined,
      lines: quotation.lines.map((line) => ({
        productId: line.product.id,
        quantity: line.quantity,
        lotId: line.lotId ?? undefined,
        serialNumbers: line.serialNumbers,
        discount: line.discount.line
          ? {
              type: line.discount.line.type,
              value: line.discount.line.value,
              reason: line.discount.line.reason,
            }
          : undefined,
      })),
    };
  }

  private differences(
    quotation: SalesQuotationData,
    current: SalesQuotationPreview['recalculated'],
  ): QuotationDifference[] {
    const result: QuotationDifference[] = [];
    for (const quoted of quotation.lines) {
      const actual = current.lines.find(
        ({ product }) => product.id === quoted.product.id,
      )!;
      if (quoted.unitPrice !== actual.unitPrice)
        result.push({
          product: quoted.product,
          field: 'UNIT_PRICE',
          quoted: quoted.unitPrice,
          current: actual.unitPrice,
          blocking: false,
        });
      if (quoted.availableQuantity !== actual.availableQuantity)
        result.push({
          product: quoted.product,
          field: 'AVAILABLE_STOCK',
          quoted: quoted.availableQuantity,
          current: actual.availableQuantity,
          blocking:
            this.quantity(actual.availableQuantity) <
            this.quantity(actual.quantity),
        });
    }
    if (quotation.totals.total !== current.totals.total)
      result.push({
        product: {
          id: quotation.id,
          name: 'Total',
          sku: quotation.quotationNumber,
        },
        field: 'TOTAL',
        quoted: quotation.totals.total,
        current: current.totals.total,
        blocking: false,
      });
    return result;
  }

  private async require(tenantId: string, branchId: string, id: string) {
    const quotation = await this.quotations.find(tenantId, branchId, id);
    if (!quotation) throw new NotFoundException();
    return quotation;
  }

  private assertValidity(value: string) {
    const validUntil = new Date(value).getTime();
    const now = Date.now();
    if (
      !Number.isFinite(validUntil) ||
      validUntil <= now ||
      validUntil > now + 366 * 24 * 60 * 60 * 1000
    )
      throw new BadRequestException({
        code: 'QUOTATION_VALIDITY_INVALID',
        message: 'La vigencia debe ser futura y no mayor a un año.',
      });
  }
  private assertKey(value: string | undefined) {
    if (!value || !/^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/.test(value))
      throw new BadRequestException({ code: 'INVALID_IDEMPOTENCY_KEY' });
  }
  private state(status: string): never {
    throw new ConflictException({ code: 'QUOTATION_NOT_ACTIVE', status });
  }
  private fingerprint(value: unknown) {
    return createHash('sha256').update(JSON.stringify(value)).digest('hex');
  }
  private contextFingerprint(input: Context) {
    return {
      branchId: input.branchId,
      warehouseId: input.warehouseId,
      cashRegisterId: input.cashRegisterId,
    };
  }
  private quantity(value: string) {
    const [whole, fraction = ''] = value.split('.');
    return BigInt(whole) * 1000n + BigInt(fraction.padEnd(3, '0'));
  }

  private rethrow(error: unknown): never {
    if (error instanceof SalesQuotationNotFoundError)
      throw new NotFoundException();
    if (error instanceof SalesQuotationIdempotencyConflictError)
      throw new ConflictException({ code: 'IDEMPOTENCY_KEY_REUSED' });
    if (error instanceof SalesQuotationVersionConflictError)
      throw new ConflictException({ code: 'QUOTATION_VERSION_CONFLICT' });
    if (error instanceof SalesQuotationReservationConflictError)
      throw new ConflictException({
        code: 'QUOTATION_RESERVATION_ALREADY_USED',
      });
    if (error instanceof SalesQuotationStateError) this.state(error.status);
    throw error;
  }
}
