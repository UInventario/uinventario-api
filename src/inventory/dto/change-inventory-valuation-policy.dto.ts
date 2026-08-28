import { Type } from 'class-transformer';
import { IsIn, IsInt, IsString, Length, Min } from 'class-validator';
import {
  INVENTORY_VALUATION_METHODS,
  type InventoryValuationMethod,
} from '../inventory-valuation-policy.types';

export class PreviewInventoryValuationPolicyDto {
  @IsIn(INVENTORY_VALUATION_METHODS)
  targetMethod!: InventoryValuationMethod;
}

export class ChangeInventoryValuationPolicyDto extends PreviewInventoryValuationPolicyDto {
  @Type(() => Number)
  @IsInt()
  @Min(1)
  expectedVersion!: number;

  @IsString()
  @Length(64, 64)
  planFingerprint!: string;
}
