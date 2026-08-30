import { IsIn, IsString, Matches } from 'class-validator';
import {
  PAYMENT_TERMINAL_SCENARIOS,
  type PaymentTerminalScenario,
} from '../payment-terminal.types';

export class StartPaymentTerminalDto {
  @IsString()
  @Matches(/^(?:[1-9]\d{0,11}(?:\.\d{1,2})?|0\.(?:0[1-9]|[1-9]\d?))$/)
  amount!: string;

  @IsString()
  @Matches(/^[A-Z]{3}$/)
  currency!: string;

  @IsIn(PAYMENT_TERMINAL_SCENARIOS)
  scenario!: PaymentTerminalScenario;
}
