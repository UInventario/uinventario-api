import { Type } from 'class-transformer';
import { IsIn, IsInt, IsOptional, Max, Min } from 'class-validator';
import { CUSTOMER_ORDER_PRIORITIES } from './create-customer-order.dto';

const STATUSES = [
  'DRAFT',
  'CONFIRMED',
  'PREPARING',
  'READY',
  'DELIVERED',
  'CANCELLED',
] as const;

export class ListCustomerOrdersDto {
  @IsOptional()
  @IsIn(STATUSES)
  status?: (typeof STATUSES)[number];

  @IsOptional()
  @IsIn(CUSTOMER_ORDER_PRIORITIES)
  priority?: (typeof CUSTOMER_ORDER_PRIORITIES)[number];

  @Type(() => Number)
  @IsInt()
  @Min(1)
  page = 1;

  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  pageSize = 20;
}
