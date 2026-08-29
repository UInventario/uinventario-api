import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsIn,
  IsISO8601,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  MaxLength,
  ValidateNested,
} from 'class-validator';
import { CreateCashSaleDto } from '../../pos/dto/create-cash-sale.dto';

const MONEY = /^(0|[1-9]\d{0,11})(\.\d{2})$/;
const QUANTITY = /^(0|[1-9]\d{0,8})(\.\d{3})$/;
const TAX_RATE = /^(0|[1-9]\d{0,2})(\.\d{4})$/;

class OfflineCashSaleSnapshotLineDto {
  @IsUUID()
  productId!: string;

  @IsString()
  @MaxLength(160)
  name!: string;

  @IsString()
  @MaxLength(40)
  sku!: string;

  @Matches(QUANTITY)
  quantity!: string;

  @Matches(MONEY)
  unitPrice!: string;

  @Matches(MONEY)
  subtotal!: string;

  @Matches(MONEY)
  tax!: string;

  @Matches(MONEY)
  total!: string;
}

class OfflineCashSaleSnapshotTotalsDto {
  @IsOptional()
  @Matches(MONEY)
  gross?: string;

  @IsOptional()
  @IsIn(['0.00'])
  lineDiscount?: '0.00';

  @IsOptional()
  @IsIn(['0.00'])
  saleDiscount?: '0.00';

  @IsOptional()
  @IsIn(['0.00'])
  discount?: '0.00';

  @Matches(MONEY)
  subtotal!: string;

  @Matches(MONEY)
  tax!: string;

  @Matches(MONEY)
  total!: string;
}

export class OfflineCashSaleSnapshotDto {
  @IsISO8601({ strict: true })
  capturedAt!: string;

  @IsUUID()
  branchId!: string;

  @IsUUID()
  warehouseId!: string;

  @IsUUID()
  cashRegisterId!: string;

  @Matches(/^[A-Z]{3}$/)
  currency!: string;

  @Matches(TAX_RATE)
  taxRate!: string;

  @IsIn(['CASH'])
  paymentMethod!: 'CASH';

  @IsIn(['DENY'])
  negativeStock!: 'DENY';

  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(100)
  @ValidateNested({ each: true })
  @Type(() => OfflineCashSaleSnapshotLineDto)
  lines!: OfflineCashSaleSnapshotLineDto[];

  @ValidateNested()
  @Type(() => OfflineCashSaleSnapshotTotalsDto)
  totals!: OfflineCashSaleSnapshotTotalsDto;
}

export class OfflineCashSaleCommandDto extends CreateCashSaleDto {
  @ValidateNested()
  @Type(() => OfflineCashSaleSnapshotDto)
  snapshot!: OfflineCashSaleSnapshotDto;
}
