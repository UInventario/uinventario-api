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
  ) {}

  @Get('bootstrap')
  async bootstrap(
    @Req() request: AuthenticatedRequest,
    @Query() query: OfflineBootstrapQueryDto,
  ) {
    await this.devices.touchOrAssert(request.principal, query.deviceId);
    return {
      data: await this.bootstrapService.bootstrap(request.principal, query),
    };
  }

  @Get('changes')
  async changes(
    @Req() request: AuthenticatedRequest,
    @Query() query: OfflineChangesQueryDto,
  ) {
    await this.devices.touchOrAssert(request.principal, query.deviceId);
    return {
      data: await this.changesService.changes(request.principal, query),
    };
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
    return this.commandService.executeBatch(
      request.principal,
      dto,
      request.requestId!,
    );
  }

  @Get('devices')
  devicesForUser(@Req() request: AuthenticatedRequest) {
    return this.devices.list(request.principal);
  }

  @Delete('devices/:deviceId')
  async revokeDevice(
    @Req() request: AuthenticatedRequest,
    @Param('deviceId', new ParseUUIDPipe()) deviceId: string,
  ): Promise<void> {
    await this.devices.revoke(request.principal, deviceId);
  }
}
