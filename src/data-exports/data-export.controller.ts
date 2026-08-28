import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Post,
  Req,
  StreamableFile,
  UseGuards,
} from '@nestjs/common';
import { SessionGuard } from '../auth/session/session.guard';
import type { AuthenticatedRequest } from '../auth/session/session.types';
import { PermissionGuard } from '../auth/authorization/permission.guard';
import { RequirePermissions } from '../auth/authorization/require-permissions.decorator';
import { AuditService } from '../audit/audit.service';
import { DataExportService } from './data-export.service';
import { CreateDataExportDto } from './dto/create-data-export.dto';

@Controller('data-exports')
@UseGuards(SessionGuard, PermissionGuard)
@RequirePermissions('AUDIT_EXPORT')
export class DataExportController {
  constructor(
    private readonly exports: DataExportService,
    private readonly audit: AuditService,
  ) {}

  @Post()
  @HttpCode(202)
  async create(
    @Req() request: AuthenticatedRequest,
    @Body() dto: CreateDataExportDto,
  ) {
    const { principal } = request;
    const result = await this.exports.create({
      tenantId: principal.tenant.id,
      userId: principal.user.id,
      permissions: principal.user.permissions,
      branchId: principal.context.branch?.id ?? null,
      warehouseId: principal.context.warehouse?.id ?? null,
      dto,
    });
    await this.audit.recordRequired({
      tenantId: principal.tenant.id,
      actorUserId: principal.user.id,
      action: 'DATA_EXPORT_REQUESTED',
      entityType: 'DATA_EXPORT',
      entityId: result.data.id,
      correlationId: request.requestId!,
      after: { dataset: dto.dataset, format: dto.format },
    });
    return result;
  }

  @Get(':id')
  get(
    @Req() request: AuthenticatedRequest,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.exports.get(
      request.principal.tenant.id,
      request.principal.user.id,
      id,
    );
  }

  @Post(':id/retry')
  @HttpCode(202)
  retry(
    @Req() request: AuthenticatedRequest,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.exports.retry(
      request.principal.tenant.id,
      request.principal.user.id,
      id,
    );
  }

  @Get(':id/download')
  async download(
    @Req() request: AuthenticatedRequest,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    const file = await this.exports.download(
      request.principal.tenant.id,
      request.principal.user.id,
      id,
    );
    return new StreamableFile(file.content, {
      type: file.contentType,
      disposition: `attachment; filename="${file.filename}"`,
    });
  }
}
