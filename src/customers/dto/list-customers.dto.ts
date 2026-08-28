import { Transform, Type } from 'class-transformer';
import {
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
} from 'class-validator';

export class ListCustomersDto {
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string'
      ? value.replace(/\s+/g, ' ').trim() || undefined
      : value,
  )
  @IsOptional()
  @IsString()
  @MaxLength(100)
  q?: string;

  @IsOptional()
  @IsIn(['ACTIVE', 'INACTIVE', 'ALL'])
  status: 'ACTIVE' | 'INACTIVE' | 'ALL' = 'ACTIVE';

  @Type(() => Number)
  @IsInt()
  @Min(1)
  page = 1;

  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  pageSize = 20;
}
