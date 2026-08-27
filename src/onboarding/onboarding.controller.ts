import { Body, Controller, Get, Put, Req, UseGuards } from '@nestjs/common';
import { SessionGuard } from '../auth/session/session.guard';
import type { AuthenticatedRequest } from '../auth/session/session.types';
import { ConfigureCompanyDto } from './dto/configure-company.dto';
import { OnboardingService } from './onboarding.service';

@Controller('onboarding/company')
@UseGuards(SessionGuard)
export class OnboardingController {
  constructor(private readonly onboarding: OnboardingService) {}

  @Get()
  getCompany(@Req() request: AuthenticatedRequest) {
    return this.onboarding.getCompany(request.principal.tenant.id);
  }

  @Put()
  configureCompany(
    @Req() request: AuthenticatedRequest,
    @Body() dto: ConfigureCompanyDto,
  ) {
    return this.onboarding.configureCompany(request.principal.tenant.id, dto);
  }
}
