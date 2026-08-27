import { Transform } from 'class-transformer';
import {
  IsIn,
  IsString,
  IsUUID,
  Matches,
  MaxLength,
  MinLength,
} from 'class-validator';
import type { UserInventoryMovementType } from '../../inventory/inventory.types';

export const OFFLINE_INVENTORY_MOVEMENT_TYPES = [
  'ENTRY',
  'EXIT',
  'RETURN',
  'LOSS',
  'DAMAGE',
] as const satisfies readonly UserInventoryMovementType[];

const trim = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.trim() : value;

export class OfflineInventoryMovementCommandDto {
  @IsUUID()
  productId!: string;

  @IsUUID()
  locationId!: string;

  @IsIn(OFFLINE_INVENTORY_MOVEMENT_TYPES)
  type!: (typeof OFFLINE_INVENTORY_MOVEMENT_TYPES)[number];

  @Transform(trim)
  @IsString()
  @Matches(/^(0|[1-9]\d{0,11})(\.\d{1,3})?$/)
  quantity!: string;

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
}
