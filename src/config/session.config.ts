import { registerAs } from '@nestjs/config';

export const sessionConfig = registerAs('session', () => ({
  cookieName: process.env.SESSION_COOKIE_NAME ?? 'uinventario_session',
  ttlMilliseconds: Number(process.env.SESSION_TTL_MINUTES ?? 480) * 60_000,
  secureCookie: process.env.NODE_ENV === 'production',
}));
