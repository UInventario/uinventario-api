import { Module } from '@nestjs/common';
import { PermissionGuard } from '../auth/authorization/permission.guard';
import { SessionModule } from '../auth/session/session.module';
import { CustomerModule } from '../customers/customer.module';
import { PrivacyController } from './privacy.controller';
import { PrivacyService } from './privacy.service';

@Module({
  imports: [SessionModule, CustomerModule],
  controllers: [PrivacyController],
  providers: [PrivacyService, PermissionGuard],
})
export class PrivacyModule {}
