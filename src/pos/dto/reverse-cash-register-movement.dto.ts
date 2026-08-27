import { IsString, MaxLength, MinLength } from 'class-validator';

export class ReverseCashRegisterMovementDto {
  @IsString()
  @MinLength(2)
  @MaxLength(160)
  reason!: string;
}
