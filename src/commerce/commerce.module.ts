import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module';
import { PermissionGuard } from '../auth/authorization/permission.guard';
import { SessionModule } from '../auth/session/session.module';
import { CustomerOrderModule } from '../orders/customer-order.module';
import { CommerceAdminController } from './commerce-admin.controller';
import { CommerceAuthGuard } from './commerce-auth.guard';
import { CommerceExternalController } from './commerce-external.controller';
import { CommerceRepository } from './commerce.repository';
import { CommerceService } from './commerce.service';
import { CommerceWebhookService } from './commerce-webhook.service';

@Module({
  imports: [SessionModule, AuditModule, CustomerOrderModule],
  controllers: [CommerceAdminController, CommerceExternalController],
  providers: [
    CommerceRepository,
    CommerceService,
    CommerceWebhookService,
    CommerceAuthGuard,
    PermissionGuard,
  ],
})
export class CommerceModule {}
