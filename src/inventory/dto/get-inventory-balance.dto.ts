import { IsUUID } from 'class-validator';

export class GetInventoryBalanceDto {
  @IsUUID()
  locationId!: string;
}
