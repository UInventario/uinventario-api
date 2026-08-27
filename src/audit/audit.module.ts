import { Global, Module } from '@nestjs/common';
import { AuditAccessGuard } from './audit-access.guard';
import { AuditController } from './audit.controller';
import { AuditService } from './audit.service';
import { SessionModule } from '../auth/session/session.module';

@Global()
@Module({
  imports: [SessionModule],
  controllers: [AuditController],
  providers: [AuditService, AuditAccessGuard],
  exports: [AuditService],
})
export class AuditModule {}
