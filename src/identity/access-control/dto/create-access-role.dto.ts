import { Transform } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  ArrayUnique,
  IsArray,
  IsIn,
  IsString,
  Length,
} from 'class-validator';
import {
  INVENTORY_PERMISSIONS,
  type AppPermission,
} from '../../../auth/authorization/authorization.types';

export class CreateAccessRoleDto {
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : value,
  )
  @IsString()
  @Length(2, 80)
  name!: string;

  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(INVENTORY_PERMISSIONS.length)
  @ArrayUnique()
  @IsIn(INVENTORY_PERMISSIONS, { each: true })
  permissions!: AppPermission[];
}
