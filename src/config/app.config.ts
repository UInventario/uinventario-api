import { registerAs } from '@nestjs/config';

export const appConfig = registerAs('app', () => ({
  environment: process.env.NODE_ENV ?? 'development',
  deploymentEnvironment: process.env.DEPLOY_ENV ?? 'local',
  port: Number(process.env.PORT ?? 3000),
  corsOrigins: (process.env.CORS_ORIGINS ?? 'http://localhost:4200')
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean),
  observabilitySuccessSampleRate: Number(
    process.env.OBSERVABILITY_SUCCESS_SAMPLE_RATE ?? 0.1,
  ),
}));
