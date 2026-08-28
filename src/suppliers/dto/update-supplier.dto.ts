import { Type } from 'class-transformer';
import { IsInt, Min } from 'class-validator';
import { CreateSupplierDto } from './create-supplier.dto';

export class UpdateSupplierDto extends CreateSupplierDto {
  @Type(() => Number)
  @IsInt()
  @Min(1)
  version!: number;
}
