import { Type } from 'class-transformer';
import { IsIn, IsInt, IsISO8601, Matches, Max, Min } from 'class-validator';

export class CarrierEventDto {
  @Matches(/^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/)
  providerEventId!: string;

  @Matches(/^[A-Za-z0-9][A-Za-z0-9._:-]{7,119}$/)
  trackingReference!: string;

  @IsIn([
    'IN_TRANSIT',
    'OUT_FOR_DELIVERY',
    'DELIVERED',
    'EXCEPTION',
    'CANCELLED',
  ])
  status!:
    'IN_TRANSIT' | 'OUT_FOR_DELIVERY' | 'DELIVERED' | 'EXCEPTION' | 'CANCELLED';

  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(2_147_483_647)
  sequence!: number;

  @IsISO8601({ strict: true })
  occurredAt!: string;
}
