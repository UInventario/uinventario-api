import { Transform } from 'class-transformer';
import {
  IsDateString,
  IsString,
  IsUUID,
  Matches,
  MaxLength,
  MinLength,
} from 'class-validator';

const trim = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.trim() : value;

export class OfflineInventoryCountCommandDto {
  @IsUUID()
  productId!: string;

  @IsUUID()
  locationId!: string;

  @Transform(trim)
  @IsString()
  @Matches(/^(0|[1-9]\d{0,11})(\.\d{1,3})?$/)
  countedQuantity!: string;

  @Transform(trim)
  @IsString()
  @Matches(/^(0|[1-9]\d{0,11})(\.\d{1,3})?$/)
  snapshotQuantity!: string;

  @Transform(trim)
  @IsString()
  @MinLength(2)
  @MaxLength(160)
  reason!: string;

  @Transform(trim)
  @IsString()
  @MinLength(2)
  @MaxLength(120)
  reference!: string;

  @IsDateString()
  capturedAt!: string;
}
