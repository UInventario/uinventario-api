import {
  IsIn,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  MinLength,
} from 'class-validator';

export const CREDIT_PAYMENT_METHODS = ['CASH', 'CARD', 'TRANSFER'] as const;
export type CustomerCreditPaymentMethod =
  (typeof CREDIT_PAYMENT_METHODS)[number];

export class CreateCustomerCreditPaymentDto {
  @IsString()
  @Matches(/^(?:0\.(?:0[1-9]|[1-9]\d)|[1-9]\d{0,13}(?:\.\d{1,2})?)$/)
  amount!: string;

  @IsIn(CREDIT_PAYMENT_METHODS)
  method!: CustomerCreditPaymentMethod;

  @IsOptional()
  @IsString()
  @MinLength(4)
  @MaxLength(120)
  @Matches(/^[A-Za-z0-9][A-Za-z0-9._:/-]*$/)
  reference?: string;
}

export class ReverseCustomerCreditPaymentDto {
  @IsString()
  @MinLength(3)
  @MaxLength(160)
  reason!: string;
}
