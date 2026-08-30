import {
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Req,
  UseGuards,
} from '@nestjs/common';
import { PermissionGuard } from '../auth/authorization/permission.guard';
import { RequirePermissions } from '../auth/authorization/require-permissions.decorator';
import { SessionGuard } from '../auth/session/session.guard';
import type { AuthenticatedRequest } from '../auth/session/session.types';
import { PosAccessGuard } from './pos-access.guard';
import { PosService } from './pos.service';
import { SaleReturnService } from './sale-return.service';
import { SalesCashReportService } from './sales-cash-report.service';

@Controller('pos/reports/sales')
@UseGuards(SessionGuard, PosAccessGuard, PermissionGuard)
@RequirePermissions('SALES_MANAGE')
export class SalesReportDetailController {
  constructor(
    private readonly pos: PosService,
    private readonly returns: SaleReturnService,
    private readonly reports: SalesCashReportService,
  ) {}

  @Get(':saleId')
  async detail(
    @Req() request: AuthenticatedRequest,
    @Param('saleId', ParseUUIDPipe) saleId: string,
  ) {
    const { principal } = request;
    const branchId = await this.branch(request, saleId);
    return this.pos.getSale(
      principal.tenant.id,
      branchId,
      saleId,
      principal.user.permissions.includes('INVENTORY_VALUATION_MANAGE'),
    );
  }

  @Get(':saleId/returns')
  @RequirePermissions('SALES_MANAGE', 'SALES_RETURN')
  async saleReturns(
    @Req() request: AuthenticatedRequest,
    @Param('saleId', ParseUUIDPipe) saleId: string,
  ) {
    const branchId = await this.branch(request, saleId);
    return this.returns.list(request.principal.tenant.id, branchId, saleId);
  }

  private branch(
    request: AuthenticatedRequest,
    saleId: string,
  ): Promise<string> {
    const { principal } = request;
    return this.reports.resolveSaleBranch({
      tenantId: principal.tenant.id,
      userId: principal.user.id,
      administrator: principal.user.permissions.includes('TENANT_MANAGE'),
      saleId,
    });
  }
}
