import { Type } from 'class-transformer';
import {
  IsArray,
  IsInt,
  IsOptional,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
  MinLength,
  ValidateNested,
} from 'class-validator';

export class CashDenominationDto {
  @IsString()
  @Matches(/^(?:[1-9]\d{0,12}(?:\.\d{1,2})?|0\.(?:0[1-9]|[1-9]\d?))$/)
  denomination!: string;

  @IsInt()
  @Min(1)
  @Max(100_000)
  quantity!: number;
}

export class CloseCashRegisterShiftDto {
  @IsString()
  @Matches(/^(0|[1-9]\d{0,12})(\.\d{1,2})?$/)
  countedAmount!: string;

  @IsOptional()
  @IsString()
  @MinLength(2)
  @MaxLength(160)
  differenceReason?: string;

  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => CashDenominationDto)
  denominations?: CashDenominationDto[];
}
