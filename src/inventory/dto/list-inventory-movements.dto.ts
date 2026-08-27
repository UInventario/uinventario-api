import { Transform, Type } from 'class-transformer';
import {
  IsDateString,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import {
  INVENTORY_MOVEMENT_TYPES,
  type InventoryMovementType,
} from '../inventory.types';

const optionalTrim = ({ value }: { value: unknown }) => {
  if (typeof value !== 'string') return value;
  const trimmed = value.trim();
  return trimmed === '' ? undefined : trimmed;
};

export class ListInventoryMovementsDto {
  @IsOptional()
  @IsUUID()
  productId?: string;

  @IsOptional()
  @IsUUID()
  locationId?: string;

  @IsOptional()
  @IsUUID()
  userId?: string;

  @Transform(optionalTrim)
  @IsOptional()
  @IsString()
  @MaxLength(80)
  q?: string;

  @Transform(optionalTrim)
  @IsOptional()
  @IsString()
  @MaxLength(120)
  location?: string;

  @Transform(optionalTrim)
  @IsOptional()
  @IsString()
  @MaxLength(254)
  responsible?: string;

  @Transform(optionalTrim)
  @IsOptional()
  @IsString()
  @MaxLength(128)
  document?: string;

  @IsOptional()
  @IsIn(INVENTORY_MOVEMENT_TYPES)
  type?: InventoryMovementType;

  @IsOptional()
  @IsDateString({ strict: true })
  dateFrom?: string;

  @IsOptional()
  @IsDateString({ strict: true })
  dateTo?: string;

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
