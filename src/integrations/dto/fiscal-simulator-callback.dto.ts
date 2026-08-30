import { IsIn, IsUUID, Matches } from 'class-validator';

export class FiscalSimulatorCallbackDto {
  @Matches(/^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/)
  eventId!: string;

  @IsUUID()
  documentId!: string;

  @IsIn(['ACCEPTED', 'REJECTED'])
  status!: 'ACCEPTED' | 'REJECTED';
}
