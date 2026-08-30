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
import {
  SavePriceListDto,
  UpdatePriceListDto,
} from './dto/save-price-list.dto';
import { PriceListService } from './price-list.service';

@Controller('price-lists')
@UseGuards(SessionGuard, PermissionGuard)
@RequirePermissions('PRODUCTS_MANAGE')
export class PriceListController {
  constructor(
    private readonly service: PriceListService,
    private readonly audit: AuditService,
  ) {}

  @Get()
  list(@Req() request: AuthenticatedRequest) {
    return this.service.list(request.principal.tenant.id);
  }

  @Post()
  async create(
    @Req() request: AuthenticatedRequest,
    @Body() dto: SavePriceListDto,
  ) {
    const result = await this.service.create(request.principal.tenant.id, dto);
    await this.record(
      request,
      result.data.id,
      'PRICE_LIST_CREATED',
      result.data,
    );
    return result;
  }

  @Put(':id')
  async update(
    @Req() request: AuthenticatedRequest,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdatePriceListDto,
  ) {
    const result = await this.service.update(
      request.principal.tenant.id,
      id,
      dto,
    );
    await this.record(request, id, 'PRICE_LIST_UPDATED', result.data);
    return result;
  }

  private record(
    request: AuthenticatedRequest,
    entityId: string,
    action: string,
    data: { priority: number; active: boolean; items: unknown[] },
  ) {
    return this.audit.record({
      tenantId: request.principal.tenant.id,
      actorUserId: request.principal.user.id,
      action,
      entityType: 'PRICE_LIST',
      entityId,
      correlationId: request.requestId!,
      after: {
        priority: data.priority,
        active: data.active,
        itemCount: data.items.length,
      },
    });
  }
}
