import { Module } from '@nestjs/common';
import { SessionModule } from '../auth/session/session.module';
import { OnboardingController } from './onboarding.controller';
import { OnboardingRepository } from './onboarding.repository';
import { OnboardingService } from './onboarding.service';
import { OnboardingAccessGuard } from './onboarding-access.guard';

@Module({
  imports: [SessionModule],
  controllers: [OnboardingController],
  providers: [OnboardingRepository, OnboardingService, OnboardingAccessGuard],
})
export class OnboardingModule {}
