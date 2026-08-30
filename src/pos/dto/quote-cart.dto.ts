import { Transform, Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  ArrayUnique,
  IsArray,
  IsIn,
  IsOptional,
  IsInt,
  IsString,
  IsUUID,
  MaxLength,
  Matches,
  MinLength,
  ValidateNested,
  Max,
  Min,
} from 'class-validator';
import { PRICE_CHANNELS } from '../../pricing/price-list.types';
import type { PriceChannel } from '../../pricing/price-list.types';

export const DISCOUNT_TYPES = ['PERCENT', 'AMOUNT'] as const;
export type DiscountType = (typeof DISCOUNT_TYPES)[number];

export class SaleDiscountDto {
  @IsIn(DISCOUNT_TYPES)
  type!: DiscountType;

  @IsString()
  @Matches(/^(?:[1-9]\d{0,11}(?:\.\d{1,2})?|0\.(?:0[1-9]|[1-9]\d?))$/)
  value!: string;

  @IsString()
  @MinLength(3)
  @MaxLength(240)
  reason!: string;
}

export class QuoteCartLineDto {
  @IsUUID()
  productId!: string;

  @IsString()
  @Matches(/^(0|[1-9]\d{0,8})(\.\d{1,3})?$/)
  quantity!: string;

  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : value,
  )
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(240)
  @Matches(/^[^\p{Cc}]*$/u)
  note?: string;

  @IsOptional()
  @IsString()
  @Matches(/^(?:[1-9]\d{0,11}(?:\.\d{1,2})?|0\.(?:0[1-9]|[1-9]\d?))$/)
  manualUnitPrice?: string;

  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : value,
  )
  @IsOptional()
  @IsString()
  @MinLength(3)
  @MaxLength(240)
  @Matches(/^[^\p{Cc}]*$/u)
  priceOverrideReason?: string;

  @IsUUID()
  @IsOptional()
  lotId?: string;

  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : value,
  )
  @IsOptional()
  @IsString()
  @MinLength(3)
  @MaxLength(240)
  expiredLotOverrideReason?: string;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(1000)
  @ArrayUnique((value: string) => value.trim().toUpperCase())
  @IsString({ each: true })
  serialNumbers?: string[];

  @IsOptional()
  @ValidateNested()
  @Type(() => SaleDiscountDto)
  discount?: SaleDiscountDto;
}

export class QuoteCartDto {
  @IsUUID()
  @IsOptional()
  customerId?: string;

  @IsOptional()
  @IsIn(PRICE_CHANNELS)
  channel?: PriceChannel;

  @IsUUID()
  @IsOptional()
  reservationId?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(10_000_000)
  loyaltyPointsToRedeem?: number;

  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(100)
  @ValidateNested({ each: true })
  @Type(() => QuoteCartLineDto)
  lines!: QuoteCartLineDto[];

  @IsOptional()
  @ValidateNested()
  @Type(() => SaleDiscountDto)
  discount?: SaleDiscountDto;
}
