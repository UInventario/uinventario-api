import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  ArrayUnique,
  IsArray,
  IsIn,
  IsInt,
  IsOptional,
  IsUUID,
  Max,
  Min,
  ValidateNested,
} from 'class-validator';
import { PRICE_CHANNELS } from '../../pricing/price-list.types';
import { QuoteCartLineDto } from '../../pos/dto/quote-cart.dto';
import { SalePaymentDto } from '../../pos/dto/create-sale.dto';
import { CustomerOrderFulfillmentDto } from './customer-order-fulfillment.dto';

export const CUSTOMER_ORDER_PRIORITIES = [
  'LOW',
  'NORMAL',
  'HIGH',
  'URGENT',
] as const;

export class CreateCustomerOrderDto {
  @IsIn(PRICE_CHANNELS)
  channel!: (typeof PRICE_CHANNELS)[number];

  @IsUUID()
  customerId!: string;

  @IsUUID()
  locationId!: string;

  @ValidateNested()
  @Type(() => CustomerOrderFulfillmentDto)
  fulfillment!: CustomerOrderFulfillmentDto;

  @IsOptional()
  @IsIn(CUSTOMER_ORDER_PRIORITIES)
  priority?: (typeof CUSTOMER_ORDER_PRIORITIES)[number];

  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(720)
  expiresInHours!: number;

  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(100)
  @ArrayUnique((line: QuoteCartLineDto) => line.productId)
  @ValidateNested({ each: true })
  @Type(() => QuoteCartLineDto)
  lines!: QuoteCartLineDto[];

  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(4)
  @ArrayUnique((payment: SalePaymentDto) => payment.method)
  @ValidateNested({ each: true })
  @Type(() => SalePaymentDto)
  payments!: SalePaymentDto[];
}
