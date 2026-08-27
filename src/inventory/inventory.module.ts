import { Module } from '@nestjs/common';
import { SessionModule } from '../auth/session/session.module';
import { InventoryAccessGuard } from './inventory-access.guard';
import { InventoryController } from './inventory.controller';
import { InventoryRepository } from './inventory.repository';
import { InventoryService } from './inventory.service';
import { InventoryTransferController } from './inventory-transfer.controller';
import { InventoryTransferRepository } from './inventory-transfer.repository';
import { InventoryTransferService } from './inventory-transfer.service';

@Module({
  imports: [SessionModule],
  controllers: [InventoryController, InventoryTransferController],
  providers: [
    InventoryRepository,
    InventoryService,
    InventoryTransferRepository,
    InventoryTransferService,
    InventoryAccessGuard,
  ],
})
export class InventoryModule {}
