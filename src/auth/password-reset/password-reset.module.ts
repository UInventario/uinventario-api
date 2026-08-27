import { Module } from '@nestjs/common';
import {
  ConfiguredPasswordResetDelivery,
  PASSWORD_RESET_DELIVERY,
} from './password-reset.delivery';
import { PasswordResetController } from './password-reset.controller';
import { PasswordResetRepository } from './password-reset.repository';
import { PasswordResetService } from './password-reset.service';

@Module({
  controllers: [PasswordResetController],
  providers: [
    PasswordResetRepository,
    PasswordResetService,
    ConfiguredPasswordResetDelivery,
    {
      provide: PASSWORD_RESET_DELIVERY,
      useExisting: ConfiguredPasswordResetDelivery,
    },
  ],
})
export class PasswordResetModule {}
