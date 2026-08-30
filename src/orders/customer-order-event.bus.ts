import { Injectable } from '@nestjs/common';
import type { CustomerOrderData } from './customer-order.types';

export type CustomerOrderEventListener = (event: {
  tenantId: string;
  order: CustomerOrderData;
}) => Promise<void>;

@Injectable()
export class CustomerOrderEventBus {
  private readonly listeners = new Set<CustomerOrderEventListener>();

  subscribe(listener: CustomerOrderEventListener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async publish(tenantId: string, order: CustomerOrderData) {
    await Promise.allSettled(
      [...this.listeners].map((listener) => listener({ tenantId, order })),
    );
  }
}
