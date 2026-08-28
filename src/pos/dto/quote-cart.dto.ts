import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  ArrayUnique,
  IsArray,
  IsIn,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  ValidateNested,
} from 'class-validator';
import { PRICE_CHANNELS } from '../../pricing/price-list.types';
import type { PriceChannel } from '../../pricing/price-list.types';

export class QuoteCartLineDto {
  @IsUUID()
  productId!: string;

  @IsString()
  @Matches(/^(0|[1-9]\d{0,8})(\.\d{1,3})?$/)
  quantity!: string;

  @IsUUID()
  @IsOptional()
  lotId?: string;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(1000)
  @ArrayUnique((value: string) => value.trim().toUpperCase())
  @IsString({ each: true })
  serialNumbers?: string[];
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

  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(100)
  @ValidateNested({ each: true })
  @Type(() => QuoteCartLineDto)
  lines!: QuoteCartLineDto[];
}
