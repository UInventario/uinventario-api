import { Transform, type TransformFnParams } from 'class-transformer';
import { IsString, MaxLength, MinLength } from 'class-validator';

export class VoidSaleDto {
  @Transform(({ value }: TransformFnParams): unknown =>
    typeof value === 'string' ? value.trim() : value,
  )
  @IsString()
  @MinLength(2)
  @MaxLength(240)
  reason!: string;
}
