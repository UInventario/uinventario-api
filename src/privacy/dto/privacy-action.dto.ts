import { Transform, Type } from 'class-transformer';
import {
  IsDateString,
  IsInt,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';

const trim = ({ value }: { value: unknown }) =>
  typeof value === 'string'
    ? value.replace(/\s+/g, ' ').trim() || undefined
    : value;

export class PrivacyActionDto {
  @Transform(trim)
  @IsString()
  @MinLength(8)
  @MaxLength(240)
  reason!: string;

  @Transform(trim)
  @IsOptional()
  @IsString()
  @MaxLength(120)
  requestReference?: string;
}

export class CreatePrivacyLegalHoldDto extends PrivacyActionDto {
  @IsOptional()
  @IsDateString({ strict: true })
  expiresAt?: string;
}

export class UpdatePrivacyPolicyDto extends PrivacyActionDto {
  @Type(() => Number)
  @IsInt()
  @Min(365)
  @Max(36_500)
  transactionRetentionDays!: number;

  @Type(() => Number)
  @IsInt()
  @Min(1)
  expectedVersion!: number;
}
