import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsInt,
  IsString,
  IsUUID,
  Matches,
  Max,
  Min,
  ValidateNested,
} from 'class-validator';

export class CreateProductReservationLineDto {
  @IsUUID()
  productId!: string;

  @IsString()
  @Matches(/^(?=.*[1-9])(0|[1-9]\d{0,11})(\.\d{1,3})?$/)
  quantity!: string;
}

export class CreateProductReservationDto {
  @IsUUID()
  customerId!: string;

  @IsUUID()
  locationId!: string;

  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(720)
  expiresInHours!: number;

  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(100)
  @ValidateNested({ each: true })
  @Type(() => CreateProductReservationLineDto)
  lines!: CreateProductReservationLineDto[];
}
