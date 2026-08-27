import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  ValidateNested,
} from 'class-validator';
import { QuoteCartLineDto } from './quote-cart.dto';

export class CreateCashSaleDto {
  @IsOptional()
  @IsUUID()
  customerId?: string;

  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(100)
  @ValidateNested({ each: true })
  @Type(() => QuoteCartLineDto)
  lines!: QuoteCartLineDto[];

  @IsString()
  @Matches(/^(0|[1-9]\d{0,11})(\.\d{1,2})?$/)
  cashReceived!: string;
}
