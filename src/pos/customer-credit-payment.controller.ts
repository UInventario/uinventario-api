import {
  Body,
  Controller,
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
import { CustomerCreditPaymentService } from './customer-credit-payment.service';
import {
  CreateCustomerCreditPaymentDto,
  ReverseCustomerCreditPaymentDto,
} from './dto/create-customer-credit-payment.dto';
import { PosAccessGuard } from './pos-access.guard';

@Controller('customers')
@UseGuards(SessionGuard, PosAccessGuard, PermissionGuard)
@RequirePermissions('SALES_MANAGE', 'SALES_CREDIT')
export class CustomerCreditPaymentController {
  constructor(private readonly payments: CustomerCreditPaymentService) {}

  @Post(':customerId/credit/payments')
  create(
    @Req() request: AuthenticatedRequest,
    @Param('customerId', ParseUUIDPipe) customerId: string,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Body() dto: CreateCustomerCreditPaymentDto,
  ) {
    return this.payments.create({
      tenantId: request.principal.tenant.id,
      branchId: request.principal.context.branch!.id,
      cashRegisterId: request.principal.context.cashRegister!.id,
      userId: request.principal.user.id,
      customerId,
      idempotencyKey,
      correlationId: request.requestId!,
      dto,
    });
  }

  @Post(':customerId/credit/payments/:paymentId/reversal')
  reverse(
    @Req() request: AuthenticatedRequest,
    @Param('customerId', ParseUUIDPipe) customerId: string,
    @Param('paymentId', ParseUUIDPipe) paymentId: string,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Body() dto: ReverseCustomerCreditPaymentDto,
  ) {
    return this.payments.reverse({
      tenantId: request.principal.tenant.id,
      branchId: request.principal.context.branch!.id,
      cashRegisterId: request.principal.context.cashRegister!.id,
      userId: request.principal.user.id,
      customerId,
      paymentId,
      idempotencyKey,
      correlationId: request.requestId!,
      dto,
    });
  }
}
