import { Module } from '@nestjs/common';
import { SessionModule } from '../auth/session/session.module';
import { InventoryAccessGuard } from './inventory-access.guard';
import { InventoryController } from './inventory.controller';
import { InventoryRepository } from './inventory.repository';
import { InventoryService } from './inventory.service';

@Module({
  imports: [SessionModule],
  controllers: [InventoryController],
  providers: [InventoryRepository, InventoryService, InventoryAccessGuard],
})
export class InventoryModule {}
