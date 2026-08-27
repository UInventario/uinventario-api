import { Module } from '@nestjs/common';
import { SessionModule } from '../auth/session/session.module';
import { PermissionGuard } from '../auth/authorization/permission.guard';
import { InventoryController } from './inventory.controller';
import { InventoryRepository } from './inventory.repository';
import { InventoryService } from './inventory.service';
import { InventoryTransferController } from './inventory-transfer.controller';
import { InventoryTransferRepository } from './inventory-transfer.repository';
import { InventoryTransferService } from './inventory-transfer.service';
import { InventoryImportRepository } from './inventory-import.repository';
import { InventoryImportService } from './inventory-import.service';

@Module({
  imports: [SessionModule],
  controllers: [InventoryController, InventoryTransferController],
  providers: [
    InventoryRepository,
    InventoryService,
    InventoryTransferRepository,
    InventoryTransferService,
    InventoryImportRepository,
    InventoryImportService,
    PermissionGuard,
  ],
  exports: [InventoryService],
})
export class InventoryModule {}
