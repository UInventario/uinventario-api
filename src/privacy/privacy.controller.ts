import {
  Body,
  Controller,
  Get,
  Headers,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Req,
  StreamableFile,
  UseGuards,
} from '@nestjs/common';
import { PermissionGuard } from '../auth/authorization/permission.guard';
import { RequirePermissions } from '../auth/authorization/require-permissions.decorator';
import { SessionGuard } from '../auth/session/session.guard';
import type { AuthenticatedRequest } from '../auth/session/session.types';
import {
  CreatePrivacyLegalHoldDto,
  PrivacyActionDto,
  UpdatePrivacyPolicyDto,
} from './dto/privacy-action.dto';
import { PrivacyService } from './privacy.service';

@Controller('privacy')
@UseGuards(SessionGuard, PermissionGuard)
@RequirePermissions('PRIVACY_MANAGE')
export class PrivacyController {
  constructor(private readonly privacy: PrivacyService) {}

  @Get('classification')
  classification() {
    return this.privacy.classification();
  }

  @Get('policy')
  policy(@Req() request: AuthenticatedRequest) {
    return this.privacy.policy(request.principal.tenant.id);
  }

  @Patch('policy')
  updatePolicy(
    @Req() request: AuthenticatedRequest,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Body() dto: UpdatePrivacyPolicyDto,
  ) {
    return this.privacy.updatePolicy({
      tenantId: request.principal.tenant.id,
      userId: request.principal.user.id,
      correlationId: request.requestId!,
      idempotencyKey,
      dto,
    });
  }

  @Get('customers/:id/report')
  report(
    @Req() request: AuthenticatedRequest,
    @Param('id', ParseUUIDPipe) customerId: string,
  ) {
    return this.privacy.report(request.principal.tenant.id, customerId);
  }

  @Get('customers/:id/export')
  async export(
    @Req() request: AuthenticatedRequest,
    @Param('id', ParseUUIDPipe) customerId: string,
  ) {
    const report = await this.privacy.report(
      request.principal.tenant.id,
      customerId,
    );
    await this.privacy.recordExport({
      tenantId: request.principal.tenant.id,
      customerId,
      userId: request.principal.user.id,
      correlationId: request.requestId!,
    });
    return new StreamableFile(Buffer.from(JSON.stringify(report, null, 2)), {
      type: 'application/json; charset=utf-8',
      disposition: `attachment; filename="customer-${customerId}-privacy.json"`,
    });
  }

  @Post('customers/:id/legal-holds')
  createLegalHold(
    @Req() request: AuthenticatedRequest,
    @Param('id', ParseUUIDPipe) customerId: string,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Body() dto: CreatePrivacyLegalHoldDto,
  ) {
    return this.privacy.createLegalHold({
      tenantId: request.principal.tenant.id,
      customerId,
      userId: request.principal.user.id,
      correlationId: request.requestId!,
      idempotencyKey,
      dto,
    });
  }

  @Post('customers/:id/legal-holds/release')
  releaseLegalHold(
    @Req() request: AuthenticatedRequest,
    @Param('id', ParseUUIDPipe) customerId: string,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Body() dto: PrivacyActionDto,
  ) {
    return this.privacy.releaseLegalHold({
      tenantId: request.principal.tenant.id,
      customerId,
      userId: request.principal.user.id,
      correlationId: request.requestId!,
      idempotencyKey,
      dto,
    });
  }

  @Post('customers/:id/anonymization')
  anonymize(
    @Req() request: AuthenticatedRequest,
    @Param('id', ParseUUIDPipe) customerId: string,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Body() dto: PrivacyActionDto,
  ) {
    return this.privacy.anonymize({
      tenantId: request.principal.tenant.id,
      customerId,
      userId: request.principal.user.id,
      correlationId: request.requestId!,
      idempotencyKey,
      dto,
    });
  }
}
