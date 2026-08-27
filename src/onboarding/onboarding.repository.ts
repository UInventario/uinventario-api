import { Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { TenantEntity } from '../tenancy/entities/tenant.entity';

export interface CompanyProfile {
  legalName: string | null;
  tradeName: string;
  countryCode: string | null;
  onboardingCompletedAt: Date | null;
}

@Injectable()
export class OnboardingRepository {
  constructor(private readonly dataSource: DataSource) {}

  async findCompany(tenantId: string): Promise<CompanyProfile | null> {
    const tenant = await this.dataSource.manager.findOne(TenantEntity, {
      where: { id: tenantId },
    });
    if (!tenant) return null;

    return {
      legalName: tenant.legalName,
      tradeName: tenant.name,
      countryCode: tenant.countryCode,
      onboardingCompletedAt: tenant.onboardingCompletedAt,
    };
  }

  async updateCompany(
    tenantId: string,
    input: { legalName: string; tradeName: string; countryCode: string },
  ): Promise<void> {
    await this.dataSource.manager.update(
      TenantEntity,
      { id: tenantId },
      {
        legalName: input.legalName,
        name: input.tradeName,
        countryCode: input.countryCode,
      },
    );
  }
}
