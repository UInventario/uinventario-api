import { Transform } from 'class-transformer';
import { IsString, IsTimeZone, MaxLength, MinLength } from 'class-validator';

const trim = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.trim() : value;

export class UpdateBranchDto {
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
}
