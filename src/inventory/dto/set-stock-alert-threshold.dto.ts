import { Transform } from 'class-transformer';
import { IsString, Matches } from 'class-validator';

const trim = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.trim() : value;

export class SetStockAlertThresholdDto {
  @Transform(trim)
  @IsString()
  @Matches(/^(0|[1-9]\d{0,11})(\.\d{1,3})?$/)
  threshold!: string;
}
