import { Injectable } from '@nestjs/common';
import { createHash } from 'node:crypto';
import type {
  PaymentTerminalAdapterState,
  PaymentTerminalScenario,
} from './payment-terminal.types';

export const PAYMENT_TERMINAL_ADAPTER = Symbol('PAYMENT_TERMINAL_ADAPTER');

export interface PaymentTerminalAdapter {
  readonly provider: string;
  readonly version: string;
  initiate(input: {
    amount: string;
    currency: string;
    idempotencyKey: string;
    correlationId: string;
    scenario: PaymentTerminalScenario;
  }): Promise<PaymentTerminalAdapterState>;
  authorize(
    input: PaymentTerminalAdapterState & {
      scenario: PaymentTerminalScenario;
    },
  ): Promise<PaymentTerminalAdapterState>;
  capture(
    input: PaymentTerminalAdapterState & {
      scenario: PaymentTerminalScenario;
    },
  ): Promise<PaymentTerminalAdapterState>;
  cancel(
    input: PaymentTerminalAdapterState,
  ): Promise<PaymentTerminalAdapterState>;
  query(
    input: PaymentTerminalAdapterState & { scenario: PaymentTerminalScenario },
  ): Promise<PaymentTerminalAdapterState>;
  reconcile(
    operations: PaymentTerminalAdapterState[],
  ): Promise<PaymentTerminalAdapterState[]>;
}

@Injectable()
export class SimulatorPaymentTerminalAdapter implements PaymentTerminalAdapter {
  readonly provider = 'SIMULATOR';
  readonly version = '1';

  initiate(input: {
    amount: string;
    currency: string;
    idempotencyKey: string;
    correlationId: string;
    scenario: PaymentTerminalScenario;
  }): Promise<PaymentTerminalAdapterState> {
    const digest = createHash('sha256')
      .update(
        JSON.stringify({
          amount: input.amount,
          currency: input.currency,
          idempotencyKey: input.idempotencyKey,
        }),
      )
      .digest('hex')
      .slice(0, 20)
      .toUpperCase();
    return Promise.resolve({
      providerReference: `TERM-${digest}`,
      status: 'PENDING',
      authorizationCode: null,
      errorCode: null,
    });
  }

  authorize(
    input: PaymentTerminalAdapterState & { scenario: PaymentTerminalScenario },
  ): Promise<PaymentTerminalAdapterState> {
    if (input.scenario === 'REJECT') {
      return Promise.resolve({
        ...input,
        status: 'DECLINED',
        authorizationCode: null,
        errorCode: 'SIMULATED_DECLINE',
      });
    }
    return Promise.resolve({
      ...input,
      status: 'AUTHORIZED',
      authorizationCode: this.authorizationCode(input.providerReference),
      errorCode: null,
    });
  }

  capture(
    input: PaymentTerminalAdapterState & { scenario: PaymentTerminalScenario },
  ): Promise<PaymentTerminalAdapterState> {
    if (input.scenario === 'INDETERMINATE') {
      return Promise.resolve({
        ...input,
        status: 'INDETERMINATE',
        errorCode: 'TERMINAL_RESPONSE_PENDING',
      });
    }
    return Promise.resolve({ ...input, status: 'CAPTURED', errorCode: null });
  }

  cancel(
    input: PaymentTerminalAdapterState,
  ): Promise<PaymentTerminalAdapterState> {
    return Promise.resolve({ ...input, status: 'CANCELLED', errorCode: null });
  }

  query(
    input: PaymentTerminalAdapterState & { scenario: PaymentTerminalScenario },
  ): Promise<PaymentTerminalAdapterState> {
    if (input.status !== 'INDETERMINATE') return Promise.resolve(input);
    return Promise.resolve({
      ...input,
      status: 'CAPTURED',
      authorizationCode:
        input.authorizationCode ??
        this.authorizationCode(input.providerReference),
      errorCode: null,
    });
  }

  reconcile(
    operations: PaymentTerminalAdapterState[],
  ): Promise<PaymentTerminalAdapterState[]> {
    return Promise.all(
      operations.map(async (operation) =>
        operation.status === 'INDETERMINATE'
          ? await this.query({ ...operation, scenario: 'INDETERMINATE' })
          : operation,
      ),
    );
  }

  private authorizationCode(providerReference: string): string {
    return createHash('sha256')
      .update(providerReference)
      .digest('hex')
      .slice(0, 10)
      .toUpperCase();
  }
}
