import {
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { ConfigureCompanyDto } from './dto/configure-company.dto';
import { ConfigureInitialLocationDto } from './dto/configure-initial-location.dto';
import { CompanyProfile, OnboardingRepository } from './onboarding.repository';
import {
  CompanyOnboardingResponse,
  InitialLocationResponse,
} from './onboarding.types';

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

  async getInitialLocation(tenantId: string): Promise<InitialLocationResponse> {
    return {
      data: await this.onboarding.findInitialLocation(tenantId),
      meta: { apiVersion: '1' },
    };
  }

  async configureInitialLocation(
    tenantId: string,
    sessionId: string,
    dto: ConfigureInitialLocationDto,
  ): Promise<InitialLocationResponse> {
    try {
      return {
        data: await this.onboarding.createInitialLocation(
          tenantId,
          sessionId,
          dto,
        ),
        meta: { apiVersion: '1' },
      };
    } catch (error) {
      if (
        error instanceof Error &&
        error.message === 'COMPANY_NOT_CONFIGURED'
      ) {
        throw new ConflictException({
          code: 'COMPANY_NOT_CONFIGURED',
          message: 'Configura la empresa antes de crear la sucursal.',
        });
      }
      throw error;
    }
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
