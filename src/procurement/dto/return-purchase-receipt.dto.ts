import { Transform, Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  ArrayUnique,
  IsArray,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  MaxLength,
  MinLength,
  ValidateNested,
} from 'class-validator';

const trim = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : value;
const quantityPattern = /^(?:[1-9]\d{0,11})(?:\.\d{1,3})?$/;

export class ReturnPurchaseReceiptLineDto {
  @IsUUID()
  purchaseReceiptLineId!: string;

  @Transform(trim)
  @IsString()
  @Matches(quantityPattern)
  returnedQuantity!: string;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(1000)
  @ArrayUnique((value: string) => value.trim().toUpperCase())
  @IsString({ each: true })
  @MaxLength(120, { each: true })
  serialNumbers?: string[];
}

export class ReturnPurchaseReceiptDto {
  @IsUUID()
  purchaseReceiptId!: string;

  @Transform(trim)
  @IsString()
  @MinLength(1)
  @MaxLength(160)
  documentReference!: string;

  @Transform(trim)
  @IsString()
  @MinLength(3)
  @MaxLength(500)
  reason!: string;

  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(100)
  @ValidateNested({ each: true })
  @Type(() => ReturnPurchaseReceiptLineDto)
  lines!: ReturnPurchaseReceiptLineDto[];
}
