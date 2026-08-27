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
import { CreateProductReservationDto } from './dto/create-product-reservation.dto';
import { ReleaseProductReservationDto } from './dto/release-product-reservation.dto';
import { ProductReservationService } from './product-reservation.service';

@Controller('reservations')
@UseGuards(SessionGuard, PermissionGuard)
@RequirePermissions('SALES_MANAGE')
export class ProductReservationController {
  constructor(
    private readonly reservations: ProductReservationService,
    private readonly audit: AuditService,
  ) {}

  @Get()
  list(@Req() request: AuthenticatedRequest) {
    return this.reservations.list(
      request.principal.tenant.id,
      request.principal.context.branch!.id,
    );
  }

  @Post()
  async create(
    @Req() request: AuthenticatedRequest,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Body() dto: CreateProductReservationDto,
  ) {
    const result = await this.reservations.create({
      tenantId: request.principal.tenant.id,
      branchId: request.principal.context.branch!.id,
      warehouseId: request.principal.context.warehouse!.id,
      userId: request.principal.user.id,
      idempotencyKey,
      dto,
    });
    await this.audit.record({
      tenantId: request.principal.tenant.id,
      actorUserId: request.principal.user.id,
      action: 'PRODUCT_RESERVATION_CREATED',
      entityType: 'PRODUCT_RESERVATION',
      entityId: result.data.id,
      correlationId: request.requestId!,
      deduplicate: true,
      after: {
        reservationNumber: result.data.reservationNumber,
        customerId: result.data.customer.id,
        expiresAt: result.data.expiresAt,
        lineCount: result.data.lines.length,
      },
    });
    return result;
  }

  @Post('expire-due')
  async expireDue(@Req() request: AuthenticatedRequest) {
    const { principal } = request;
    const result = await this.reservations.expireDue(
      principal.tenant.id,
      principal.context.branch!.id,
      principal.user.id,
    );
    for (const reservation of result.data) {
      await this.audit.record({
        tenantId: principal.tenant.id,
        actorUserId: principal.user.id,
        action: 'PRODUCT_RESERVATION_EXPIRED',
        entityType: 'PRODUCT_RESERVATION',
        entityId: reservation.id,
        correlationId: request.requestId!,
        deduplicate: true,
        after: {
          status: reservation.status,
          closureReason: reservation.closureReason,
        },
      });
    }
    return result;
  }

  @Post(':reservationId/release')
  async release(
    @Req() request: AuthenticatedRequest,
    @Param('reservationId', ParseUUIDPipe) reservationId: string,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Body() dto: ReleaseProductReservationDto,
  ) {
    const { principal } = request;
    const result = await this.reservations.release({
      tenantId: principal.tenant.id,
      branchId: principal.context.branch!.id,
      userId: principal.user.id,
      reservationId,
      idempotencyKey,
      dto,
    });
    await this.audit.record({
      tenantId: principal.tenant.id,
      actorUserId: principal.user.id,
      action: 'PRODUCT_RESERVATION_RELEASED',
      entityType: 'PRODUCT_RESERVATION',
      entityId: result.data.id,
      correlationId: request.requestId!,
      deduplicate: true,
      after: {
        status: result.data.status,
        closureReason: result.data.closureReason,
      },
    });
    return result;
  }
}
