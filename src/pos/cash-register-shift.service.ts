import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  CashRegisterShiftConflictError,
  CashRegisterShiftContextError,
  CashRegisterShiftIdempotencyConflictError,
} from './cash-register-shift.errors';
import { CashRegisterShiftRepository } from './cash-register-shift.repository';
import type {
  CashRegisterShiftData,
  CashRegisterShiftResponse,
} from './cash-register-shift.types';

interface ShiftContext {
  tenantId: string;
  branchId: string;
  cashRegisterId: string;
  userId: string;
}

@Injectable()
export class CashRegisterShiftService {
  constructor(private readonly shifts: CashRegisterShiftRepository) {}

  async current(context: ShiftContext) {
    return {
      data: await this.shifts.current(context),
      meta: { apiVersion: '1' as const },
    };
  }

  async requireCurrent(context: ShiftContext): Promise<CashRegisterShiftData> {
    const shift = await this.shifts.current(context);
    if (!shift) {
      throw new ConflictException({
        code: 'CASH_REGISTER_SHIFT_REQUIRED',
        message: 'Abre un turno en la caja activa antes de operar el POS.',
      });
    }
    return shift;
  }

  async open(
    context: ShiftContext,
    openingAmount: string,
    idempotencyKey: string | undefined,
  ): Promise<CashRegisterShiftResponse> {
    this.assertIdempotencyKey(idempotencyKey);
    try {
      const result = await this.shifts.open({
        ...context,
        openingAmount: this.money(openingAmount),
        idempotencyKey: idempotencyKey!,
      });
      return {
        data: result.shift,
        meta: { apiVersion: '1', idempotentReplay: result.replay },
      };
    } catch (error) {
      if (error instanceof CashRegisterShiftContextError)
        throw new NotFoundException();
      if (error instanceof CashRegisterShiftIdempotencyConflictError) {
        throw new ConflictException({
          code: 'IDEMPOTENCY_KEY_REUSED',
          message: 'La clave de idempotencia ya fue usada con otros datos.',
        });
      }
      if (error instanceof CashRegisterShiftConflictError) {
        throw new ConflictException({
          code: 'CASH_REGISTER_ALREADY_OPEN',
          message: 'La caja o el usuario ya tienen un turno abierto.',
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
}
