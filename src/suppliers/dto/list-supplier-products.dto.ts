import { Transform, Type } from 'class-transformer';
import {
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
} from 'class-validator';

export class ListSupplierProductsDto {
  @Transform(({ value }: { value: unknown }) => {
    if (typeof value !== 'string') return value;
    const trimmed = value.trim();
    return trimmed || undefined;
  })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  q?: string;

  @IsOptional()
  @IsUUID()
  supplierId?: string;

  @IsOptional()
  @IsUUID()
  productId?: string;

  @Type(() => Number)
  @IsOptional()
  @IsInt()
  @Min(1)
  page = 1;

  @Type(() => Number)
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(100)
  pageSize = 20;
}
