import { Module } from '@nestjs/common';
import { PermissionGuard } from '../auth/authorization/permission.guard';
import { SessionModule } from '../auth/session/session.module';
import { PosModule } from '../pos/pos.module';
import { SalesQuotationController } from './sales-quotation.controller';
import { SalesQuotationRepository } from './sales-quotation.repository';
import { SalesQuotationService } from './sales-quotation.service';

@Module({
  imports: [SessionModule, PosModule],
  controllers: [SalesQuotationController],
  providers: [SalesQuotationRepository, SalesQuotationService, PermissionGuard],
})
export class SalesQuotationModule {}
