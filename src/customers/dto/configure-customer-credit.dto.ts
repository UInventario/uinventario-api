import { Transform, Type } from 'class-transformer';
import { IsBoolean, IsInt, IsString, Matches, Max, Min } from 'class-validator';

export class ConfigureCustomerCreditDto {
  @IsBoolean()
  enabled!: boolean;

  @IsString()
  @Matches(/^(0|[1-9]\d{0,11})(\.\d{1,2})?$/)
  creditLimit!: string;

  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim().toUpperCase() : value,
  )
  @IsString()
  @Matches(/^[A-Z]{3}$/)
  currency!: string;

  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(365)
  termDays!: number;

  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(36)
  maxInstallments!: number;

  @Type(() => Number)
  @IsInt()
  @Min(1)
  version!: number;
}
