import { Matches } from 'class-validator';

export class RefundPspPaymentDto {
  @Matches(/^(?:0|[1-9]\d{0,11})\.\d{2}$/)
  amount!: string;
}
