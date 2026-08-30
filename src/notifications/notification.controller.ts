import {
  Body,
  Controller,
  Get,
  HttpCode,
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
import { ListNotificationDeliveriesDto } from './dto/list-notification-deliveries.dto';
import { ListNotificationsDto } from './dto/list-notifications.dto';
import { ReplaceNotificationPreferencesDto } from './dto/replace-notification-preferences.dto';
import { NotificationService } from './notification.service';

@Controller('notifications')
@UseGuards(SessionGuard, PermissionGuard)
export class NotificationController {
  constructor(
    private readonly notifications: NotificationService,
    private readonly audit: AuditService,
  ) {}

  @Post('refresh')
  @HttpCode(200)
  @RequirePermissions('NOTIFICATIONS_VIEW')
  refresh(@Req() request: AuthenticatedRequest) {
    return this.notifications.refresh(request.principal.tenant.id);
  }

  @Get()
  @RequirePermissions('NOTIFICATIONS_VIEW')
  list(
    @Req() request: AuthenticatedRequest,
    @Query() query: ListNotificationsDto,
  ) {
    return this.notifications.list(
      request.principal.tenant.id,
      request.principal.user.id,
      query,
    );
  }

  @Post('read-all')
  @HttpCode(200)
  @RequirePermissions('NOTIFICATIONS_VIEW')
  markAllRead(@Req() request: AuthenticatedRequest) {
    return this.notifications.markAllRead(
      request.principal.tenant.id,
      request.principal.user.id,
    );
  }

  @Post(':id/read')
  @HttpCode(200)
  @RequirePermissions('NOTIFICATIONS_VIEW')
  markRead(
    @Req() request: AuthenticatedRequest,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.notifications.markRead(
      request.principal.tenant.id,
      request.principal.user.id,
      id,
    );
  }

  @Get('preferences')
  @RequirePermissions('NOTIFICATIONS_MANAGE')
  preferences(@Req() request: AuthenticatedRequest) {
    return this.notifications.preferences(request.principal.tenant.id);
  }

  @Put('preferences')
  @RequirePermissions('NOTIFICATIONS_MANAGE')
  async replacePreferences(
    @Req() request: AuthenticatedRequest,
    @Body() dto: ReplaceNotificationPreferencesDto,
  ) {
    const result = await this.notifications.replacePreferences(
      request.principal.tenant.id,
      dto,
    );
    await this.audit.recordRequired({
      tenantId: request.principal.tenant.id,
      actorUserId: request.principal.user.id,
      action: 'NOTIFICATION_PREFERENCES_UPDATED',
      entityType: 'NOTIFICATION_PREFERENCE',
      entityId: request.principal.tenant.id,
      correlationId: request.requestId!,
      after: { rules: dto.preferences.length },
    });
    return result;
  }

  @Get('deliveries')
  @RequirePermissions('NOTIFICATIONS_MANAGE')
  deliveries(
    @Req() request: AuthenticatedRequest,
    @Query() query: ListNotificationDeliveriesDto,
  ) {
    return this.notifications.listDeliveries(
      request.principal.tenant.id,
      query,
    );
  }

  @Post('deliveries/retry')
  @HttpCode(200)
  @RequirePermissions('NOTIFICATIONS_MANAGE')
  async retryDeliveries(@Req() request: AuthenticatedRequest) {
    const result = await this.notifications.retryDeliveries(
      request.principal.tenant.id,
    );
    await this.audit.recordRequired({
      tenantId: request.principal.tenant.id,
      actorUserId: request.principal.user.id,
      action: 'NOTIFICATION_DELIVERIES_RETRIED',
      entityType: 'NOTIFICATION_DELIVERY',
      entityId: request.principal.tenant.id,
      correlationId: request.requestId!,
      after: result.data,
    });
    return result;
  }
}
