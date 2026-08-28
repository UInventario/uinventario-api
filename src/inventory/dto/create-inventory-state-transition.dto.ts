import { Transform } from 'class-transformer';
import {
  IsIn,
  IsString,
  IsUUID,
  Matches,
  MaxLength,
  MinLength,
} from 'class-validator';
import type { InventoryStockState } from '../inventory.types';

const trim = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.trim() : value;
const STATES: InventoryStockState[] = [
  'AVAILABLE',
  'RESERVED',
  'DAMAGED',
  'IN_TRANSIT',
];

export class CreateInventoryStateTransitionDto {
  @IsUUID()
  productId!: string;

  @IsUUID()
  locationId!: string;

  @IsIn(STATES)
  fromState!: InventoryStockState;

  @IsIn(STATES)
  toState!: InventoryStockState;

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
