import {
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { SessionGuard } from '../auth/session/session.guard';
import type { AuthenticatedRequest } from '../auth/session/session.types';
import { CreateCashSaleDto } from './dto/create-cash-sale.dto';
import { ListSalesDto } from './dto/list-sales.dto';
import { QuoteCartDto } from './dto/quote-cart.dto';
import { PosAccessGuard } from './pos-access.guard';
import { PosService } from './pos.service';

@Controller('pos')
@UseGuards(SessionGuard, PosAccessGuard)
export class PosController {
  constructor(private readonly pos: PosService) {}

  @Get('sales')
  listSales(
    @Req() request: AuthenticatedRequest,
    @Query() query: ListSalesDto,
  ) {
    const { principal } = request;
    return this.pos.listSales(
      principal.tenant.id,
      principal.context.branch!.id,
      query,
    );
  }

  @Get('sales/:saleId')
  getSale(
    @Req() request: AuthenticatedRequest,
    @Param('saleId', ParseUUIDPipe) saleId: string,
  ) {
    const { principal } = request;
    return this.pos.getSale(
      principal.tenant.id,
      principal.context.branch!.id,
      saleId,
    );
  }

  @Post('cart/quote')
  @HttpCode(200)
  quoteCart(@Req() request: AuthenticatedRequest, @Body() dto: QuoteCartDto) {
    const { principal } = request;
    return this.pos.quoteCart({
      tenantId: principal.tenant.id,
      branchId: principal.context.branch!.id,
      warehouseId: principal.context.warehouse!.id,
      cashRegisterId: principal.context.cashRegister!.id,
      dto,
    });
  }

  @Post('sales/cash')
  createCashSale(
    @Req() request: AuthenticatedRequest,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Body() dto: CreateCashSaleDto,
  ) {
    const { principal } = request;
    return this.pos.createCashSale({
      tenantId: principal.tenant.id,
      branchId: principal.context.branch!.id,
      warehouseId: principal.context.warehouse!.id,
      cashRegisterId: principal.context.cashRegister!.id,
      userId: principal.user.id,
      idempotencyKey,
      dto,
    });
  }
}
