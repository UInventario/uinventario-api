import { Transform } from 'class-transformer';
import { IsIn, IsInt, IsOptional, Matches, Max, Min } from 'class-validator';
import { ERP_RESOURCES } from '../erp-integration.types';

export class ErpExportQueryDto {
  @Matches(/^[A-Z][A-Z0-9_-]{1,31}$/)
  provider!: string;

  @IsIn(ERP_RESOURCES)
  resource!: (typeof ERP_RESOURCES)[number];

  @IsOptional()
  @Matches(/^[A-Za-z0-9_-]{8,500}$/)
  cursor?: string;

  @Transform(({ value }) => Number(value))
  @IsInt()
  @Min(1)
  @Max(100)
  limit = 50;
}
