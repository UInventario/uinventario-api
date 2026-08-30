import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  ArrayUnique,
  IsArray,
  IsBoolean,
  IsInt,
  Min,
  ValidateNested,
} from 'class-validator';
import { SalePaymentDto } from '../../pos/dto/create-sale.dto';

export class ConvertSalesQuotationDto {
  @Type(() => Number) @IsInt() @Min(1) version!: number;
  @IsBoolean() acceptDifferences!: boolean;
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(4)
  @ArrayUnique((payment: SalePaymentDto) => payment.method)
  @ValidateNested({ each: true })
  @Type(() => SalePaymentDto)
  payments!: SalePaymentDto[];
}
