import { Transform, Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
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
  typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : value;
const quantityPattern = /^(?:[1-9]\d{0,11})(?:\.\d{1,3})?$/;

export class ReceivePurchaseOrderLineDto {
  @IsUUID()
  purchaseOrderLineId!: string;

  @Transform(trim)
  @IsString()
  @Matches(quantityPattern)
  receivedQuantity!: string;

  @Transform(trim)
  @IsOptional()
  @IsString()
  @Matches(/^[A-Za-z0-9][A-Za-z0-9._/ -]{0,63}$/)
  lotCode?: string;
}

export class ReceivePurchaseOrderDto {
  @Type(() => Number)
  @IsInt()
  @Min(1)
  version!: number;

  @IsUUID()
  locationId!: string;

  @Transform(trim)
  @IsString()
  @MinLength(1)
  @MaxLength(160)
  documentReference!: string;

  @Transform(({ value }: { value: unknown }) => {
    const normalized = trim({ value });
    return normalized === '' ? undefined : normalized;
  })
  @IsOptional()
  @IsString()
  @MinLength(3)
  @MaxLength(500)
  overageReason?: string;

  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(100)
  @ValidateNested({ each: true })
  @Type(() => ReceivePurchaseOrderLineDto)
  lines!: ReceivePurchaseOrderLineDto[];
}
