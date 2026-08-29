import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import { createHash } from 'node:crypto';
import { posConfig } from '../config/pos.config';
import { CreateCashSaleDto } from './dto/create-cash-sale.dto';
import { CreateSaleDto, SalePaymentDto } from './dto/create-sale.dto';
import { ListSalesDto } from './dto/list-sales.dto';
import { QuoteCartDto, SaleDiscountDto } from './dto/quote-cart.dto';
import { VoidSaleDto } from './dto/void-sale.dto';
import {
  PosContextNotFoundError,
  CustomerCreditLimitExceededError,
  CustomerCreditNotAvailableError,
  PosCustomerNotAvailableError,
  PosIdempotencyConflictError,
  PosInsufficientStockError,
  PaymentReferenceConflictError,
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
import {
  PaymentAuthorizationService,
  PaymentDeclinedError,
  PaymentMethodUnavailableError,
} from './payment-authorization.service';
import {
  InsufficientInventoryLotStockError,
  InventoryFifoCurrencyMismatchError,
  InventoryFifoLayerShortageError,
  InventoryLotNotFoundError,
} from '../inventory/inventory.errors';
import {
  InventorySerialDuplicateError,
  InventorySerialNotFoundError,
  InventorySerialQuantityError,
  InventorySerialRequiredError,
  InventorySerialStateConflictError,
} from '../inventory/inventory-serial-tracking';
import { SuspendedSaleStateError } from './suspended-sale.errors';
import { PriceListRepository } from '../pricing/price-list.repository';

@Injectable()
export class PosService {
  constructor(
    private readonly pos: PosRepository,
    private readonly sales: SalesRepository,
    private readonly shifts: CashRegisterShiftService,
    private readonly paymentAuthorization: PaymentAuthorizationService,
    private readonly priceLists: PriceListRepository,
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

  async getSale(
    tenantId: string,
    branchId: string,
    saleId: string,
    canViewMargin = false,
  ) {
    const sale = await this.sales.getSaleDetail(tenantId, branchId, saleId);
    if (!sale) throw new NotFoundException();
    return {
      data: this.applyMarginAccess(sale, canViewMargin),
      meta: { apiVersion: '1' as const },
    };
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
    canDiscount?: boolean;
    canViewMargin?: boolean;
  }): Promise<CashSaleResponse> {
    return this.createSale({
      ...input,
      dto: {
        channel: input.dto.channel,
        customerId: input.dto.customerId,
        reservationId: input.dto.reservationId,
        lines: input.dto.lines,
        discount: input.dto.discount,
        payment: { method: 'CASH', amountReceived: input.dto.cashReceived },
      },
    });
  }

  async createSale(input: {
    tenantId: string;
    branchId: string;
    warehouseId: string;
    cashRegisterId: string;
    userId: string;
    idempotencyKey: string | undefined;
    dto: CreateSaleDto;
    expectedSnapshot?: OfflineCashSaleSnapshot;
    canDiscount?: boolean;
    canCredit?: boolean;
    canViewMargin?: boolean;
  }): Promise<CashSaleResponse> {
    this.assertIdempotencyKey(input.idempotencyKey);
    if (input.dto.credit && !input.canCredit) {
      throw new ForbiddenException({
        code: 'CUSTOMER_CREDIT_PERMISSION_REQUIRED',
        message: 'No tienes permiso para registrar ventas a crédito.',
      });
    }
    if (input.dto.credit && !input.dto.customerId) {
      throw new BadRequestException({
        code: 'CUSTOMER_REQUIRED_FOR_CREDIT',
        message: 'Selecciona un cliente para vender a crédito.',
      });
    }
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
          data: this.applyMarginAccess(replay.sale, input.canViewMargin),
          meta: { apiVersion: '1', idempotentReplay: true },
        };
      }
      const quote = await this.quoteCart({
        tenantId: input.tenantId,
        branchId: input.branchId,
        warehouseId: input.warehouseId,
        cashRegisterId: input.cashRegisterId,
        userId: input.userId,
        dto: {
          lines: input.dto.lines,
          reservationId: input.dto.reservationId,
          customerId: input.dto.customerId,
          channel: input.dto.channel,
          discount: input.dto.discount,
        },
        canDiscount: input.canDiscount,
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
      const totalCents = this.toMoneyCents(quote.data.totals.total);
      const payments = this.preparePayments(
        input.dto,
        totalCents,
        quote.data.currency,
        input.idempotencyKey!,
      );
      const result = await this.sales.persistSale({
        tenantId: input.tenantId,
        userId: input.userId,
        idempotencyKey: input.idempotencyKey!,
        fingerprint,
        cashRegisterShiftId: shift.id,
        quote: quote.data,
        customerId: input.dto.customerId ?? null,
        reservationId: input.dto.reservationId ?? null,
        suspendedSaleId: input.dto.suspendedSaleId ?? null,
        payments,
        credit: input.dto.credit ?? null,
      });
      return {
        data: this.applyMarginAccess(result.sale, input.canViewMargin),
        meta: { apiVersion: '1', idempotentReplay: result.replay },
      };
    } catch (error) {
      if (error instanceof PosIdempotencyConflictError) {
        throw new ConflictException({
          code: 'IDEMPOTENCY_KEY_REUSED',
          message: 'La clave de idempotencia ya fue usada con otros datos.',
        });
      }
      if (error instanceof SuspendedSaleStateError) {
        throw new ConflictException({
          code:
            error.status === 'EXPIRED'
              ? 'SUSPENDED_SALE_EXPIRED'
              : 'SUSPENDED_SALE_NOT_ACTIVE',
          status: error.status,
        });
      }
      if (error instanceof PaymentMethodUnavailableError) {
        throw new BadRequestException({
          code: 'PAYMENT_METHOD_UNAVAILABLE',
          message: 'El medio de pago no está habilitado en este ambiente.',
        });
      }
      if (error instanceof PaymentDeclinedError) {
        throw new ConflictException({
          code: 'PAYMENT_DECLINED',
          message:
            'La autorización del pago fue rechazada; no se registró la venta.',
        });
      }
      if (error instanceof PaymentReferenceConflictError) {
        throw new ConflictException({
          code: 'PAYMENT_REFERENCE_REUSED',
          message: 'La referencia del pago ya fue utilizada.',
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
      if (error instanceof CustomerCreditNotAvailableError) {
        throw new ConflictException({
          code: 'CUSTOMER_CREDIT_NOT_AVAILABLE',
          reason: error.reason,
          message:
            'La configuración de crédito del cliente no permite esta venta.',
        });
      }
      if (error instanceof CustomerCreditLimitExceededError) {
        throw new ConflictException({
          code: 'CUSTOMER_CREDIT_LIMIT_EXCEEDED',
          balance: error.balance,
          limit: error.limit,
          message: 'La venta excede el límite de crédito disponible.',
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
      if (error instanceof InventoryLotNotFoundError) {
        throw new NotFoundException({ code: 'INVENTORY_LOT_NOT_FOUND' });
      }
      if (error instanceof InsufficientInventoryLotStockError) {
        throw new ConflictException({
          code: 'INSUFFICIENT_INVENTORY_LOT_STOCK',
        });
      }
      if (error instanceof InventoryFifoLayerShortageError) {
        throw new ConflictException({ code: 'INVENTORY_FIFO_LAYER_SHORTAGE' });
      }
      if (error instanceof InventoryFifoCurrencyMismatchError) {
        throw new ConflictException({
          code: 'INVENTORY_FIFO_CURRENCY_MISMATCH',
        });
      }
      if (
        error instanceof InventorySerialRequiredError ||
        error instanceof InventorySerialQuantityError
      ) {
        throw new BadRequestException({ code: 'INVENTORY_SERIALS_REQUIRED' });
      }
      if (error instanceof InventorySerialNotFoundError)
        throw new NotFoundException({ code: 'INVENTORY_SERIAL_NOT_FOUND' });
      if (
        error instanceof InventorySerialDuplicateError ||
        error instanceof InventorySerialStateConflictError
      ) {
        throw new ConflictException({
          code: 'INVENTORY_SERIAL_STATE_CONFLICT',
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

  paymentOptions() {
    return {
      data: {
        methods: this.paymentAuthorization.enabledMethods(),
        nonCashProvider: this.config.nonCashProvider,
      },
      meta: { apiVersion: '1' as const },
    };
  }

  async quoteCart(input: {
    tenantId: string;
    branchId: string;
    warehouseId: string;
    cashRegisterId: string;
    userId: string;
    dto: QuoteCartDto;
    canDiscount?: boolean;
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
      const requestedLots = new Map<string, string | null>();
      const requestedSerials = new Map<string, string[]>();
      const requestedDiscounts = new Map<string, SaleDiscountDto | null>();
      const hasDiscount =
        Boolean(input.dto.discount) ||
        input.dto.lines.some((line) => Boolean(line.discount));
      if (hasDiscount && !input.canDiscount) {
        throw new ForbiddenException({
          code: 'SALE_DISCOUNT_PERMISSION_REQUIRED',
          message: 'No tienes permiso para aplicar descuentos.',
        });
      }
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
        const previousLot = requestedLots.get(line.productId);
        const selectedLot = line.lotId ?? null;
        if (previousLot !== undefined && previousLot !== selectedLot) {
          throw new BadRequestException({ code: 'MIXED_PRODUCT_LOTS' });
        }
        requestedLots.set(line.productId, selectedLot);
        requestedSerials.set(line.productId, [
          ...(requestedSerials.get(line.productId) ?? []),
          ...(line.serialNumbers ?? []),
        ]);
        const previousDiscount = requestedDiscounts.get(line.productId);
        const discount = line.discount ?? null;
        if (
          previousDiscount !== undefined &&
          JSON.stringify(previousDiscount) !== JSON.stringify(discount)
        ) {
          throw new BadRequestException({
            code: 'MIXED_PRODUCT_DISCOUNTS',
            message: 'Un producto repetido debe usar el mismo descuento.',
          });
        }
        requestedDiscounts.set(line.productId, discount);
      }
      const products = await this.pos.getProducts(
        input.tenantId,
        input.warehouseId,
        [...requested.keys()],
        input.dto.reservationId,
      );
      const selectedLots = [...requestedLots]
        .filter((entry): entry is [string, string] => entry[1] !== null)
        .map(([productId, lotId]) => ({ productId, lotId }));
      if (input.dto.reservationId && selectedLots.length > 0) {
        throw new BadRequestException({
          code: 'RESERVATION_LOT_SELECTION_NOT_SUPPORTED',
        });
      }
      const lotAvailability = await this.pos.getSelectedLotAvailability(
        input.tenantId,
        input.warehouseId,
        selectedLots,
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
      const currency = this.currencyFor(context.countryCode);
      const resolvedPrices = await this.priceLists.resolve({
        tenantId: input.tenantId,
        branchId: input.branchId,
        ...(input.dto.customerId ? { customerId: input.dto.customerId } : {}),
        channel: input.dto.channel ?? 'POS',
        currency,
        productIds: [...requested.keys()],
      });
      const preparedLines = [...requested.entries()].map(
        ([productId, quantityUnits]) => {
          const product = productMap.get(productId);
          if (!product)
            throw new NotFoundException({ code: 'PRODUCT_NOT_FOUND' });
          if (!product.active) throw new PosProductNotAvailableError(productId);
          const serialNumbers = requestedSerials.get(productId) ?? [];
          if (
            product.trackSerials &&
            BigInt(serialNumbers.length) * 1000n !== quantityUnits
          ) {
            throw new BadRequestException({
              code: 'INVENTORY_SERIALS_REQUIRED',
              message: 'Escanea una serie por cada unidad vendida.',
            });
          }
          const selectedLotId = requestedLots.get(productId) ?? null;
          const availableQuantity = selectedLotId
            ? lotAvailability.get(`${productId}:${selectedLotId}`)
            : product.availableQuantity;
          if (selectedLotId && availableQuantity === undefined) {
            throw new InventoryLotNotFoundError();
          }
          if (quantityUnits > this.toQuantityUnits(availableQuantity!)) {
            throw new PosInsufficientStockError(productId);
          }
          const resolvedPrice = resolvedPrices.get(productId);
          const effectivePrice = resolvedPrice?.price ?? product.price;
          const grossCents = this.roundDivide(
            this.toMoneyCents(effectivePrice) * quantityUnits,
            1000n,
          );
          const requestedDiscount = requestedDiscounts.get(productId) ?? null;
          const lineDiscountCents = this.discountAmount(
            requestedDiscount,
            grossCents,
          );
          return {
            product: { id: product.id, name: product.name, sku: product.sku },
            quantity: this.fromQuantityUnits(quantityUnits),
            lotId: requestedLots.get(productId) ?? null,
            serialNumbers,
            availableQuantity: availableQuantity!,
            unitPrice: this.fromMoneyCents(this.toMoneyCents(effectivePrice)),
            priceSource: resolvedPrice?.source ?? ('BASE' as const),
            priceList: resolvedPrice?.priceList ?? null,
            grossCents,
            lineDiscountCents,
            requestedDiscount,
          };
        },
      );
      const grossCents = preparedLines.reduce(
        (sum, line) => sum + line.grossCents,
        0n,
      );
      const lineDiscountCents = preparedLines.reduce(
        (sum, line) => sum + line.lineDiscountCents,
        0n,
      );
      const saleDiscountBase = grossCents - lineDiscountCents;
      const saleDiscountCents = this.discountAmount(
        input.dto.discount ?? null,
        saleDiscountBase,
      );
      const totalDiscountCents = lineDiscountCents + saleDiscountCents;
      if (totalDiscountCents * 2n > grossCents) {
        throw new BadRequestException({
          code: 'SALE_DISCOUNT_LIMIT_EXCEEDED',
          message: 'El descuento combinado no puede superar 50% de la venta.',
        });
      }
      const saleAllocations = this.allocateDiscount(
        preparedLines.map((line) => line.grossCents - line.lineDiscountCents),
        saleDiscountCents,
      );
      let subtotalCents = 0n;
      let taxCents = 0n;
      let totalCents = 0n;
      const lines = preparedLines.map((line, index) => {
        const saleAllocation = saleAllocations[index] ?? 0n;
        const totalDiscount = line.lineDiscountCents + saleAllocation;
        const lineTotal = line.grossCents - totalDiscount;
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
          product: line.product,
          quantity: line.quantity,
          lotId: line.lotId,
          serialNumbers: line.serialNumbers,
          availableQuantity: line.availableQuantity,
          unitPrice: line.unitPrice,
          priceSource: line.priceSource,
          priceList: line.priceList,
          grossTotal: this.fromMoneyCents(line.grossCents),
          discount: {
            line: this.appliedDiscount(
              line.requestedDiscount,
              line.lineDiscountCents,
            ),
            sale: this.appliedDiscount(input.dto.discount, saleAllocation),
            total: this.fromMoneyCents(totalDiscount),
          },
          subtotal: this.fromMoneyCents(lineSubtotal),
          tax: this.fromMoneyCents(lineTax),
          total: this.fromMoneyCents(lineTotal),
        };
      });
      return {
        data: {
          context: {
            branch: context.branch,
            warehouse: context.warehouse,
            cashRegister: context.cashRegister,
          },
          currency,
          taxRate: this.normalizeTaxRate(taxRate),
          discount: this.appliedDiscount(input.dto.discount, saleDiscountCents),
          lines,
          totals: {
            gross: this.fromMoneyCents(grossCents),
            lineDiscount: this.fromMoneyCents(lineDiscountCents),
            saleDiscount: this.fromMoneyCents(saleDiscountCents),
            discount: this.fromMoneyCents(totalDiscountCents),
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
      if (error instanceof InventoryLotNotFoundError) {
        throw new NotFoundException({ code: 'INVENTORY_LOT_NOT_FOUND' });
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

  private applyMarginAccess<
    T extends {
      lines: Array<{ grossProfit: string | null }>;
      totals: { grossProfit: string | null };
    },
  >(sale: T, canViewMargin = false): T {
    if (canViewMargin) return sale;
    return {
      ...sale,
      lines: sale.lines.map((line) => ({ ...line, grossProfit: null })),
      totals: { ...sale.totals, grossProfit: null },
    };
  }

  private preparePayments(
    dto: CreateSaleDto,
    totalCents: bigint,
    currency: string,
    idempotencyKey: string,
  ) {
    if (dto.credit) {
      if (dto.payment || dto.payments) {
        throw new BadRequestException({
          code: 'PAYMENT_CONFIGURATION_INVALID',
          message: 'Una venta a crédito no puede incluir cobros inmediatos.',
        });
      }
      return [];
    }
    if ((!dto.payment && !dto.payments) || (dto.payment && dto.payments)) {
      throw new BadRequestException({
        code: 'PAYMENT_CONFIGURATION_INVALID',
        message: 'Indica un pago único o un desglose de pagos, pero no ambos.',
      });
    }
    const source: SalePaymentDto[] = dto.payments ?? [dto.payment!];
    let appliedTotal = 0n;
    const payments = source.map((payment, index) => {
      const amount =
        payment.amount ??
        (source.length === 1 ? this.fromMoneyCents(totalCents) : undefined);
      if (!amount || this.toMoneyCents(amount) <= 0n) {
        throw new BadRequestException({
          code: 'PAYMENT_AMOUNT_INVALID',
          message: 'Cada pago debe tener un importe mayor a cero.',
        });
      }
      const amountCents = this.toMoneyCents(amount);
      appliedTotal += amountCents;
      const isCash = payment.method === 'CASH';
      if (
        (isCash && payment.reference) ||
        (!isCash && payment.amountReceived)
      ) {
        throw new BadRequestException({
          code: 'PAYMENT_FIELDS_INVALID',
          message: 'Los campos del pago no corresponden al medio seleccionado.',
        });
      }
      if (isCash && !payment.amountReceived) {
        throw new BadRequestException({
          code: 'CASH_RECEIVED_REQUIRED',
          message: 'Indica el efectivo recibido.',
        });
      }
      if (!isCash && !payment.reference) {
        throw new BadRequestException({
          code: 'PAYMENT_REFERENCE_REQUIRED',
          message: 'La referencia es obligatoria para pagos no efectivos.',
        });
      }
      const receivedCents = isCash
        ? this.toMoneyCents(payment.amountReceived!)
        : amountCents;
      if (receivedCents < amountCents) {
        throw new BadRequestException({
          code: 'INSUFFICIENT_CASH_RECEIVED',
          message: 'El efectivo recibido no cubre su parte de la venta.',
        });
      }
      const authorization = this.paymentAuthorization.authorize({
        method: payment.method,
        reference: payment.reference,
        amount: this.fromMoneyCents(amountCents),
        currency,
        idempotencyKey: `${idempotencyKey}:${index}`,
      });
      return {
        method: payment.method,
        amountReceived: this.fromMoneyCents(receivedCents),
        amountApplied: this.fromMoneyCents(amountCents),
        change: this.fromMoneyCents(receivedCents - amountCents),
        reference: isCash ? null : payment.reference!,
        ...authorization,
      };
    });
    if (appliedTotal !== totalCents) {
      throw new BadRequestException({
        code: 'PAYMENT_TOTAL_MISMATCH',
        message: 'La suma de pagos debe coincidir exactamente con el total.',
      });
    }
    return payments;
  }

  private saleFingerprint(dto: CreateSaleDto): string {
    const quantities = new Map<string, bigint>();
    const lots = new Map<string, string | null>();
    const serials = new Map<string, string[]>();
    const discounts = new Map<string, SaleDiscountDto | null>();
    for (const line of dto.lines) {
      quantities.set(
        line.productId,
        (quantities.get(line.productId) ?? 0n) +
          this.toQuantityUnits(line.quantity),
      );
      const previousLot = lots.get(line.productId);
      const lotId = line.lotId ?? null;
      if (previousLot !== undefined && previousLot !== lotId) {
        throw new BadRequestException({ code: 'MIXED_PRODUCT_LOTS' });
      }
      lots.set(line.productId, lotId);
      serials.set(line.productId, [
        ...(serials.get(line.productId) ?? []),
        ...(line.serialNumbers ?? []),
      ]);
      const previousDiscount = discounts.get(line.productId);
      const discount = line.discount ?? null;
      if (
        previousDiscount !== undefined &&
        JSON.stringify(previousDiscount) !== JSON.stringify(discount)
      ) {
        throw new BadRequestException({
          code: 'MIXED_PRODUCT_DISCOUNTS',
          message: 'Un producto repetido debe usar el mismo descuento.',
        });
      }
      discounts.set(line.productId, discount);
    }
    const canonical = {
      lines: [...quantities.entries()]
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([productId, quantity]) => ({
          productId,
          quantity: this.fromQuantityUnits(quantity),
          lotId: lots.get(productId) ?? null,
          serialNumbers: (serials.get(productId) ?? [])
            .map((value) => value.trim().toUpperCase())
            .sort(),
          discount: discounts.get(productId)
            ? {
                ...discounts.get(productId),
                reason: discounts.get(productId)!.reason.trim(),
              }
            : null,
        })),
      payments: (dto.payments ?? (dto.payment ? [dto.payment] : [])).map(
        (payment) => ({
          method: payment.method,
          amount: payment.amount
            ? this.fromMoneyCents(this.toMoneyCents(payment.amount))
            : null,
          amountReceived: payment.amountReceived
            ? this.fromMoneyCents(this.toMoneyCents(payment.amountReceived))
            : null,
          reference: payment.reference ?? null,
        }),
      ),
      credit: dto.credit
        ? { installmentCount: dto.credit.installmentCount }
        : null,
      customerId: dto.customerId ?? null,
      reservationId: dto.reservationId ?? null,
      suspendedSaleId: dto.suspendedSaleId ?? null,
      discount: dto.discount
        ? {
            ...dto.discount,
            reason: dto.discount.reason.trim(),
          }
        : null,
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
      totals: {
        subtotal: expected.totals.subtotal,
        tax: expected.totals.tax,
        total: expected.totals.total,
      },
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
      totals: {
        subtotal: current.totals.subtotal,
        tax: current.totals.tax,
        total: current.totals.total,
      },
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

  private discountAmount(
    discount: SaleDiscountDto | null | undefined,
    baseCents: bigint,
  ): bigint {
    if (!discount) return 0n;
    if (discount.reason.trim().length < 3) {
      throw new BadRequestException({
        code: 'SALE_DISCOUNT_REASON_REQUIRED',
        message: 'Indica un motivo de al menos tres caracteres.',
      });
    }
    const amount =
      discount.type === 'PERCENT'
        ? this.roundDivide(
            baseCents * this.toPercentageBasisPoints(discount.value),
            10_000n,
          )
        : this.toMoneyCents(discount.value);
    if (amount <= 0n || amount >= baseCents || amount * 2n > baseCents) {
      throw new BadRequestException({
        code: 'SALE_DISCOUNT_LIMIT_EXCEEDED',
        message:
          'El descuento debe ser mayor que cero, menor al importe y no superar 50%.',
      });
    }
    return amount;
  }

  private toPercentageBasisPoints(value: string): bigint {
    const [whole, fraction = ''] = value.split('.');
    const basisPoints =
      BigInt(whole) * 100n + BigInt(fraction.padEnd(2, '0').slice(0, 2));
    if (basisPoints > 5_000n) {
      throw new BadRequestException({
        code: 'SALE_DISCOUNT_LIMIT_EXCEEDED',
        message: 'El porcentaje de descuento no puede superar 50%.',
      });
    }
    return basisPoints;
  }

  private appliedDiscount(
    discount: SaleDiscountDto | null | undefined,
    amountCents: bigint,
  ) {
    if (!discount) return null;
    return {
      type: discount.type,
      value:
        discount.type === 'PERCENT'
          ? this.fromPercentageBasisPoints(
              this.toPercentageBasisPoints(discount.value),
            )
          : this.fromMoneyCents(this.toMoneyCents(discount.value)),
      reason: discount.reason.trim(),
      amount: this.fromMoneyCents(amountCents),
    };
  }

  private allocateDiscount(weights: bigint[], amount: bigint): bigint[] {
    if (amount === 0n) return weights.map(() => 0n);
    const total = weights.reduce((sum, weight) => sum + weight, 0n);
    const allocations = weights.map((weight) => (amount * weight) / total);
    let remainder =
      amount - allocations.reduce((sum, value) => sum + value, 0n);
    const order = weights
      .map((weight, index) => ({
        index,
        remainder: (amount * weight) % total,
      }))
      .sort((left, right) =>
        left.remainder === right.remainder
          ? left.index - right.index
          : left.remainder > right.remainder
            ? -1
            : 1,
      );
    for (const entry of order) {
      if (remainder === 0n) break;
      allocations[entry.index] += 1n;
      remainder -= 1n;
    }
    return allocations;
  }

  private fromPercentageBasisPoints(value: bigint): string {
    return `${value / 100n}.${String(value % 100n).padStart(2, '0')}`;
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
