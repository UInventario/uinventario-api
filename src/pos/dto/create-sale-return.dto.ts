import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsEnum,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  MaxLength,
  MinLength,
  ValidateNested,
} from 'class-validator';

export enum SaleReturnConditionDto {
  SELLABLE = 'SELLABLE',
  DAMAGED = 'DAMAGED',
}

export class CreateSaleReturnLineDto {
  @IsUUID()
  saleLineId!: string;

  @IsString()
  @Matches(/^\d{1,15}(?:\.\d{1,3})?$/)
  quantity!: string;

  @IsEnum(SaleReturnConditionDto)
  condition!: SaleReturnConditionDto;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(1000)
  @IsString({ each: true })
  @MaxLength(120, { each: true })
  serialNumbers?: string[];
}

export class CreateSaleReturnDto {
  @IsString()
  @MinLength(3)
  @MaxLength(240)
  reason!: string;

  @IsOptional()
  @IsUUID()
  exchangeSaleId?: string;

  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(100)
  @ValidateNested({ each: true })
  @Type(() => CreateSaleReturnLineDto)
  lines!: CreateSaleReturnLineDto[];
}
