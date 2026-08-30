import { Injectable } from '@nestjs/common';

export const CUSTOMER_ORDER_CARRIER_ADAPTER = Symbol(
  'CUSTOMER_ORDER_CARRIER_ADAPTER',
);

export type CustomerOrderDispatchResult =
  | {
      status: 'SUCCEEDED';
      trackingReference: string;
      label: { format: 'ZPL'; payload: string };
      trackingStatus: 'LABEL_READY';
    }
  | { status: 'FAILED_RETRYABLE'; errorCode: string };

export type CarrierTrackingStatus =
  | 'LABEL_READY'
  | 'IN_TRANSIT'
  | 'OUT_FOR_DELIVERY'
  | 'DELIVERED'
  | 'EXCEPTION'
  | 'CANCELLED';

export interface CustomerOrderCarrierPayload {
  carrierCode: 'SIMULATED' | 'SIMULATED_RETRY';
  orderNumber: string;
  currency: string;
  windowStart: string;
  windowEnd: string;
  recipient: { name: string; phone: string };
  address: {
    line1: string;
    line2: string | null;
    city: string;
    region: string;
    postalCode: string;
    countryCode: string;
  };
  parcels: Array<{ sku: string; quantity: string }>;
}

export interface CarrierTrackingEvent {
  providerEventId: string;
  trackingReference: string;
  status: CarrierTrackingStatus;
  sequence: number;
  occurredAt: string;
}

export interface CustomerOrderCarrierAdapter {
  readonly provider: 'SIMULATOR';
  readonly version: '1';
  quote(input: CustomerOrderCarrierPayload): Promise<{
    quoteReference: string;
    service: string;
    amount: string;
    currency: string;
    estimatedDeliveryAt: string;
  }>;
  createShipment(
    input: CustomerOrderCarrierPayload & {
      attempt: number;
      idempotencyKey: string;
    },
  ): Promise<CustomerOrderDispatchResult>;
  cancel(input: {
    trackingReference: string;
    scenario: 'SUCCESS' | 'TIMEOUT';
    idempotencyKey: string;
  }): Promise<
    { status: 'CANCELLED' } | { status: 'FAILED_RETRYABLE'; errorCode: string }
  >;
  track(input: {
    trackingReference: string;
    currentSequence: number;
    scenario: 'IN_TRANSIT' | 'OUT_FOR_DELIVERY' | 'DELIVERED' | 'TIMEOUT';
    idempotencyKey: string;
  }): Promise<
    | { status: 'SUCCEEDED'; event: CarrierTrackingEvent }
    | { status: 'FAILED_RETRYABLE'; errorCode: string }
  >;
}

@Injectable()
export class SimulatorCustomerOrderCarrierAdapter implements CustomerOrderCarrierAdapter {
  readonly provider = 'SIMULATOR' as const;
  readonly version = '1' as const;

  quote(input: CustomerOrderCarrierPayload) {
    const quantity = input.parcels.reduce(
      (total, parcel) => total + Number(parcel.quantity),
      0,
    );
    return Promise.resolve({
      quoteReference: `QUOTE-${input.orderNumber}`,
      service: 'SIMULATED_STANDARD',
      amount: (75 + quantity * 5).toFixed(2),
      currency: input.currency,
      estimatedDeliveryAt: input.windowEnd,
    });
  }

  createShipment(
    input: CustomerOrderCarrierPayload & {
      attempt: number;
      idempotencyKey: string;
    },
  ): Promise<CustomerOrderDispatchResult> {
    if (input.carrierCode === 'SIMULATED_RETRY' && input.attempt === 1) {
      return Promise.resolve({
        status: 'FAILED_RETRYABLE',
        errorCode: 'SIMULATED_CARRIER_TIMEOUT',
      });
    }
    const trackingReference = `SIM-${input.orderNumber}-${input.attempt}`;
    return Promise.resolve({
      status: 'SUCCEEDED',
      trackingReference,
      trackingStatus: 'LABEL_READY',
      label: {
        format: 'ZPL',
        payload: `^XA^FO40,40^FD${input.orderNumber}^FS^FO40,80^FD${trackingReference}^FS^XZ`,
      },
    });
  }

  cancel(input: {
    trackingReference: string;
    scenario: 'SUCCESS' | 'TIMEOUT';
    idempotencyKey: string;
  }) {
    return Promise.resolve(
      input.scenario === 'TIMEOUT'
        ? {
            status: 'FAILED_RETRYABLE' as const,
            errorCode: 'SIMULATED_CARRIER_CANCEL_TIMEOUT',
          }
        : { status: 'CANCELLED' as const },
    );
  }

  track(input: {
    trackingReference: string;
    currentSequence: number;
    scenario: 'IN_TRANSIT' | 'OUT_FOR_DELIVERY' | 'DELIVERED' | 'TIMEOUT';
    idempotencyKey: string;
  }) {
    if (input.scenario === 'TIMEOUT') {
      return Promise.resolve({
        status: 'FAILED_RETRYABLE' as const,
        errorCode: 'SIMULATED_CARRIER_TRACKING_TIMEOUT',
      });
    }
    const sequence = input.currentSequence + 1;
    return Promise.resolve({
      status: 'SUCCEEDED' as const,
      event: {
        providerEventId: `POLL-${input.trackingReference}-${sequence}`,
        trackingReference: input.trackingReference,
        status: input.scenario,
        sequence,
        occurredAt: new Date().toISOString(),
      },
    });
  }
}
