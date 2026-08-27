import { Injectable } from '@nestjs/common';

export interface PurchaseOrderDeliveryResult {
  mode: 'SIMULATED';
  recipient: string | null;
}

export abstract class PurchaseOrderDelivery {
  abstract send(input: {
    folio: string;
    recipient: string | null;
  }): Promise<PurchaseOrderDeliveryResult>;
}

@Injectable()
export class SimulatedPurchaseOrderDelivery implements PurchaseOrderDelivery {
  async send(input: {
    folio: string;
    recipient: string | null;
  }): Promise<PurchaseOrderDeliveryResult> {
    return Promise.resolve({ mode: 'SIMULATED', recipient: input.recipient });
  }
}
