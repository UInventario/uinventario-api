import { Transform, Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsString,
  IsUUID,
  Matches,
  MaxLength,
  MinLength,
  ValidateNested,
} from 'class-validator';

const trim = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.trim() : value;

export class CreateInventoryTransferLineDto {
  @IsUUID()
  productId!: string;

  @IsUUID()
  sourceLocationId!: string;

  @IsUUID()
  destinationLocationId!: string;

  @Transform(trim)
  @IsString()
  @Matches(/^[1-9]\d{0,11}(\.\d{1,3})?$|^0\.\d{1,3}$/)
  quantity!: string;
}

export class CreateInventoryTransferDto {
  @IsUUID()
  destinationWarehouseId!: string;

  @Transform(trim)
  @IsString()
  @MinLength(2)
  @MaxLength(120)
  reference!: string;

  @Transform(trim)
  @IsString()
  @MinLength(2)
  @MaxLength(160)
  reason!: string;

  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(100)
  @ValidateNested({ each: true })
  @Type(() => CreateInventoryTransferLineDto)
  lines!: CreateInventoryTransferLineDto[];
}
