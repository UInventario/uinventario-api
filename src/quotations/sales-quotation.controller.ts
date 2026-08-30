import {
  Body,
  Controller,
  Get,
  Headers,
  Param,
  ParseUUIDPipe,
  Post,
  Put,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { AuditService } from '../audit/audit.service';
import { PermissionGuard } from '../auth/authorization/permission.guard';
import { RequirePermissions } from '../auth/authorization/require-permissions.decorator';
import { SessionGuard } from '../auth/session/session.guard';
import type { AuthenticatedRequest } from '../auth/session/session.types';
import { PosAccessGuard } from '../pos/pos-access.guard';
import { ConvertSalesQuotationDto } from './dto/convert-sales-quotation.dto';
import { CreateSalesQuotationDto } from './dto/create-sales-quotation.dto';
import { ListSalesQuotationsDto } from './dto/list-sales-quotations.dto';
import { UpdateSalesQuotationDto } from './dto/update-sales-quotation.dto';
import { SalesQuotationService } from './sales-quotation.service';

@Controller('quotations')
@UseGuards(SessionGuard, PosAccessGuard, PermissionGuard)
@RequirePermissions('SALES_MANAGE')
export class SalesQuotationController {
  constructor(
    private readonly quotations: SalesQuotationService,
    private readonly audit: AuditService,
  ) {}

  @Get() list(
    @Req() request: AuthenticatedRequest,
    @Query() query: ListSalesQuotationsDto,
  ) {
    return this.quotations.list(
      request.principal.tenant.id,
      request.principal.context.branch!.id,
      query,
    );
  }
  @Get(':quotationId') get(
    @Req() request: AuthenticatedRequest,
    @Param('quotationId', ParseUUIDPipe) id: string,
  ) {
    return this.quotations.get(
      request.principal.tenant.id,
      request.principal.context.branch!.id,
      id,
    );
  }
  @Post() async create(
    @Req() request: AuthenticatedRequest,
    @Headers('idempotency-key') key: string | undefined,
    @Body() dto: CreateSalesQuotationDto,
  ) {
    const result = await this.quotations.create({
      ...this.context(request),
      idempotencyKey: key,
      dto,
      canDiscount: this.canDiscount(request),
    });
    await this.record(request, result.data.id, 'SALES_QUOTATION_CREATED', {
      quotationNumber: result.data.quotationNumber,
      total: result.data.totals.total,
      validUntil: result.data.validUntil,
    });
    return result;
  }
  @Put(':quotationId') async update(
    @Req() request: AuthenticatedRequest,
    @Param('quotationId', ParseUUIDPipe) quotationId: string,
    @Headers('idempotency-key') key: string | undefined,
    @Body() dto: UpdateSalesQuotationDto,
  ) {
    const result = await this.quotations.update({
      ...this.context(request),
      quotationId,
      idempotencyKey: key,
      dto,
      canDiscount: this.canDiscount(request),
    });
    await this.record(request, quotationId, 'SALES_QUOTATION_UPDATED', {
      version: result.data.version,
      total: result.data.totals.total,
      validUntil: result.data.validUntil,
    });
    return result;
  }
  @Post(':quotationId/preview') preview(
    @Req() request: AuthenticatedRequest,
    @Param('quotationId', ParseUUIDPipe) quotationId: string,
  ) {
    return this.quotations.preview({
      ...this.context(request),
      quotationId,
      canDiscount: this.canDiscount(request),
    });
  }
  @Post(':quotationId/convert') async convert(
    @Req() request: AuthenticatedRequest,
    @Param('quotationId', ParseUUIDPipe) quotationId: string,
    @Headers('idempotency-key') key: string | undefined,
    @Body() dto: ConvertSalesQuotationDto,
  ) {
    const result = await this.quotations.convert({
      ...this.context(request),
      quotationId,
      idempotencyKey: key,
      dto,
      canDiscount: this.canDiscount(request),
      canCredit: request.principal.user.permissions.includes('SALES_CREDIT'),
      canViewMargin: request.principal.user.permissions.includes(
        'INVENTORY_VALUATION_MANAGE',
      ),
    });
    await this.record(request, quotationId, 'SALES_QUOTATION_CONVERTED', {
      saleId: result.data.sale.id,
      differences: result.data.differences,
    });
    await this.audit.record({
      tenantId: request.principal.tenant.id,
      actorUserId: request.principal.user.id,
      action: 'SALE_COMPLETED',
      entityType: 'SALE',
      entityId: result.data.sale.id,
      correlationId: request.requestId!,
      deduplicate: true,
      after: { quotationId },
    });
    if (result.data.quotation.reservation)
      await this.audit.record({
        tenantId: request.principal.tenant.id,
        actorUserId: request.principal.user.id,
        action: 'PRODUCT_RESERVATION_CONSUMED',
        entityType: 'PRODUCT_RESERVATION',
        entityId: result.data.quotation.reservation.id,
        correlationId: request.requestId!,
        deduplicate: true,
        after: { quotationId, saleId: result.data.sale.id },
      });
    return result;
  }

  private context(request: AuthenticatedRequest) {
    const { principal } = request;
    return {
      tenantId: principal.tenant.id,
      branchId: principal.context.branch!.id,
      warehouseId: principal.context.warehouse!.id,
      cashRegisterId: principal.context.cashRegister!.id,
      userId: principal.user.id,
    };
  }
  private canDiscount(request: AuthenticatedRequest) {
    return request.principal.user.permissions.includes('SALES_DISCOUNT');
  }
  private record(
    request: AuthenticatedRequest,
    id: string,
    action: string,
    after: Record<string, unknown>,
  ) {
    return this.audit.record({
      tenantId: request.principal.tenant.id,
      actorUserId: request.principal.user.id,
      action,
      entityType: 'SALES_QUOTATION',
      entityId: id,
      correlationId: request.requestId!,
      deduplicate: true,
      after,
    });
  }
}
