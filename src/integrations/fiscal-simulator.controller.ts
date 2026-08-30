import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Headers,
  Param,
  ParseUUIDPipe,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import { AuditService } from '../audit/audit.service';
import { PermissionGuard } from '../auth/authorization/permission.guard';
import { RequirePermissions } from '../auth/authorization/require-permissions.decorator';
import { SessionGuard } from '../auth/session/session.guard';
import type { AuthenticatedRequest } from '../auth/session/session.types';
import { FiscalSimulatorCallbackDto } from './dto/fiscal-simulator-callback.dto';
import { IssueSimulatedFiscalDocumentDto } from './dto/issue-simulated-fiscal-document.dto';
import { FiscalSimulatorService } from './fiscal-simulator.service';

@Controller('integrations/fiscal/simulator')
@UseGuards(SessionGuard, PermissionGuard)
@RequirePermissions('TENANT_MANAGE')
export class FiscalSimulatorController {
  constructor(
    private readonly simulator: FiscalSimulatorService,
    private readonly audit: AuditService,
  ) {}

  @Get('documents')
  list(@Req() request: AuthenticatedRequest) {
    return this.simulator.list(request.principal.tenant.id);
  }

  @Post('documents')
  async issue(
    @Req() request: AuthenticatedRequest,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Body() dto: IssueSimulatedFiscalDocumentDto,
  ) {
    const result = await this.simulator.issue({
      tenantId: request.principal.tenant.id,
      idempotencyKey: idempotencyKey ?? '',
      dto,
    });
    await this.record(
      request,
      result.data.id,
      'FISCAL_SIMULATOR_DOCUMENT_ISSUED',
      result.data,
    );
    return result;
  }

  @Post('documents/:documentId/queries')
  async query(
    @Req() request: AuthenticatedRequest,
    @Param('documentId', ParseUUIDPipe) documentId: string,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
  ) {
    const result = await this.simulator.query(
      request.principal.tenant.id,
      documentId,
      idempotencyKey ?? '',
    );
    await this.record(
      request,
      documentId,
      'FISCAL_SIMULATOR_DOCUMENT_QUERIED',
      result.data,
    );
    return result;
  }

  @Post('documents/:documentId/cancellations')
  async cancel(
    @Req() request: AuthenticatedRequest,
    @Param('documentId', ParseUUIDPipe) documentId: string,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
  ) {
    const result = await this.simulator.cancel(
      request.principal.tenant.id,
      documentId,
      idempotencyKey ?? '',
    );
    await this.record(
      request,
      documentId,
      'FISCAL_SIMULATOR_DOCUMENT_CANCELLED',
      result.data,
    );
    return result;
  }

  @Post('callbacks')
  async callback(
    @Req() request: AuthenticatedRequest,
    @Body() dto: FiscalSimulatorCallbackDto,
  ) {
    const result = await this.simulator.callback(
      request.principal.tenant.id,
      dto,
    );
    await this.record(
      request,
      dto.documentId,
      'FISCAL_SIMULATOR_CALLBACK_RECEIVED',
      result.data,
    );
    return result;
  }

  @Get('documents/:documentId/artifacts/:kind')
  download(
    @Req() request: AuthenticatedRequest,
    @Param('documentId', ParseUUIDPipe) documentId: string,
    @Param('kind') kindValue: string,
  ) {
    if (!['PDF', 'XML'].includes(kindValue)) {
      throw new BadRequestException('FISCAL_ARTIFACT_KIND_INVALID');
    }
    return this.simulator.download(
      request.principal.tenant.id,
      documentId,
      kindValue as 'PDF' | 'XML',
    );
  }

  private record(
    request: AuthenticatedRequest,
    entityId: string,
    action: string,
    document: {
      status: string;
      documentType: string;
      scenario: string;
      errorCode: string | null;
    },
  ) {
    return this.audit.recordRequired({
      tenantId: request.principal.tenant.id,
      actorUserId: request.principal.user.id,
      action,
      entityType: 'FISCAL_SIMULATOR_DOCUMENT',
      entityId,
      correlationId: request.requestId!,
      deduplicate: true,
      after: {
        status: document.status,
        documentType: document.documentType,
        scenario: document.scenario,
        errorCode: document.errorCode,
      },
    });
  }
}
