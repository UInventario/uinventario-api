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
import { CreateSaleDto } from './dto/create-sale.dto';
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
import { VoidSaleDto } from './dto/void-sale.dto';
import { PermissionGuard } from '../auth/authorization/permission.guard';
import { RequirePermissions } from '../auth/authorization/require-permissions.decorator';
import { SalesCashReportDto } from './dto/sales-cash-report.dto';
import { SalesCashReportService } from './sales-cash-report.service';
import { PosProfitabilityReportDto } from './dto/pos-profitability-report.dto';
import { PosProfitabilityReportService } from './pos-profitability-report.service';

@Controller('pos')
@UseGuards(SessionGuard, PosAccessGuard)
export class PosController {
  constructor(
    private readonly pos: PosService,
    private readonly shifts: CashRegisterShiftService,
    private readonly cashMovements: CashRegisterMovementService,
    private readonly closures: CashRegisterClosureService,
    private readonly audit: AuditService,
    private readonly reports: SalesCashReportService,
    private readonly profitabilityReports: PosProfitabilityReportService,
  ) {}

  @Get('reports/profitability')
  @UseGuards(PermissionGuard)
  @RequirePermissions('SALES_MANAGE', 'INVENTORY_VALUATION_MANAGE')
  profitabilityReport(
    @Req() request: AuthenticatedRequest,
    @Query() query: PosProfitabilityReportDto,
  ) {
    const { principal } = request;
    return this.profitabilityReports.report({
      tenantId: principal.tenant.id,
      userId: principal.user.id,
      administrator: principal.user.permissions.includes('TENANT_MANAGE'),
      query,
    });
  }

  @Get('reports/sales-cash')
  @UseGuards(PermissionGuard)
  @RequirePermissions('SALES_MANAGE')
  salesCashReport(
    @Req() request: AuthenticatedRequest,
    @Query() query: SalesCashReportDto,
  ) {
    const { principal } = request;
    return this.reports.report({
      tenantId: principal.tenant.id,
      userId: principal.user.id,
      administrator: principal.user.permissions.includes('TENANT_MANAGE'),
      query,
    });
  }

  @Get('payment-options')
  paymentOptions() {
    return this.pos.paymentOptions();
  }

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
  @UseGuards(PermissionGuard)
  @RequirePermissions('CASH_REGISTER_CLOSE')
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
  @UseGuards(PermissionGuard)
  @RequirePermissions('CASH_REGISTER_MOVE')
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
  @UseGuards(PermissionGuard)
  @RequirePermissions('CASH_REGISTER_MOVE')
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
  @UseGuards(PermissionGuard)
  @RequirePermissions('CASH_REGISTER_OPEN')
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
      principal.user.permissions.includes('INVENTORY_VALUATION_MANAGE'),
    );
  }

  @Post('sales/:saleId/void')
  @UseGuards(PermissionGuard)
  @RequirePermissions('SALES_VOID')
  async voidSale(
    @Req() request: AuthenticatedRequest,
    @Param('saleId', ParseUUIDPipe) saleId: string,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Body() dto: VoidSaleDto,
  ) {
    const { principal } = request;
    const result = await this.pos.voidSale({
      tenantId: principal.tenant.id,
      branchId: principal.context.branch!.id,
      cashRegisterId: principal.context.cashRegister!.id,
      userId: principal.user.id,
      saleId,
      idempotencyKey,
      dto,
      correlationId: request.requestId!,
    });
    return result;
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
      canDiscount: principal.user.permissions.includes('SALES_DISCOUNT'),
      canOverridePrice: principal.user.permissions.includes(
        'SALES_PRICE_OVERRIDE',
      ),
      canOverrideExpired: principal.user.permissions.includes(
        'INVENTORY_EXPIRED_STOCK_OVERRIDE',
      ),
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
      canDiscount: principal.user.permissions.includes('SALES_DISCOUNT'),
      canOverridePrice: principal.user.permissions.includes(
        'SALES_PRICE_OVERRIDE',
      ),
      canOverrideExpired: principal.user.permissions.includes(
        'INVENTORY_EXPIRED_STOCK_OVERRIDE',
      ),
      canViewMargin: principal.user.permissions.includes(
        'INVENTORY_VALUATION_MANAGE',
      ),
    });
    await this.audit.record({
      tenantId: principal.tenant.id,
      actorUserId: principal.user.id,
      action: 'SALE_COMPLETED',
      entityType: 'SALE',
      entityId: result.data.id,
      correlationId: request.requestId!,
      deduplicate: true,
      after: {
        discountTotal: result.data.totals.discount,
        discountReasons: this.discountReasons(result.data),
        priceOverrides: this.priceOverrides(result.data),
        expiredLotOverrides: this.expiredLotOverrides(result.data),
      },
    });
    if (dto.reservationId) {
      await this.audit.record({
        tenantId: principal.tenant.id,
        actorUserId: principal.user.id,
        action: 'PRODUCT_RESERVATION_CONSUMED',
        entityType: 'PRODUCT_RESERVATION',
        entityId: dto.reservationId,
        correlationId: request.requestId!,
        deduplicate: true,
        after: { status: 'CONSUMED', saleId: result.data.id },
      });
    }
    return result;
  }

  @Post('sales')
  async createSale(
    @Req() request: AuthenticatedRequest,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Body() dto: CreateSaleDto,
  ) {
    const { principal } = request;
    const result = await this.pos.createSale({
      tenantId: principal.tenant.id,
      branchId: principal.context.branch!.id,
      warehouseId: principal.context.warehouse!.id,
      cashRegisterId: principal.context.cashRegister!.id,
      userId: principal.user.id,
      idempotencyKey,
      dto,
      canDiscount: principal.user.permissions.includes('SALES_DISCOUNT'),
      canOverridePrice: principal.user.permissions.includes(
        'SALES_PRICE_OVERRIDE',
      ),
      canOverrideExpired: principal.user.permissions.includes(
        'INVENTORY_EXPIRED_STOCK_OVERRIDE',
      ),
      canCredit: principal.user.permissions.includes('SALES_CREDIT'),
      canViewMargin: principal.user.permissions.includes(
        'INVENTORY_VALUATION_MANAGE',
      ),
    });
    await this.audit.record({
      tenantId: principal.tenant.id,
      actorUserId: principal.user.id,
      action: 'SALE_COMPLETED',
      entityType: 'SALE',
      entityId: result.data.id,
      correlationId: request.requestId!,
      deduplicate: true,
      after: {
        paymentMethods: result.data.payments.map((payment) => payment.method),
        discountTotal: result.data.totals.discount,
        discountReasons: this.discountReasons(result.data),
        priceOverrides: this.priceOverrides(result.data),
        expiredLotOverrides: this.expiredLotOverrides(result.data),
      },
    });
    if (dto.reservationId) {
      await this.audit.record({
        tenantId: principal.tenant.id,
        actorUserId: principal.user.id,
        action: 'PRODUCT_RESERVATION_CONSUMED',
        entityType: 'PRODUCT_RESERVATION',
        entityId: dto.reservationId,
        correlationId: request.requestId!,
        deduplicate: true,
        after: { status: 'CONSUMED', saleId: result.data.id },
      });
    }
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

  private discountReasons(
    sale: Awaited<ReturnType<PosService['createSale']>>['data'],
  ): string[] {
    return [
      sale.discount?.reason,
      ...sale.lines.map((line) => line.discount.line?.reason),
    ].filter((reason): reason is string => Boolean(reason));
  }

  private expiredLotOverrides(
    sale: Awaited<ReturnType<PosService['createSale']>>['data'],
  ): Array<{ productId: string; reason: string }> {
    return sale.lines.flatMap((line) =>
      line.expiredLotOverrideReason
        ? [
            {
              productId: line.product.id,
              reason: line.expiredLotOverrideReason,
            },
          ]
        : [],
    );
  }

  private priceOverrides(
    sale: Awaited<ReturnType<PosService['createSale']>>['data'],
  ): Array<{ productId: string; unitPrice: string; reason: string }> {
    return sale.lines.flatMap((line) =>
      line.priceSource === 'MANUAL' && line.priceOverrideReason
        ? [
            {
              productId: line.product.id,
              unitPrice: line.unitPrice,
              reason: line.priceOverrideReason,
            },
          ]
        : [],
    );
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
