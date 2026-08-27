import { Transform } from 'class-transformer';
import {
  IsIn,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  MaxLength,
  MinLength,
} from 'class-validator';

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

  @IsIn(['INITIAL', 'ENTRY', 'ADJUSTMENT'])
  type!: 'INITIAL' | 'ENTRY' | 'ADJUSTMENT';

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
}
