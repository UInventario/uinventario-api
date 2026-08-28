import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { AuditService } from '../audit/audit.service';
import { UpdatePosPeripheralProfileDto } from './dto/update-pos-peripheral-profile.dto';
import { PosPeripheralRepository } from './pos-peripheral.repository';
import { SaleReceiptRepository } from './sale-receipt.repository';

interface PeripheralContext {
  tenantId: string;
  branchId: string;
  cashRegisterId: string;
  userId: string;
  correlationId: string;
}

@Injectable()
export class PosPeripheralService {
  constructor(
    private readonly peripherals: PosPeripheralRepository,
    private readonly receipts: SaleReceiptRepository,
    private readonly audit: AuditService,
  ) {}

  async getProfile(context: PeripheralContext) {
    const data = await this.peripherals.getProfile(context);
    return { data, meta: { apiVersion: '1' as const } };
  }

  async updateProfile(
    context: PeripheralContext,
    dto: UpdatePosPeripheralProfileDto,
  ) {
    const data = await this.peripherals.updateProfile({ ...context, ...dto });
    await this.audit.recordRequired({
      tenantId: context.tenantId,
      actorUserId: context.userId,
      action: 'POS_PERIPHERAL_PROFILE_UPDATED',
      entityType: 'CASH_REGISTER',
      entityId: context.cashRegisterId,
      correlationId: context.correlationId,
      after: {
        deviceId: data.deviceId,
        adapter: data.adapter,
        printerEnabled: data.printerEnabled,
        drawerEnabled: data.drawerEnabled,
        autoOpenCashSale: data.autoOpenCashSale,
      },
    });
    return { data, meta: { apiVersion: '1' as const } };
  }

  async printReceipt(
    context: PeripheralContext,
    saleId: string,
    idempotencyKey: string | undefined,
  ) {
    const key = this.idempotencyKey(idempotencyKey);
    const receipt = await this.receipts.get(
      context.tenantId,
      context.branchId,
      saleId,
    );
    if (!receipt) throw new NotFoundException();
    const result = await this.peripherals.execute({
      ...context,
      action: 'PRINT_RECEIPT',
      trigger: 'MANUAL',
      saleId,
      idempotencyKey: key,
    });
    await this.recordOperation(context, result.operation, result.replay);
    return {
      data: { receipt, operation: result.operation },
      meta: { apiVersion: '1' as const, idempotentReplay: result.replay },
    };
  }

  async openDrawer(
    context: PeripheralContext,
    input: {
      trigger: 'MANUAL' | 'CASH_SALE_COMPLETED';
      saleId?: string;
      idempotencyKey?: string;
    },
  ) {
    if (input.trigger === 'CASH_SALE_COMPLETED' && !input.saleId) {
      throw new BadRequestException({
        code: 'SALE_ID_REQUIRED',
        message: 'La venta es obligatoria para la apertura automatica.',
      });
    }
    const result = await this.peripherals.execute({
      ...context,
      action: 'OPEN_DRAWER',
      trigger: input.trigger,
      saleId: input.saleId ?? null,
      idempotencyKey: this.idempotencyKey(input.idempotencyKey),
    });
    await this.recordOperation(context, result.operation, result.replay);
    return {
      data: result.operation,
      meta: { apiVersion: '1' as const, idempotentReplay: result.replay },
    };
  }

  private async recordOperation(
    context: PeripheralContext,
    operation: {
      id: string;
      action: string;
      trigger: string;
      status: string;
      errorCode: string | null;
      saleId: string | null;
      deviceId: string;
    },
    replay: boolean,
  ): Promise<void> {
    if (replay) return;
    await this.audit.recordRequired({
      tenantId: context.tenantId,
      actorUserId: context.userId,
      action: `POS_PERIPHERAL_${operation.status}`,
      entityType: 'POS_PERIPHERAL_OPERATION',
      entityId: operation.id,
      correlationId: context.correlationId,
      after: {
        action: operation.action,
        trigger: operation.trigger,
        saleId: operation.saleId,
        deviceId: operation.deviceId,
        errorCode: operation.errorCode,
      },
    });
  }

  private idempotencyKey(value: string | undefined): string {
    if (!value || !/^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/.test(value)) {
      throw new BadRequestException({
        code: 'IDEMPOTENCY_KEY_REQUIRED',
        message:
          'Idempotency-Key es obligatorio y debe tener entre 8 y 128 caracteres.',
      });
    }
    return value;
  }
}
