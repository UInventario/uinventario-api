import { Global, Module } from '@nestjs/common';
import { AuditController } from './audit.controller';
import { AuditService } from './audit.service';
import { SessionModule } from '../auth/session/session.module';
import { PermissionGuard } from '../auth/authorization/permission.guard';

@Global()
@Module({
  imports: [SessionModule],
  controllers: [AuditController],
  providers: [AuditService, PermissionGuard],
  exports: [AuditService],
})
export class AuditModule {}
