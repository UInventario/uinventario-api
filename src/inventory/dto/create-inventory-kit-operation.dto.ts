import { Transform } from 'class-transformer';
import { IsIn, IsString, IsUUID, Matches } from 'class-validator';

const trim = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.trim() : value;

export class CreateInventoryKitOperationDto {
  @IsIn(['ASSEMBLE', 'DISASSEMBLE'])
  operationType!: 'ASSEMBLE' | 'DISASSEMBLE';

  @IsUUID()
  locationId!: string;

  @Transform(trim)
  @IsString()
  @Matches(/^(?:0|[1-9]\d{0,11})(?:\.\d{1,3})?$/)
  quantity!: string;
}
