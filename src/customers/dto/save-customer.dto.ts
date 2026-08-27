import { Transform, Type } from 'class-transformer';
import {
  IsBoolean,
  IsEmail,
  IsInt,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';

const trim = ({ value }: { value: unknown }) =>
  typeof value === 'string'
    ? value.replace(/\s+/g, ' ').trim() || undefined
    : value;

export class SaveCustomerDto {
  @Transform(trim)
  @IsString()
  @MinLength(2)
  @MaxLength(160)
  name!: string;

  @Transform(trim)
  @IsOptional()
  @IsString()
  @MaxLength(80)
  identifier?: string;

  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim().toLowerCase() || undefined : value,
  )
  @IsOptional()
  @IsEmail()
  @MaxLength(254)
  email?: string;

  @Transform(trim)
  @IsOptional()
  @IsString()
  @Matches(/^\+?[0-9 ()-]{7,32}$/)
  phone?: string;

  @IsBoolean()
  dataProcessingConsent!: boolean;

  @IsOptional()
  @IsBoolean()
  active?: boolean;
}

export class UpdateCustomerDto extends SaveCustomerDto {
  @Type(() => Number)
  @IsInt()
  @Min(1)
  version!: number;
}
