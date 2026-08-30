import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Post,
  Put,
  Req,
  UseGuards,
} from '@nestjs/common';
import { AuditService } from '../audit/audit.service';
import { PermissionGuard } from '../auth/authorization/permission.guard';
import { RequirePermissions } from '../auth/authorization/require-permissions.decorator';
import { SessionGuard } from '../auth/session/session.guard';
import type { AuthenticatedRequest } from '../auth/session/session.types';
import { SavePromotionDto, UpdatePromotionDto } from './dto/save-promotion.dto';
import { PromotionService } from './promotion.service';

@Controller('promotions')
@UseGuards(SessionGuard, PermissionGuard)
@RequirePermissions('PRODUCTS_MANAGE')
export class PromotionController {
  constructor(
    private readonly service: PromotionService,
    private readonly audit: AuditService,
  ) {}

  @Get()
  list(@Req() request: AuthenticatedRequest) {
    return this.service.list(request.principal.tenant.id);
  }

  @Post()
  async create(
    @Req() request: AuthenticatedRequest,
    @Body() dto: SavePromotionDto,
  ) {
    const result = await this.service.create(request.principal.tenant.id, dto);
    await this.record(
      request,
      result.data.id,
      'PROMOTION_CREATED',
      result.data,
    );
    return result;
  }

  @Put(':id')
  async update(
    @Req() request: AuthenticatedRequest,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdatePromotionDto,
  ) {
    const result = await this.service.update(
      request.principal.tenant.id,
      id,
      dto,
    );
    await this.record(request, id, 'PROMOTION_UPDATED', result.data);
    return result;
  }

  private record(
    request: AuthenticatedRequest,
    entityId: string,
    action: string,
    data: { type: string; priority: number; active: boolean },
  ) {
    return this.audit.record({
      tenantId: request.principal.tenant.id,
      actorUserId: request.principal.user.id,
      action,
      entityType: 'PROMOTION',
      entityId,
      correlationId: request.requestId!,
      after: { type: data.type, priority: data.priority, active: data.active },
    });
  }
}
