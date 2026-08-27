import {
  Controller,
  Get,
  Query,
  Req,
  StreamableFile,
  UseGuards,
} from '@nestjs/common';
import { SessionGuard } from '../auth/session/session.guard';
import type { AuthenticatedRequest } from '../auth/session/session.types';
import { PermissionGuard } from '../auth/authorization/permission.guard';
import { RequirePermissions } from '../auth/authorization/require-permissions.decorator';
import { AuditService } from './audit.service';
import { ListAuditEventsDto } from './dto/list-audit-events.dto';

@Controller('audit-events')
@UseGuards(SessionGuard, PermissionGuard)
export class AuditController {
  constructor(private readonly audit: AuditService) {}

  @Get()
  @RequirePermissions('AUDIT_VIEW')
  async list(
    @Req() request: AuthenticatedRequest,
    @Query() query: ListAuditEventsDto,
  ) {
    const result = await this.audit.list(request.principal.tenant.id, query);
    await this.audit.recordRequired({
      tenantId: request.principal.tenant.id,
      actorUserId: request.principal.user.id,
      action: 'AUDIT_QUERY_EXECUTED',
      entityType: 'AUDIT_QUERY',
      entityId: request.requestId!,
      correlationId: request.requestId!,
      origin: 'ADMIN_CONSOLE',
      after: {
        filters: this.audit.filtersSnapshot(query),
        results: result.data.length,
      },
    });
    return result;
  }

  @Get('export')
  @RequirePermissions('AUDIT_EXPORT')
  async export(
    @Req() request: AuthenticatedRequest,
    @Query() query: ListAuditEventsDto,
  ) {
    const result = await this.audit.exportCsv(
      request.principal.tenant.id,
      query,
    );
    await this.audit.recordRequired({
      tenantId: request.principal.tenant.id,
      actorUserId: request.principal.user.id,
      action: 'AUDIT_EXPORT_CREATED',
      entityType: 'AUDIT_EXPORT',
      entityId: request.requestId!,
      correlationId: request.requestId!,
      origin: 'ADMIN_CONSOLE',
      after: {
        filters: this.audit.filtersSnapshot(query),
        results: result.count,
      },
    });
    return new StreamableFile(Buffer.from(result.content, 'utf8'), {
      type: 'text/csv; charset=utf-8',
      disposition: `attachment; filename="audit-${new Date().toISOString().slice(0, 10)}.csv"`,
    });
  }
}
