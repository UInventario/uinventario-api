import { Type } from 'class-transformer';
import { IsInt, Min } from 'class-validator';
import { CreateSalesQuotationDto } from './create-sales-quotation.dto';

export class UpdateSalesQuotationDto extends CreateSalesQuotationDto {
  @Type(() => Number) @IsInt() @Min(1) version!: number;
}
