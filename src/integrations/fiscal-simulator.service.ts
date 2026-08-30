import {
  BadRequestException,
  ConflictException,
  Injectable,
} from '@nestjs/common';
import type { FiscalSimulatorCallbackDto } from './dto/fiscal-simulator-callback.dto';
import type { IssueSimulatedFiscalDocumentDto } from './dto/issue-simulated-fiscal-document.dto';
import { FiscalContractRegistry } from './fiscal-contract.registry';
import { FiscalContractRepository } from './fiscal-contract.repository';
import { FiscalSimulatorIdempotencyConflictError } from './fiscal-simulator.errors';
import { FiscalSimulatorRepository } from './fiscal-simulator.repository';
import type { FiscalArtifactKind } from './fiscal-provider-adapter.types';

@Injectable()
export class FiscalSimulatorService {
  constructor(
    private readonly simulator: FiscalSimulatorRepository,
    private readonly fiscalConfigs: FiscalContractRepository,
    private readonly contracts: FiscalContractRegistry,
  ) {}

  async list(tenantId: string) {
    return { data: await this.simulator.list(tenantId), meta: this.meta() };
  }

  async issue(input: {
    tenantId: string;
    idempotencyKey: string;
    dto: IssueSimulatedFiscalDocumentDto;
  }) {
    this.key(input.idempotencyKey);
    const config = await this.configuration(input.tenantId);
    if (!config.documentTypes.includes(input.dto.documentType)) {
      throw new BadRequestException('FISCAL_DOCUMENT_TYPE_NOT_CONFIGURED');
    }
    try {
      const result = await this.simulator.issue({
        ...input,
        countryCode: config.countryCode,
        contractVersion: config.contractVersion,
      });
      return {
        data: result.document,
        meta: { ...this.meta(), idempotentReplay: result.replay },
      };
    } catch (error) {
      this.rethrow(error);
    }
  }

  async query(tenantId: string, documentId: string, idempotencyKey: string) {
    this.key(idempotencyKey);
    await this.configuration(tenantId);
    try {
      const result = await this.simulator.query({
        tenantId,
        documentId,
        idempotencyKey,
      });
      return {
        data: result.document,
        meta: { ...this.meta(), idempotentReplay: result.replay },
      };
    } catch (error) {
      this.rethrow(error);
    }
  }

  async cancel(tenantId: string, documentId: string, idempotencyKey: string) {
    this.key(idempotencyKey);
    await this.configuration(tenantId);
    try {
      const result = await this.simulator.cancel({
        tenantId,
        documentId,
        idempotencyKey,
      });
      return {
        data: result.document,
        meta: { ...this.meta(), idempotentReplay: result.replay },
      };
    } catch (error) {
      this.rethrow(error);
    }
  }

  async callback(tenantId: string, dto: FiscalSimulatorCallbackDto) {
    await this.configuration(tenantId);
    try {
      const result = await this.simulator.callback({ tenantId, ...dto });
      return {
        data: result.document,
        meta: { ...this.meta(), duplicate: result.replay },
      };
    } catch (error) {
      this.rethrow(error);
    }
  }

  async download(
    tenantId: string,
    documentId: string,
    kind: FiscalArtifactKind,
  ) {
    await this.configuration(tenantId);
    return {
      data: await this.simulator.download(tenantId, documentId, kind),
      meta: this.meta(),
    };
  }

  private async configuration(tenantId: string) {
    const config = await this.fiscalConfigs.configuration(tenantId);
    if (!config || !config.enabled || config.providerProfile !== 'SIMULATOR') {
      throw new BadRequestException('FISCAL_SIMULATOR_NOT_ENABLED');
    }
    const contract = this.contracts.get(
      config.countryCode,
      config.contractVersion,
    );
    if (!contract || !this.contracts.validate(contract, config).valid) {
      throw new BadRequestException('FISCAL_CONTRACT_NOT_READY');
    }
    return config;
  }

  private key(value: string): void {
    if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/.test(value)) {
      throw new BadRequestException('IDEMPOTENCY_KEY_REQUIRED');
    }
  }

  private rethrow(error: unknown): never {
    if (error instanceof FiscalSimulatorIdempotencyConflictError) {
      throw new ConflictException('IDEMPOTENCY_KEY_CONFLICT');
    }
    throw error;
  }

  private meta() {
    return {
      apiVersion: '1' as const,
      provider: 'SIMULATOR' as const,
      production: false,
    };
  }
}
