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
import { AuditService } from '../audit/audit.service';
import { PermissionGuard } from '../auth/authorization/permission.guard';
import { RequirePermissions } from '../auth/authorization/require-permissions.decorator';
import { SessionGuard } from '../auth/session/session.guard';
import type { AuthenticatedRequest } from '../auth/session/session.types';
import { CreateSuspendedSaleDto } from './dto/create-suspended-sale.dto';
import { PosAccessGuard } from './pos-access.guard';
import { SuspendedSaleService } from './suspended-sale.service';

@Controller('pos/suspended-sales')
@UseGuards(SessionGuard, PosAccessGuard, PermissionGuard)
@RequirePermissions('SALES_MANAGE')
export class SuspendedSaleController {
  constructor(
    private readonly suspended: SuspendedSaleService,
    private readonly audit: AuditService,
  ) {}

  @Get()
  async list(@Req() request: AuthenticatedRequest) {
    const result = await this.suspended.list(this.context(request));
    for (const sale of result.data.filter(
      ({ status }) => status === 'EXPIRED',
    )) {
      await this.record(request, 'SALE_SUSPENSION_EXPIRED', sale.id, {
        status: sale.status,
        expiresAt: sale.expiresAt,
      });
    }
    return result;
  }

  @Post()
  async create(
    @Req() request: AuthenticatedRequest,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Body() dto: CreateSuspendedSaleDto,
  ) {
    const result = await this.suspended.create(
      this.context(request),
      dto,
      idempotencyKey,
    );
    await this.record(request, 'SALE_SUSPENDED', result.data.id, {
      status: result.data.status,
      expiresAt: result.data.expiresAt,
      lineCount: result.data.lines.length,
    });
    return result;
  }

  @Post(':id/resume')
  async resume(
    @Req() request: AuthenticatedRequest,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    const result = await this.suspended.resume(this.context(request), id);
    await this.record(request, 'SALE_SUSPENSION_RESUMED', id, {
      conflicts: result.data.conflicts.map((conflict) => conflict.code),
    });
    return result;
  }

  @Post(':id/cancel')
  async cancel(
    @Req() request: AuthenticatedRequest,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    const result = await this.suspended.cancel(this.context(request), id);
    await this.record(request, 'SALE_SUSPENSION_CANCELLED', id, {
      status: result.data.status,
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

  private record(
    request: AuthenticatedRequest,
    action: string,
    entityId: string,
    after: Record<string, unknown>,
  ) {
    return this.audit.record({
      tenantId: request.principal.tenant.id,
      actorUserId: request.principal.user.id,
      action,
      entityType: 'SUSPENDED_SALE',
      entityId,
      correlationId: request.requestId!,
      deduplicate: true,
      after,
    });
  }
}
