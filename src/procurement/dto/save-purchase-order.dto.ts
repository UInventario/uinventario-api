import { Transform, Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsISO4217CurrencyCode,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  MaxLength,
  ValidateNested,
} from 'class-validator';

const trim = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.trim() : value;
const optionalTrim = ({ value }: { value: unknown }) => {
  const trimmed = trim({ value });
  return trimmed === '' || trimmed === null ? undefined : trimmed;
};

export class PurchaseOrderLineDto {
  @IsUUID()
  supplierProductId!: string;

  @Transform(trim)
  @IsString()
  @Matches(
    /^(?:[1-9]\d{0,11}(?:\.\d{1,3})?|0\.(?:00[1-9]|0[1-9]\d?|[1-9]\d{0,2}))$/,
  )
  quantity!: string;

  @Transform(trim)
  @IsString()
  @Matches(/^(?:[1-9]\d{0,11}(?:\.\d{1,2})?|0\.(?:0[1-9]|[1-9]\d?))$/)
  unitCost!: string;

  @Transform(optionalTrim)
  @IsOptional()
  @IsString()
  @MaxLength(500)
  notes?: string;
}

export class SavePurchaseOrderDto {
  @IsUUID()
  supplierId!: string;

  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim().toUpperCase() : value,
  )
  @IsISO4217CurrencyCode()
  currency!: string;

  @Transform(optionalTrim)
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  notes?: string;

  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(100)
  @ValidateNested({ each: true })
  @Type(() => PurchaseOrderLineDto)
  lines!: PurchaseOrderLineDto[];
}
