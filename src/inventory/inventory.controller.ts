import {
  Body,
  Controller,
  Get,
  Headers,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { SessionGuard } from '../auth/session/session.guard';
import type { AuthenticatedRequest } from '../auth/session/session.types';
import { PermissionGuard } from '../auth/authorization/permission.guard';
import { RequirePermissions } from '../auth/authorization/require-permissions.decorator';
import { CreateInventoryMovementDto } from './dto/create-inventory-movement.dto';
import { CreateInventoryStateTransitionDto } from './dto/create-inventory-state-transition.dto';
import { GetInventoryBalanceDto } from './dto/get-inventory-balance.dto';
import { ListInventoryStockDto } from './dto/list-inventory-stock.dto';
import { ListInventoryMovementsDto } from './dto/list-inventory-movements.dto';
import { InventoryService } from './inventory.service';
import { AuditService } from '../audit/audit.service';

@Controller('inventory')
@UseGuards(SessionGuard, PermissionGuard)
export class InventoryController {
  constructor(
    private readonly inventory: InventoryService,
    private readonly audit: AuditService,
  ) {}

  @Get('stock')
  @RequirePermissions('INVENTORY_VIEW')
  listStock(
    @Req() request: AuthenticatedRequest,
    @Query() query: ListInventoryStockDto,
  ) {
    this.assertRequestedScope(
      query.branchId,
      query.warehouseId,
      request.principal.context.branch!.id,
      request.principal.context.warehouse!.id,
    );
    return this.inventory.listStock(
      request.principal.tenant.id,
      request.principal.context.branch!.id,
      request.principal.context.warehouse!.id,
      query,
    );
  }

  @Get('movements')
  @RequirePermissions('INVENTORY_VIEW')
  listMovements(
    @Req() request: AuthenticatedRequest,
    @Query() query: ListInventoryMovementsDto,
  ) {
    return this.inventory.listMovements(
      request.principal.tenant.id,
      request.principal.context.branch!.id,
      query,
    );
  }

  @Get('locations')
  @RequirePermissions('INVENTORY_VIEW')
  listLocations(@Req() request: AuthenticatedRequest) {
    return this.inventory.listLocations(
      request.principal.tenant.id,
      request.principal.context.warehouse!.id,
    );
  }

  @Get('products/:productId/balance')
  @RequirePermissions('INVENTORY_VIEW')
  getBalance(
    @Req() request: AuthenticatedRequest,
    @Param('productId', new ParseUUIDPipe()) productId: string,
    @Query() query: GetInventoryBalanceDto,
  ) {
    return this.inventory.getBalance(
      request.principal.tenant.id,
      request.principal.context.warehouse!.id,
      productId,
      query.locationId,
    );
  }

  @Post('movements')
  @RequirePermissions('INVENTORY_ADJUST')
  async createMovement(
    @Req() request: AuthenticatedRequest,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Body() dto: CreateInventoryMovementDto,
  ) {
    const result = await this.inventory.createMovement({
      tenantId: request.principal.tenant.id,
      warehouseId: request.principal.context.warehouse!.id,
      userId: request.principal.user.id,
      idempotencyKey,
      dto,
    });
    await this.audit.record({
      tenantId: request.principal.tenant.id,
      actorUserId: request.principal.user.id,
      action: 'INVENTORY_MOVEMENT_CREATED',
      entityType: 'INVENTORY_MOVEMENT',
      entityId: result.data.id,
      correlationId: request.requestId!,
      deduplicate: true,
    });
    return result;
  }

  @Post('state-transitions')
  @RequirePermissions('INVENTORY_ADJUST')
  async createStateTransition(
    @Req() request: AuthenticatedRequest,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Body() dto: CreateInventoryStateTransitionDto,
  ) {
    const result = await this.inventory.createStateTransition({
      tenantId: request.principal.tenant.id,
      warehouseId: request.principal.context.warehouse!.id,
      userId: request.principal.user.id,
      idempotencyKey,
      dto,
    });
    await this.audit.record({
      tenantId: request.principal.tenant.id,
      actorUserId: request.principal.user.id,
      action: 'INVENTORY_STATE_TRANSITION_CREATED',
      entityType: 'INVENTORY_MOVEMENT',
      entityId: result.data.id,
      correlationId: request.requestId!,
      deduplicate: true,
    });
    return result;
  }

  private assertRequestedScope(
    branchId: string | undefined,
    warehouseId: string | undefined,
    activeBranchId: string,
    activeWarehouseId: string,
  ): void {
    if (
      (branchId !== undefined && branchId !== activeBranchId) ||
      (warehouseId !== undefined && warehouseId !== activeWarehouseId)
    ) {
      throw new NotFoundException('Inventory scope not found.');
    }
  }
}
