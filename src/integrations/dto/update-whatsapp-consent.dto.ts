import { IsBoolean } from 'class-validator';

export class UpdateWhatsappConsentDto {
  @IsBoolean()
  enabled!: boolean;
}
