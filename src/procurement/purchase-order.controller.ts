import {
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { AuditService } from '../audit/audit.service';
import { PermissionGuard } from '../auth/authorization/permission.guard';
import { RequirePermissions } from '../auth/authorization/require-permissions.decorator';
import { RequireAnyPermission } from '../auth/authorization/require-any-permission.decorator';
import { SessionGuard } from '../auth/session/session.guard';
import type { AuthenticatedRequest } from '../auth/session/session.types';
import { ListPurchaseOrdersDto } from './dto/list-purchase-orders.dto';
import { SavePurchaseOrderDto } from './dto/save-purchase-order.dto';
import { UpdatePurchaseOrderDto } from './dto/update-purchase-order.dto';
import {
  ApprovePurchaseOrderDto,
  CancelPurchaseOrderDto,
  TransitionPurchaseOrderDto,
} from './dto/transition-purchase-order.dto';
import { PurchaseOrderService } from './purchase-order.service';

@Controller('purchase-orders')
@UseGuards(SessionGuard, PermissionGuard)
export class PurchaseOrderController {
  constructor(
    private readonly orders: PurchaseOrderService,
    private readonly audit: AuditService,
  ) {}

  @Get()
  @RequireAnyPermission('PURCHASE_ORDERS_MANAGE', 'PURCHASE_ORDERS_APPROVE')
  list(
    @Req() request: AuthenticatedRequest,
    @Query() query: ListPurchaseOrdersDto,
  ) {
    return this.orders.list(request.principal.tenant.id, query);
  }

  @Get(':id')
  @RequireAnyPermission('PURCHASE_ORDERS_MANAGE', 'PURCHASE_ORDERS_APPROVE')
  get(
    @Req() request: AuthenticatedRequest,
    @Param('id', new ParseUUIDPipe()) id: string,
  ) {
    return this.orders.get(request.principal.tenant.id, id);
  }

  @Post()
  @RequirePermissions('PURCHASE_ORDERS_MANAGE')
  async create(
    @Req() request: AuthenticatedRequest,
    @Body() dto: SavePurchaseOrderDto,
  ) {
    const result = await this.orders.create(
      request.principal.tenant.id,
      request.principal.user.id,
      dto,
    );
    await this.audit.record({
      tenantId: request.principal.tenant.id,
      actorUserId: request.principal.user.id,
      action: 'PURCHASE_ORDER_CREATED',
      entityType: 'PURCHASE_ORDER',
      entityId: result.data.id,
      correlationId: request.requestId!,
      after: {
        folio: result.data.folio,
        supplierId: result.data.supplier.id,
        currency: result.data.currency,
        total: result.data.total,
      },
    });
    return result;
  }

  @Patch(':id')
  @RequirePermissions('PURCHASE_ORDERS_MANAGE')
  async update(
    @Req() request: AuthenticatedRequest,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() dto: UpdatePurchaseOrderDto,
  ) {
    const before = await this.orders.get(request.principal.tenant.id, id);
    const result = await this.orders.update(
      request.principal.tenant.id,
      id,
      dto,
    );
    await this.audit.record({
      tenantId: request.principal.tenant.id,
      actorUserId: request.principal.user.id,
      action: 'PURCHASE_ORDER_UPDATED',
      entityType: 'PURCHASE_ORDER',
      entityId: id,
      correlationId: request.requestId!,
      before: {
        version: before.data.version,
        total: before.data.total,
      },
      after: {
        version: result.data.version,
        total: result.data.total,
      },
    });
    return result;
  }

  @Post(':id/approve')
  @RequirePermissions('PURCHASE_ORDERS_APPROVE')
  @HttpCode(200)
  async approve(
    @Req() request: AuthenticatedRequest,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Body() dto: ApprovePurchaseOrderDto,
  ) {
    const result = await this.orders.approve({
      tenantId: request.principal.tenant.id,
      orderId: id,
      actorUserId: request.principal.user.id,
      version: dto.version,
      reason: dto.reason,
      idempotencyKey,
    });
    await this.recordTransition(request, result, 'PURCHASE_ORDER_APPROVED');
    return result;
  }

  @Post(':id/send')
  @RequirePermissions('PURCHASE_ORDERS_MANAGE')
  @HttpCode(200)
  async send(
    @Req() request: AuthenticatedRequest,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Body() dto: TransitionPurchaseOrderDto,
  ) {
    const result = await this.orders.send({
      tenantId: request.principal.tenant.id,
      orderId: id,
      actorUserId: request.principal.user.id,
      version: dto.version,
      idempotencyKey,
    });
    await this.recordTransition(request, result, 'PURCHASE_ORDER_SENT');
    return result;
  }

  @Post(':id/cancel')
  @RequirePermissions('PURCHASE_ORDERS_APPROVE')
  @HttpCode(200)
  async cancel(
    @Req() request: AuthenticatedRequest,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Body() dto: CancelPurchaseOrderDto,
  ) {
    const result = await this.orders.cancel({
      tenantId: request.principal.tenant.id,
      orderId: id,
      actorUserId: request.principal.user.id,
      version: dto.version,
      reason: dto.reason,
      idempotencyKey,
    });
    await this.recordTransition(request, result, 'PURCHASE_ORDER_CANCELLED');
    return result;
  }

  private async recordTransition(
    request: AuthenticatedRequest,
    result: Awaited<ReturnType<PurchaseOrderService['approve']>>,
    action: string,
  ): Promise<void> {
    if (result.meta.idempotentReplay) return;
    const latest = result.data.transitions.at(-1)!;
    await this.audit.record({
      tenantId: request.principal.tenant.id,
      actorUserId: request.principal.user.id,
      action,
      entityType: 'PURCHASE_ORDER',
      entityId: result.data.id,
      correlationId: request.requestId!,
      before: { status: latest.fromStatus },
      after: {
        status: latest.toStatus,
        reason: latest.reason,
        deliveryMode: latest.delivery?.mode ?? null,
      },
    });
  }
}
