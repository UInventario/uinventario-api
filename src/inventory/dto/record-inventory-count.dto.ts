import { IsInt, Matches, Min } from 'class-validator';

export class RecordInventoryCountDto {
  @Matches(/^\d{1,15}(\.\d{1,3})?$/)
  countedQuantity!: string;

  @IsInt()
  @Min(0)
  expectedAttempt!: number;
}
