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
  OPERATIONAL_PERMISSIONS,
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
  @ArrayMaxSize(OPERATIONAL_PERMISSIONS.length)
  @ArrayUnique()
  @IsIn(OPERATIONAL_PERMISSIONS, { each: true })
  permissions!: AppPermission[];
}
