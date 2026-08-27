import { Body, Controller, Get, Put, Req, UseGuards } from '@nestjs/common';
import { SessionGuard } from '../auth/session/session.guard';
import type { AuthenticatedRequest } from '../auth/session/session.types';
import { ConfigureCompanyDto } from './dto/configure-company.dto';
import { ConfigureInitialCashRegisterDto } from './dto/configure-initial-cash-register.dto';
import { ConfigureInitialLocationDto } from './dto/configure-initial-location.dto';
import { OnboardingService } from './onboarding.service';
import { AuditService } from '../audit/audit.service';
import { OnboardingAccessGuard } from './onboarding-access.guard';

@Controller('onboarding')
@UseGuards(SessionGuard, OnboardingAccessGuard)
export class OnboardingController {
  constructor(
    private readonly onboarding: OnboardingService,
    private readonly audit: AuditService,
  ) {}

  @Get('company')
  getCompany(@Req() request: AuthenticatedRequest) {
    return this.onboarding.getCompany(request.principal.tenant.id);
  }

  @Put('company')
  async configureCompany(
    @Req() request: AuthenticatedRequest,
    @Body() dto: ConfigureCompanyDto,
  ) {
    const result = await this.onboarding.configureCompany(
      request.principal.tenant.id,
      dto,
    );
    await this.audit.record({
      tenantId: request.principal.tenant.id,
      actorUserId: request.principal.user.id,
      action: 'COMPANY_UPDATED',
      entityType: 'TENANT',
      entityId: request.principal.tenant.id,
      correlationId: request.requestId!,
    });
    return result;
  }

  @Get('initial-location')
  getInitialLocation(@Req() request: AuthenticatedRequest) {
    return this.onboarding.getInitialLocation(request.principal.tenant.id);
  }

  @Put('initial-location')
  configureInitialLocation(
    @Req() request: AuthenticatedRequest,
    @Body() dto: ConfigureInitialLocationDto,
  ) {
    return this.onboarding.configureInitialLocation(
      request.principal.tenant.id,
      request.principal.sessionId,
      dto,
    );
  }

  @Get('initial-cash-register')
  getInitialCashRegister(@Req() request: AuthenticatedRequest) {
    return this.onboarding.getInitialCashRegister(request.principal.tenant.id);
  }

  @Put('initial-cash-register')
  configureInitialCashRegister(
    @Req() request: AuthenticatedRequest,
    @Body() dto: ConfigureInitialCashRegisterDto,
  ) {
    return this.onboarding.configureInitialCashRegister(
      request.principal.tenant.id,
      request.principal.sessionId,
      dto,
    );
  }
}
