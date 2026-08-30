import { IsISO8601, IsIn, Matches } from 'class-validator';

export class PspWebhookDto {
  @Matches(/^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/)
  eventId!: string;

  @Matches(/^PSP-[A-F0-9]{24}$/)
  providerReference!: string;

  @IsIn(['AUTHORIZED', 'CAPTURED', 'DECLINED'])
  status!: 'AUTHORIZED' | 'CAPTURED' | 'DECLINED';

  @IsISO8601({ strict: true })
  occurredAt!: string;
}
