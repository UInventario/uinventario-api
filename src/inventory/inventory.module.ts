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
import { InventoryCountController } from './inventory-count.controller';
import { InventoryCountRepository } from './inventory-count.repository';
import { InventoryCountService } from './inventory-count.service';
import { InventoryValuationPolicyService } from './inventory-valuation-policy.service';
import { InventoryReconciliationService } from './inventory-reconciliation.service';

@Module({
  imports: [SessionModule],
  controllers: [
    InventoryController,
    InventoryTransferController,
    InventoryCountController,
  ],
  providers: [
    InventoryRepository,
    InventoryService,
    InventoryTransferRepository,
    InventoryTransferService,
    InventoryImportRepository,
    InventoryImportService,
    InventoryCountRepository,
    InventoryCountService,
    InventoryValuationPolicyService,
    InventoryReconciliationService,
    PermissionGuard,
  ],
  exports: [
    InventoryService,
    InventoryValuationPolicyService,
    InventoryReconciliationService,
  ],
})
export class InventoryModule {}
