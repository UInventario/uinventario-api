import { Transform, Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  MaxLength,
  MinLength,
  ValidateNested,
} from 'class-validator';

const trim = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.trim() : value;
const quantityPattern = /^(0|[1-9]\d{0,11})(\.\d{1,3})?$/;

export class ReceiveInventoryTransferLineDto {
  @IsUUID()
  transferLineId!: string;

  @Transform(trim)
  @IsString()
  @Matches(quantityPattern)
  receivedQuantity!: string;

  @Transform(trim)
  @IsString()
  @Matches(quantityPattern)
  discrepancyQuantity!: string;
}

export class ReceiveInventoryTransferDto {
  @Transform(trim)
  @IsOptional()
  @IsString()
  @MinLength(2)
  @MaxLength(160)
  discrepancyReason?: string;

  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(100)
  @ValidateNested({ each: true })
  @Type(() => ReceiveInventoryTransferLineDto)
  lines!: ReceiveInventoryTransferLineDto[];
}
