import { Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type {
  SaleReceiptData,
  SaleReceiptDeliveryData,
} from './sale-receipt.types';

export const SALE_RECEIPT_EMAIL_ADAPTER = Symbol('SALE_RECEIPT_EMAIL_ADAPTER');

export interface SaleReceiptEmailAdapter {
  send(
    receipt: SaleReceiptData,
    recipient: string,
  ): Promise<SaleReceiptDeliveryData>;
}

@Injectable()
export class SimulatorSaleReceiptEmailAdapter implements SaleReceiptEmailAdapter {
  send(
    _receipt: SaleReceiptData,
    recipient: string,
  ): Promise<SaleReceiptDeliveryData> {
    return Promise.resolve({
      mode: 'SIMULATED',
      channel: 'EMAIL',
      recipient,
      messageId: `sim-${randomUUID()}`,
      acceptedAt: new Date().toISOString(),
    });
  }
}
