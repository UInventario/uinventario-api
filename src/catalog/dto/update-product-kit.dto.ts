import { Transform, Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsDateString,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  Min,
  ValidateIf,
  ValidateNested,
} from 'class-validator';

const trim = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.trim() : value;

export class ProductKitComponentDto {
  @IsUUID()
  productId!: string;

  @Transform(trim)
  @IsString()
  @Matches(/^(?:0|[1-9]\d{0,11})(?:\.\d{1,3})?$/)
  quantity!: string;
}

export class UpdateProductKitDto {
  @IsInt()
  @Min(1)
  version!: number;

  @IsBoolean()
  enabled!: boolean;

  @ValidateIf((dto: UpdateProductKitDto) => dto.enabled)
  @IsIn(['DERIVED', 'ASSEMBLED'])
  stockMode?: 'DERIVED' | 'ASSEMBLED';

  @ValidateIf((dto: UpdateProductKitDto) => dto.enabled)
  @IsIn(['FIXED', 'COMPONENT_SUM'])
  priceRule?: 'FIXED' | 'COMPONENT_SUM';

  @IsOptional()
  @IsDateString({ strict: true })
  effectiveFrom?: string;

  @IsOptional()
  @IsDateString({ strict: true })
  effectiveTo?: string;

  @ValidateIf((dto: UpdateProductKitDto) => dto.enabled)
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(50)
  @ValidateNested({ each: true })
  @Type(() => ProductKitComponentDto)
  components?: ProductKitComponentDto[];
}
