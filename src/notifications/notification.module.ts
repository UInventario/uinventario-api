import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module';
import { PermissionGuard } from '../auth/authorization/permission.guard';
import { SessionModule } from '../auth/session/session.module';
import { InventoryModule } from '../inventory/inventory.module';
import { ExternalAdapterModule } from '../integrations/external-adapter.module';
import { NotificationController } from './notification.controller';
import { NotificationDeliveryService } from './notification-delivery.service';
import { NotificationRepository } from './notification.repository';
import { NotificationService } from './notification.service';

@Module({
  imports: [SessionModule, AuditModule, InventoryModule, ExternalAdapterModule],
  controllers: [NotificationController],
  providers: [
    NotificationRepository,
    NotificationService,
    NotificationDeliveryService,
    PermissionGuard,
  ],
})
export class NotificationModule {}
