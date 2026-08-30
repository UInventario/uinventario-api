import {
  IsBoolean,
  IsIn,
  IsInt,
  IsISO31661Alpha2,
  IsOptional,
  Matches,
  Max,
  Min,
} from 'class-validator';

export class UpdateExternalAdapterConfigDto {
  @IsISO31661Alpha2()
  countryCode!: string;

  @IsIn(['SIMULATOR', 'RESEND'])
  provider!: string;

  @IsIn(['1'])
  adapterVersion!: string;

  @IsBoolean()
  enabled!: boolean;

  @IsInt()
  @Min(50)
  @Max(30_000)
  timeoutMs!: number;

  @IsInt()
  @Min(1)
  @Max(5)
  maxAttempts!: number;

  @IsOptional()
  @Matches(/^[A-Za-z][A-Za-z0-9_-]{2,159}$/)
  secretReference?: string | null;
}
