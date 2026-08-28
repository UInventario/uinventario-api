import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { createHash } from 'node:crypto';
import { CreateSaleReturnDto } from './dto/create-sale-return.dto';
import {
  CreateSaleReturnSettlementDto,
  SaleReturnSettlementModeDto,
} from './dto/create-sale-return-settlement.dto';
import { CashRegisterShiftService } from './cash-register-shift.service';
import { PosIdempotencyConflictError } from './pos.errors';
import { SaleReturnRepository } from './sale-return.repository';
import { SaleReturnSettlementRepository } from './sale-return-settlement.repository';
import {
  SaleReturnExchangeError,
  SaleReturnNotAllowedError,
  SaleReturnQuantityError,
  SaleReturnSerialError,
  SaleReturnSettlementAmountError,
  SaleReturnSettlementCashError,
  SaleReturnSettlementCustomerError,
  SaleReturnSettlementPaymentError,
  SaleReturnSettlementShiftError,
} from './sale-return.types';

@Injectable()
export class SaleReturnService {
  constructor(
    private readonly returns: SaleReturnRepository,
    private readonly settlements: SaleReturnSettlementRepository,
    private readonly shifts: CashRegisterShiftService,
  ) {}

  async list(tenantId: string, branchId: string, saleId: string) {
    const returns = await this.returns.listBySale(tenantId, branchId, saleId);
    if (!returns) throw new NotFoundException();
    return { data: returns, meta: { apiVersion: '1' as const } };
  }

  async create(input: {
    tenantId: string;
    branchId: string;
    userId: string;
    saleId: string;
    idempotencyKey: string | undefined;
    correlationId: string;
    dto: CreateSaleReturnDto;
  }) {
    if (
      !input.idempotencyKey ||
      !/^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/.test(input.idempotencyKey)
    ) {
      throw new BadRequestException({
        code: 'INVALID_IDEMPOTENCY_KEY',
        message: 'Se requiere una clave de idempotencia válida.',
      });
    }
    const fingerprint = createHash('sha256')
      .update(
        JSON.stringify({
          saleId: input.saleId,
          reason: input.dto.reason.trim(),
          exchangeSaleId: input.dto.exchangeSaleId ?? null,
          lines: [...input.dto.lines]
            .map((line) => ({
              saleLineId: line.saleLineId,
              quantity: line.quantity,
              condition: line.condition,
              serialNumbers: [...(line.serialNumbers ?? [])]
                .map((value) => value.trim().toUpperCase())
                .sort(),
            }))
            .sort((left, right) =>
              left.saleLineId.localeCompare(right.saleLineId),
            ),
        }),
      )
      .digest('hex');
    try {
      const result = await this.returns.create({
        ...input,
        idempotencyKey: input.idempotencyKey,
        fingerprint,
      });
      if (!result) throw new NotFoundException();
      return {
        data: result.saleReturn,
        meta: { apiVersion: '1' as const, idempotentReplay: result.replay },
      };
    } catch (error) {
      if (error instanceof PosIdempotencyConflictError) {
        throw new ConflictException({
          code: 'IDEMPOTENCY_KEY_REUSED',
          message: 'La clave de idempotencia ya fue usada con otros datos.',
        });
      }
      if (error instanceof SaleReturnQuantityError) {
        throw new ConflictException({
          code: 'SALE_RETURN_QUANTITY_EXCEEDED',
          message:
            'La cantidad supera lo vendido menos las devoluciones anteriores.',
        });
      }
      if (error instanceof SaleReturnNotAllowedError) {
        throw new ConflictException({
          code: 'SALE_RETURN_NOT_ALLOWED',
          message: 'Sólo se admiten devoluciones de ventas completadas.',
        });
      }
      if (error instanceof SaleReturnExchangeError) {
        throw new ConflictException({
          code: 'SALE_RETURN_EXCHANGE_INVALID',
          message:
            'La venta de cambio debe estar completada, pertenecer a esta sucursal y no estar enlazada.',
        });
      }
      if (error instanceof SaleReturnSerialError) {
        throw new BadRequestException({
          code: 'SALE_RETURN_SERIALS_INVALID',
          message:
            'Los números de serie deben corresponder a las unidades vendidas que se devuelven.',
        });
      }
      throw error;
    }
  }

  async settle(input: {
    tenantId: string;
    branchId: string;
    cashRegisterId: string;
    userId: string;
    saleId: string;
    returnId: string;
    idempotencyKey: string | undefined;
    correlationId: string;
    dto: CreateSaleReturnSettlementDto;
  }) {
    if (
      !input.idempotencyKey ||
      !/^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/.test(input.idempotencyKey)
    ) {
      throw new BadRequestException({
        code: 'INVALID_IDEMPOTENCY_KEY',
        message: 'Se requiere una clave de idempotencia vÃ¡lida.',
      });
    }
    const fingerprint = createHash('sha256')
      .update(
        JSON.stringify({
          saleId: input.saleId,
          returnId: input.returnId,
          mode: input.dto.mode,
          amount: this.money(input.dto.amount),
          originalPaymentId: input.dto.originalPaymentId ?? null,
        }),
      )
      .digest('hex');
    const shift =
      input.dto.mode === SaleReturnSettlementModeDto.REFUND
        ? await this.shifts.current({
            tenantId: input.tenantId,
            branchId: input.branchId,
            cashRegisterId: input.cashRegisterId,
            userId: input.userId,
          })
        : null;
    try {
      const result = await this.settlements.create({
        ...input,
        idempotencyKey: input.idempotencyKey,
        fingerprint,
        cashRegisterShiftId: shift?.data?.id ?? null,
      });
      if (!result) throw new NotFoundException();
      const saleReturn = await this.returns.getById(
        input.tenantId,
        input.branchId,
        input.saleId,
        input.returnId,
      );
      if (!saleReturn) throw new NotFoundException();
      return {
        data: { saleReturn, settlement: result.settlement },
        meta: { apiVersion: '1' as const, idempotentReplay: result.replay },
      };
    } catch (error) {
      if (error instanceof PosIdempotencyConflictError) {
        throw new ConflictException({
          code: 'IDEMPOTENCY_KEY_REUSED',
          message: 'La clave de idempotencia ya fue usada con otros datos.',
        });
      }
      if (error instanceof SaleReturnSettlementAmountError) {
        throw new ConflictException({
          code: 'SALE_RETURN_SETTLEMENT_EXCEEDS_BALANCE',
          message: 'El importe supera el saldo pendiente de la devoluciÃ³n.',
        });
      }
      if (error instanceof SaleReturnSettlementPaymentError) {
        throw new ConflictException({
          code: 'SALE_RETURN_PAYMENT_NOT_REFUNDABLE',
          message: 'El pago original no admite ese reembolso o no tiene saldo.',
        });
      }
      if (error instanceof SaleReturnSettlementCustomerError) {
        throw new ConflictException({
          code: 'SALE_RETURN_CUSTOMER_REQUIRED',
          message: 'La venta debe tener un cliente para emitir saldo a favor.',
        });
      }
      if (error instanceof SaleReturnSettlementCashError) {
        throw new ConflictException({
          code: 'INSUFFICIENT_EXPECTED_CASH',
          message:
            'La caja no tiene efectivo esperado suficiente para el reembolso.',
        });
      }
      if (error instanceof SaleReturnSettlementShiftError) {
        throw new ConflictException({
          code: 'CASH_REGISTER_SHIFT_REQUIRED',
          message:
            'Abre un turno en la caja activa antes de reembolsar efectivo.',
        });
      }
      throw error;
    }
  }

  private money(value: string): string {
    const [whole, fraction = ''] = value.split('.');
    return `${whole}.${fraction.padEnd(2, '0')}`;
  }
}
