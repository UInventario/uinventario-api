import { Transform, Type } from 'class-transformer';
import {
  IsInt,
  IsOptional,
  IsString,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';

export class TransitionPurchaseOrderDto {
  @Type(() => Number)
  @IsInt()
  @Min(1)
  version!: number;
}

export class CancelPurchaseOrderDto extends TransitionPurchaseOrderDto {
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : value,
  )
  @IsString()
  @MinLength(3)
  @MaxLength(500)
  reason!: string;
}

export class ApprovePurchaseOrderDto extends TransitionPurchaseOrderDto {
  @Transform(({ value }: { value: unknown }) => {
    if (typeof value !== 'string') return value;
    return value.replace(/\s+/g, ' ').trim() || undefined;
  })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  reason?: string;
}
