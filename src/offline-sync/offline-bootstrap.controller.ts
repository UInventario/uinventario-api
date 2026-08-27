import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { SessionGuard } from '../auth/session/session.guard';
import type { AuthenticatedRequest } from '../auth/session/session.types';
import { PermissionGuard } from '../auth/authorization/permission.guard';
import { RequirePermissions } from '../auth/authorization/require-permissions.decorator';
import { AuditService } from '../audit/audit.service';
import { OfflineBootstrapQueryDto } from './dto/offline-bootstrap-query.dto';
import { OfflineBootstrapService } from './offline-bootstrap.service';
import { OfflineChangesQueryDto } from './dto/offline-changes-query.dto';
import { OfflineChangesService } from './offline-changes.service';
import { OfflineCommandBatchDto } from './dto/offline-command-batch.dto';
import { OfflineCommandService } from './offline-command.service';
import { OfflineDeviceService } from './offline-device.service';

@Controller('offline')
@UseGuards(SessionGuard)
export class OfflineBootstrapController {
  constructor(
    private readonly bootstrapService: OfflineBootstrapService,
    private readonly changesService: OfflineChangesService,
    private readonly commandService: OfflineCommandService,
    private readonly devices: OfflineDeviceService,
    private readonly audit: AuditService,
  ) {}

  @Get('bootstrap')
  async bootstrap(
    @Req() request: AuthenticatedRequest,
    @Query() query: OfflineBootstrapQueryDto,
  ) {
    await this.devices.touchOrAssert(
      request.principal,
      query.deviceId,
      'BOOTSTRAP',
    );
    const data = await this.bootstrapService.bootstrap(
      request.principal,
      query,
    );
    if (data.page.complete) {
      await this.devices.markSync({
        principal: request.principal,
        deviceId: query.deviceId,
        cursor: data.page.initialSyncCursor,
        correlationId: request.requestId!,
        bootstrapComplete: true,
      });
    } else {
      await this.devices.markActivity(
        request.principal,
        query.deviceId,
        request.requestId!,
      );
    }
    return {
      data,
    };
  }

  @Get('changes')
  async changes(
    @Req() request: AuthenticatedRequest,
    @Query() query: OfflineChangesQueryDto,
  ) {
    await this.devices.touchOrAssert(request.principal, query.deviceId);
    const data = await this.changesService.changes(request.principal, query);
    await this.devices.markSync({
      principal: request.principal,
      deviceId: query.deviceId,
      cursor: data.nextCursor,
      correlationId: request.requestId!,
    });
    return { data };
  }

  @Post('commands/batch')
  async commands(
    @Req() request: AuthenticatedRequest,
    @Body() dto: OfflineCommandBatchDto,
  ) {
    for (const deviceId of new Set(
      dto.commands.map(({ scope }) => scope.deviceId),
    )) {
      await this.devices.touchOrAssert(request.principal, deviceId);
    }
    const result = await this.commandService.executeBatch(
      request.principal,
      dto,
      request.requestId!,
    );
    await Promise.all(
      [...new Set(dto.commands.map(({ scope }) => scope.deviceId))].map(
        (deviceId) =>
          this.devices.markActivity(
            request.principal,
            deviceId,
            request.requestId!,
          ),
      ),
    );
    return result;
  }

  @Get('devices')
  @UseGuards(PermissionGuard)
  @RequirePermissions('ACCESS_MANAGE')
  devicesForUser(@Req() request: AuthenticatedRequest) {
    return this.devices.list(request.principal);
  }

  @Delete('devices/:deviceId')
  @UseGuards(PermissionGuard)
  @RequirePermissions('ACCESS_MANAGE')
  async revokeDevice(
    @Req() request: AuthenticatedRequest,
    @Param('deviceId', new ParseUUIDPipe()) deviceId: string,
  ): Promise<void> {
    await this.devices.revoke(request.principal, deviceId);
    await this.audit.recordRequired({
      tenantId: request.principal.tenant.id,
      actorUserId: request.principal.user.id,
      action: 'OFFLINE_DEVICE_REVOKED',
      entityType: 'OFFLINE_DEVICE',
      entityId: deviceId,
      correlationId: request.requestId!,
      after: { bootstrapRequired: true },
    });
  }
}
