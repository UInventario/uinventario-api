import { Module } from '@nestjs/common';
import { PermissionGuard } from '../auth/authorization/permission.guard';
import { SessionModule } from '../auth/session/session.module';
import { LoyaltyController } from './loyalty.controller';
import { LoyaltyRepository } from './loyalty.repository';
import { LoyaltyService } from './loyalty.service';

@Module({
  imports: [SessionModule],
  controllers: [LoyaltyController],
  providers: [LoyaltyRepository, LoyaltyService, PermissionGuard],
  exports: [LoyaltyRepository, LoyaltyService],
})
export class LoyaltyModule {}
