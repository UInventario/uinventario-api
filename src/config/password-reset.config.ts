import { registerAs } from '@nestjs/config';

export const passwordResetConfig = registerAs('passwordReset', () => ({
  ttlMilliseconds:
    Number.parseInt(process.env.PASSWORD_RESET_TTL_MINUTES ?? '30', 10) *
    60_000,
  publicUrl:
    process.env.PASSWORD_RESET_PUBLIC_URL ??
    'http://localhost:4200/restablecer',
  delivery:
    process.env.PASSWORD_RESET_DELIVERY ??
    (process.env.NODE_ENV === 'production' ? 'disabled' : 'local'),
  production: process.env.NODE_ENV === 'production',
}));
