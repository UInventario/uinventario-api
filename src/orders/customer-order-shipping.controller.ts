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
import { PermissionGuard } from '../auth/authorization/permission.guard';
import { RequirePermissions } from '../auth/authorization/require-permissions.decorator';
import { SessionGuard } from '../auth/session/session.guard';
import type { AuthenticatedRequest } from '../auth/session/session.types';
import { PosAccessGuard } from '../pos/pos-access.guard';
import { CustomerOrderShippingService } from './customer-order-shipping.service';
import { CarrierCancelDto, CarrierPollDto } from './dto/carrier-action.dto';
import { CarrierEventDto } from './dto/carrier-event.dto';

@Controller('shipping/v1')
@UseGuards(SessionGuard, PosAccessGuard, PermissionGuard)
@RequirePermissions('SALES_MANAGE')
export class CustomerOrderShippingController {
  constructor(
    private readonly shipping: CustomerOrderShippingService,
    private readonly audit: AuditService,
  ) {}

  @Get('contract')
  contract() {
    return this.shipping.contract();
  }

  @Post('orders/:orderId/quote')
  async quote(
    @Req() request: AuthenticatedRequest,
    @Param('orderId', ParseUUIDPipe) orderId: string,
  ) {
    const result = await this.shipping.quote(this.context(request, orderId));
    await this.record(request, orderId, 'CARRIER_QUOTED', {
      provider: 'SIMULATOR',
      service: result.data.service,
      quoteReference: result.data.quoteReference,
    });
    return result;
  }

  @Post('orders/:orderId/cancel')
  async cancel(
    @Req() request: AuthenticatedRequest,
    @Param('orderId', ParseUUIDPipe) orderId: string,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Body() dto: CarrierCancelDto,
  ) {
    const result = await this.shipping.cancel({
      ...this.context(request, orderId),
      idempotencyKey: idempotencyKey ?? '',
      dto,
    });
    await this.record(request, orderId, 'CARRIER_SHIPMENT_CANCELLED', {
      trackingStatus: result.data.fulfillment.carrier?.trackingStatus ?? null,
      manualActionRequired:
        result.data.fulfillment.carrier?.manualActionRequired ?? false,
    });
    return result;
  }

  @Post('orders/:orderId/poll')
  async poll(
    @Req() request: AuthenticatedRequest,
    @Param('orderId', ParseUUIDPipe) orderId: string,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Body() dto: CarrierPollDto,
  ) {
    const result = await this.shipping.poll({
      ...this.context(request, orderId),
      idempotencyKey: idempotencyKey ?? '',
      dto,
    });
    await this.record(request, orderId, 'CARRIER_TRACKING_POLLED', {
      scenario: dto.scenario,
      eventApplied: result.meta.eventApplied,
      trackingStatus: result.data.fulfillment.carrier?.trackingStatus ?? null,
    });
    return result;
  }

  @Post('orders/:orderId/events')
  async event(
    @Req() request: AuthenticatedRequest,
    @Param('orderId', ParseUUIDPipe) orderId: string,
    @Body() dto: CarrierEventDto,
  ) {
    const result = await this.shipping.event({
      ...this.context(request, orderId),
      dto,
    });
    await this.record(request, orderId, 'CARRIER_TRACKING_EVENT_RECEIVED', {
      providerEventId: dto.providerEventId,
      trackingReference: dto.trackingReference,
      status: dto.status,
      sequence: dto.sequence,
      eventApplied: result.meta.eventApplied,
      idempotentReplay: result.meta.idempotentReplay,
    });
    return result;
  }

  private context(request: AuthenticatedRequest, orderId: string) {
    return {
      tenantId: request.principal.tenant.id,
      branchId: request.principal.context.branch!.id,
      orderId,
    };
  }

  private record(
    request: AuthenticatedRequest,
    orderId: string,
    action: string,
    after: Record<string, unknown>,
  ) {
    return this.audit.record({
      tenantId: request.principal.tenant.id,
      actorUserId: request.principal.user.id,
      action,
      entityType: 'CUSTOMER_ORDER_SHIPPING',
      entityId: orderId,
      correlationId: request.requestId!,
      deduplicate: true,
      after,
    });
  }
}
