import {
  Body,
  Controller,
  Get,
  Headers,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { PermissionGuard } from '../auth/authorization/permission.guard';
import { RequirePermissions } from '../auth/authorization/require-permissions.decorator';
import { SessionGuard } from '../auth/session/session.guard';
import type { AuthenticatedRequest } from '../auth/session/session.types';
import { ErpExportQueryDto } from './dto/erp-export-query.dto';
import { ImportErpMappingsDto } from './dto/import-erp-mappings.dto';
import { ErpIntegrationService } from './erp-integration.service';

@Controller('integrations/erp/v1')
@UseGuards(SessionGuard, PermissionGuard)
@RequirePermissions('TENANT_MANAGE')
export class ErpIntegrationController {
  constructor(private readonly erp: ErpIntegrationService) {}

  @Get('contract')
  contract() {
    return this.erp.contract();
  }

  @Get('exports')
  export(
    @Req() request: AuthenticatedRequest,
    @Query() query: ErpExportQueryDto,
  ) {
    return this.erp.export(request.principal.tenant.id, query);
  }

  @Post('mappings/imports')
  import(
    @Req() request: AuthenticatedRequest,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Body() dto: ImportErpMappingsDto,
  ) {
    return this.erp.import({
      tenantId: request.principal.tenant.id,
      userId: request.principal.user.id,
      correlationId: request.requestId!,
      idempotencyKey: idempotencyKey ?? '',
      dto,
    });
  }

  @Get('mappings')
  mappings(
    @Req() request: AuthenticatedRequest,
    @Query('provider') provider: string,
  ) {
    return this.erp.mappings(request.principal.tenant.id, provider);
  }

  @Get('imports')
  runs(
    @Req() request: AuthenticatedRequest,
    @Query('provider') provider: string,
  ) {
    return this.erp.runs(request.principal.tenant.id, provider);
  }
}
