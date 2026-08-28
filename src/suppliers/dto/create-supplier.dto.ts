import { Transform, Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  MinLength,
  ValidateNested,
} from 'class-validator';
import { SupplierContactDto } from './supplier-contact.dto';

const trim = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.trim() : value;
const optionalTrim = ({ value }: { value: unknown }) => {
  const trimmed = trim({ value });
  return trimmed === '' || trimmed === null ? undefined : trimmed;
};

export class CreateSupplierDto {
  @Transform(trim)
  @IsString()
  @MinLength(2)
  @MaxLength(180)
  legalName!: string;

  @Transform(optionalTrim)
  @IsOptional()
  @IsString()
  @MinLength(2)
  @MaxLength(180)
  tradeName?: string;

  @Transform(trim)
  @IsString()
  @Matches(/^[\p{L}\p{N}.&\-/ ]{3,64}$/u)
  taxIdentifier!: string;

  @IsArray()
  @ArrayMaxSize(20)
  @ValidateNested({ each: true })
  @Type(() => SupplierContactDto)
  contacts: SupplierContactDto[] = [];
}
