import { Transform } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayUnique,
  IsArray,
  IsIn,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  MaxLength,
  MinLength,
} from 'class-validator';
import type { UserInventoryMovementType } from '../inventory.types';

const USER_MOVEMENT_TYPES: UserInventoryMovementType[] = [
  'INITIAL',
  'ENTRY',
  'EXIT',
  'RETURN',
  'LOSS',
  'DAMAGE',
  'ADJUSTMENT',
];

const trim = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.trim() : value;
const optionalTrim = ({ value }: { value: unknown }) => {
  const trimmed = trim({ value });
  return trimmed === '' || trimmed === null ? undefined : trimmed;
};

export class CreateInventoryMovementDto {
  @IsUUID()
  productId!: string;

  @IsUUID()
  locationId!: string;

  @IsIn(USER_MOVEMENT_TYPES)
  type!: UserInventoryMovementType;

  @Transform(trim)
  @IsString()
  @Matches(/^-?(0|[1-9]\d{0,11})(\.\d{1,3})?$/)
  quantity!: string;

  @Transform(trim)
  @IsString()
  @MinLength(2)
  @MaxLength(160)
  reason!: string;

  @Transform(optionalTrim)
  @IsOptional()
  @IsString()
  @MaxLength(120)
  reference?: string;

  @Transform(optionalTrim)
  @IsOptional()
  @IsString()
  @Matches(/^[A-Za-z0-9][A-Za-z0-9._/ -]{0,63}$/)
  lotCode?: string;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(1000)
  @ArrayUnique((value: string) => value.trim().toUpperCase())
  @IsString({ each: true })
  @MaxLength(120, { each: true })
  serialNumbers?: string[];
}
