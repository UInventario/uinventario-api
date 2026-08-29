import { Transform, Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  ArrayUnique,
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsISO8601,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  Max,
  MaxLength,
  Min,
  MinLength,
  ValidateNested,
} from 'class-validator';
import {
  PRICE_CHANNELS,
  type PriceChannel,
} from '../../pricing/price-list.types';
import { PROMOTION_TYPES, type PromotionType } from '../promotion.types';

const quantity =
  /^(?:[1-9]\d{0,11}(?:\.\d{1,3})?|0\.(?:00[1-9]|0[1-9]\d?|[1-9]\d{0,2}))$/;
const percent =
  /^(?:100(?:\.0{1,4})?|(?:[1-9]\d?|0\.\d{0,3}[1-9]|[1-9]\d?\.\d{1,4}))$/;
const money = /^(?:[1-9]\d{0,11}(?:\.\d{1,2})?|0\.(?:0[1-9]|[1-9]\d?))$/;

export class PromotionProductDto {
  @IsUUID()
  productId!: string;

  @IsString()
  @Matches(quantity)
  quantity!: string;
}

export class PromotionTierDto {
  @IsString()
  @Matches(quantity)
  minimumQuantity!: string;

  @IsString()
  @Matches(percent)
  discountPercent!: string;
}

export class SavePromotionDto {
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : value,
  )
  @IsString()
  @MinLength(2)
  @MaxLength(120)
  name!: string;

  @IsIn(PROMOTION_TYPES)
  type!: PromotionType;

  @IsOptional()
  @IsUUID()
  branchId?: string;

  @IsOptional()
  @IsUUID()
  customerId?: string;

  @IsOptional()
  @IsIn(PRICE_CHANNELS)
  channel?: PriceChannel;

  @Type(() => Number)
  @IsInt()
  @Min(-100000)
  @Max(100000)
  priority!: number;

  @IsBoolean()
  stackable!: boolean;

  @IsISO8601({ strict: true })
  validFrom!: string;

  @IsOptional()
  @IsISO8601({ strict: true })
  validTo?: string;

  @IsBoolean()
  active!: boolean;

  @IsOptional()
  @IsString()
  @Matches(percent)
  discountPercent?: string;

  @IsOptional()
  @IsString()
  @Matches(money)
  fixedPrice?: string;

  @IsOptional()
  @IsString()
  @Matches(quantity)
  buyQuantity?: string;

  @IsOptional()
  @IsString()
  @Matches(quantity)
  rewardQuantity?: string;

  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(50)
  @ArrayUnique((item: PromotionProductDto) => item.productId)
  @ValidateNested({ each: true })
  @Type(() => PromotionProductDto)
  products!: PromotionProductDto[];

  @IsArray()
  @ArrayMaxSize(20)
  @ArrayUnique((item: PromotionTierDto) => item.minimumQuantity)
  @ValidateNested({ each: true })
  @Type(() => PromotionTierDto)
  tiers!: PromotionTierDto[];
}

export class UpdatePromotionDto extends SavePromotionDto {
  @Type(() => Number)
  @IsInt()
  @Min(1)
  version!: number;
}
