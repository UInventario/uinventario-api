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

@Module({
  imports: [SessionModule, AuditModule],
  controllers: [ExternalAdapterController],
  providers: [
    ExternalAdapterRepository,
    ExternalAdapterRegistry,
    ExternalAdapterExecutionService,
    ExternalAdapterService,
    SimulatedEmailExternalAdapter,
    SimulatedPushExternalAdapter,
    PermissionGuard,
  ],
  exports: [ExternalAdapterExecutionService],
})
export class ExternalAdapterModule {}
