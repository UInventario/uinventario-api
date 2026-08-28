import { Type } from 'class-transformer';
import {
  IsDateString,
  IsIn,
  IsInt,
  IsOptional,
  Max,
  Min,
} from 'class-validator';

export const CUSTOMER_HISTORY_STATUSES = [
  'ALL',
  'COMPLETED',
  'VOIDED',
] as const;
export type CustomerHistoryStatus = (typeof CUSTOMER_HISTORY_STATUSES)[number];

export class ListCustomerHistoryDto {
  @IsOptional()
  @IsDateString({ strict: true })
  dateFrom?: string;

  @IsOptional()
  @IsDateString({ strict: true })
  dateTo?: string;

  @IsIn(CUSTOMER_HISTORY_STATUSES)
  status: CustomerHistoryStatus = 'ALL';

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
