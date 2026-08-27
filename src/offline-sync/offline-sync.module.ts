import { Module } from '@nestjs/common';
import { SessionModule } from '../auth/session/session.module';
import { OfflineBootstrapController } from './offline-bootstrap.controller';
import { OfflineBootstrapRepository } from './offline-bootstrap.repository';
import { OfflineBootstrapService } from './offline-bootstrap.service';
import { OfflineChangesRepository } from './offline-changes.repository';
import { OfflineChangesService } from './offline-changes.service';

@Module({
  imports: [SessionModule],
  controllers: [OfflineBootstrapController],
  providers: [
    OfflineBootstrapRepository,
    OfflineBootstrapService,
    OfflineChangesRepository,
    OfflineChangesService,
  ],
})
export class OfflineSyncModule {}
