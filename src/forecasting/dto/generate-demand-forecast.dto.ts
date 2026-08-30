import { Type } from 'class-transformer';
import { IsIn, IsInt } from 'class-validator';

export class GenerateDemandForecastDto {
  @Type(() => Number)
  @IsInt()
  @IsIn([7, 14, 30])
  horizonDays = 14;
}
