import { IsString, Matches } from 'class-validator';

export class OpenCashRegisterShiftDto {
  @IsString()
  @Matches(/^(0|[1-9]\d{0,12})(\.\d{1,2})?$/)
  openingAmount!: string;
}
