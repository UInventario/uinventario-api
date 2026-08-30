import { Injectable } from '@nestjs/common';
import { createHash } from 'node:crypto';
import type { PspAdapterState, PspPaymentData } from './psp-payment.types';

export interface VersionedPspAdapter {
  readonly provider: 'SIMULATOR';
  readonly version: '1';
  intent(input: {
    tenantId: string;
    merchantReference: string;
    amount: string;
    currency: string;
  }): { providerReference: string };
  confirm(payment: PspPaymentData): PspAdapterState;
  capture(payment: PspPaymentData): PspAdapterState;
  query(payment: PspPaymentData): PspAdapterState;
  refund(payment: PspPaymentData, amount: string): PspAdapterState;
}

@Injectable()
export class SimulatedPspAdapter implements VersionedPspAdapter {
  readonly provider = 'SIMULATOR' as const;
  readonly version = '1' as const;

  intent(input: {
    tenantId: string;
    merchantReference: string;
    amount: string;
    currency: string;
  }) {
    const digest = createHash('sha256')
      .update(JSON.stringify(input))
      .digest('hex')
      .slice(0, 24)
      .toUpperCase();
    return { providerReference: `PSP-${digest}` };
  }

  confirm(payment: PspPaymentData): PspAdapterState {
    return payment.scenario === 'DECLINE'
      ? { status: 'DECLINED', errorCode: 'SIMULATED_DECLINE' }
      : { status: 'AUTHORIZED', errorCode: null };
  }

  capture(payment: PspPaymentData): PspAdapterState {
    return payment.scenario === 'TIMEOUT'
      ? { status: 'INDETERMINATE', errorCode: 'SIMULATED_CAPTURE_TIMEOUT' }
      : { status: 'CAPTURED', errorCode: null };
  }

  query(payment: PspPaymentData): PspAdapterState {
    return payment.status === 'INDETERMINATE'
      ? { status: 'CAPTURED', errorCode: null }
      : { status: payment.status, errorCode: payment.errorCode };
  }

  refund(payment: PspPaymentData, amount: string): PspAdapterState {
    void amount;
    return { status: payment.status, errorCode: null };
  }
}
