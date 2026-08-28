import { Transform } from 'class-transformer';
import {
  IsISO4217CurrencyCode,
  IsDateString,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  MaxLength,
  MinLength,
} from 'class-validator';

const trim = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.trim() : value;
const optionalTrim = ({ value }: { value: unknown }) => {
  const trimmed = trim({ value });
  return trimmed === '' || trimmed === null ? undefined : trimmed;
};

export class CreateSupplierProductDto {
  @IsUUID()
  supplierId!: string;

  @IsUUID()
  productId!: string;

  @Transform(trim)
  @IsString()
  @MinLength(1)
  @MaxLength(64)
  @Matches(/^[\p{L}\p{N}._\-/ ]+$/u)
  supplierCode!: string;

  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim().toUpperCase() : value,
  )
  @IsISO4217CurrencyCode()
  currency!: string;

  @Transform(trim)
  @IsString()
  @Matches(/^(?:[1-9]\d{0,11}(?:\.\d{1,2})?|0\.(?:0[1-9]|[1-9]\d?))$/)
  unitCost!: string;

  @Transform(optionalTrim)
  @IsOptional()
  @IsString()
  @Matches(
    /^(?:[1-9]\d{0,11}(?:\.\d{1,3})?|0\.(?:00[1-9]|0[1-9]\d?|[1-9]\d{0,2}))$/,
  )
  minimumQuantity?: string;

  @Transform(trim)
  @IsDateString({ strict: true })
  validFrom!: string;

  @Transform(optionalTrim)
  @IsOptional()
  @IsDateString({ strict: true })
  validTo?: string;
}
