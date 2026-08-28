import { IsEnum, IsOptional, IsString, IsUUID, Matches } from 'class-validator';

export enum SaleReturnSettlementModeDto {
  REFUND = 'REFUND',
  STORE_CREDIT = 'STORE_CREDIT',
}

export class CreateSaleReturnSettlementDto {
  @IsEnum(SaleReturnSettlementModeDto)
  mode!: SaleReturnSettlementModeDto;

  @IsString()
  @Matches(/^(?:0\.(?:0[1-9]|[1-9]\d)|[1-9]\d{0,14}(?:\.\d{1,2})?)$/)
  amount!: string;

  @IsOptional()
  @IsUUID()
  originalPaymentId?: string;
}
