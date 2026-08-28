import { Transform, Type } from 'class-transformer';
import {
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
} from 'class-validator';

export enum SupplierStatusFilter {
  ACTIVE = 'ACTIVE',
  INACTIVE = 'INACTIVE',
  ALL = 'ALL',
}

export class ListSuppliersDto {
  @Transform(({ value }: { value: unknown }) => {
    if (typeof value !== 'string') return value;
    const trimmed = value.trim();
    return trimmed || undefined;
  })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  q?: string;

  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim().toUpperCase() : value,
  )
  @IsOptional()
  @IsEnum(SupplierStatusFilter)
  status = SupplierStatusFilter.ACTIVE;

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
