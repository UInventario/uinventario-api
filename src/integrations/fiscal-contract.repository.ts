import { Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { DataSource } from 'typeorm';
import type { UpdateFiscalContractDto } from './dto/update-fiscal-contract.dto';
import type { FiscalTenantConfiguration } from './fiscal-contract.types';

interface Row {
  id: string;
  country_code: string;
  contract_version: '1';
  provider_profile: 'SIMULATOR' | 'LIVE_GENERIC';
  enabled: number | boolean;
  document_types: string | string[];
  tax_codes: string | string[];
  folio_mode: 'PROVIDER' | 'LOCAL_AUTHORIZED';
  tax_identifier: string | null;
  certificate_secret_reference: string | null;
  private_key_secret_reference: string | null;
  folio_authorization_secret_reference: string | null;
  environment: 'TEST' | 'PRODUCTION' | null;
  updated_at: Date | string;
}

@Injectable()
export class FiscalContractRepository {
  constructor(private readonly dataSource: DataSource) {}

  async tenantCountry(tenantId: string): Promise<string | null | undefined> {
    const [row] = await this.dataSource.query<
      Array<{ country_code: string | null }>
    >('SELECT country_code FROM tenants WHERE id = ? LIMIT 1', [tenantId]);
    return row?.country_code;
  }

  async configuration(
    tenantId: string,
  ): Promise<FiscalTenantConfiguration | null> {
    const [row] = await this.dataSource.query<Row[]>(
      `SELECT id, country_code, contract_version, provider_profile, enabled,
              document_types, tax_codes, folio_mode, tax_identifier,
              certificate_secret_reference, private_key_secret_reference,
              folio_authorization_secret_reference, environment, updated_at
       FROM fiscal_tenant_configs WHERE tenant_id = ? LIMIT 1`,
      [tenantId],
    );
    return row ? this.toData(row) : null;
  }

  async save(
    tenantId: string,
    countryCode: string,
    dto: UpdateFiscalContractDto,
  ): Promise<FiscalTenantConfiguration> {
    await this.dataSource.query(
      `INSERT INTO fiscal_tenant_configs
        (id, tenant_id, country_code, contract_version, provider_profile, enabled,
         document_types, tax_codes, folio_mode, tax_identifier,
         certificate_secret_reference, private_key_secret_reference,
         folio_authorization_secret_reference, environment)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE country_code = VALUES(country_code),
         contract_version = VALUES(contract_version),
         provider_profile = VALUES(provider_profile), enabled = VALUES(enabled),
         document_types = VALUES(document_types), tax_codes = VALUES(tax_codes),
         folio_mode = VALUES(folio_mode), tax_identifier = VALUES(tax_identifier),
         certificate_secret_reference = VALUES(certificate_secret_reference),
         private_key_secret_reference = VALUES(private_key_secret_reference),
         folio_authorization_secret_reference = VALUES(folio_authorization_secret_reference),
         environment = VALUES(environment)`,
      [
        randomUUID(),
        tenantId,
        countryCode,
        dto.contractVersion,
        dto.providerProfile,
        dto.enabled,
        JSON.stringify(dto.documentTypes),
        JSON.stringify(dto.taxCodes),
        dto.folioMode,
        dto.taxIdentifier?.trim() || null,
        dto.certificateSecretReference || null,
        dto.privateKeySecretReference || null,
        dto.folioAuthorizationSecretReference || null,
        dto.environment || null,
      ],
    );
    return (await this.configuration(tenantId))!;
  }

  private toData(row: Row): FiscalTenantConfiguration {
    return {
      id: row.id,
      countryCode: row.country_code,
      contractVersion: row.contract_version,
      providerProfile: row.provider_profile,
      enabled: Boolean(row.enabled),
      documentTypes: this.json(
        row.document_types,
      ) as FiscalTenantConfiguration['documentTypes'],
      taxCodes: this.json(row.tax_codes),
      folioMode: row.folio_mode,
      taxIdentifier: row.tax_identifier,
      certificateSecretReference: row.certificate_secret_reference,
      privateKeySecretReference: row.private_key_secret_reference,
      folioAuthorizationSecretReference:
        row.folio_authorization_secret_reference,
      environment: row.environment,
      updatedAt: new Date(row.updated_at).toISOString(),
    };
  }

  private json(value: string | string[]): string[] {
    return typeof value === 'string' ? (JSON.parse(value) as string[]) : value;
  }
}
