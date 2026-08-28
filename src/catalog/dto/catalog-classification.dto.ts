import { Transform } from 'class-transformer';
import {
  IsBoolean,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  MinLength,
} from 'class-validator';

const trim = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.trim() : value;

export enum CatalogClassificationKind {
  CATEGORIES = 'categories',
  BRANDS = 'brands',
}

export class CreateCatalogClassificationDto {
  @Transform(trim)
  @IsString()
  @MinLength(2)
  @MaxLength(120)
  name!: string;
}

export class UpdateCatalogClassificationDto {
  @Transform(trim)
  @IsOptional()
  @IsString()
  @MinLength(2)
  @MaxLength(120)
  name?: string;

  @IsOptional()
  @IsBoolean()
  active?: boolean;
}

export class ListCatalogClassificationsDto {
  @Transform(
    ({ value }: { value: unknown }) => value === true || value === 'true',
  )
  @IsOptional()
  @IsBoolean()
  includeInactive = false;
}

export class DeactivateCatalogClassificationDto {
  @IsOptional()
  @IsUUID()
  replacementId?: string;
}
