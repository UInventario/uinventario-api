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
import { CashRegisterMovementService } from './cash-register-movement.service';
import { CreateCashRegisterMovementDto } from './dto/create-cash-register-movement.dto';
import { ReverseCashRegisterMovementDto } from './dto/reverse-cash-register-movement.dto';
import { CashRegisterClosureService } from './cash-register-closure.service';
import { CloseCashRegisterShiftDto } from './dto/close-cash-register-shift.dto';

@Controller('pos')
@UseGuards(SessionGuard, PosAccessGuard)
export class PosController {
  constructor(
    private readonly pos: PosService,
    private readonly shifts: CashRegisterShiftService,
    private readonly cashMovements: CashRegisterMovementService,
    private readonly closures: CashRegisterClosureService,
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

  @Get('register-shifts/current/movements')
  listCashMovements(@Req() request: AuthenticatedRequest) {
    const { principal } = request;
    return this.cashMovements.list(this.cashContext(principal));
  }

  @Get('register-shifts/latest-closed')
  latestClosedShift(@Req() request: AuthenticatedRequest) {
    return this.closures.latest(this.cashContext(request.principal));
  }

  @Post('register-shifts/current/closure')
  async closeShift(
    @Req() request: AuthenticatedRequest,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Body() dto: CloseCashRegisterShiftDto,
  ) {
    const result = await this.closures.close(
      this.cashContext(request.principal),
      dto,
      idempotencyKey,
    );
    await this.auditCashMovement(
      request,
      result.data.id,
      'CASH_REGISTER_SHIFT_CLOSED',
      'CASH_REGISTER_SHIFT',
    );
    return result;
  }

  @Post('register-shifts/current/movements')
  async createCashMovement(
    @Req() request: AuthenticatedRequest,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Body() dto: CreateCashRegisterMovementDto,
  ) {
    const { principal } = request;
    const result = await this.cashMovements.create(
      this.cashContext(principal),
      dto,
      idempotencyKey,
    );
    await this.auditCashMovement(
      request,
      result.data.id,
      'CASH_REGISTER_MOVEMENT_CREATED',
    );
    return result;
  }

  @Post('register-shifts/current/movements/:movementId/reversals')
  async reverseCashMovement(
    @Req() request: AuthenticatedRequest,
    @Param('movementId', ParseUUIDPipe) movementId: string,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Body() dto: ReverseCashRegisterMovementDto,
  ) {
    const { principal } = request;
    const result = await this.cashMovements.reverse(
      this.cashContext(principal),
      movementId,
      dto.reason,
      idempotencyKey,
    );
    await this.auditCashMovement(
      request,
      result.data.id,
      'CASH_REGISTER_MOVEMENT_REVERSED',
    );
    return result;
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

  private cashContext(principal: AuthenticatedRequest['principal']) {
    return {
      tenantId: principal.tenant.id,
      branchId: principal.context.branch!.id,
      cashRegisterId: principal.context.cashRegister!.id,
      userId: principal.user.id,
    };
  }

  private async auditCashMovement(
    request: AuthenticatedRequest,
    entityId: string,
    action: string,
    entityType = 'CASH_REGISTER_MOVEMENT',
  ): Promise<void> {
    await this.audit.record({
      tenantId: request.principal.tenant.id,
      actorUserId: request.principal.user.id,
      action,
      entityType,
      entityId,
      correlationId: request.requestId!,
      deduplicate: true,
    });
  }
}
