import { Transform, Type } from 'class-transformer';
import {
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import { OFFLINE_SYNC_MAX_PAGE_SIZE } from '../offline-sync-v1.contract';

export class OfflineChangesQueryDto {
  @IsOptional()
  @Matches(/^1\.\d+$/)
  protocolVersion?: string = '1.0';

  @IsUUID()
  deviceId!: string;

  @IsString()
  @MaxLength(4096)
  cursor!: string;

  @Transform(({ value }: { value: unknown }) =>
    value === '' ? undefined : value,
  )
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(OFFLINE_SYNC_MAX_PAGE_SIZE)
  pageSize = 100;
}
