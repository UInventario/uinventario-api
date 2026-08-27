import {
  Body,
  Controller,
  Get,
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
import { SessionGuard } from '../auth/session/session.guard';
import type { AuthenticatedRequest } from '../auth/session/session.types';
import { ListPurchaseOrdersDto } from './dto/list-purchase-orders.dto';
import { SavePurchaseOrderDto } from './dto/save-purchase-order.dto';
import { UpdatePurchaseOrderDto } from './dto/update-purchase-order.dto';
import { PurchaseOrderService } from './purchase-order.service';

@Controller('purchase-orders')
@UseGuards(SessionGuard, PermissionGuard)
@RequirePermissions('PURCHASE_ORDERS_MANAGE')
export class PurchaseOrderController {
  constructor(
    private readonly orders: PurchaseOrderService,
    private readonly audit: AuditService,
  ) {}

  @Get()
  list(
    @Req() request: AuthenticatedRequest,
    @Query() query: ListPurchaseOrdersDto,
  ) {
    return this.orders.list(request.principal.tenant.id, query);
  }

  @Get(':id')
  get(
    @Req() request: AuthenticatedRequest,
    @Param('id', new ParseUUIDPipe()) id: string,
  ) {
    return this.orders.get(request.principal.tenant.id, id);
  }

  @Post()
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
}
