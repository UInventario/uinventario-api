import { Transform } from 'class-transformer';
import {
  IsBoolean,
  IsDateString,
  IsIn,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  MaxLength,
} from 'class-validator';

export const DATA_EXPORT_DATASETS = [
  'PRODUCTS',
  'STOCK',
  'SALES',
  'MOVEMENTS',
] as const;
export type DataExportDataset = (typeof DATA_EXPORT_DATASETS)[number];
export type DataExportFormat = 'CSV' | 'XLSX';

const trim = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.trim() || undefined : value;

export class CreateDataExportDto {
  @IsIn(DATA_EXPORT_DATASETS)
  dataset!: DataExportDataset;

  @IsIn(['CSV', 'XLSX'])
  format!: DataExportFormat;

  @Transform(trim)
  @IsOptional()
  @IsString()
  @MaxLength(80)
  q?: string;

  @IsOptional()
  @IsIn(['ACTIVE', 'INACTIVE', 'ALL'])
  productStatus?: 'ACTIVE' | 'INACTIVE' | 'ALL';

  @IsOptional()
  @IsIn(['COMPLETED', 'VOIDED', 'ALL'])
  saleStatus?: 'COMPLETED' | 'VOIDED' | 'ALL';

  @IsOptional()
  @IsString()
  @MaxLength(30)
  movementType?: string;

  @IsOptional()
  @IsUUID()
  categoryId?: string;

  @IsOptional()
  @IsUUID()
  brandId?: string;

  @IsOptional()
  @IsUUID()
  productId?: string;

  @IsOptional()
  @IsUUID()
  locationId?: string;

  @IsOptional()
  @IsUUID()
  cashRegisterId?: string;

  @IsOptional()
  @IsUUID()
  userId?: string;

  @IsOptional()
  @IsDateString({ strict: true })
  @Matches(/^\d{4}-\d{2}-\d{2}$/)
  dateFrom?: string;

  @IsOptional()
  @IsDateString({ strict: true })
  @Matches(/^\d{4}-\d{2}-\d{2}$/)
  dateTo?: string;

  @IsOptional()
  @IsBoolean()
  includeSensitive = false;
}
