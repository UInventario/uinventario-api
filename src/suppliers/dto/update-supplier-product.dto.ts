import { Type } from 'class-transformer';
import { IsInt, Min } from 'class-validator';
import { CreateSupplierProductDto } from './create-supplier-product.dto';

export class UpdateSupplierProductDto extends CreateSupplierProductDto {
  @Type(() => Number)
  @IsInt()
  @Min(1)
  version!: number;
}
