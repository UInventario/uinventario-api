import { Transform, Type } from 'class-transformer';
import {
  IsBoolean,
  IsDefined,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  ValidateIf,
  Matches,
  MaxLength,
  Max,
  Min,
  MinLength,
} from 'class-validator';
import {
  PRODUCT_BASE_UNITS,
  QUANTITY_ROUNDING_MODES,
} from '../../common/quantity-policy';
import type {
  ProductBaseUnit,
  QuantityRoundingMode,
} from '../../common/quantity-policy';

export const LOT_EXPIRATION_POLICIES = [
  'NONE',
  'OPTIONAL',
  'REQUIRED',
] as const;
export type LotExpirationPolicy = (typeof LOT_EXPIRATION_POLICIES)[number];

const trim = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.trim() : value;
const optionalTrim = ({ value }: { value: unknown }) => {
  const trimmed = trim({ value });
  return trimmed === '' || trimmed === null ? undefined : trimmed;
};

export class CreateProductDto {
  @Transform(trim)
  @IsString()
  @MinLength(2)
  @MaxLength(160)
  name!: string;

  @Transform(optionalTrim)
  @ValidateIf((dto: CreateProductDto) => !dto.withoutCode)
  @IsDefined()
  @IsString()
  @Matches(/^[A-Za-z0-9][A-Za-z0-9._-]{0,39}$/)
  sku?: string;

  @IsOptional()
  @IsBoolean()
  withoutCode?: boolean;

  @IsOptional()
  @IsIn(['TRACKED', 'UNTRACKED'])
  stockBehavior?: 'TRACKED' | 'UNTRACKED';

  @IsOptional()
  @IsIn(['STANDARD', 'EXEMPT'])
  taxBehavior?: 'STANDARD' | 'EXEMPT';

  @Transform(optionalTrim)
  @IsOptional()
  @IsString()
  @Matches(/^[A-Za-z0-9][A-Za-z0-9._-]{3,63}$/)
  barcode?: string;

  @IsOptional()
  @IsIn(PRODUCT_BASE_UNITS)
  baseUnit?: ProductBaseUnit;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(3)
  quantityPrecision?: number;

  @IsOptional()
  @IsIn(QUANTITY_ROUNDING_MODES)
  quantityRounding?: QuantityRoundingMode;

  @Transform(optionalTrim)
  @IsOptional()
  @IsString()
  @Matches(
    /^(?:[1-9]\d{0,11}(?:\.\d{1,3})?|0\.(?:00[1-9]|0[1-9]\d?|[1-9]\d{0,2}))$/,
  )
  minimumQuantity?: string;

  @IsOptional()
  @IsBoolean()
  trackLots?: boolean;

  @IsOptional()
  @IsIn(LOT_EXPIRATION_POLICIES)
  lotExpirationPolicy?: LotExpirationPolicy;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(365)
  lotExpirationAlertDays?: number;

  @IsOptional()
  @IsBoolean()
  allowExpiredStockOverride?: boolean;

  @IsOptional()
  @IsBoolean()
  trackSerials?: boolean;

  @Transform(optionalTrim)
  @IsOptional()
  @IsString()
  @MinLength(2)
  @MaxLength(80)
  categoryName?: string;

  @Transform(optionalTrim)
  @IsOptional()
  @IsString()
  @MinLength(2)
  @MaxLength(120)
  brandName?: string;

  @Transform(trim)
  @IsString()
  @Matches(/^(0|[1-9]\d{0,11})(\.\d{1,2})?$/)
  cost!: string;

  @Transform(trim)
  @IsString()
  @Matches(/^(0|[1-9]\d{0,11})(\.\d{1,2})?$/)
  price!: string;
}
