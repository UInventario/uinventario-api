import { Controller, Get, Query, Req, UseGuards } from '@nestjs/common';
import { SessionGuard } from '../auth/session/session.guard';
import type { AuthenticatedRequest } from '../auth/session/session.types';
import { OfflineBootstrapQueryDto } from './dto/offline-bootstrap-query.dto';
import { OfflineBootstrapService } from './offline-bootstrap.service';

@Controller('offline')
@UseGuards(SessionGuard)
export class OfflineBootstrapController {
  constructor(private readonly bootstrapService: OfflineBootstrapService) {}

  @Get('bootstrap')
  async bootstrap(
    @Req() request: AuthenticatedRequest,
    @Query() query: OfflineBootstrapQueryDto,
  ) {
    return {
      data: await this.bootstrapService.bootstrap(request.principal, query),
    };
  }
}
