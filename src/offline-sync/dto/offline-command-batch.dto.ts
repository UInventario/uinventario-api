import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsIn,
  IsInt,
  IsISO8601,
  IsObject,
  IsString,
  IsUUID,
  Matches,
  Min,
  ValidateIf,
  ValidateNested,
} from 'class-validator';

export class OfflineCommandScopeDto {
  @IsUUID()
  tenantId!: string;

  @IsUUID()
  userId!: string;

  @IsUUID()
  deviceId!: string;

  @ValidateIf(({ branchId }: OfflineCommandScopeDto) => branchId !== null)
  @IsUUID()
  branchId!: string | null;

  @ValidateIf(
    ({ cashRegisterId }: OfflineCommandScopeDto) => cashRegisterId !== null,
  )
  @IsUUID()
  cashRegisterId!: string | null;
}

export class OfflineCommandDto {
  @IsIn(['1.0'])
  protocolVersion!: '1.0';

  @IsUUID()
  commandId!: string;

  @IsString()
  @Matches(/^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/)
  idempotencyKey!: string;

  @ValidateNested()
  @Type(() => OfflineCommandScopeDto)
  scope!: OfflineCommandScopeDto;

  @Type(() => Number)
  @IsInt()
  @Min(1)
  sequence!: number;

  @IsISO8601({ strict: true })
  createdAt!: string;

  @IsIn(['CASH_SALE', 'INVENTORY_COUNT', 'INVENTORY_MOVEMENT'])
  kind!: 'CASH_SALE' | 'INVENTORY_COUNT' | 'INVENTORY_MOVEMENT';

  @IsObject()
  payload!: Record<string, unknown>;
}

export class OfflineCommandBatchDto {
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(20)
  @ValidateNested({ each: true })
  @Type(() => OfflineCommandDto)
  commands!: OfflineCommandDto[];
}
