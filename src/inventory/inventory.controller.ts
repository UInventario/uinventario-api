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
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { SessionGuard } from '../auth/session/session.guard';
import type { AuthenticatedRequest } from '../auth/session/session.types';
import { PermissionGuard } from '../auth/authorization/permission.guard';
import { RequirePermissions } from '../auth/authorization/require-permissions.decorator';
import { RequireAnyPermission } from '../auth/authorization/require-any-permission.decorator';
import { CreateInventoryMovementDto } from './dto/create-inventory-movement.dto';
import { CreateInventoryStateTransitionDto } from './dto/create-inventory-state-transition.dto';
import { GetInventoryBalanceDto } from './dto/get-inventory-balance.dto';
import { ListInventoryStockDto } from './dto/list-inventory-stock.dto';
import { ListInventoryMovementsDto } from './dto/list-inventory-movements.dto';
import { InventoryService } from './inventory.service';
import { AuditService } from '../audit/audit.service';
import { PreviewInventoryImportDto } from './dto/preview-inventory-import.dto';
import { InventoryImportService } from './inventory-import.service';
import type { InventoryImportFile } from './inventory-import.types';

@Controller('inventory')
@UseGuards(SessionGuard, PermissionGuard)
export class InventoryController {
  constructor(
    private readonly inventory: InventoryService,
    private readonly audit: AuditService,
    private readonly inventoryImports: InventoryImportService,
  ) {}

  @Post('imports/preview')
  @RequirePermissions('INVENTORY_ADJUST')
  @UseInterceptors(
    FileInterceptor('file', {
      limits: { fileSize: 2 * 1024 * 1024, files: 1 },
    }),
  )
  previewImport(
    @Req() request: AuthenticatedRequest,
    @Body() dto: PreviewInventoryImportDto,
    @UploadedFile() file: InventoryImportFile | undefined,
  ) {
    return this.inventoryImports.preview({
      tenantId: request.principal.tenant.id,
      warehouseId: request.principal.context.warehouse!.id,
      userId: request.principal.user.id,
      correlationId: request.requestId!,
      mode: dto.mode,
      file,
    });
  }

  @Get('imports/:importId')
  @RequirePermissions('INVENTORY_ADJUST')
  getImport(
    @Req() request: AuthenticatedRequest,
    @Param('importId', new ParseUUIDPipe()) importId: string,
  ) {
    return this.inventoryImports.get(
      request.principal.tenant.id,
      request.principal.context.warehouse!.id,
      importId,
    );
  }

  @Post('imports/:importId/confirm')
  @RequirePermissions('INVENTORY_ADJUST')
  confirmImport(
    @Req() request: AuthenticatedRequest,
    @Param('importId', new ParseUUIDPipe()) importId: string,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
  ) {
    return this.inventoryImports.confirm({
      tenantId: request.principal.tenant.id,
      warehouseId: request.principal.context.warehouse!.id,
      userId: request.principal.user.id,
      importId,
      idempotencyKey,
      correlationId: request.requestId!,
    });
  }

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
  @RequireAnyPermission('INVENTORY_VIEW', 'PURCHASE_ORDERS_MANAGE')
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

  @Get('products/:productId/lots')
  @RequirePermissions('INVENTORY_VIEW')
  listLots(
    @Req() request: AuthenticatedRequest,
    @Param('productId', new ParseUUIDPipe()) productId: string,
  ) {
    return this.inventory.listLots(
      request.principal.tenant.id,
      request.principal.context.warehouse!.id,
      productId,
    );
  }

  @Get('products/:productId/fifo-layers')
  @RequirePermissions('INVENTORY_VIEW')
  listFifoLayers(
    @Req() request: AuthenticatedRequest,
    @Param('productId', new ParseUUIDPipe()) productId: string,
  ) {
    return this.inventory.listFifoLayers(
      request.principal.tenant.id,
      request.principal.context.warehouse!.id,
      productId,
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
