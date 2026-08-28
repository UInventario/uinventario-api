import { IsBoolean, IsIn, IsString, Length, Matches } from 'class-validator';

export class UpdatePosPeripheralProfileDto {
  @IsString()
  @Length(3, 80)
  @Matches(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/)
  deviceId!: string;

  @IsString()
  @Length(2, 120)
  label!: string;

  @IsIn(['SIMULATOR'])
  adapter!: 'SIMULATOR';

  @IsBoolean()
  printerEnabled!: boolean;

  @IsBoolean()
  drawerEnabled!: boolean;

  @IsBoolean()
  autoOpenCashSale!: boolean;
}
