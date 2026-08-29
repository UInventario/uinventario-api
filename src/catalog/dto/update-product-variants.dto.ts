import { Transform, Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  MaxLength,
  Min,
  MinLength,
  ValidateNested,
} from 'class-validator';

const trim = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.trim() : value;
const optionalTrim = ({ value }: { value: unknown }) => {
  const trimmed = trim({ value });
  return trimmed === '' || trimmed === null ? undefined : trimmed;
};
const trimValues = ({ value }: { value: unknown }) =>
  Array.isArray(value)
    ? (value as unknown[]).map((item: unknown) =>
        typeof item === 'string' ? item.trim() : item,
      )
    : value;

export class ProductVariantAttributeDto {
  @Transform(trim)
  @IsString()
  @MinLength(1)
  @MaxLength(40)
  name!: string;

  @Transform(trimValues)
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(20)
  @IsString({ each: true })
  @MinLength(1, { each: true })
  @MaxLength(40, { each: true })
  values!: string[];
}

export class ProductVariantInputDto {
  @IsOptional()
  @IsUUID()
  id?: string;

  @IsOptional()
  @IsInt()
  @Min(1)
  version?: number;

  @Transform(trimValues)
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(3)
  @IsString({ each: true })
  @MinLength(1, { each: true })
  @MaxLength(40, { each: true })
  values!: string[];

  @Transform(trim)
  @IsString()
  @Matches(/^[A-Za-z0-9][A-Za-z0-9._-]{0,39}$/)
  sku!: string;

  @Transform(optionalTrim)
  @IsOptional()
  @IsString()
  @Matches(/^[A-Za-z0-9][A-Za-z0-9._-]{3,63}$/)
  barcode?: string;

  @Transform(trim)
  @IsString()
  @Matches(/^(0|[1-9]\d{0,11})(\.\d{1,2})?$/)
  cost!: string;

  @Transform(trim)
  @IsString()
  @Matches(/^(0|[1-9]\d{0,11})(\.\d{1,2})?$/)
  price!: string;

  @IsBoolean()
  active!: boolean;
}

export class UpdateProductVariantsDto {
  @IsInt()
  @Min(1)
  version!: number;

  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(3)
  @ValidateNested({ each: true })
  @Type(() => ProductVariantAttributeDto)
  attributes!: ProductVariantAttributeDto[];

  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(100)
  @ValidateNested({ each: true })
  @Type(() => ProductVariantInputDto)
  variants!: ProductVariantInputDto[];
}
