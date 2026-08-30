import { IsIn, IsUUID, Matches } from 'class-validator';

export class SaleFiscalCallbackDto {
  @Matches(/^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/)
  eventId!: string;

  @IsUUID()
  saleId!: string;

  @IsIn(['ACCEPTED', 'REJECTED'])
  status!: 'ACCEPTED' | 'REJECTED';
}
