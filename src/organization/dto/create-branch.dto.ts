import { Transform } from 'class-transformer';
import {
  IsString,
  IsTimeZone,
  Matches,
  MaxLength,
  MinLength,
} from 'class-validator';

const trim = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.trim() : value;

export class CreateBranchDto {
  @Transform(trim)
  @IsString()
  @MinLength(2)
  @MaxLength(120)
  name!: string;

  @Transform(trim)
  @IsString()
  @IsTimeZone()
  @MaxLength(64)
  timezone!: string;

  @Transform(trim)
  @IsString()
  @MinLength(2)
  @MaxLength(120)
  warehouseName!: string;

  @Transform(trim)
  @IsString()
  @MinLength(2)
  @MaxLength(120)
  locationName!: string;

  @Transform(trim)
  @IsString()
  @Matches(/^[A-Za-z0-9][A-Za-z0-9_-]{1,39}$/)
  locationCode!: string;
}
