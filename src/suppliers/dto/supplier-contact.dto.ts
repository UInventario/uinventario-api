import { Transform } from 'class-transformer';
import {
  IsBoolean,
  IsEmail,
  IsOptional,
  IsString,
  MaxLength,
  MinLength,
  ValidateIf,
} from 'class-validator';

const trim = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.trim() : value;
const optionalTrim = ({ value }: { value: unknown }) => {
  const trimmed = trim({ value });
  return trimmed === '' || trimmed === null ? undefined : trimmed;
};

export class SupplierContactDto {
  @Transform(trim)
  @IsString()
  @MinLength(2)
  @MaxLength(120)
  name!: string;

  @Transform(optionalTrim)
  @IsOptional()
  @IsEmail()
  @MaxLength(254)
  email?: string;

  @Transform(optionalTrim)
  @IsOptional()
  @IsString()
  @MaxLength(40)
  phone?: string;

  @Transform(optionalTrim)
  @IsOptional()
  @IsString()
  @MaxLength(80)
  role?: string;

  @IsBoolean()
  @IsOptional()
  primary = false;

  @ValidateIf((contact: SupplierContactDto) => !contact.email && !contact.phone)
  @IsString({ message: 'Cada contacto requiere correo o teléfono.' })
  private readonly contactMethod?: never;
}
