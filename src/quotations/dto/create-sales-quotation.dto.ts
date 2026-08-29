import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  ArrayUnique,
  IsArray,
  IsDateString,
  IsIn,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  ValidateNested,
} from 'class-validator';
import { PRICE_CHANNELS } from '../../pricing/price-list.types';
import {
  QuoteCartLineDto,
  SaleDiscountDto,
} from '../../pos/dto/quote-cart.dto';

export class CreateSalesQuotationDto {
  @IsOptional() @IsUUID() customerId?: string;
  @IsOptional() @IsUUID() reservationId?: string;
  @IsIn(PRICE_CHANNELS) channel!: (typeof PRICE_CHANNELS)[number];
  @IsDateString() validUntil!: string;
  @IsOptional() @IsString() @MaxLength(1000) notes?: string;
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(100)
  @ArrayUnique((line: QuoteCartLineDto) => line.productId)
  @ValidateNested({ each: true })
  @Type(() => QuoteCartLineDto)
  lines!: QuoteCartLineDto[];
  @IsOptional()
  @ValidateNested()
  @Type(() => SaleDiscountDto)
  discount?: SaleDiscountDto;
}
