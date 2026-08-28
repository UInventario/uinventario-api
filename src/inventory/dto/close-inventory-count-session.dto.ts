import { IsString, MaxLength, MinLength } from 'class-validator';

export class CloseInventoryCountSessionDto {
  @IsString()
  @MinLength(3)
  @MaxLength(160)
  reason!: string;

  @IsString()
  @MinLength(1)
  @MaxLength(120)
  reference!: string;
}
