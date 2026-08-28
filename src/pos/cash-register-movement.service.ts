import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  CashRegisterMovementAlreadyReversedError,
  CashRegisterMovementIdempotencyConflictError,
  CashRegisterMovementInsufficientBalanceError,
  CashRegisterMovementNotFoundError,
} from './cash-register-movement.errors';
import { CashRegisterMovementRepository } from './cash-register-movement.repository';
import { CashRegisterShiftService } from './cash-register-shift.service';
import type { CreateCashRegisterMovementDto } from './dto/create-cash-register-movement.dto';

interface CashContext {
  tenantId: string;
  branchId: string;
  cashRegisterId: string;
  userId: string;
}

@Injectable()
export class CashRegisterMovementService {
  constructor(
    private readonly movements: CashRegisterMovementRepository,
    private readonly shifts: CashRegisterShiftService,
  ) {}

  async list(context: CashContext) {
    const shift = await this.shifts.requireCurrent(context);
    const result = await this.movements.list({ ...context, shiftId: shift.id });
    return {
      data: result.movements,
      meta: {
        apiVersion: '1' as const,
        shiftId: shift.id,
        currency: shift.currency,
        expectedCash: result.expectedCash,
      },
    };
  }

  async create(
    context: CashContext,
    dto: CreateCashRegisterMovementDto,
    idempotencyKey: string | undefined,
  ) {
    this.assertIdempotencyKey(idempotencyKey);
    const shift = await this.shifts.requireCurrent(context);
    return this.execute(() =>
      this.movements.create({
        ...context,
        shiftId: shift.id,
        type: dto.type,
        amount: this.money(dto.amount),
        reason: dto.reason.trim(),
        idempotencyKey: idempotencyKey!,
      }),
    );
  }

  async reverse(
    context: CashContext,
    movementId: string,
    reason: string,
    idempotencyKey: string | undefined,
  ) {
    this.assertIdempotencyKey(idempotencyKey);
    const shift = await this.shifts.requireCurrent(context);
    return this.execute(() =>
      this.movements.reverse({
        ...context,
        shiftId: shift.id,
        movementId,
        reason: reason.trim(),
        idempotencyKey: idempotencyKey!,
      }),
    );
  }

  private async execute(
    operation: () => ReturnType<CashRegisterMovementRepository['create']>,
  ) {
    try {
      const result = await operation();
      return {
        data: result.movement,
        meta: {
          apiVersion: '1' as const,
          expectedCash: result.expectedCash,
          idempotentReplay: result.replay,
        },
      };
    } catch (error) {
      if (error instanceof CashRegisterMovementNotFoundError)
        throw new NotFoundException();
      if (error instanceof CashRegisterMovementAlreadyReversedError) {
        throw new ConflictException({
          code: 'CASH_REGISTER_MOVEMENT_ALREADY_REVERSED',
          message: 'El movimiento ya fue reversado.',
        });
      }
      if (error instanceof CashRegisterMovementInsufficientBalanceError) {
        throw new ConflictException({
          code: 'INSUFFICIENT_EXPECTED_CASH',
          message: 'El movimiento dejaría un saldo esperado negativo.',
        });
      }
      if (error instanceof CashRegisterMovementIdempotencyConflictError) {
        throw new ConflictException({
          code: 'IDEMPOTENCY_KEY_REUSED',
          message: 'La clave de idempotencia ya fue usada con otros datos.',
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
