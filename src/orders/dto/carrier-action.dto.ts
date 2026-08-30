import { IsIn } from 'class-validator';

export class CarrierCancelDto {
  @IsIn(['SUCCESS', 'TIMEOUT'])
  scenario!: 'SUCCESS' | 'TIMEOUT';
}

export class CarrierPollDto {
  @IsIn(['IN_TRANSIT', 'OUT_FOR_DELIVERY', 'DELIVERED', 'TIMEOUT'])
  scenario!: 'IN_TRANSIT' | 'OUT_FOR_DELIVERY' | 'DELIVERED' | 'TIMEOUT';
}
