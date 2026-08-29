import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Headers,
  Param,
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
import { DiagnoseExternalAdapterDto } from './dto/diagnose-external-adapter.dto';
import { ListExternalAdapterExecutionsDto } from './dto/list-external-adapter-executions.dto';
import { UpdateExternalAdapterConfigDto } from './dto/update-external-adapter-config.dto';
import { ExternalAdapterService } from './external-adapter.service';

@Controller('integrations/adapters')
@UseGuards(SessionGuard, PermissionGuard)
@RequirePermissions('TENANT_MANAGE')
export class ExternalAdapterController {
  constructor(
    private readonly adapters: ExternalAdapterService,
    private readonly audit: AuditService,
  ) {}

  @Get()
  configurations(@Req() request: AuthenticatedRequest) {
    return this.adapters.configurations(request.principal.tenant.id);
  }

  @Get('executions')
  executions(
    @Req() request: AuthenticatedRequest,
    @Query() query: ListExternalAdapterExecutionsDto,
  ) {
    return this.adapters.executions(request.principal.tenant.id, query);
  }

  @Put(':capability')
  async update(
    @Req() request: AuthenticatedRequest,
    @Param('capability') capability: string,
    @Body() dto: UpdateExternalAdapterConfigDto,
  ) {
    const result = await this.adapters.update(
      request.principal.tenant.id,
      capability,
      dto,
    );
    await this.audit.recordRequired({
      tenantId: request.principal.tenant.id,
      actorUserId: request.principal.user.id,
      action: 'EXTERNAL_ADAPTER_CONFIG_UPDATED',
      entityType: 'EXTERNAL_ADAPTER_CONFIG',
      entityId: result.data.id,
      correlationId: request.requestId!,
      after: {
        capability: result.data.capability,
        countryCode: result.data.countryCode,
        provider: result.data.provider,
        adapterVersion: result.data.adapterVersion,
        enabled: result.data.enabled,
        timeoutMs: result.data.timeoutMs,
        maxAttempts: result.data.maxAttempts,
        secretReference: result.data.secretReference,
      },
    });
    return result;
  }

  @Post(':capability/diagnostics')
  async diagnose(
    @Req() request: AuthenticatedRequest,
    @Param('capability') capabilityValue: string,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Body() dto: DiagnoseExternalAdapterDto,
  ) {
    if (
      !idempotencyKey ||
      !/^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/.test(idempotencyKey)
    )
      throw new BadRequestException('IDEMPOTENCY_KEY_REQUIRED');
    const result = await this.adapters.diagnose({
      tenantId: request.principal.tenant.id,
      capabilityValue,
      idempotencyKey,
      correlationId: request.requestId!,
      dto,
    });
    await this.audit.recordRequired({
      tenantId: request.principal.tenant.id,
      actorUserId: request.principal.user.id,
      action: 'EXTERNAL_ADAPTER_DIAGNOSED',
      entityType: 'EXTERNAL_ADAPTER_EXECUTION',
      entityId: result.data.id,
      correlationId: request.requestId!,
      after: {
        capability: result.data.capability,
        status: result.data.status,
        attemptCount: result.data.attemptCount,
        errorCode: result.data.errorCode,
      },
    });
    return result;
  }
}
