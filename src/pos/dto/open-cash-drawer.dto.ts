import { IsIn, IsOptional, IsUUID } from 'class-validator';

export class OpenCashDrawerDto {
  @IsIn(['MANUAL', 'CASH_SALE_COMPLETED'])
  trigger!: 'MANUAL' | 'CASH_SALE_COMPLETED';

  @IsOptional()
  @IsUUID()
  saleId?: string;
}
