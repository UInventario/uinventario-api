import { Module } from '@nestjs/common';
import { SessionModule } from '../auth/session/session.module';
import { OfflineBootstrapController } from './offline-bootstrap.controller';
import { OfflineBootstrapRepository } from './offline-bootstrap.repository';
import { OfflineBootstrapService } from './offline-bootstrap.service';

@Module({
  imports: [SessionModule],
  controllers: [OfflineBootstrapController],
  providers: [OfflineBootstrapRepository, OfflineBootstrapService],
})
export class OfflineSyncModule {}
