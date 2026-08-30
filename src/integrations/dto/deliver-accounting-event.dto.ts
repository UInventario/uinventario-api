import { IsIn } from 'class-validator';

export class DeliverAccountingEventDto {
  @IsIn(['SUCCESS', 'REJECT', 'TIMEOUT'])
  scenario!: 'SUCCESS' | 'REJECT' | 'TIMEOUT';
}
