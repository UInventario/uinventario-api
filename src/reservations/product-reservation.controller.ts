import {
  Body,
  Controller,
  Get,
  Headers,
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
}
