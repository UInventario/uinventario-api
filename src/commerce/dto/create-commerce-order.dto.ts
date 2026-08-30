import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  ArrayUnique,
  IsArray,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  Max,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';
import { CUSTOMER_ORDER_PRIORITIES } from '../../orders/dto/create-customer-order.dto';
import { CustomerOrderFulfillmentDto } from '../../orders/dto/customer-order-fulfillment.dto';

export class CommerceOrderLineDto {
  @IsUUID()
  productId!: string;

  @IsString()
  @Matches(
    /^(?:[1-9]\d{0,8}(?:\.\d{1,3})?|0\.(?:00[1-9]|0[1-9]\d?|[1-9]\d{0,2}))$/,
  )
  quantity!: string;
}

export class CommerceOrderPaymentDto {
  @IsIn(['CARD', 'TRANSFER', 'VOUCHER'])
  method!: 'CARD' | 'TRANSFER' | 'VOUCHER';

  @IsString()
  @Matches(/^[A-Za-z0-9][A-Za-z0-9._:/-]{3,119}$/)
  reference!: string;
}

export class CreateCommerceOrderDto {
  @IsString()
  @MaxLength(100)
  @Matches(/^[A-Za-z0-9][A-Za-z0-9._:-]{2,99}$/)
  externalOrderId!: string;

  @IsOptional()
  @IsIn(CUSTOMER_ORDER_PRIORITIES)
  priority?: (typeof CUSTOMER_ORDER_PRIORITIES)[number];

  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(720)
  expiresInHours!: number;

  @ValidateNested()
  @Type(() => CustomerOrderFulfillmentDto)
  fulfillment!: CustomerOrderFulfillmentDto;

  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(100)
  @ArrayUnique((line: CommerceOrderLineDto) => line.productId)
  @ValidateNested({ each: true })
  @Type(() => CommerceOrderLineDto)
  lines!: CommerceOrderLineDto[];

  @ValidateNested()
  @Type(() => CommerceOrderPaymentDto)
  payment!: CommerceOrderPaymentDto;
}
