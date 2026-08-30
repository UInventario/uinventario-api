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
import { PermissionGuard } from '../auth/authorization/permission.guard';
import { RequirePermissions } from '../auth/authorization/require-permissions.decorator';
import { SessionGuard } from '../auth/session/session.guard';
import type { AuthenticatedRequest } from '../auth/session/session.types';
import { CreatePspIntentDto } from './dto/create-psp-intent.dto';
import { PspWebhookDto } from './dto/psp-webhook.dto';
import { RefundPspPaymentDto } from './dto/refund-psp-payment.dto';
import { PspPaymentService } from './psp-payment.service';

@Controller('integrations/psp/v1')
@UseGuards(SessionGuard, PermissionGuard)
@RequirePermissions('TENANT_MANAGE')
export class PspPaymentController {
  constructor(private readonly psp: PspPaymentService) {}

  @Get('contract')
  contract() {
    return this.psp.contract();
  }

  @Get('payments')
  list(@Req() request: AuthenticatedRequest) {
    return this.psp.list(request.principal.tenant.id);
  }

  @Get('payments/:id')
  get(
    @Req() request: AuthenticatedRequest,
    @Param('id', ParseUUIDPipe) paymentId: string,
  ) {
    return this.psp.get(request.principal.tenant.id, paymentId);
  }

  @Post('payments')
  create(
    @Req() request: AuthenticatedRequest,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Body() dto: CreatePspIntentDto,
  ) {
    return this.psp.create({
      ...this.context(request),
      idempotencyKey: idempotencyKey ?? '',
      dto,
    });
  }

  @Post('payments/:id/confirm')
  confirm(
    @Req() request: AuthenticatedRequest,
    @Param('id', ParseUUIDPipe) paymentId: string,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
  ) {
    return this.psp.confirm({
      ...this.context(request),
      paymentId,
      idempotencyKey: idempotencyKey ?? '',
    });
  }

  @Post('payments/:id/capture')
  capture(
    @Req() request: AuthenticatedRequest,
    @Param('id', ParseUUIDPipe) paymentId: string,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
  ) {
    return this.psp.capture({
      ...this.context(request),
      paymentId,
      idempotencyKey: idempotencyKey ?? '',
    });
  }

  @Post('payments/:id/query')
  query(
    @Req() request: AuthenticatedRequest,
    @Param('id', ParseUUIDPipe) paymentId: string,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
  ) {
    return this.psp.query({
      ...this.context(request),
      paymentId,
      idempotencyKey: idempotencyKey ?? '',
    });
  }

  @Post('payments/:id/refunds')
  refund(
    @Req() request: AuthenticatedRequest,
    @Param('id', ParseUUIDPipe) paymentId: string,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Body() dto: RefundPspPaymentDto,
  ) {
    return this.psp.refund({
      ...this.context(request),
      paymentId,
      idempotencyKey: idempotencyKey ?? '',
      dto,
    });
  }

  @Post('webhooks/simulator')
  webhook(
    @Req() request: AuthenticatedRequest,
    @Headers('x-simulator-webhook-token') token: string | undefined,
    @Body() dto: PspWebhookDto,
  ) {
    return this.psp.webhook({
      ...this.context(request),
      token: token ?? '',
      dto,
    });
  }

  private context(request: AuthenticatedRequest) {
    return {
      tenantId: request.principal.tenant.id,
      userId: request.principal.user.id,
      correlationId: request.requestId!,
    };
  }
}
