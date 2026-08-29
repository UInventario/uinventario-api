import { Module } from '@nestjs/common';
import { PermissionGuard } from '../auth/authorization/permission.guard';
import { SessionModule } from '../auth/session/session.module';
import { PromotionController } from './promotion.controller';
import { PromotionEngineService } from './promotion-engine.service';
import { PromotionRepository } from './promotion.repository';
import { PromotionService } from './promotion.service';

@Module({
  imports: [SessionModule],
  controllers: [PromotionController],
  providers: [
    PromotionRepository,
    PromotionEngineService,
    PromotionService,
    PermissionGuard,
  ],
  exports: [PromotionEngineService],
})
export class PromotionModule {}
