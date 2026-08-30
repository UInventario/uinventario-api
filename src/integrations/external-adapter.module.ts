import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module';
import { PermissionGuard } from '../auth/authorization/permission.guard';
import { SessionModule } from '../auth/session/session.module';
import { ExternalAdapterExecutionService } from './external-adapter-execution.service';
import { ExternalAdapterController } from './external-adapter.controller';
import { ExternalAdapterRegistry } from './external-adapter.registry';
import { ExternalAdapterRepository } from './external-adapter.repository';
import { ExternalAdapterService } from './external-adapter.service';
import {
  SimulatedEmailExternalAdapter,
  SimulatedPushExternalAdapter,
} from './simulated-notification.adapter';
import { ResendEmailExternalAdapter } from './resend-email.adapter';
import { TransactionalEmailTemplateService } from './transactional-email-template.service';
import { ResendWebhookController } from './resend-webhook.controller';
import { ResendWebhookService } from './resend-webhook.service';
import { FiscalContractController } from './fiscal-contract.controller';
import { FiscalContractRegistry } from './fiscal-contract.registry';
import { FiscalContractRepository } from './fiscal-contract.repository';
import { FiscalContractService } from './fiscal-contract.service';
import { FiscalSimulatorController } from './fiscal-simulator.controller';
import { FiscalSimulatorRepository } from './fiscal-simulator.repository';
import { FiscalSimulatorService } from './fiscal-simulator.service';
import { SimulatedFiscalAdapter } from './simulated-fiscal.adapter';

@Module({
  imports: [SessionModule, AuditModule],
  controllers: [
    ExternalAdapterController,
    ResendWebhookController,
    FiscalContractController,
    FiscalSimulatorController,
  ],
  providers: [
    ExternalAdapterRepository,
    ExternalAdapterRegistry,
    ExternalAdapterExecutionService,
    ExternalAdapterService,
    SimulatedEmailExternalAdapter,
    SimulatedPushExternalAdapter,
    ResendEmailExternalAdapter,
    TransactionalEmailTemplateService,
    ResendWebhookService,
    FiscalContractRegistry,
    FiscalContractRepository,
    FiscalContractService,
    SimulatedFiscalAdapter,
    FiscalSimulatorRepository,
    FiscalSimulatorService,
    PermissionGuard,
  ],
  exports: [
    ExternalAdapterExecutionService,
    ExternalAdapterRepository,
    TransactionalEmailTemplateService,
  ],
})
export class ExternalAdapterModule {}
