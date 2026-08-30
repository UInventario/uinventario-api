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
import { PermissionGuard } from '../auth/authorization/permission.guard';
import { RequirePermissions } from '../auth/authorization/require-permissions.decorator';
import { SessionGuard } from '../auth/session/session.guard';
import type { AuthenticatedRequest } from '../auth/session/session.types';
import { CreateSaleReturnDto } from './dto/create-sale-return.dto';
import { CreateSaleReturnSettlementDto } from './dto/create-sale-return-settlement.dto';
import { PosAccessGuard } from './pos-access.guard';
import { SaleReturnService } from './sale-return.service';

@Controller('pos/sales')
@UseGuards(SessionGuard, PosAccessGuard, PermissionGuard)
@RequirePermissions('SALES_RETURN')
export class SaleReturnController {
  constructor(private readonly returns: SaleReturnService) {}

  @Get(':saleId/returns')
  list(
    @Req() request: AuthenticatedRequest,
    @Param('saleId', ParseUUIDPipe) saleId: string,
  ) {
    return this.returns.list(
      request.principal.tenant.id,
      request.principal.context.branch!.id,
      saleId,
    );
  }

  @Post(':saleId/returns')
  create(
    @Req() request: AuthenticatedRequest,
    @Param('saleId', ParseUUIDPipe) saleId: string,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Body() dto: CreateSaleReturnDto,
  ) {
    return this.returns.create({
      tenantId: request.principal.tenant.id,
      branchId: request.principal.context.branch!.id,
      userId: request.principal.user.id,
      saleId,
      idempotencyKey,
      correlationId: request.requestId!,
      dto,
    });
  }

  @Post(':saleId/returns/:returnId/settlements')
  settle(
    @Req() request: AuthenticatedRequest,
    @Param('saleId', ParseUUIDPipe) saleId: string,
    @Param('returnId', ParseUUIDPipe) returnId: string,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Body() dto: CreateSaleReturnSettlementDto,
  ) {
    return this.returns.settle({
      tenantId: request.principal.tenant.id,
      branchId: request.principal.context.branch!.id,
      cashRegisterId: request.principal.context.cashRegister!.id,
      userId: request.principal.user.id,
      saleId,
      returnId,
      idempotencyKey,
      correlationId: request.requestId!,
      dto,
    });
  }
}
