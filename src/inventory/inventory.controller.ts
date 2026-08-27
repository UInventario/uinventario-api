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
import { SessionGuard } from '../auth/session/session.guard';
import type { AuthenticatedRequest } from '../auth/session/session.types';
import { CreateInventoryMovementDto } from './dto/create-inventory-movement.dto';
import { GetInventoryBalanceDto } from './dto/get-inventory-balance.dto';
import { ListInventoryStockDto } from './dto/list-inventory-stock.dto';
import { InventoryAccessGuard } from './inventory-access.guard';
import { InventoryService } from './inventory.service';

@Controller('inventory')
@UseGuards(SessionGuard, InventoryAccessGuard)
export class InventoryController {
  constructor(private readonly inventory: InventoryService) {}

  @Get('stock')
  listStock(
    @Req() request: AuthenticatedRequest,
    @Query() query: ListInventoryStockDto,
  ) {
    return this.inventory.listStock(
      request.principal.tenant.id,
      query.branchId ?? request.principal.context.branch!.id,
      query.warehouseId ?? request.principal.context.warehouse!.id,
      query,
    );
  }

  @Get('locations')
  listLocations(@Req() request: AuthenticatedRequest) {
    return this.inventory.listLocations(
      request.principal.tenant.id,
      request.principal.context.warehouse!.id,
    );
  }

  @Get('products/:productId/balance')
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
  createMovement(
    @Req() request: AuthenticatedRequest,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Body() dto: CreateInventoryMovementDto,
  ) {
    return this.inventory.createMovement({
      tenantId: request.principal.tenant.id,
      warehouseId: request.principal.context.warehouse!.id,
      userId: request.principal.user.id,
      idempotencyKey,
      dto,
    });
  }
}
