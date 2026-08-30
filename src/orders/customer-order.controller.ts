import {
  Body,
  Controller,
  Get,
  Headers,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { AuditService } from '../audit/audit.service';
import { PermissionGuard } from '../auth/authorization/permission.guard';
import { RequirePermissions } from '../auth/authorization/require-permissions.decorator';
import { SessionGuard } from '../auth/session/session.guard';
import type { AuthenticatedRequest } from '../auth/session/session.types';
import { PosAccessGuard } from '../pos/pos-access.guard';
import { CustomerOrderService } from './customer-order.service';
import { CreateCustomerOrderDto } from './dto/create-customer-order.dto';
import { ListCustomerOrdersDto } from './dto/list-customer-orders.dto';
import { TransitionCustomerOrderDto } from './dto/transition-customer-order.dto';

@Controller('orders')
@UseGuards(SessionGuard, PosAccessGuard, PermissionGuard)
@RequirePermissions('SALES_MANAGE')
export class CustomerOrderController {
  constructor(
    private readonly orders: CustomerOrderService,
    private readonly audit: AuditService,
  ) {}

  @Get()
  list(
    @Req() request: AuthenticatedRequest,
    @Query() query: ListCustomerOrdersDto,
  ) {
    return this.orders.list(
      request.principal.tenant.id,
      request.principal.context.branch!.id,
      query,
    );
  }

  @Get(':orderId')
  get(
    @Req() request: AuthenticatedRequest,
    @Param('orderId', ParseUUIDPipe) orderId: string,
  ) {
    return this.orders.get(
      request.principal.tenant.id,
      request.principal.context.branch!.id,
      orderId,
    );
  }

  @Post()
  async create(
    @Req() request: AuthenticatedRequest,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Body() dto: CreateCustomerOrderDto,
  ) {
    const result = await this.orders.create({
      ...this.context(request),
      idempotencyKey,
      dto,
    });
    await this.record(request, result.data.id, 'CUSTOMER_ORDER_CREATED', {
      orderNumber: result.data.orderNumber,
      status: result.data.status,
      total: result.data.totals.total,
      currency: result.data.currency,
    });
    return result;
  }

  @Post(':orderId/confirm')
  confirm(
    @Req() request: AuthenticatedRequest,
    @Param('orderId', ParseUUIDPipe) orderId: string,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Body() dto: TransitionCustomerOrderDto,
  ) {
    return this.runTransition(request, orderId, idempotencyKey, dto, 'confirm');
  }

  @Post(':orderId/prepare')
  prepare(
    @Req() request: AuthenticatedRequest,
    @Param('orderId', ParseUUIDPipe) orderId: string,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Body() dto: TransitionCustomerOrderDto,
  ) {
    return this.runTransition(request, orderId, idempotencyKey, dto, 'prepare');
  }

  @Post(':orderId/ready')
  ready(
    @Req() request: AuthenticatedRequest,
    @Param('orderId', ParseUUIDPipe) orderId: string,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Body() dto: TransitionCustomerOrderDto,
  ) {
    return this.runTransition(request, orderId, idempotencyKey, dto, 'ready');
  }

  @Post(':orderId/deliver')
  deliver(
    @Req() request: AuthenticatedRequest,
    @Param('orderId', ParseUUIDPipe) orderId: string,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Body() dto: TransitionCustomerOrderDto,
  ) {
    return this.runTransition(request, orderId, idempotencyKey, dto, 'deliver');
  }

  @Post(':orderId/dispatch')
  dispatch(
    @Req() request: AuthenticatedRequest,
    @Param('orderId', ParseUUIDPipe) orderId: string,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Body() dto: TransitionCustomerOrderDto,
  ) {
    return this.runTransition(
      request,
      orderId,
      idempotencyKey,
      dto,
      'dispatch',
    );
  }

  @Post(':orderId/cancel')
  cancel(
    @Req() request: AuthenticatedRequest,
    @Param('orderId', ParseUUIDPipe) orderId: string,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Body() dto: TransitionCustomerOrderDto,
  ) {
    return this.runTransition(request, orderId, idempotencyKey, dto, 'cancel');
  }

  private async runTransition(
    request: AuthenticatedRequest,
    orderId: string,
    idempotencyKey: string | undefined,
    dto: TransitionCustomerOrderDto,
    action: 'confirm' | 'prepare' | 'ready' | 'dispatch' | 'deliver' | 'cancel',
  ) {
    const input = { ...this.context(request), orderId, idempotencyKey, dto };
    const result =
      action === 'deliver'
        ? await this.orders.deliver({
            ...input,
            canViewMargin: request.principal.user.permissions.includes(
              'INVENTORY_VALUATION_MANAGE',
            ),
          })
        : action === 'dispatch'
          ? await this.orders.dispatch(input)
          : await this.orders[action](input);
    const auditAction =
      action === 'dispatch'
        ? result.data.fulfillment.status === 'DISPATCHED'
          ? 'CUSTOMER_ORDER_DISPATCHED'
          : 'CUSTOMER_ORDER_DISPATCH_RETRYABLE'
        : {
            confirm: 'CUSTOMER_ORDER_CONFIRMED',
            prepare: 'CUSTOMER_ORDER_PREPARED',
            ready: 'CUSTOMER_ORDER_READY',
            deliver: 'CUSTOMER_ORDER_DELIVERED',
            cancel: 'CUSTOMER_ORDER_CANCELLED',
          }[action];
    await this.record(request, orderId, auditAction, {
      status: result.data.status,
      version: result.data.version,
      reservationId: result.data.reservation?.id ?? null,
      saleId: result.data.sale?.id ?? null,
      reason: dto.reason ?? null,
      fulfillment: {
        method: result.data.fulfillment.method,
        status: result.data.fulfillment.status,
        carrierCode: result.data.fulfillment.carrier?.code ?? null,
        attempts: result.data.fulfillment.carrier?.attempts ?? 0,
        trackingStatus: result.data.fulfillment.carrier?.trackingStatus ?? null,
        manualActionRequired:
          result.data.fulfillment.carrier?.manualActionRequired ?? false,
      },
    });
    if (action === 'confirm' && result.data.reservation) {
      await this.recordRelated(
        request,
        'PRODUCT_RESERVATION_CREATED',
        'PRODUCT_RESERVATION',
        result.data.reservation.id,
        { orderId, status: result.data.reservation.status },
      );
    }
    if (action === 'cancel' && result.data.reservation) {
      await this.recordRelated(
        request,
        'PRODUCT_RESERVATION_RELEASED',
        'PRODUCT_RESERVATION',
        result.data.reservation.id,
        {
          orderId,
          status: result.data.reservation.status,
          reason: dto.reason ?? null,
        },
      );
    }
    if (action === 'deliver' && result.data.sale && result.data.reservation) {
      await this.recordRelated(
        request,
        'SALE_COMPLETED',
        'SALE',
        result.data.sale.id,
        {
          orderId,
          paymentMethods: result.data.payments.map(({ method }) => method),
        },
      );
      await this.recordRelated(
        request,
        'PRODUCT_RESERVATION_CONSUMED',
        'PRODUCT_RESERVATION',
        result.data.reservation.id,
        {
          orderId,
          saleId: result.data.sale.id,
          status: result.data.reservation.status,
        },
      );
    }
    return result;
  }

  private context(request: AuthenticatedRequest) {
    const { principal } = request;
    return {
      tenantId: principal.tenant.id,
      branchId: principal.context.branch!.id,
      warehouseId: principal.context.warehouse!.id,
      cashRegisterId: principal.context.cashRegister!.id,
      userId: principal.user.id,
    };
  }

  private record(
    request: AuthenticatedRequest,
    entityId: string,
    action: string,
    after: Record<string, unknown>,
  ) {
    return this.recordRelated(
      request,
      action,
      'CUSTOMER_ORDER',
      entityId,
      after,
    );
  }

  private recordRelated(
    request: AuthenticatedRequest,
    action: string,
    entityType: string,
    entityId: string,
    after: Record<string, unknown>,
  ) {
    return this.audit.record({
      tenantId: request.principal.tenant.id,
      actorUserId: request.principal.user.id,
      action,
      entityType,
      entityId,
      correlationId: request.requestId!,
      deduplicate: true,
      after,
    });
  }
}
