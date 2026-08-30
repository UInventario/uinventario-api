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
import { PRICE_CHANNELS } from '../price-list.types';
import type { PriceChannel } from '../price-list.types';

export class PriceListItemDto {
  @IsUUID()
  productId!: string;

  @IsString()
  @Matches(/^(?:[1-9]\d{0,11}(?:\.\d{1,2})?|0\.(?:0[1-9]|[1-9]\d?))$/)
  price!: string;
}

export class SavePriceListDto {
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : value,
  )
  @IsString()
  @MinLength(2)
  @MaxLength(120)
  name!: string;

  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim().toUpperCase() : value,
  )
  @IsString()
  @Matches(/^[A-Z]{3}$/)
  currency!: string;

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

  @IsISO8601({ strict: true })
  validFrom!: string;

  @IsOptional()
  @IsISO8601({ strict: true })
  validTo?: string;

  @IsBoolean()
  active!: boolean;

  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(500)
  @ArrayUnique((item: PriceListItemDto) => item.productId)
  @ValidateNested({ each: true })
  @Type(() => PriceListItemDto)
  items!: PriceListItemDto[];
}

export class UpdatePriceListDto extends SavePriceListDto {
  @Type(() => Number)
  @IsInt()
  @Min(1)
  version!: number;
}
