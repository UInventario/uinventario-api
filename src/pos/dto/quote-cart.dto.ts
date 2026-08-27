import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsString,
  IsUUID,
  Matches,
  ValidateNested,
} from 'class-validator';

export class QuoteCartLineDto {
  @IsUUID()
  productId!: string;

  @IsString()
  @Matches(/^(0|[1-9]\d{0,8})(\.\d{1,3})?$/)
  quantity!: string;
}

export class QuoteCartDto {
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(100)
  @ValidateNested({ each: true })
  @Type(() => QuoteCartLineDto)
  lines!: QuoteCartLineDto[];
}
