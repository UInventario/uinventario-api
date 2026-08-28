import { Module } from '@nestjs/common';
import { PermissionGuard } from '../auth/authorization/permission.guard';
import { SessionModule } from '../auth/session/session.module';
import { PriceListController } from './price-list.controller';
import { PriceListRepository } from './price-list.repository';
import { PriceListService } from './price-list.service';

@Module({
  imports: [SessionModule],
  controllers: [PriceListController],
  providers: [PriceListRepository, PriceListService, PermissionGuard],
  exports: [PriceListRepository],
})
export class PriceListModule {}
