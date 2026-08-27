import { Module } from '@nestjs/common';
import { SessionModule } from '../../auth/session/session.module';
import { PermissionGuard } from '../../auth/authorization/permission.guard';
import { AccessControlController } from './access-control.controller';
import { AccessControlRepository } from './access-control.repository';
import { AccessControlService } from './access-control.service';

@Module({
  imports: [SessionModule],
  controllers: [AccessControlController],
  providers: [PermissionGuard, AccessControlRepository, AccessControlService],
})
export class AccessControlModule {}
