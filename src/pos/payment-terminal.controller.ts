import {
  Body,
  Controller,
  Get,
  Headers,
  Param,
  ParseUUIDPipe,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import { AuditService } from '../audit/audit.service';
import { SessionGuard } from '../auth/session/session.guard';
import type { AuthenticatedRequest } from '../auth/session/session.types';
import { StartPaymentTerminalDto } from './dto/start-payment-terminal.dto';
import { PosAccessGuard } from './pos-access.guard';
import { PaymentTerminalService } from './payment-terminal.service';

@Controller('pos/payment-terminal')
@UseGuards(SessionGuard, PosAccessGuard)
export class PaymentTerminalController {
  constructor(
    private readonly terminal: PaymentTerminalService,
    private readonly audit: AuditService,
  ) {}

  @Post('operations')
  async start(
    @Req() request: AuthenticatedRequest,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Body() dto: StartPaymentTerminalDto,
  ) {
    const context = this.context(request);
    const result = await this.terminal.start({
      ...context,
      idempotencyKey,
      correlationId: request.requestId!,
      dto,
    });
    await this.audit.record({
      tenantId: context.tenantId,
      actorUserId: context.userId,
      action: 'PAYMENT_TERMINAL_STARTED',
      entityType: 'PAYMENT_TERMINAL_OPERATION',
      entityId: result.data.id,
      correlationId: request.requestId!,
      deduplicate: true,
      after: {
        provider: result.data.provider,
        amount: result.data.amount,
        currency: result.data.currency,
        status: result.data.status,
      },
    });
    return result;
  }

  @Get('operations/:id')
  get(
    @Req() request: AuthenticatedRequest,
    @Param('id', ParseUUIDPipe) operationId: string,
  ) {
    return this.terminal.get(request.principal.tenant.id, operationId);
  }

  @Post('operations/:id/cancel')
  async cancel(
    @Req() request: AuthenticatedRequest,
    @Param('id', ParseUUIDPipe) operationId: string,
  ) {
    const result = await this.terminal.cancel(
      request.principal.tenant.id,
      operationId,
    );
    await this.audit.record({
      tenantId: request.principal.tenant.id,
      actorUserId: request.principal.user.id,
      action: 'PAYMENT_TERMINAL_CANCELLED',
      entityType: 'PAYMENT_TERMINAL_OPERATION',
      entityId: operationId,
      correlationId: request.requestId!,
      deduplicate: true,
      after: { status: result.data.status },
    });
    return result;
  }

  @Post('reconciliation')
  reconcile(@Req() request: AuthenticatedRequest) {
    return this.terminal.reconcile(
      request.principal.tenant.id,
      request.principal.context.branch!.id,
    );
  }

  private context(request: AuthenticatedRequest) {
    return {
      tenantId: request.principal.tenant.id,
      branchId: request.principal.context.branch!.id,
      cashRegisterId: request.principal.context.cashRegister!.id,
      userId: request.principal.user.id,
    };
  }
}
