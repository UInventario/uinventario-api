import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { createHash } from 'node:crypto';
import type { StartPaymentTerminalDto } from './dto/start-payment-terminal.dto';
import {
  PAYMENT_TERMINAL_ADAPTER,
  type PaymentTerminalAdapter,
} from './payment-terminal.adapter';
import { PaymentTerminalIdempotencyConflictError } from './payment-terminal.errors';
import { PaymentTerminalRepository } from './payment-terminal.repository';

@Injectable()
export class PaymentTerminalService {
  constructor(
    private readonly repository: PaymentTerminalRepository,
    @Inject(PAYMENT_TERMINAL_ADAPTER)
    private readonly adapter: PaymentTerminalAdapter,
  ) {}

  async start(input: {
    tenantId: string;
    branchId: string;
    cashRegisterId: string;
    userId: string;
    idempotencyKey: string | undefined;
    correlationId: string;
    dto: StartPaymentTerminalDto;
  }) {
    this.assertIdempotencyKey(input.idempotencyKey);
    const amount = this.money(input.dto.amount);
    const fingerprint = createHash('sha256')
      .update(
        JSON.stringify({
          branchId: input.branchId,
          cashRegisterId: input.cashRegisterId,
          amount,
          currency: input.dto.currency,
          scenario: input.dto.scenario,
        }),
      )
      .digest('hex');
    try {
      const pending = await this.repository.createPending({
        tenantId: input.tenantId,
        branchId: input.branchId,
        cashRegisterId: input.cashRegisterId,
        userId: input.userId,
        provider: this.adapter.provider,
        adapterVersion: this.adapter.version,
        amount,
        currency: input.dto.currency,
        scenario: input.dto.scenario,
        idempotencyKey: input.idempotencyKey!,
        fingerprint,
        correlationId: input.correlationId,
      });
      if (pending.operation.status !== 'PENDING') {
        return {
          data: pending.operation,
          meta: { apiVersion: '1' as const, idempotentReplay: true },
        };
      }
      let state;
      try {
        state = await this.adapter.initiate({
          amount,
          currency: input.dto.currency,
          idempotencyKey: input.idempotencyKey!,
          correlationId: input.correlationId,
          scenario: input.dto.scenario,
        });
        state = await this.adapter.authorize({
          ...state,
          scenario: input.dto.scenario,
        });
        if (state.status === 'AUTHORIZED') {
          state = await this.adapter.capture({
            ...state,
            scenario: input.dto.scenario,
          });
        }
      } catch {
        state = {
          providerReference:
            pending.operation.providerReference ??
            `PENDING-${pending.operation.id}`,
          status: 'INDETERMINATE' as const,
          authorizationCode: pending.operation.authorizationCode,
          errorCode: 'TERMINAL_TIMEOUT',
        };
      }
      const operation = await this.repository.updateState(
        input.tenantId,
        pending.operation.id,
        state,
      );
      return {
        data: operation,
        meta: {
          apiVersion: '1' as const,
          idempotentReplay: pending.replay,
        },
      };
    } catch (error) {
      if (error instanceof PaymentTerminalIdempotencyConflictError) {
        throw new ConflictException({
          code: 'PAYMENT_TERMINAL_IDEMPOTENCY_CONFLICT',
          message: 'La clave del terminal ya fue usada con otros datos.',
        });
      }
      throw error;
    }
  }

  async get(tenantId: string, operationId: string) {
    const found = await this.repository.findDetails(tenantId, operationId);
    if (!found)
      throw new NotFoundException({ code: 'PAYMENT_TERMINAL_NOT_FOUND' });
    let operation = found.operation;
    if (operation.status === 'INDETERMINATE' && !operation.saleId) {
      const state = await this.adapter.query({
        ...found.state,
        scenario: found.scenario,
      });
      operation = await this.repository.updateState(
        tenantId,
        operationId,
        state,
        true,
      );
    }
    return { data: operation, meta: { apiVersion: '1' as const } };
  }

  async cancel(tenantId: string, operationId: string) {
    const found = await this.repository.findDetails(tenantId, operationId);
    if (!found)
      throw new NotFoundException({ code: 'PAYMENT_TERMINAL_NOT_FOUND' });
    if (found.operation.status === 'CANCELLED') {
      return {
        data: found.operation,
        meta: { apiVersion: '1' as const, idempotentReplay: true },
      };
    }
    if (found.operation.saleId || found.operation.status === 'DECLINED') {
      throw new ConflictException({ code: 'PAYMENT_TERMINAL_CANNOT_CANCEL' });
    }
    const state = await this.adapter.cancel(found.state);
    return {
      data: await this.repository.updateState(tenantId, operationId, state),
      meta: { apiVersion: '1' as const, idempotentReplay: false },
    };
  }

  async reconcile(tenantId: string, branchId: string) {
    const local = await this.repository.listForReconciliation(
      tenantId,
      branchId,
    );
    const providerStates = await this.adapter.reconcile(
      local.map(({ state }) => state),
    );
    const items = [];
    for (let index = 0; index < local.length; index++) {
      const current = local[index];
      const provider = providerStates[index];
      let operation = current.operation;
      if (
        provider &&
        !operation.saleId &&
        (provider.status !== current.state.status ||
          provider.errorCode !== current.state.errorCode)
      ) {
        operation = await this.repository.updateState(
          tenantId,
          operation.id,
          provider,
          true,
        );
      }
      items.push(operation);
    }
    return {
      data: items,
      meta: {
        apiVersion: '1' as const,
        totals: {
          operations: items.length,
          captured: items.filter((item) => item.status === 'CAPTURED').length,
          pending: items.filter((item) =>
            ['PENDING', 'AUTHORIZED', 'INDETERMINATE'].includes(item.status),
          ).length,
          matchedSales: items.filter((item) => Boolean(item.saleId)).length,
        },
      },
    };
  }

  private assertIdempotencyKey(value: string | undefined): void {
    if (!value || !/^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/.test(value)) {
      throw new BadRequestException({ code: 'INVALID_IDEMPOTENCY_KEY' });
    }
  }

  private money(value: string): string {
    const [whole, fraction = ''] = value.split('.');
    return `${BigInt(whole)}.${fraction.padEnd(2, '0')}`;
  }
}
