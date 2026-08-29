import { registerAs } from '@nestjs/config';

export interface ResendSecretConfig {
  apiKey: string;
  from: string;
  diagnosticRecipient: string;
  webhookSecret: string;
}

function parseResendConfig(): ResendSecretConfig | null {
  const value = process.env.RESEND_CONFIG;
  if (!value) return null;
  return JSON.parse(value) as ResendSecretConfig;
}

export const emailProviderConfig = registerAs('emailProvider', () => {
  const deploymentEnvironment = process.env.DEPLOY_ENV ?? 'local';
  return {
    baseUrl: process.env.RESEND_API_BASE_URL ?? 'https://api.resend.com',
    secretReference:
      process.env.EMAIL_PROVIDER_SECRET_REFERENCE ??
      `uinventario-${deploymentEnvironment}-resend-config`,
    resend: parseResendConfig(),
  };
});
