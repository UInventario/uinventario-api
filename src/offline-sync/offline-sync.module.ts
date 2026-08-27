import { Module } from '@nestjs/common';
import { SessionModule } from '../auth/session/session.module';
import { OfflineBootstrapController } from './offline-bootstrap.controller';
import { OfflineBootstrapRepository } from './offline-bootstrap.repository';
import { OfflineBootstrapService } from './offline-bootstrap.service';
import { OfflineChangesRepository } from './offline-changes.repository';
import { OfflineChangesService } from './offline-changes.service';
import { InventoryModule } from '../inventory/inventory.module';
import { PosModule } from '../pos/pos.module';
import { OfflineCommandRepository } from './offline-command.repository';
import { OfflineCommandService } from './offline-command.service';
import { OfflineDeviceService } from './offline-device.service';

@Module({
  imports: [SessionModule, InventoryModule, PosModule],
  controllers: [OfflineBootstrapController],
  providers: [
    OfflineBootstrapRepository,
    OfflineBootstrapService,
    OfflineChangesRepository,
    OfflineChangesService,
    OfflineCommandRepository,
    OfflineCommandService,
    OfflineDeviceService,
  ],
})
export class OfflineSyncModule {}
