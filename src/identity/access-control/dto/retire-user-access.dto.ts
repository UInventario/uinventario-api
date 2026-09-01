import { Transform } from 'class-transformer';
import { IsEmail, MaxLength } from 'class-validator';

export class RetireUserAccessDto {
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim().toLowerCase() : value,
  )
  @IsEmail()
  @MaxLength(254)
  confirmationEmail!: string;
}
