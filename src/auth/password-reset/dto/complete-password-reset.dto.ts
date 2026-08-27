import { IsString, Length, Matches } from 'class-validator';

export class CompletePasswordResetDto {
  @IsString()
  @Matches(/^[A-Za-z0-9_-]{43}$/)
  token!: string;

  @IsString()
  @Length(12, 128)
  @Matches(/[a-z]/)
  @Matches(/[A-Z]/)
  @Matches(/[0-9]/)
  @Matches(/[^A-Za-z0-9]/)
  password!: string;
}
