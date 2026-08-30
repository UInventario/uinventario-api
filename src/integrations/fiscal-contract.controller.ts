import { Body, Controller, Get, Put, Req, UseGuards } from '@nestjs/common';
import { AuditService } from '../audit/audit.service';
import { PermissionGuard } from '../auth/authorization/permission.guard';
import { RequirePermissions } from '../auth/authorization/require-permissions.decorator';
import { SessionGuard } from '../auth/session/session.guard';
import type { AuthenticatedRequest } from '../auth/session/session.types';
import { UpdateFiscalContractDto } from './dto/update-fiscal-contract.dto';
import { FiscalContractService } from './fiscal-contract.service';

@Controller('integrations/fiscal')
@UseGuards(SessionGuard, PermissionGuard)
@RequirePermissions('TENANT_MANAGE')
export class FiscalContractController {
  constructor(
    private readonly fiscal: FiscalContractService,
    private readonly audit: AuditService,
  ) {}

  @Get('configuration')
  configuration(@Req() request: AuthenticatedRequest) {
    return this.fiscal.get(request.principal.tenant.id);
  }

  @Get('contracts')
  contracts() {
    return this.fiscal.catalog();
  }

  @Put('configuration')
  async update(
    @Req() request: AuthenticatedRequest,
    @Body() dto: UpdateFiscalContractDto,
  ) {
    const result = await this.fiscal.update(request.principal.tenant.id, dto);
    await this.audit.recordRequired({
      tenantId: request.principal.tenant.id,
      actorUserId: request.principal.user.id,
      action: 'FISCAL_CONTRACT_CONFIG_UPDATED',
      entityType: 'FISCAL_TENANT_CONFIG',
      entityId: result.data.configuration.id!,
      correlationId: request.requestId!,
      after: {
        countryCode: result.data.countryCode,
        contractVersion: result.data.configuration.contractVersion,
        providerProfile: result.data.configuration.providerProfile,
        enabled: result.data.configuration.enabled,
        documentTypes: result.data.configuration.documentTypes,
        taxCodes: result.data.configuration.taxCodes,
        folioMode: result.data.configuration.folioMode,
        taxIdentifierConfigured: Boolean(
          result.data.configuration.taxIdentifier,
        ),
        certificateConfigured: Boolean(
          result.data.configuration.certificateSecretReference,
        ),
        privateKeyConfigured: Boolean(
          result.data.configuration.privateKeySecretReference,
        ),
        folioAuthorizationConfigured: Boolean(
          result.data.configuration.folioAuthorizationSecretReference,
        ),
      },
    });
    return result;
  }
}
