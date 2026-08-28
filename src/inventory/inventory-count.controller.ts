import {
  Body,
  Controller,
  Get,
  Headers,
  Param,
  ParseUUIDPipe,
  Post,
  Put,
  Req,
  UseGuards,
} from '@nestjs/common';
import { AuditService } from '../audit/audit.service';
import { PermissionGuard } from '../auth/authorization/permission.guard';
import { RequireAnyPermission } from '../auth/authorization/require-any-permission.decorator';
import { RequirePermissions } from '../auth/authorization/require-permissions.decorator';
import { SessionGuard } from '../auth/session/session.guard';
import type { AuthenticatedRequest } from '../auth/session/session.types';
import { CloseInventoryCountSessionDto } from './dto/close-inventory-count-session.dto';
import { CreateInventoryCountSessionDto } from './dto/create-inventory-count-session.dto';
import { RecordInventoryCountDto } from './dto/record-inventory-count.dto';
import { InventoryCountService } from './inventory-count.service';

@Controller('inventory/count-sessions')
@UseGuards(SessionGuard, PermissionGuard)
export class InventoryCountController {
  constructor(
    private readonly counts: InventoryCountService,
    private readonly audit: AuditService,
  ) {}

  @Post()
  @RequirePermissions('INVENTORY_COUNT')
  async create(
    @Req() request: AuthenticatedRequest,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Body() dto: CreateInventoryCountSessionDto,
  ) {
    const result = await this.counts.create({
      tenantId: request.principal.tenant.id,
      branchId: request.principal.context.branch!.id,
      warehouseId: request.principal.context.warehouse!.id,
      userId: request.principal.user.id,
      idempotencyKey,
      dto,
    });
    await this.audit.record({
      tenantId: request.principal.tenant.id,
      actorUserId: request.principal.user.id,
      action: 'INVENTORY_COUNT_SESSION_CREATED',
      entityType: 'INVENTORY_COUNT_SESSION',
      entityId: result.data.id,
      correlationId: request.requestId!,
      deduplicate: true,
      after: { blind: result.data.blind, products: result.data.lines.length },
    });
    return result;
  }

  @Get()
  @RequireAnyPermission(
    'INVENTORY_COUNT',
    'INVENTORY_APPROVE',
    'INVENTORY_VIEW',
  )
  list(@Req() request: AuthenticatedRequest) {
    return this.counts.list(
      request.principal.tenant.id,
      request.principal.context.warehouse!.id,
    );
  }

  @Get(':sessionId')
  @RequireAnyPermission(
    'INVENTORY_COUNT',
    'INVENTORY_APPROVE',
    'INVENTORY_VIEW',
  )
  get(
    @Req() request: AuthenticatedRequest,
    @Param('sessionId', new ParseUUIDPipe()) sessionId: string,
  ) {
    return this.counts.get(
      request.principal.tenant.id,
      request.principal.context.warehouse!.id,
      sessionId,
    );
  }

  @Put(':sessionId/lines/:productId')
  @RequirePermissions('INVENTORY_COUNT')
  async record(
    @Req() request: AuthenticatedRequest,
    @Param('sessionId', new ParseUUIDPipe()) sessionId: string,
    @Param('productId', new ParseUUIDPipe()) productId: string,
    @Body() dto: RecordInventoryCountDto,
  ) {
    const result = await this.counts.record({
      tenantId: request.principal.tenant.id,
      warehouseId: request.principal.context.warehouse!.id,
      sessionId,
      productId,
      userId: request.principal.user.id,
      dto,
    });
    const line = result.data.lines.find(
      ({ product }) => product.id === productId,
    )!;
    await this.audit.record({
      tenantId: request.principal.tenant.id,
      actorUserId: request.principal.user.id,
      action:
        line.attemptCount > 1
          ? 'INVENTORY_COUNT_RECOUNTED'
          : 'INVENTORY_COUNT_RECORDED',
      entityType: 'INVENTORY_COUNT_SESSION',
      entityId: sessionId,
      correlationId: request.requestId!,
      after: {
        productId,
        attempt: line.attemptCount,
        countedQuantity: line.countedQuantity,
      },
    });
    return result;
  }

  @Post(':sessionId/close')
  @RequirePermissions('INVENTORY_APPROVE')
  async close(
    @Req() request: AuthenticatedRequest,
    @Param('sessionId', new ParseUUIDPipe()) sessionId: string,
    @Body() dto: CloseInventoryCountSessionDto,
  ) {
    const result = await this.counts.close({
      tenantId: request.principal.tenant.id,
      warehouseId: request.principal.context.warehouse!.id,
      sessionId,
      userId: request.principal.user.id,
      dto,
    });
    await this.audit.record({
      tenantId: request.principal.tenant.id,
      actorUserId: request.principal.user.id,
      action: 'INVENTORY_COUNT_SESSION_CLOSED',
      entityType: 'INVENTORY_COUNT_SESSION',
      entityId: sessionId,
      correlationId: request.requestId!,
      deduplicate: true,
      after: {
        reference: dto.reference,
        adjustedProducts: result.data.lines.filter(
          ({ movementId }) => movementId !== null,
        ).length,
      },
    });
    return result;
  }
}
