import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { createHash } from 'node:crypto';
import { CustomerRepository } from '../customers/customer.repository';
import {
  CustomerCreditPaymentAllocationError,
  CustomerCreditPaymentAlreadyReversedError,
  CustomerCreditPaymentAmountError,
  CustomerCreditPaymentCashError,
  CustomerCreditPaymentCurrencyError,
  CustomerCreditPaymentNotFoundError,
  CustomerCreditPaymentRefundError,
  CustomerCreditPaymentShiftError,
} from './customer-credit-payment.errors';
import { CustomerCreditPaymentRepository } from './customer-credit-payment.repository';
import {
  CreateCustomerCreditPaymentDto,
  ReverseCustomerCreditPaymentDto,
} from './dto/create-customer-credit-payment.dto';
import {
  PaymentDeclinedError,
  PaymentMethodUnavailableError,
} from './payment-authorization.service';
import { PosIdempotencyConflictError } from './pos.errors';

interface CreditPaymentContext {
  tenantId: string;
  branchId: string;
  cashRegisterId: string;
  userId: string;
  customerId: string;
  idempotencyKey: string | undefined;
  correlationId: string;
}

@Injectable()
export class CustomerCreditPaymentService {
  constructor(
    private readonly payments: CustomerCreditPaymentRepository,
    private readonly customers: CustomerRepository,
  ) {}

  async create(
    input: CreditPaymentContext & { dto: CreateCustomerCreditPaymentDto },
  ) {
    this.assertIdempotencyKey(input.idempotencyKey);
    if (
      (input.dto.method === 'CASH' && input.dto.reference) ||
      (input.dto.method !== 'CASH' && !input.dto.reference)
    ) {
      throw new BadRequestException({
        code: 'CREDIT_PAYMENT_REFERENCE_INVALID',
        message:
          'La referencia es obligatoria para tarjeta o transferencia y no aplica a efectivo.',
      });
    }
    const fingerprint = createHash('sha256')
      .update(
        JSON.stringify({
          customerId: input.customerId,
          amount: this.money(input.dto.amount),
          method: input.dto.method,
          reference: input.dto.reference ?? null,
        }),
      )
      .digest('hex');
    try {
      const result = await this.payments.create({
        ...input,
        idempotencyKey: input.idempotencyKey!,
        fingerprint,
      });
      return {
        data: {
          payment: result.payment,
          credit: await this.customers.creditStatement(
            input.tenantId,
            input.customerId,
          ),
        },
        meta: { apiVersion: '1' as const, idempotentReplay: result.replay },
      };
    } catch (error) {
      this.mapError(error, false);
    }
  }

  async reverse(
    input: CreditPaymentContext & {
      paymentId: string;
      dto: ReverseCustomerCreditPaymentDto;
    },
  ) {
    this.assertIdempotencyKey(input.idempotencyKey);
    const fingerprint = createHash('sha256')
      .update(
        JSON.stringify({
          customerId: input.customerId,
          paymentId: input.paymentId,
          reason: input.dto.reason.trim(),
        }),
      )
      .digest('hex');
    try {
      const result = await this.payments.reverse({
        ...input,
        idempotencyKey: input.idempotencyKey!,
        fingerprint,
      });
      return {
        data: {
          payment: result.payment,
          credit: await this.customers.creditStatement(
            input.tenantId,
            input.customerId,
          ),
        },
        meta: { apiVersion: '1' as const, idempotentReplay: result.replay },
      };
    } catch (error) {
      this.mapError(error, true);
    }
  }

  private assertIdempotencyKey(value: string | undefined): void {
    if (!value || !/^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/.test(value)) {
      throw new BadRequestException({
        code: 'INVALID_IDEMPOTENCY_KEY',
        message:
          'Idempotency-Key es obligatorio y debe tener entre 8 y 128 caracteres.',
      });
    }
  }

  private mapError(error: unknown, reversal: boolean): never {
    if (error instanceof CustomerCreditPaymentNotFoundError)
      throw new NotFoundException();
    if (error instanceof PosIdempotencyConflictError)
      throw new ConflictException({
        code: 'IDEMPOTENCY_KEY_REUSED',
        message: 'La clave de idempotencia ya fue usada con otros datos.',
      });
    if (error instanceof CustomerCreditPaymentAmountError)
      throw new ConflictException({
        code: 'CREDIT_PAYMENT_EXCEEDS_BALANCE',
        message:
          'El abono debe ser positivo y no superar el saldo de la deuda.',
      });
    if (error instanceof CustomerCreditPaymentShiftError)
      throw new ConflictException({
        code: 'CASH_REGISTER_SHIFT_REQUIRED',
        message: 'Abre un turno en la caja activa antes de registrar el abono.',
      });
    if (error instanceof CustomerCreditPaymentCurrencyError)
      throw new ConflictException({
        code: 'CREDIT_PAYMENT_CURRENCY_MISMATCH',
        message: 'La moneda de la deuda no coincide con la del turno de caja.',
      });
    if (error instanceof CustomerCreditPaymentAlreadyReversedError)
      throw new ConflictException({
        code: 'CREDIT_PAYMENT_ALREADY_REVERSED',
        message: 'El abono ya fue reversado.',
      });
    if (error instanceof CustomerCreditPaymentCashError)
      throw new ConflictException({
        code: 'INSUFFICIENT_EXPECTED_CASH',
        message: 'La caja actual no tiene efectivo esperado para la reversa.',
      });
    if (error instanceof CustomerCreditPaymentRefundError)
      throw new ConflictException({
        code: 'CREDIT_PAYMENT_REFUND_FAILED',
        message:
          'El proveedor no confirmó la reversa; la deuda no fue modificada.',
      });
    if (error instanceof CustomerCreditPaymentAllocationError)
      throw new ConflictException({
        code: 'CREDIT_PAYMENT_ALLOCATION_CONFLICT',
        message:
          'La deuda cambió durante el abono; vuelve a consultar el saldo.',
      });
    if (error instanceof PaymentMethodUnavailableError)
      throw new BadRequestException({
        code: 'PAYMENT_METHOD_UNAVAILABLE',
        message: 'El medio de pago no está habilitado en este ambiente.',
      });
    if (error instanceof PaymentDeclinedError)
      throw new ConflictException({
        code: 'PAYMENT_DECLINED',
        message: reversal
          ? 'La reversa fue rechazada; la deuda no fue modificada.'
          : 'La autorización fue rechazada; el abono no fue registrado.',
      });
    throw error;
  }

  private money(value: string): string {
    const [whole, fraction = ''] = value.split('.');
    return `${whole}.${fraction.padEnd(2, '0').slice(0, 2)}`;
  }
}
