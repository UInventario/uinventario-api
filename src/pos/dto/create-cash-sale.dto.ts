import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsIn,
  IsOptional,
  IsInt,
  IsString,
  IsUUID,
  Matches,
  ValidateNested,
  Max,
  Min,
} from 'class-validator';
import { QuoteCartLineDto, SaleDiscountDto } from './quote-cart.dto';
import { PRICE_CHANNELS } from '../../pricing/price-list.types';
import type { PriceChannel } from '../../pricing/price-list.types';

export class CreateCashSaleDto {
  @IsOptional()
  @IsIn(PRICE_CHANNELS)
  channel?: PriceChannel;

  @IsOptional()
  @IsUUID()
  customerId?: string;

  @IsOptional()
  @IsUUID()
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

  @IsString()
  @Matches(/^(0|[1-9]\d{0,11})(\.\d{1,2})?$/)
  cashReceived!: string;
}
