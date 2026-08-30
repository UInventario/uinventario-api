import { IsIn, IsISO8601, Matches } from 'class-validator';

export class WhatsappWebhookDto {
  @Matches(/^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/)
  providerEventId!: string;

  @Matches(/^SIM-[a-f0-9]{24}$/)
  providerReference!: string;

  @IsIn(['SENT', 'DELIVERED', 'READ', 'FAILED'])
  status!: 'SENT' | 'DELIVERED' | 'READ' | 'FAILED';

  @IsISO8601({ strict: true })
  occurredAt!: string;
}
