import { IsIn, IsString, Matches, MaxLength, MinLength } from 'class-validator';

export class CreateCashRegisterMovementDto {
  @IsIn(['INCOME', 'WITHDRAWAL'])
  type!: 'INCOME' | 'WITHDRAWAL';

  @IsString()
  @Matches(/^(?:[1-9]\d{0,12}(?:\.\d{1,2})?|0\.(?:0[1-9]|[1-9]\d?))$/)
  amount!: string;

  @IsString()
  @MinLength(2)
  @MaxLength(160)
  reason!: string;
}
