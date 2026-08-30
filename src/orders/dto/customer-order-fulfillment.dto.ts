import {
  IsIn,
  IsISO8601,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  MinLength,
} from 'class-validator';

export const CUSTOMER_ORDER_FULFILLMENT_METHODS = [
  'PICKUP',
  'DELIVERY',
] as const;
export const CUSTOMER_ORDER_CARRIERS = [
  'SIMULATED',
  'SIMULATED_RETRY',
] as const;

export class CustomerOrderFulfillmentDto {
  @IsIn(CUSTOMER_ORDER_FULFILLMENT_METHODS)
  method!: (typeof CUSTOMER_ORDER_FULFILLMENT_METHODS)[number];

  @IsISO8601({ strict: true })
  windowStart!: string;

  @IsISO8601({ strict: true })
  windowEnd!: string;

  @Matches(/^(0|[1-9]\d{0,9})(\.\d{1,2})?$/)
  deliveryCost!: string;

  @IsOptional()
  @IsString()
  @MinLength(2)
  @MaxLength(120)
  recipientName?: string;

  @IsOptional()
  @Matches(/^\+?[0-9 ()-]{7,40}$/)
  recipientPhone?: string;

  @IsOptional()
  @IsString()
  @MinLength(4)
  @MaxLength(180)
  addressLine1?: string;

  @IsOptional()
  @IsString()
  @MaxLength(180)
  addressLine2?: string;

  @IsOptional()
  @IsString()
  @MinLength(2)
  @MaxLength(100)
  city?: string;

  @IsOptional()
  @IsString()
  @MinLength(2)
  @MaxLength(100)
  region?: string;

  @IsOptional()
  @Matches(/^[A-Za-z0-9 -]{3,24}$/)
  postalCode?: string;

  @IsOptional()
  @Matches(/^[A-Z]{2}$/)
  countryCode?: string;

  @IsOptional()
  @IsIn(CUSTOMER_ORDER_CARRIERS)
  carrierCode?: (typeof CUSTOMER_ORDER_CARRIERS)[number];
}
