import { Inject, Injectable } from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import { createHash } from 'node:crypto';
import { posConfig } from '../config/pos.config';
import type { PaymentMethod } from './dto/create-sale.dto';

export interface PaymentRefundResult {
  status: 'COMPLETED' | 'FAILED';
  provider: string;
  providerReference: string | null;
  failureCode: string | null;
}

@Injectable()
export class PaymentRefundService {
  constructor(
    @Inject(posConfig.KEY)
    private readonly config: ConfigType<typeof posConfig>,
  ) {}

  refund(input: {
    method: PaymentMethod;
    originalExternalReference: string | null;
    originalProviderReference: string | null;
    amount: string;
    currency: string;
    idempotencyKey: string;
  }): PaymentRefundResult {
    if (input.method === 'CASH') {
      return {
        status: 'COMPLETED',
        provider: 'CASH',
        providerReference: null,
        failureCode: null,
      };
    }
    if (this.config.nonCashProvider !== 'SIMULATOR') {
      return {
        status: 'FAILED',
        provider: this.config.nonCashProvider,
        providerReference: null,
        failureCode: 'REFUND_PROVIDER_UNAVAILABLE',
      };
    }
    if (
      input.originalExternalReference?.toUpperCase().startsWith('FAIL-REFUND')
    ) {
      return {
        status: 'FAILED',
        provider: 'SIMULATOR',
        providerReference: null,
        failureCode: 'SIMULATED_REFUND_FAILURE',
      };
    }
    const digest = createHash('sha256')
      .update(
        JSON.stringify({
          originalProviderReference: input.originalProviderReference,
          amount: input.amount,
          currency: input.currency,
          idempotencyKey: input.idempotencyKey,
        }),
      )
      .digest('hex')
      .slice(0, 20)
      .toUpperCase();
    return {
      status: 'COMPLETED',
      provider: 'SIMULATOR',
      providerReference: `SIM-REF-${digest}`,
      failureCode: null,
    };
  }
}
