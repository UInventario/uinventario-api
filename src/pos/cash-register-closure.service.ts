import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  CashRegisterAlreadyClosedError,
  CashRegisterClosureIdempotencyConflictError,
  CashRegisterClosureNotFoundError,
  CashRegisterClosureReasonRequiredError,
} from './cash-register-closure.errors';
import { CashRegisterClosureRepository } from './cash-register-closure.repository';
import type { CloseCashRegisterShiftDto } from './dto/close-cash-register-shift.dto';

interface ClosureContext {
  tenantId: string;
  branchId: string;
  cashRegisterId: string;
  userId: string;
}

@Injectable()
export class CashRegisterClosureService {
  constructor(private readonly closures: CashRegisterClosureRepository) {}

  async latest(context: ClosureContext) {
    return {
      data: await this.closures.latest(context),
      meta: { apiVersion: '1' as const },
    };
  }

  async close(
    context: ClosureContext,
    dto: CloseCashRegisterShiftDto,
    idempotencyKey: string | undefined,
  ) {
    this.assertIdempotencyKey(idempotencyKey);
    const countedAmount = this.money(dto.countedAmount);
    const denominations = (dto.denominations ?? []).map(
      ({ denomination, quantity }) => ({
        denomination: this.money(denomination),
        quantity,
      }),
    );
    if (denominations.length > 0) {
      const denominationTotal = denominations.reduce(
        (total, item) =>
          total + this.cents(item.denomination) * BigInt(item.quantity),
        0n,
      );
      if (denominationTotal !== this.cents(countedAmount)) {
        throw new BadRequestException({
          code: 'DENOMINATION_TOTAL_MISMATCH',
          message: 'Las denominaciones no coinciden con el efectivo contado.',
        });
      }
    }
    try {
      const result = await this.closures.close({
        ...context,
        countedAmount,
        differenceReason: dto.differenceReason?.trim() || null,
        denominations,
        idempotencyKey: idempotencyKey!,
      });
      return {
        data: result.closure,
        meta: { apiVersion: '1' as const, idempotentReplay: result.replay },
      };
    } catch (error) {
      if (error instanceof CashRegisterClosureNotFoundError)
        throw new NotFoundException();
      if (error instanceof CashRegisterAlreadyClosedError) {
        throw new ConflictException({
          code: 'CASH_REGISTER_ALREADY_CLOSED',
          message: 'El turno ya fue cerrado.',
        });
      }
      if (error instanceof CashRegisterClosureReasonRequiredError) {
        throw new BadRequestException({
          code: 'CASH_DIFFERENCE_REASON_REQUIRED',
          message:
            'Explica la diferencia entre el efectivo esperado y contado.',
        });
      }
      if (error instanceof CashRegisterClosureIdempotencyConflictError) {
        throw new ConflictException({
          code: 'IDEMPOTENCY_KEY_REUSED',
          message: 'La clave de idempotencia ya fue usada con otro arqueo.',
        });
      }
      throw error;
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

  private money(value: string): string {
    const [whole, fraction = ''] = value.split('.');
    return `${whole}.${fraction.padEnd(2, '0')}`;
  }

  private cents(value: string): bigint {
    const [whole, fraction = ''] = value.split('.');
    return BigInt(whole) * 100n + BigInt(fraction.padEnd(2, '0'));
  }
}
