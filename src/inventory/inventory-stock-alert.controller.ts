import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Put,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { PermissionGuard } from '../auth/authorization/permission.guard';
import { RequirePermissions } from '../auth/authorization/require-permissions.decorator';
import { SessionGuard } from '../auth/session/session.guard';
import type { AuthenticatedRequest } from '../auth/session/session.types';
import { ListStockAlertsDto } from './dto/list-stock-alerts.dto';
import { SetStockAlertThresholdDto } from './dto/set-stock-alert-threshold.dto';
import { InventoryStockAlertService } from './inventory-stock-alert.service';

@Controller('inventory/stock-alerts')
@UseGuards(SessionGuard, PermissionGuard)
export class InventoryStockAlertController {
  constructor(private readonly alerts: InventoryStockAlertService) {}

  @Get()
  @RequirePermissions('INVENTORY_VIEW')
  list(
    @Req() request: AuthenticatedRequest,
    @Query() query: ListStockAlertsDto,
  ) {
    return this.alerts.list(
      request.principal.tenant.id,
      request.principal.context.branch!.id,
      request.principal.context.warehouse!.id,
      query,
    );
  }

  @Put('products/:productId/locations/:locationId/threshold')
  @RequirePermissions('INVENTORY_ADJUST')
  setThreshold(
    @Req() request: AuthenticatedRequest,
    @Param('productId', new ParseUUIDPipe()) productId: string,
    @Param('locationId', new ParseUUIDPipe()) locationId: string,
    @Body() dto: SetStockAlertThresholdDto,
  ) {
    return this.alerts.setThreshold({
      tenantId: request.principal.tenant.id,
      warehouseId: request.principal.context.warehouse!.id,
      productId,
      locationId,
      threshold: dto.threshold,
    });
  }
}
