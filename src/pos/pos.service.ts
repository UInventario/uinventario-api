import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import { createHash } from 'node:crypto';
import { posConfig } from '../config/pos.config';
import { CreateCashSaleDto } from './dto/create-cash-sale.dto';
import { ListSalesDto } from './dto/list-sales.dto';
import { QuoteCartDto } from './dto/quote-cart.dto';
import { VoidSaleDto } from './dto/void-sale.dto';
import {
  PosContextNotFoundError,
  PosCustomerNotAvailableError,
  PosIdempotencyConflictError,
  PosInsufficientStockError,
  PosProductNotAvailableError,
  PosReservationNotAvailableError,
  SaleAlreadyVoidedError,
  SaleVoidNotAllowedError,
} from './pos.errors';
import { PosRepository } from './pos.repository';
import { SalesRepository } from './sales.repository';
import {
  CashSaleResponse,
  OfflineCashSaleSnapshot,
  PosCartQuoteResponse,
} from './pos.types';
import { CashRegisterShiftService } from './cash-register-shift.service';
import { CashRegisterShiftRequiredError } from './cash-register-shift.errors';

@Injectable()
export class PosService {
  constructor(
    private readonly pos: PosRepository,
    private readonly sales: SalesRepository,
    private readonly shifts: CashRegisterShiftService,
    @Inject(posConfig.KEY)
    private readonly config: ConfigType<typeof posConfig>,
  ) {}

  async listSales(tenantId: string, branchId: string, query: ListSalesDto) {
    if (query.dateFrom && query.dateTo && query.dateFrom > query.dateTo) {
      throw new BadRequestException({
        code: 'INVALID_SALES_DATE_RANGE',
        message: 'La fecha inicial no puede ser posterior a la fecha final.',
      });
    }
    const result = await this.sales.listSales(tenantId, branchId, query);
    return {
      data: result.items,
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

  async getSale(tenantId: string, branchId: string, saleId: string) {
    const sale = await this.sales.getSaleDetail(tenantId, branchId, saleId);
    if (!sale) throw new NotFoundException();
    return { data: sale, meta: { apiVersion: '1' as const } };
  }

  async voidSale(input: {
    tenantId: string;
    branchId: string;
    cashRegisterId: string;
    userId: string;
    saleId: string;
    idempotencyKey: string | undefined;
    dto: VoidSaleDto;
    correlationId: string;
  }) {
    this.assertIdempotencyKey(input.idempotencyKey);
    const fingerprint = createHash('sha256')
      .update(
        JSON.stringify({ saleId: input.saleId, reason: input.dto.reason }),
      )
      .digest('hex');
    try {
      const result = await this.sales.voidSale({
        tenantId: input.tenantId,
        branchId: input.branchId,
        cashRegisterId: input.cashRegisterId,
        userId: input.userId,
        saleId: input.saleId,
        reason: input.dto.reason,
        idempotencyKey: input.idempotencyKey!,
        fingerprint,
        correlationId: input.correlationId,
      });
      if (!result) throw new NotFoundException();
      const detail = await this.sales.getSaleDetail(
        input.tenantId,
        input.branchId,
        result.saleId,
      );
      if (!detail) throw new NotFoundException();
      return {
        data: detail,
        meta: { apiVersion: '1' as const, idempotentReplay: result.replay },
      };
    } catch (error) {
      if (error instanceof PosIdempotencyConflictError) {
        throw new ConflictException({
          code: 'IDEMPOTENCY_KEY_REUSED',
          message: 'La clave de idempotencia ya fue usada con otros datos.',
        });
      }
      if (error instanceof SaleAlreadyVoidedError) {
        throw new ConflictException({
          code: 'SALE_ALREADY_VOIDED',
          message: 'La venta ya fue anulada.',
        });
      }
      if (error instanceof SaleVoidNotAllowedError) {
        throw new ConflictException({
          code: 'SALE_VOID_NOT_ALLOWED',
          message:
            'La venta sólo puede anularse mientras su turno de caja siga abierto.',
        });
      }
      throw error;
    }
  }

  async createCashSale(input: {
    tenantId: string;
    branchId: string;
    warehouseId: string;
    cashRegisterId: string;
    userId: string;
    idempotencyKey: string | undefined;
    dto: CreateCashSaleDto;
    expectedSnapshot?: OfflineCashSaleSnapshot;
  }): Promise<CashSaleResponse> {
    this.assertIdempotencyKey(input.idempotencyKey);
    const fingerprint = this.saleFingerprint(input.dto);
    try {
      const replay = await this.sales.findByIdempotency(
        input.tenantId,
        input.idempotencyKey!,
      );
      if (replay) {
        if (replay.fingerprint !== fingerprint)
          throw new PosIdempotencyConflictError();
        return {
          data: replay.sale,
          meta: { apiVersion: '1', idempotentReplay: true },
        };
      }
      const quote = await this.quoteCart({
        tenantId: input.tenantId,
        branchId: input.branchId,
        warehouseId: input.warehouseId,
        cashRegisterId: input.cashRegisterId,
        userId: input.userId,
        dto: { lines: input.dto.lines, reservationId: input.dto.reservationId },
      });
      if (input.expectedSnapshot) {
        this.assertOfflineSnapshot(input.expectedSnapshot, quote.data);
      }
      const shift = await this.shifts.requireCurrent({
        tenantId: input.tenantId,
        branchId: input.branchId,
        cashRegisterId: input.cashRegisterId,
        userId: input.userId,
      });
      const receivedCents = this.toMoneyCents(input.dto.cashReceived);
      const totalCents = this.toMoneyCents(quote.data.totals.total);
      if (receivedCents < totalCents) {
        throw new BadRequestException({
          code: 'INSUFFICIENT_CASH_RECEIVED',
          message: 'El efectivo recibido no cubre el total de la venta.',
        });
      }
      const result = await this.sales.persistCashSale({
        tenantId: input.tenantId,
        userId: input.userId,
        idempotencyKey: input.idempotencyKey!,
        fingerprint,
        cashRegisterShiftId: shift.id,
        quote: quote.data,
        customerId: input.dto.customerId ?? null,
        reservationId: input.dto.reservationId ?? null,
        amountReceived: this.fromMoneyCents(receivedCents),
        change: this.fromMoneyCents(receivedCents - totalCents),
      });
      return {
        data: result.sale,
        meta: { apiVersion: '1', idempotentReplay: result.replay },
      };
    } catch (error) {
      if (error instanceof PosIdempotencyConflictError) {
        throw new ConflictException({
          code: 'IDEMPOTENCY_KEY_REUSED',
          message: 'La clave de idempotencia ya fue usada con otros datos.',
        });
      }
      if (error instanceof PosInsufficientStockError) {
        throw new ConflictException({
          code: 'INSUFFICIENT_STOCK',
          productId: error.productId,
        });
      }
      if (error instanceof PosCustomerNotAvailableError) {
        throw new BadRequestException({
          code: 'POS_CUSTOMER_NOT_AVAILABLE',
          message: 'El cliente no existe o está inactivo.',
        });
      }
      if (error instanceof PosReservationNotAvailableError) {
        throw new ConflictException({
          code: 'POS_RESERVATION_NOT_AVAILABLE',
          message: 'La reserva no está activa o no coincide con esta venta.',
          status: error.status,
        });
      }
      if (error instanceof CashRegisterShiftRequiredError) {
        throw new ConflictException({
          code: 'CASH_REGISTER_SHIFT_REQUIRED',
          message: 'Abre un turno en la caja activa antes de registrar ventas.',
        });
      }
      throw error;
    }
  }

  async offlinePolicy(input: {
    tenantId: string;
    branchId: string;
    warehouseId: string;
    cashRegisterId: string;
    userId: string;
  }) {
    const [shiftResponse, context] = await Promise.all([
      this.shifts.current(input),
      this.pos.getContext(input),
    ]);
    const shift = shiftResponse.data;
    if (!shift) return null;
    const taxRate =
      this.config.taxRates[context.countryCode] ??
      this.config.taxRates.DEFAULT ??
      '0.0000';
    return {
      shift,
      currency: this.currencyFor(context.countryCode),
      taxRate: this.normalizeTaxRate(taxRate),
      paymentMethods: ['CASH'] as const,
      negativeStock: 'DENY' as const,
    };
  }

  async quoteCart(input: {
    tenantId: string;
    branchId: string;
    warehouseId: string;
    cashRegisterId: string;
    userId: string;
    dto: QuoteCartDto;
  }): Promise<PosCartQuoteResponse> {
    try {
      await this.shifts.requireCurrent({
        tenantId: input.tenantId,
        branchId: input.branchId,
        cashRegisterId: input.cashRegisterId,
        userId: input.userId,
      });
      const context = await this.pos.getContext(input);
      const requested = new Map<string, bigint>();
      for (const line of input.dto.lines) {
        const quantity = this.toQuantityUnits(line.quantity);
        if (quantity <= 0n) {
          throw new BadRequestException({
            code: 'INVALID_CART_QUANTITY',
            message: 'La cantidad debe ser mayor que cero.',
          });
        }
        requested.set(
          line.productId,
          (requested.get(line.productId) ?? 0n) + quantity,
        );
      }
      const products = await this.pos.getProducts(
        input.tenantId,
        input.warehouseId,
        [...requested.keys()],
        input.dto.reservationId,
      );
      const productMap = new Map(
        products.map((product) => [product.id, product]),
      );
      if (input.dto.reservationId && productMap.size !== requested.size)
        throw new PosReservationNotAvailableError();
      const taxRate =
        this.config.taxRates[context.countryCode] ??
        this.config.taxRates.DEFAULT ??
        '0.0000';
      const taxBasisPoints = this.taxBasisPoints(taxRate);
      let subtotalCents = 0n;
      let taxCents = 0n;
      let totalCents = 0n;
      const lines = [...requested.entries()].map(
        ([productId, quantityUnits]) => {
          const product = productMap.get(productId);
          if (!product)
            throw new NotFoundException({ code: 'PRODUCT_NOT_FOUND' });
          if (!product.active) throw new PosProductNotAvailableError(productId);
          if (quantityUnits > this.toQuantityUnits(product.availableQuantity)) {
            throw new PosInsufficientStockError(productId);
          }
          const lineTotal = this.roundDivide(
            this.toMoneyCents(product.price) * quantityUnits,
            1000n,
          );
          const lineTax =
            taxBasisPoints === 0n
              ? 0n
              : this.roundDivide(
                  lineTotal * taxBasisPoints,
                  10_000n + taxBasisPoints,
                );
          const lineSubtotal = lineTotal - lineTax;
          subtotalCents += lineSubtotal;
          taxCents += lineTax;
          totalCents += lineTotal;
          return {
            product: { id: product.id, name: product.name, sku: product.sku },
            quantity: this.fromQuantityUnits(quantityUnits),
            availableQuantity: product.availableQuantity,
            unitPrice: this.fromMoneyCents(this.toMoneyCents(product.price)),
            subtotal: this.fromMoneyCents(lineSubtotal),
            tax: this.fromMoneyCents(lineTax),
            total: this.fromMoneyCents(lineTotal),
          };
        },
      );
      return {
        data: {
          context: {
            branch: context.branch,
            warehouse: context.warehouse,
            cashRegister: context.cashRegister,
          },
          currency: this.currencyFor(context.countryCode),
          taxRate: this.normalizeTaxRate(taxRate),
          lines,
          totals: {
            subtotal: this.fromMoneyCents(subtotalCents),
            tax: this.fromMoneyCents(taxCents),
            total: this.fromMoneyCents(totalCents),
          },
        },
        meta: { apiVersion: '1', recalculatedAt: new Date().toISOString() },
      };
    } catch (error) {
      if (error instanceof PosContextNotFoundError)
        throw new NotFoundException();
      if (error instanceof PosProductNotAvailableError) {
        throw new ConflictException({
          code: 'PRODUCT_NOT_AVAILABLE',
          productId: error.productId,
        });
      }
      if (error instanceof PosInsufficientStockError) {
        throw new ConflictException({
          code: 'INSUFFICIENT_STOCK',
          productId: error.productId,
        });
      }
      if (error instanceof PosReservationNotAvailableError) {
        throw new ConflictException({
          code: 'POS_RESERVATION_NOT_AVAILABLE',
          message: 'La reserva no está activa o no coincide con este carrito.',
        });
      }
      throw error;
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

  private saleFingerprint(dto: CreateCashSaleDto): string {
    const quantities = new Map<string, bigint>();
    for (const line of dto.lines) {
      quantities.set(
        line.productId,
        (quantities.get(line.productId) ?? 0n) +
          this.toQuantityUnits(line.quantity),
      );
    }
    const canonical = {
      lines: [...quantities.entries()]
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([productId, quantity]) => ({
          productId,
          quantity: this.fromQuantityUnits(quantity),
        })),
      cashReceived: this.fromMoneyCents(this.toMoneyCents(dto.cashReceived)),
      customerId: dto.customerId ?? null,
      reservationId: dto.reservationId ?? null,
    };
    return createHash('sha256').update(JSON.stringify(canonical)).digest('hex');
  }

  private assertOfflineSnapshot(
    expected: OfflineCashSaleSnapshot,
    current: PosCartQuoteResponse['data'],
  ): void {
    const expectedValue = {
      branchId: expected.branchId,
      warehouseId: expected.warehouseId,
      cashRegisterId: expected.cashRegisterId,
      currency: expected.currency,
      taxRate: expected.taxRate,
      paymentMethod: expected.paymentMethod,
      negativeStock: expected.negativeStock,
      lines: [...expected.lines].sort((left, right) =>
        left.productId.localeCompare(right.productId),
      ),
      totals: expected.totals,
    };
    const currentValue = {
      branchId: current.context.branch.id,
      warehouseId: current.context.warehouse.id,
      cashRegisterId: current.context.cashRegister.id,
      currency: current.currency,
      taxRate: current.taxRate,
      paymentMethod: 'CASH' as const,
      negativeStock: 'DENY' as const,
      lines: current.lines
        .map((line) => ({
          productId: line.product.id,
          name: line.product.name,
          sku: line.product.sku,
          quantity: line.quantity,
          unitPrice: line.unitPrice,
          subtotal: line.subtotal,
          tax: line.tax,
          total: line.total,
        }))
        .sort((left, right) => left.productId.localeCompare(right.productId)),
      totals: current.totals,
    };
    if (JSON.stringify(expectedValue) !== JSON.stringify(currentValue)) {
      throw new ConflictException({
        code: 'OFFLINE_SALE_SNAPSHOT_CONFLICT',
        message:
          'Precio, impuesto o contexto cambiaron desde la captura offline; la venta requiere conciliación.',
      });
    }
  }

  private toQuantityUnits(value: string): bigint {
    const [whole, fraction = ''] = value.split('.');
    return BigInt(whole) * 1000n + BigInt(fraction.padEnd(3, '0'));
  }

  private fromQuantityUnits(value: bigint): string {
    return `${value / 1000n}.${String(value % 1000n).padStart(3, '0')}`;
  }

  private toMoneyCents(value: string): bigint {
    const [whole, fraction = ''] = value.split('.');
    return BigInt(whole) * 100n + BigInt(fraction.padEnd(2, '0'));
  }

  private fromMoneyCents(value: bigint): string {
    return `${value / 100n}.${String(value % 100n).padStart(2, '0')}`;
  }

  private roundDivide(numerator: bigint, denominator: bigint): bigint {
    return (numerator + denominator / 2n) / denominator;
  }

  private taxBasisPoints(value: string): bigint {
    const [whole, fraction = ''] = value.split('.');
    return BigInt(whole) * 10_000n + BigInt(fraction.padEnd(4, '0'));
  }

  private normalizeTaxRate(value: string): string {
    const [whole, fraction = ''] = value.split('.');
    return `${whole}.${fraction.padEnd(4, '0')}`;
  }

  private currencyFor(countryCode: string): string {
    if (countryCode === 'MX') return 'MXN';
    if (countryCode === 'CL') return 'CLP';
    return 'USD';
  }
}
