import { Type } from 'class-transformer';
import { IsIn, IsInt, IsOptional, Max, Min } from 'class-validator';
import type { SalesQuotationStatus } from '../sales-quotation.types';

export class ListSalesQuotationsDto {
  @IsOptional()
  @IsIn(['ACTIVE', 'EXPIRED', 'CONVERTING', 'CONVERTED'])
  status?: SalesQuotationStatus;
  @Type(() => Number) @IsInt() @Min(1) page = 1;
  @Type(() => Number) @IsInt() @Min(1) @Max(100) pageSize = 20;
}
