import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type { UpdateFiscalContractDto } from './dto/update-fiscal-contract.dto';
import { FiscalContractRegistry } from './fiscal-contract.registry';
import { FiscalContractRepository } from './fiscal-contract.repository';

@Injectable()
export class FiscalContractService {
  constructor(
    private readonly repository: FiscalContractRepository,
    private readonly registry: FiscalContractRegistry,
  ) {}

  async get(tenantId: string) {
    const countryCode = await this.country(tenantId);
    const contract = this.registry.get(countryCode);
    if (!contract) {
      return {
        data: {
          countryCode,
          configuration: null,
          contract: null,
          validation: null,
        },
        meta: { apiVersion: '1' as const, supportedCountries: ['MX', 'CL'] },
      };
    }
    const configuration =
      (await this.repository.configuration(tenantId)) ??
      this.registry.draft(contract);
    return {
      data: {
        countryCode,
        configuration,
        contract,
        validation: this.registry.validate(contract, configuration),
      },
      meta: { apiVersion: '1' as const, supportedCountries: ['MX', 'CL'] },
    };
  }

  async update(tenantId: string, dto: UpdateFiscalContractDto) {
    const countryCode = await this.country(tenantId);
    const contract = this.registry.get(countryCode, dto.contractVersion);
    if (!contract)
      throw new BadRequestException('FISCAL_COUNTRY_NOT_SUPPORTED');
    const candidate = {
      ...this.registry.draft(contract),
      ...dto,
      countryCode,
      taxIdentifier: dto.taxIdentifier ?? null,
      certificateSecretReference: dto.certificateSecretReference ?? null,
      privateKeySecretReference: dto.privateKeySecretReference ?? null,
      folioAuthorizationSecretReference:
        dto.folioAuthorizationSecretReference ?? null,
      environment: dto.environment ?? null,
    };
    const validation = this.registry.validate(contract, candidate);
    if (dto.enabled && !validation.valid) {
      throw new BadRequestException({
        code: 'FISCAL_REQUIREMENTS_MISSING',
        validation,
      });
    }
    const configuration = await this.repository.save(
      tenantId,
      countryCode,
      dto,
    );
    return {
      data: { countryCode, configuration, contract, validation },
      meta: { apiVersion: '1' as const },
    };
  }

  catalog() {
    return {
      data: this.registry.catalog(),
      meta: { apiVersion: '1' as const },
    };
  }

  private async country(tenantId: string): Promise<string> {
    const country = await this.repository.tenantCountry(tenantId);
    if (country === undefined) throw new NotFoundException();
    if (!country) throw new BadRequestException('TENANT_COUNTRY_REQUIRED');
    return country;
  }
}
