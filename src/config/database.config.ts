import { registerAs } from '@nestjs/config';

export const databaseConfig = registerAs('database', () => ({
  url: process.env.DATABASE_URL,
  migrationsRun: process.env.DB_MIGRATIONS_RUN === 'true',
}));
