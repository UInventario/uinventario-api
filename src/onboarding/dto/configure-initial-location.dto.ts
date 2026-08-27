import { Transform } from 'class-transformer';
import { IsString, IsTimeZone, MaxLength, MinLength } from 'class-validator';

const trim = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.trim() : value;

export class ConfigureInitialLocationDto {
  @Transform(trim)
  @IsString()
  @MinLength(2)
  @MaxLength(120)
  branchName!: string;

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
}
