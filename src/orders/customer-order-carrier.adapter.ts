import { Injectable } from '@nestjs/common';

export const CUSTOMER_ORDER_CARRIER_ADAPTER = Symbol(
  'CUSTOMER_ORDER_CARRIER_ADAPTER',
);

export type CustomerOrderDispatchResult =
  | { status: 'SUCCEEDED'; trackingReference: string }
  | { status: 'FAILED_RETRYABLE'; errorCode: string };

export interface CustomerOrderCarrierAdapter {
  dispatch(input: {
    carrierCode: 'SIMULATED' | 'SIMULATED_RETRY';
    orderNumber: string;
    attempt: number;
    windowStart: string;
    windowEnd: string;
  }): Promise<CustomerOrderDispatchResult>;
}

@Injectable()
export class SimulatorCustomerOrderCarrierAdapter implements CustomerOrderCarrierAdapter {
  dispatch(input: {
    carrierCode: 'SIMULATED' | 'SIMULATED_RETRY';
    orderNumber: string;
    attempt: number;
  }): Promise<CustomerOrderDispatchResult> {
    if (input.carrierCode === 'SIMULATED_RETRY' && input.attempt === 1) {
      return Promise.resolve({
        status: 'FAILED_RETRYABLE',
        errorCode: 'SIMULATED_CARRIER_UNAVAILABLE',
      });
    }
    return Promise.resolve({
      status: 'SUCCEEDED',
      trackingReference: `SIM-${input.orderNumber}-${input.attempt}`,
    });
  }
}
