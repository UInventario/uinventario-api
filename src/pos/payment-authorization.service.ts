import { Inject, Injectable } from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import { createHash } from 'node:crypto';
import { posConfig } from '../config/pos.config';
import type { PaymentMethod } from './dto/create-sale.dto';

export class PaymentMethodUnavailableError extends Error {}
export class PaymentDeclinedError extends Error {}

export interface PaymentAuthorization {
  provider: string;
  providerReference: string | null;
  authorizationCode: string | null;
}

@Injectable()
export class PaymentAuthorizationService {
  constructor(
    @Inject(posConfig.KEY)
    private readonly config: ConfigType<typeof posConfig>,
  ) {}

  enabledMethods(): PaymentMethod[] {
    return this.config.paymentMethods;
  }

  authorize(input: {
    method: PaymentMethod;
    reference?: string;
    amount: string;
    currency: string;
    idempotencyKey: string;
  }): PaymentAuthorization {
    if (!this.config.paymentMethods.includes(input.method)) {
      throw new PaymentMethodUnavailableError();
    }
    if (input.method === 'CASH') {
      return {
        provider: 'CASH',
        providerReference: null,
        authorizationCode: null,
      };
    }
    if (this.config.nonCashProvider !== 'SIMULATOR') {
      throw new PaymentMethodUnavailableError();
    }
    if (
      !input.reference ||
      input.reference.toUpperCase().startsWith('DECLINE')
    ) {
      throw new PaymentDeclinedError();
    }
    const digest = createHash('sha256')
      .update(
        JSON.stringify({
          method: input.method,
          reference: input.reference,
          amount: input.amount,
          currency: input.currency,
          idempotencyKey: input.idempotencyKey,
        }),
      )
      .digest('hex')
      .slice(0, 16)
      .toUpperCase();
    return {
      provider: 'SIMULATOR',
      providerReference: `SIM-${digest}`,
      authorizationCode: digest.slice(0, 8),
    };
  }
}
