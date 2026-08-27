import { IsOptional, IsUUID } from 'class-validator';

export class UpdateSessionContextDto {
  @IsUUID()
  branchId!: string;

  @IsUUID()
  warehouseId!: string;

  @IsUUID()
  @IsOptional()
  cashRegisterId?: string;
}
