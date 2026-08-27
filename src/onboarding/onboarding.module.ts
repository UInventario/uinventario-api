import { Module } from '@nestjs/common';
import { SessionModule } from '../auth/session/session.module';
import { OnboardingController } from './onboarding.controller';
import { OnboardingRepository } from './onboarding.repository';
import { OnboardingService } from './onboarding.service';

@Module({
  imports: [SessionModule],
  controllers: [OnboardingController],
  providers: [OnboardingRepository, OnboardingService],
})
export class OnboardingModule {}
