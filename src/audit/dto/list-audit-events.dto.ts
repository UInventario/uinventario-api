import { Type } from 'class-transformer';
import { Transform } from 'class-transformer';
import {
  IsDateString,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
} from 'class-validator';

const optionalTrim = ({ value }: { value: unknown }) => {
  if (typeof value !== 'string') return value;
  const trimmed = value.trim();
  return trimmed === '' ? undefined : trimmed;
};

export class ListAuditEventsDto {
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @IsOptional()
  page = 1;

  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  @IsOptional()
  pageSize = 20;

  @Transform(optionalTrim)
  @IsOptional()
  @IsString()
  @MaxLength(100)
  q?: string;

  @Transform(optionalTrim)
  @IsOptional()
  @IsString()
  @MaxLength(64)
  action?: string;

  @Transform(optionalTrim)
  @IsOptional()
  @IsString()
  @MaxLength(48)
  entityType?: string;

  @IsOptional()
  @IsUUID()
  actorId?: string;

  @IsOptional()
  @IsDateString({ strict: true })
  dateFrom?: string;

  @IsOptional()
  @IsDateString({ strict: true })
  dateTo?: string;
}
