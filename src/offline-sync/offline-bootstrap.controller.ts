import {
  Body,
  Controller,
  Get,
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

@Controller('offline')
@UseGuards(SessionGuard)
export class OfflineBootstrapController {
  constructor(
    private readonly bootstrapService: OfflineBootstrapService,
    private readonly changesService: OfflineChangesService,
    private readonly commandService: OfflineCommandService,
  ) {}

  @Get('bootstrap')
  async bootstrap(
    @Req() request: AuthenticatedRequest,
    @Query() query: OfflineBootstrapQueryDto,
  ) {
    return {
      data: await this.bootstrapService.bootstrap(request.principal, query),
    };
  }

  @Get('changes')
  async changes(
    @Req() request: AuthenticatedRequest,
    @Query() query: OfflineChangesQueryDto,
  ) {
    return {
      data: await this.changesService.changes(request.principal, query),
    };
  }

  @Post('commands/batch')
  commands(
    @Req() request: AuthenticatedRequest,
    @Body() dto: OfflineCommandBatchDto,
  ) {
    return this.commandService.executeBatch(
      request.principal,
      dto,
      request.requestId!,
    );
  }
}
