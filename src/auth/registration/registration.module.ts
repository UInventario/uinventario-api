import { Module } from '@nestjs/common';
import { RegistrationController } from './registration.controller';
import { RegistrationRepository } from './registration.repository';
import { RegistrationService } from './registration.service';

@Module({
  controllers: [RegistrationController],
  providers: [RegistrationRepository, RegistrationService],
})
export class RegistrationModule {}
