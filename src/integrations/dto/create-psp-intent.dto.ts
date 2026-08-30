import { IsIn, Matches } from 'class-validator';
import { PSP_SCENARIOS } from '../psp-payment.types';

export class CreatePspIntentDto {
  @Matches(/^(?:0|[1-9]\d{0,11})\.\d{2}$/)
  amount!: string;

  @Matches(/^[A-Z]{3}$/)
  currency!: string;

  @Matches(/^[A-Za-z0-9][A-Za-z0-9._:-]{2,99}$/)
  merchantReference!: string;

  @IsIn(PSP_SCENARIOS)
  scenario!: (typeof PSP_SCENARIOS)[number];
}
