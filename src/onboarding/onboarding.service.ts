import { Injectable, NotFoundException } from '@nestjs/common';
import { ConfigureCompanyDto } from './dto/configure-company.dto';
import { CompanyProfile, OnboardingRepository } from './onboarding.repository';
import { CompanyOnboardingResponse } from './onboarding.types';

@Injectable()
export class OnboardingService {
  constructor(private readonly onboarding: OnboardingRepository) {}

  async getCompany(tenantId: string): Promise<CompanyOnboardingResponse> {
    const company = await this.onboarding.findCompany(tenantId);
    if (!company) throw new NotFoundException();
    return this.toResponse(company);
  }

  async configureCompany(
    tenantId: string,
    dto: ConfigureCompanyDto,
  ): Promise<CompanyOnboardingResponse> {
    await this.onboarding.updateCompany(tenantId, dto);
    const company = await this.onboarding.findCompany(tenantId);
    if (!company) throw new NotFoundException();
    return this.toResponse(company);
  }

  private toResponse(company: CompanyProfile): CompanyOnboardingResponse {
    const companyReady = Boolean(company.legalName && company.countryCode);
    const complete = Boolean(company.onboardingCompletedAt);
    return {
      data: {
        company: {
          legalName: company.legalName,
          tradeName: company.tradeName,
          countryCode: company.countryCode,
        },
        progress: {
          currentStep: complete
            ? 'COMPLETE'
            : companyReady
              ? 'BRANCH'
              : 'COMPANY',
          completedSteps: companyReady ? ['COMPANY'] : [],
        },
      },
      meta: { apiVersion: '1' },
    };
  }
}
