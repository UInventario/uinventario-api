import { IsInt, Min } from 'class-validator';
import { CreateProductDto } from './create-product.dto';

export class UpdateProductDto extends CreateProductDto {
  @IsInt()
  @Min(1)
  version!: number;
}
