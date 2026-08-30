import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type {
  CarrierCancelDto,
  CarrierPollDto,
} from './dto/carrier-action.dto';
import type { CarrierEventDto } from './dto/carrier-event.dto';
import {
  CUSTOMER_ORDER_CARRIER_ADAPTER,
  type CustomerOrderCarrierAdapter,
} from './customer-order-carrier.adapter';
import {
  CustomerOrderIdempotencyConflictError,
  CustomerOrderNotFoundError,
  CustomerOrderStateError,
} from './customer-order.errors';
import { CustomerOrderRepository } from './customer-order.repository';
import { CustomerOrderShippingRepository } from './customer-order-shipping.repository';

@Injectable()
export class CustomerOrderShippingService {
  constructor(
    private readonly shipping: CustomerOrderShippingRepository,
    private readonly orders: CustomerOrderRepository,
    @Inject(CUSTOMER_ORDER_CARRIER_ADAPTER)
    private readonly carrier: CustomerOrderCarrierAdapter,
  ) {}

  contract() {
    return {
      data: {
        name: 'UINVENTARIO_CARRIER',
        version: '1',
        provider: {
          key: this.carrier.provider,
          version: this.carrier.version,
          mode: 'SIMULATOR',
          production: false,
        },
        operations: ['QUOTE', 'CREATE_SHIPMENT', 'LABEL', 'CANCEL', 'TRACK'],
        privacy: {
          addressReturnedByApi: false,
          addressSentOnlyDuringProviderOperation: true,
          piiWrittenToAudit: false,
        },
        tracking: {
          sources: ['WEBHOOK', 'POLLING'],
          deduplicated: true,
          outOfOrderProtected: true,
        },
        fallback: { manualOperationAvailable: true },
      },
      meta: { apiVersion: '1' as const },
    };
  }

  async quote(input: Context) {
    try {
      const payload = await this.shipping.payload(
        input.tenantId,
        input.branchId,
        input.orderId,
      );
      const quote = await this.carrier.quote(payload);
      return { data: quote, meta: { apiVersion: '1' as const } };
    } catch (error) {
      this.rethrow(error);
    }
  }

  async cancel(
    input: Context & { idempotencyKey: string; dto: CarrierCancelDto },
  ) {
    this.key(input.idempotencyKey);
    try {
      const result = await this.shipping.cancel({
        ...input,
        scenario: input.dto.scenario,
        execute: (trackingReference) =>
          this.carrier.cancel({
            trackingReference,
            scenario: input.dto.scenario,
            idempotencyKey: input.idempotencyKey,
          }),
      });
      return {
        data: await this.requireOrder(input),
        meta: { apiVersion: '1' as const, idempotentReplay: result.replay },
      };
    } catch (error) {
      this.rethrow(error);
    }
  }

  async poll(input: Context & { idempotencyKey: string; dto: CarrierPollDto }) {
    this.key(input.idempotencyKey);
    try {
      const result = await this.shipping.poll({
        ...input,
        scenario: input.dto.scenario,
        execute: (trackingReference, currentSequence) =>
          this.carrier.track({
            trackingReference,
            currentSequence,
            scenario: input.dto.scenario,
            idempotencyKey: input.idempotencyKey,
          }),
      });
      return {
        data: await this.requireOrder(input),
        meta: {
          apiVersion: '1' as const,
          idempotentReplay: result.replay,
          eventApplied: result.eventApplied,
        },
      };
    } catch (error) {
      this.rethrow(error);
    }
  }

  async event(input: Context & { dto: CarrierEventDto }) {
    try {
      const result = await this.shipping.event({
        ...input,
        event: {
          providerEventId: input.dto.providerEventId,
          trackingReference: input.dto.trackingReference,
          status: input.dto.status,
          sequence: input.dto.sequence,
          occurredAt: input.dto.occurredAt,
        },
      });
      return {
        data: await this.requireOrder(input),
        meta: {
          apiVersion: '1' as const,
          idempotentReplay: result.replay,
          eventApplied: result.applied,
        },
      };
    } catch (error) {
      this.rethrow(error);
    }
  }

  private async requireOrder(input: Context) {
    const order = await this.orders.find(
      input.tenantId,
      input.branchId,
      input.orderId,
    );
    if (!order) throw new CustomerOrderNotFoundError();
    return order;
  }

  private key(value: string): void {
    if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/.test(value)) {
      throw new BadRequestException({ code: 'INVALID_IDEMPOTENCY_KEY' });
    }
  }

  private rethrow(error: unknown): never {
    if (error instanceof CustomerOrderNotFoundError)
      throw new NotFoundException();
    if (error instanceof CustomerOrderIdempotencyConflictError) {
      throw new ConflictException({
        code: 'CUSTOMER_ORDER_IDEMPOTENCY_CONFLICT',
      });
    }
    if (error instanceof CustomerOrderStateError) {
      throw new ConflictException({
        code: 'CUSTOMER_ORDER_SHIPPING_STATE_CONFLICT',
        status: error.status,
      });
    }
    throw error;
  }
}

interface Context {
  tenantId: string;
  branchId: string;
  orderId: string;
}
