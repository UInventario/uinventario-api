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
import { AuditService } from '../audit/audit.service';
import { OpenCashRegisterShiftDto } from './dto/open-cash-register-shift.dto';
import { CashRegisterShiftService } from './cash-register-shift.service';

@Controller('pos')
@UseGuards(SessionGuard, PosAccessGuard)
export class PosController {
  constructor(
    private readonly pos: PosService,
    private readonly shifts: CashRegisterShiftService,
    private readonly audit: AuditService,
  ) {}

  @Get('register-shifts/current')
  currentShift(@Req() request: AuthenticatedRequest) {
    const { principal } = request;
    return this.shifts.current({
      tenantId: principal.tenant.id,
      branchId: principal.context.branch!.id,
      cashRegisterId: principal.context.cashRegister!.id,
      userId: principal.user.id,
    });
  }

  @Post('register-shifts')
  async openShift(
    @Req() request: AuthenticatedRequest,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Body() dto: OpenCashRegisterShiftDto,
  ) {
    const { principal } = request;
    const result = await this.shifts.open(
      {
        tenantId: principal.tenant.id,
        branchId: principal.context.branch!.id,
        cashRegisterId: principal.context.cashRegister!.id,
        userId: principal.user.id,
      },
      dto.openingAmount,
      idempotencyKey,
    );
    await this.audit.record({
      tenantId: principal.tenant.id,
      actorUserId: principal.user.id,
      action: 'CASH_REGISTER_SHIFT_OPENED',
      entityType: 'CASH_REGISTER_SHIFT',
      entityId: result.data.id,
      correlationId: request.requestId!,
      deduplicate: true,
    });
    return result;
  }

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
      userId: principal.user.id,
      dto,
    });
  }

  @Post('sales/cash')
  async createCashSale(
    @Req() request: AuthenticatedRequest,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Body() dto: CreateCashSaleDto,
  ) {
    const { principal } = request;
    const result = await this.pos.createCashSale({
      tenantId: principal.tenant.id,
      branchId: principal.context.branch!.id,
      warehouseId: principal.context.warehouse!.id,
      cashRegisterId: principal.context.cashRegister!.id,
      userId: principal.user.id,
      idempotencyKey,
      dto,
    });
    await this.audit.record({
      tenantId: principal.tenant.id,
      actorUserId: principal.user.id,
      action: 'SALE_COMPLETED',
      entityType: 'SALE',
      entityId: result.data.id,
      correlationId: request.requestId!,
      deduplicate: true,
    });
    return result;
  }
}
