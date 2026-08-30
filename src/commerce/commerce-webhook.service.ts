import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { createHmac } from 'node:crypto';
import { CustomerOrderEventBus } from '../orders/customer-order-event.bus';
import type { CustomerOrderData } from '../orders/customer-order.types';
import { CommerceRepository } from './commerce.repository';
import type { CommerceWebhookEvent } from './commerce.types';

@Injectable()
export class CommerceWebhookService implements OnModuleInit, OnModuleDestroy {
  private unsubscribe?: () => void;

  constructor(
    private readonly repository: CommerceRepository,
    private readonly orderEvents: CustomerOrderEventBus,
  ) {}

  onModuleInit() {
    this.unsubscribe = this.orderEvents.subscribe(({ tenantId, order }) =>
      this.publishOrder(tenantId, order),
    );
  }

  onModuleDestroy() {
    this.unsubscribe?.();
  }

  async publishOrder(tenantId: string, order: CustomerOrderData) {
    const configuration = await this.repository.webhookConfiguration(
      tenantId,
      order.id,
    );
    if (!configuration) return;
    const eventType = this.eventType(order);
    if (!configuration.events.includes(eventType)) return;
    const payload = {
      apiVersion: '1',
      eventId: `${order.id}:${eventType}:${order.version}`,
      type: eventType,
      occurredAt: order.updatedAt,
      order: {
        externalId: configuration.externalOrderId,
        id: order.id,
        number: order.orderNumber,
        status: order.status,
        fulfillmentStatus: order.fulfillment.status,
        total: order.totals.total,
        currency: order.currency,
        version: order.version,
      },
    };
    const signature = this.signature(configuration.keyHash, payload);
    const delivery = await this.repository.createDelivery({
      tenantId,
      credentialId: configuration.credentialId,
      eventId: payload.eventId,
      eventType,
      targetUrl: configuration.url,
      payload,
      signature,
    });
    if (!delivery || delivery.status === 'SUCCEEDED') return;
    for (let attempt = delivery.attemptCount + 1; attempt <= 3; attempt += 1) {
      const result = this.simulate(configuration.url, attempt);
      await this.repository.updateDelivery(delivery.id, result);
      if (result.status === 'SUCCEEDED' || result.status === 'FAILED') return;
    }
  }

  async replay(tenantId: string, deliveryId: string) {
    const prepared = await this.repository.prepareDeliveryReplay(
      tenantId,
      deliveryId,
    );
    if (!prepared) return null;
    const signature = this.signature(prepared.keyHash, prepared.payload);
    await this.repository.updateDeliverySignature(
      tenantId,
      deliveryId,
      signature,
    );
    let delivery = { ...prepared.delivery, signature };
    for (let attempt = delivery.attemptCount + 1; attempt <= 5; attempt += 1) {
      const result = this.simulate(delivery.targetUrl, attempt);
      await this.repository.updateDelivery(delivery.id, result);
      delivery = {
        ...delivery,
        status: result.status,
        attemptCount: attempt,
        errorCode: result.errorCode,
        deliveredAt:
          result.status === 'SUCCEEDED' ? new Date().toISOString() : null,
      };
      if (result.status === 'SUCCEEDED' || result.status === 'FAILED') break;
    }
    return delivery;
  }

  private signature(secret: string, payload: object): string {
    return `sha256=${createHmac('sha256', secret)
      .update(JSON.stringify(payload))
      .digest('hex')}`;
  }

  private eventType(order: CustomerOrderData): CommerceWebhookEvent {
    if (
      order.status === 'READY' &&
      ['DISPATCHED', 'RETRYABLE_FAILURE'].includes(order.fulfillment.status)
    )
      return 'ORDER_FULFILLMENT_UPDATED';
    if (order.status === 'CONFIRMED') return 'ORDER_CONFIRMED';
    if (order.status === 'PREPARING') return 'ORDER_PREPARING';
    if (order.status === 'READY') return 'ORDER_READY';
    if (order.status === 'DELIVERED') return 'ORDER_DELIVERED';
    if (order.status === 'CANCELLED') return 'ORDER_CANCELLED';
    return 'ORDER_FULFILLMENT_UPDATED';
  }

  private simulate(url: string, attempt: number) {
    if (url.includes('reject'))
      return { status: 'FAILED' as const, errorCode: 'SIMULATED_REJECTED' };
    if (url.includes('recover') && attempt <= 3)
      return {
        status: 'RETRYABLE_FAILURE' as const,
        errorCode: 'SIMULATED_TIMEOUT',
      };
    if (url.includes('retry') && attempt === 1)
      return {
        status: 'RETRYABLE_FAILURE' as const,
        errorCode: 'SIMULATED_TIMEOUT',
      };
    return { status: 'SUCCEEDED' as const, errorCode: null };
  }
}
