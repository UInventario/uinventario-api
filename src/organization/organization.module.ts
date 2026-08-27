import { Module } from '@nestjs/common';
import { SessionModule } from '../auth/session/session.module';
import { OrganizationAccessGuard } from './organization-access.guard';
import { OrganizationController } from './organization.controller';
import { OrganizationRepository } from './organization.repository';
import { OrganizationService } from './organization.service';

@Module({
  imports: [SessionModule],
  controllers: [OrganizationController],
  providers: [
    OrganizationAccessGuard,
    OrganizationRepository,
    OrganizationService,
  ],
})
export class OrganizationModule {}
