import { Controller, Get, Query, Req, UseGuards } from '@nestjs/common';
import { SessionGuard } from '../auth/session/session.guard';
import type { AuthenticatedRequest } from '../auth/session/session.types';
import { AuditAccessGuard } from './audit-access.guard';
import { AuditService } from './audit.service';
import { ListAuditEventsDto } from './dto/list-audit-events.dto';

@Controller('audit-events')
@UseGuards(SessionGuard, AuditAccessGuard)
export class AuditController {
  constructor(private readonly audit: AuditService) {}

  @Get()
  list(
    @Req() request: AuthenticatedRequest,
    @Query() query: ListAuditEventsDto,
  ) {
    return this.audit.list(request.principal.tenant.id, query);
  }
}
