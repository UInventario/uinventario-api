import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { createHash } from 'node:crypto';
import { PosService } from '../pos/pos.service';
import type { SalePaymentDto } from '../pos/dto/create-sale.dto';
import { ProductReservationService } from '../reservations/product-reservation.service';
import {
  CustomerOrderIdempotencyConflictError,
  CustomerOrderNotFoundError,
  CustomerOrderPriceChangedError,
  CustomerOrderReservationUnavailableError,
  CustomerOrderStateError,
  CustomerOrderVersionConflictError,
} from './customer-order.errors';
import { CustomerOrderRepository } from './customer-order.repository';
import type {
  CustomerOrderData,
  CustomerOrderResponse,
  CustomerOrderStatus,
} from './customer-order.types';
import type { CreateCustomerOrderDto } from './dto/create-customer-order.dto';
import type { ListCustomerOrdersDto } from './dto/list-customer-orders.dto';
import type { TransitionCustomerOrderDto } from './dto/transition-customer-order.dto';
import {
  CUSTOMER_ORDER_CARRIER_ADAPTER,
  type CustomerOrderCarrierAdapter,
} from './customer-order-carrier.adapter';
import type { CustomerOrderFulfillmentDto } from './dto/customer-order-fulfillment.dto';
import { CustomerOrderEventBus } from './customer-order-event.bus';

interface CustomerOrderTransitionInput {
  tenantId: string;
  branchId: string;
  warehouseId: string;
  cashRegisterId: string;
  userId: string;
  orderId: string;
  idempotencyKey: string | undefined;
  dto: TransitionCustomerOrderDto;
}

@Injectable()
export class CustomerOrderService {
  constructor(
    private readonly orders: CustomerOrderRepository,
    private readonly reservations: ProductReservationService,
    private readonly pos: PosService,
    @Inject(CUSTOMER_ORDER_CARRIER_ADAPTER)
    private readonly carrier: CustomerOrderCarrierAdapter,
    private readonly events: CustomerOrderEventBus,
  ) {}

  async create(input: {
    tenantId: string;
    branchId: string;
    warehouseId: string;
    cashRegisterId: string;
    userId: string;
    idempotencyKey: string | undefined;
    dto: CreateCustomerOrderDto;
  }): Promise<CustomerOrderResponse> {
    this.assertKey(input.idempotencyKey);
    if (input.dto.lines.some((line) => line.discount)) {
      throw new BadRequestException({
        code: 'ORDER_DISCOUNT_NOT_SUPPORTED',
        message:
          'Los descuentos de pedidos se administrarán en una capacidad posterior.',
      });
    }
    const fingerprint = createHash('sha256')
      .update(
        JSON.stringify({
          dto: input.dto,
          priority: input.dto.priority ?? 'NORMAL',
          branchId: input.branchId,
          warehouseId: input.warehouseId,
          cashRegisterId: input.cashRegisterId,
        }),
      )
      .digest('hex');
    const replay = await this.orders.findByIdempotency(
      input.tenantId,
      input.branchId,
      input.idempotencyKey!,
    );
    if (replay) {
      if (replay.fingerprint !== fingerprint)
        this.rethrow(new CustomerOrderIdempotencyConflictError());
      return {
        data: replay.order,
        meta: { apiVersion: '1', idempotentReplay: true },
      };
    }
    const quote = await this.pos.quoteCart({
      tenantId: input.tenantId,
      branchId: input.branchId,
      warehouseId: input.warehouseId,
      cashRegisterId: input.cashRegisterId,
      userId: input.userId,
      dto: {
        customerId: input.dto.customerId,
        channel: input.dto.channel,
        lines: input.dto.lines,
      },
      canDiscount: false,
    });
    const payments = this.normalizePayments(
      input.dto.payments,
      quote.data.totals.total,
    );
    try {
      const result = await this.orders.create({
        ...input,
        idempotencyKey: input.idempotencyKey!,
        locationId: input.dto.locationId,
        customerId: input.dto.customerId,
        channel: input.dto.channel,
        priority: input.dto.priority ?? 'NORMAL',
        expiresInHours: input.dto.expiresInHours,
        lines: input.dto.lines,
        payments,
        fulfillment: this.normalizeFulfillment(input.dto.fulfillment),
        quote: quote.data,
        fingerprint,
      });
      return {
        data: result.order,
        meta: { apiVersion: '1', idempotentReplay: result.replay },
      };
    } catch (error) {
      this.rethrow(error);
    }
  }

  async list(tenantId: string, branchId: string, query: ListCustomerOrdersDto) {
    const result = await this.orders.list(tenantId, branchId, query);
    return {
      data: result.orders,
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

  async get(tenantId: string, branchId: string, orderId: string) {
    const order = await this.orders.find(tenantId, branchId, orderId);
    if (!order) throw new NotFoundException();
    return { data: order, meta: { apiVersion: '1' as const } };
  }

  async confirm(
    input: CustomerOrderTransitionInput,
  ): Promise<CustomerOrderResponse> {
    this.assertKey(input.idempotencyKey);
    const current = await this.requireOrder(input);
    if (!['DRAFT', 'CONFIRMED'].includes(current.status))
      this.state(current.status);
    const reservation = await this.reservations.create({
      tenantId: input.tenantId,
      branchId: input.branchId,
      warehouseId: input.warehouseId,
      userId: input.userId,
      idempotencyKey: `order-reservation:${input.orderId}`,
      dto: {
        customerId: current.customer.id,
        locationId: current.context.location.id,
        expiresInHours: current.expiresInHours,
        lines: current.lines.map((line) => ({
          productId: line.product.id,
          quantity: line.quantity,
          serialNumbers: line.serialNumbers,
        })),
      },
    });
    try {
      return await this.change({
        ...input,
        from: ['DRAFT'],
        to: 'CONFIRMED',
        reservationId: reservation.data.id,
      });
    } catch (error) {
      const latest = await this.orders.find(
        input.tenantId,
        input.branchId,
        input.orderId,
      );
      if (latest?.reservation?.id !== reservation.data.id) {
        await this.reservations.release({
          tenantId: input.tenantId,
          branchId: input.branchId,
          userId: input.userId,
          reservationId: reservation.data.id,
          idempotencyKey: `order-reservation-cleanup:${input.orderId}`,
          dto: { reason: 'Compensación de confirmación de pedido' },
        });
      }
      throw error;
    }
  }

  prepare(input: CustomerOrderTransitionInput): Promise<CustomerOrderResponse> {
    return this.change({ ...input, from: ['CONFIRMED'], to: 'PREPARING' });
  }

  ready(input: CustomerOrderTransitionInput): Promise<CustomerOrderResponse> {
    return this.change({ ...input, from: ['PREPARING'], to: 'READY' });
  }

  async dispatch(
    input: CustomerOrderTransitionInput,
  ): Promise<CustomerOrderResponse> {
    this.assertKey(input.idempotencyKey);
    try {
      const replay = await this.orders.findDispatchByIdempotency({
        tenantId: input.tenantId,
        branchId: input.branchId,
        orderId: input.orderId,
        version: input.dto.version,
        idempotencyKey: input.idempotencyKey!,
      });
      if (replay) {
        return {
          data: replay,
          meta: { apiVersion: '1', idempotentReplay: true },
        };
      }
    } catch (error) {
      this.rethrow(error);
    }
    const current = await this.requireOrder(input);
    if (
      current.status !== 'READY' ||
      current.fulfillment.method !== 'DELIVERY' ||
      !['READY', 'RETRYABLE_FAILURE', 'DISPATCHED'].includes(
        current.fulfillment.status,
      ) ||
      !current.fulfillment.carrier
    )
      this.state(current.fulfillment.status);
    if (current.version !== input.dto.version)
      this.rethrow(new CustomerOrderVersionConflictError());
    const result = await this.carrier.dispatch({
      carrierCode: current.fulfillment.carrier.code,
      orderNumber: current.orderNumber,
      attempt: current.fulfillment.carrier.attempts + 1,
      windowStart: current.fulfillment.window.start,
      windowEnd: current.fulfillment.window.end,
    });
    try {
      const dispatched = await this.orders.dispatch({
        tenantId: input.tenantId,
        branchId: input.branchId,
        orderId: input.orderId,
        actorUserId: input.userId,
        version: input.dto.version,
        idempotencyKey: input.idempotencyKey!,
        result,
      });
      await this.events.publish(input.tenantId, dispatched.order);
      return {
        data: dispatched.order,
        meta: { apiVersion: '1', idempotentReplay: dispatched.replay },
      };
    } catch (error) {
      this.rethrow(error);
    }
  }

  async deliver(
    input: CustomerOrderTransitionInput & { canViewMargin: boolean },
  ) {
    this.assertKey(input.idempotencyKey);
    const current = await this.requireOrder(input);
    if (!['READY', 'DELIVERED'].includes(current.status))
      this.state(current.status);
    if (!current.reservation) this.state(current.status);
    if (
      current.status === 'READY' &&
      ((current.fulfillment.method === 'PICKUP' &&
        current.fulfillment.status !== 'READY') ||
        (current.fulfillment.method === 'DELIVERY' &&
          current.fulfillment.status !== 'DISPATCHED'))
    )
      this.state(current.fulfillment.status);
    if (current.status === 'READY') {
      const quote = await this.pos.quoteCart({
        tenantId: input.tenantId,
        branchId: input.branchId,
        warehouseId: input.warehouseId,
        cashRegisterId: input.cashRegisterId,
        userId: input.userId,
        dto: {
          reservationId: current.reservation.id,
          customerId: current.customer.id,
          channel: current.channel,
          lines: this.saleLines(current),
        },
        canDiscount: false,
      });
      if (
        quote.data.currency !== current.currency ||
        quote.data.totals.total !== current.totals.total
      )
        this.rethrow(new CustomerOrderPriceChangedError());
    }
    const sale = await this.pos.createSale({
      tenantId: input.tenantId,
      branchId: input.branchId,
      warehouseId: input.warehouseId,
      cashRegisterId: input.cashRegisterId,
      userId: input.userId,
      idempotencyKey: `order-delivery:${input.orderId}`,
      dto: {
        reservationId: current.reservation.id,
        customerId: current.customer.id,
        channel: current.channel,
        lines: this.saleLines(current),
        payments: current.payments.map((payment) => ({
          method: payment.method,
          amount: payment.amount,
          ...(payment.method === 'CASH'
            ? { amountReceived: payment.amountReceived }
            : { reference: payment.reference! }),
        })),
      },
      canDiscount: false,
      canCredit: false,
      canViewMargin: input.canViewMargin,
    });
    return this.change({
      ...input,
      from: ['READY'],
      to: 'DELIVERED',
      saleId: sale.data.id,
    });
  }

  async cancel(
    input: CustomerOrderTransitionInput,
  ): Promise<CustomerOrderResponse> {
    this.assertKey(input.idempotencyKey);
    if (!input.dto.reason?.trim()) {
      throw new BadRequestException({
        code: 'ORDER_CANCELLATION_REASON_REQUIRED',
        message: 'Indica el motivo de cancelación.',
      });
    }
    const current = await this.requireOrder(input);
    if (
      !['DRAFT', 'CONFIRMED', 'PREPARING', 'READY', 'CANCELLED'].includes(
        current.status,
      )
    )
      this.state(current.status);
    if (current.reservation && current.status !== 'CANCELLED') {
      await this.reservations.release({
        tenantId: input.tenantId,
        branchId: input.branchId,
        userId: input.userId,
        reservationId: current.reservation.id,
        idempotencyKey: `order-cancel-reservation:${input.orderId}`,
        dto: { reason: `Pedido ${current.orderNumber} cancelado` },
      });
    }
    return this.change({
      ...input,
      from: ['DRAFT', 'CONFIRMED', 'PREPARING', 'READY'],
      to: 'CANCELLED',
      reason: input.dto.reason,
    });
  }

  private async change(
    input: CustomerOrderTransitionInput & {
      from: CustomerOrderStatus[];
      to: CustomerOrderStatus;
      reservationId?: string;
      saleId?: string;
      reason?: string;
    },
  ): Promise<CustomerOrderResponse> {
    this.assertKey(input.idempotencyKey);
    try {
      const result = await this.orders.transition({
        tenantId: input.tenantId,
        branchId: input.branchId,
        orderId: input.orderId,
        actorUserId: input.userId,
        version: input.dto.version,
        idempotencyKey: input.idempotencyKey!,
        from: input.from,
        to: input.to,
        reason: input.reason,
        reservationId: input.reservationId,
        saleId: input.saleId,
      });
      await this.events.publish(input.tenantId, result.order);
      return {
        data: result.order,
        meta: { apiVersion: '1', idempotentReplay: result.replay },
      };
    } catch (error) {
      this.rethrow(error);
    }
  }

  private requireOrder(input: {
    tenantId: string;
    branchId: string;
    orderId: string;
  }) {
    return this.orders
      .find(input.tenantId, input.branchId, input.orderId)
      .then((order) => {
        if (!order) throw new NotFoundException();
        return order;
      });
  }

  private saleLines(order: CustomerOrderData) {
    return order.lines.map((line) => ({
      productId: line.product.id,
      quantity: line.quantity,
      ...(line.lotId ? { lotId: line.lotId } : {}),
      ...(line.serialNumbers.length
        ? { serialNumbers: line.serialNumbers }
        : {}),
    }));
  }

  private normalizePayments(payments: SalePaymentDto[], total: string) {
    const totalCents = this.cents(total);
    let applied = 0n;
    const normalized = payments.map((payment) => {
      const amount =
        payment.amount ?? (payments.length === 1 ? total : undefined);
      if (!amount || this.cents(amount) <= 0n)
        throw new BadRequestException({ code: 'PAYMENT_AMOUNT_INVALID' });
      const amountCents = this.cents(amount);
      applied += amountCents;
      if (payment.method === 'CASH') {
        if (!payment.amountReceived || payment.reference)
          throw new BadRequestException({ code: 'CASH_RECEIVED_REQUIRED' });
        const received = this.cents(payment.amountReceived);
        if (received < amountCents)
          throw new BadRequestException({ code: 'INSUFFICIENT_CASH_RECEIVED' });
        return {
          method: payment.method,
          amount: this.money(amountCents),
          amountReceived: this.money(received),
          reference: null,
        };
      }
      if (!payment.reference || payment.amountReceived)
        throw new BadRequestException({ code: 'PAYMENT_REFERENCE_REQUIRED' });
      return {
        method: payment.method,
        amount: this.money(amountCents),
        amountReceived: this.money(amountCents),
        reference: payment.reference,
      };
    });
    if (applied !== totalCents)
      throw new BadRequestException({
        code: 'PAYMENT_TOTAL_MISMATCH',
        message:
          'La suma del plan de pagos debe coincidir con el total del pedido.',
      });
    return normalized;
  }

  private normalizeFulfillment(dto: CustomerOrderFulfillmentDto) {
    const windowStart = new Date(dto.windowStart);
    const windowEnd = new Date(dto.windowEnd);
    if (
      Number.isNaN(windowStart.getTime()) ||
      Number.isNaN(windowEnd.getTime()) ||
      windowStart.getTime() < Date.now() - 5 * 60_000 ||
      windowEnd <= windowStart ||
      windowEnd.getTime() - windowStart.getTime() > 7 * 24 * 60 * 60_000
    ) {
      throw new BadRequestException({
        code: 'ORDER_FULFILLMENT_WINDOW_INVALID',
        message:
          'La ventana debe ser futura, terminar después de iniciar y durar como máximo 7 días.',
      });
    }
    const deliveryCost = this.money(this.cents(dto.deliveryCost));
    if (dto.method === 'PICKUP') {
      if (
        deliveryCost !== '0.00' ||
        dto.carrierCode ||
        dto.addressLine1 ||
        dto.recipientName ||
        dto.recipientPhone
      ) {
        throw new BadRequestException({
          code: 'ORDER_PICKUP_DATA_INVALID',
          message: 'El retiro no admite costo, transportista ni dirección.',
        });
      }
      return {
        method: dto.method,
        deliveryCost,
        windowStart,
        windowEnd,
        recipientName: null,
        recipientPhone: null,
        addressLine1: null,
        addressLine2: null,
        city: null,
        region: null,
        postalCode: null,
        countryCode: null,
        carrierCode: null,
        carrierName: null,
      };
    }
    const required = [
      dto.recipientName,
      dto.recipientPhone,
      dto.addressLine1,
      dto.city,
      dto.region,
      dto.postalCode,
      dto.countryCode,
      dto.carrierCode,
    ];
    if (required.some((value) => !value?.trim())) {
      throw new BadRequestException({
        code: 'ORDER_DELIVERY_DATA_REQUIRED',
        message:
          'Completa destinatario, teléfono, dirección, ciudad, región, código postal, país y transportista.',
      });
    }
    return {
      method: dto.method,
      deliveryCost,
      windowStart,
      windowEnd,
      recipientName: dto.recipientName!.trim(),
      recipientPhone: dto.recipientPhone!.trim(),
      addressLine1: dto.addressLine1!.trim(),
      addressLine2: dto.addressLine2?.trim() || null,
      city: dto.city!.trim(),
      region: dto.region!.trim(),
      postalCode: dto.postalCode!.trim(),
      countryCode: dto.countryCode!,
      carrierCode: dto.carrierCode!,
      carrierName:
        dto.carrierCode === 'SIMULATED_RETRY'
          ? 'Transportista simulado con reintento'
          : 'Transportista simulado',
    };
  }

  private assertKey(value: string | undefined): void {
    if (!value || !/^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/.test(value))
      throw new BadRequestException({
        code: 'INVALID_IDEMPOTENCY_KEY',
        message:
          'Idempotency-Key es obligatorio y debe tener entre 8 y 128 caracteres.',
      });
  }

  private state(status: string): never {
    throw new ConflictException({
      code: 'CUSTOMER_ORDER_STATE_CONFLICT',
      message: `El pedido ya no admite esta transición desde ${status}.`,
      status,
    });
  }

  private rethrow(error: unknown): never {
    if (error instanceof CustomerOrderNotFoundError)
      throw new NotFoundException();
    if (error instanceof CustomerOrderStateError) this.state(error.status);
    if (error instanceof CustomerOrderVersionConflictError)
      throw new ConflictException({
        code: 'CUSTOMER_ORDER_VERSION_CONFLICT',
        message: 'El pedido cambió; recarga la bandeja antes de continuar.',
      });
    if (error instanceof CustomerOrderIdempotencyConflictError)
      throw new ConflictException({
        code: 'IDEMPOTENCY_KEY_REUSED',
        message: 'La clave de idempotencia ya fue usada con otros datos.',
      });
    if (error instanceof CustomerOrderPriceChangedError)
      throw new ConflictException({
        code: 'CUSTOMER_ORDER_PRICE_CHANGED',
        message:
          'El precio cambió desde la creación; cancela y crea un pedido actualizado.',
      });
    if (error instanceof CustomerOrderReservationUnavailableError)
      throw new ConflictException({
        code: 'CUSTOMER_ORDER_RESERVATION_UNAVAILABLE',
        message:
          'La reserva del pedido venció o dejó de estar activa; cancela el pedido.',
      });
    throw error;
  }

  private cents(value: string): bigint {
    const [whole, fraction = ''] = value.split('.');
    return BigInt(whole) * 100n + BigInt((fraction + '00').slice(0, 2));
  }

  private money(value: bigint): string {
    return `${value / 100n}.${(value % 100n).toString().padStart(2, '0')}`;
  }
}
