import { Type } from 'class-transformer';
import { IsInt, Min } from 'class-validator';
import { SavePurchaseOrderDto } from './save-purchase-order.dto';

export class UpdatePurchaseOrderDto extends SavePurchaseOrderDto {
  @Type(() => Number)
  @IsInt()
  @Min(1)
  version!: number;
}
