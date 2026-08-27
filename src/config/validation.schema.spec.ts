import { validationSchema } from './validation.schema';

describe('environment validation', () => {
  it('accepts an explicit production environment contract', () => {
    const result = validationSchema.validate({
      NODE_ENV: 'production',
      DEPLOY_ENV: 'dev',
      PORT: 8080,
      CORS_ORIGINS: 'https://dev.example.invalid',
      DATABASE_URL: 'mysql://database.example.invalid:3306/uinventario',
      PASSWORD_RESET_PUBLIC_URL: 'https://dev.example.invalid/restablecer',
      PASSWORD_RESET_DELIVERY: 'disabled',
    });

    expect(result.error).toBeUndefined();
    expect(result.value as Record<string, unknown>).toMatchObject({
      NODE_ENV: 'production',
      DEPLOY_ENV: 'dev',
      CORS_ORIGINS: 'https://dev.example.invalid',
    });
  });

  it('keeps safe local defaults while still requiring persistence', () => {
    const result = validationSchema.validate({
      DATABASE_URL: 'mysql://localhost:3307/uinventario',
    });

    expect(result.error).toBeUndefined();
    expect(result.value as Record<string, unknown>).toMatchObject({
      NODE_ENV: 'development',
      DEPLOY_ENV: 'local',
      CORS_ORIGINS: 'http://localhost:4200',
      DB_MIGRATIONS_RUN: false,
    });
  });

  it.each([
    [
      'missing database',
      { NODE_ENV: 'development' },
      '"DATABASE_URL" is required',
    ],
    [
      'missing production environment',
      {
        NODE_ENV: 'production',
        CORS_ORIGINS: 'https://app.example.invalid',
        DATABASE_URL: 'mysql://database.example.invalid:3306/uinventario',
        PASSWORD_RESET_PUBLIC_URL: 'https://app.example.invalid/restablecer',
      },
      '"DEPLOY_ENV" is required',
    ],
    [
      'invalid browser origin',
      {
        DATABASE_URL: 'mysql://localhost:3307/uinventario',
        CORS_ORIGINS: 'https://app.example.invalid/path',
      },
      '"CORS_ORIGINS" must contain comma-separated HTTP(S) origins',
    ],
    [
      'insecure production origin',
      {
        NODE_ENV: 'production',
        DEPLOY_ENV: 'prod',
        CORS_ORIGINS: 'http://app.example.invalid',
        DATABASE_URL: 'mysql://database.example.invalid:3306/uinventario',
        PASSWORD_RESET_PUBLIC_URL: 'https://app.example.invalid/restablecer',
      },
      '"CORS_ORIGINS" must contain only HTTPS origins in production',
    ],
  ])('rejects %s with a clear message', (_name, input, message) => {
    const { error } = validationSchema.validate(input);

    expect(error?.message).toContain(message);
  });
});
