import { Type } from 'class-transformer';
import {
  IsDateString,
  IsIn,
  IsInt,
  Matches,
  IsOptional,
  IsUUID,
  Max,
  Min,
} from 'class-validator';

export class SalesCashReportDto {
  @IsOptional()
  @IsDateString({ strict: true })
  @Matches(/^\d{4}-\d{2}-\d{2}$/)
  dateFrom?: string;

  @IsOptional()
  @IsDateString({ strict: true })
  @Matches(/^\d{4}-\d{2}-\d{2}$/)
  dateTo?: string;

  @IsOptional()
  @IsUUID()
  branchId?: string;

  @IsOptional()
  @IsUUID()
  cashRegisterId?: string;

  @IsOptional()
  @IsUUID()
  userId?: string;

  @IsOptional()
  @IsIn(['ALL', 'COMPLETED', 'VOIDED'])
  status: 'ALL' | 'COMPLETED' | 'VOIDED' = 'ALL';

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
