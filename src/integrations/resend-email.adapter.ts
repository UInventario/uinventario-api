import { Inject, Injectable } from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import { emailProviderConfig } from '../config/email-provider.config';
import type {
  ExternalAdapterCommand,
  ExternalAdapterResult,
  VersionedExternalAdapter,
} from './external-adapter.types';

interface ResendResponse {
  id?: string;
  name?: string;
}

@Injectable()
export class ResendEmailExternalAdapter implements VersionedExternalAdapter {
  readonly capability = 'NOTIFICATION_EMAIL' as const;
  readonly provider = 'RESEND';
  readonly version = '1';

  constructor(
    @Inject(emailProviderConfig.KEY)
    private readonly config: ConfigType<typeof emailProviderConfig>,
  ) {}

  async execute(
    command: ExternalAdapterCommand,
    signal: AbortSignal,
  ): Promise<ExternalAdapterResult> {
    const secret = this.config.resend;
    if (!secret)
      return {
        status: 'REJECTED',
        errorCode: 'EMAIL_PROVIDER_NOT_CONFIGURED',
      };
    if (command.secretReference !== this.config.secretReference)
      return {
        status: 'REJECTED',
        errorCode: 'EMAIL_SECRET_REFERENCE_MISMATCH',
      };
    if (command.scenario && command.scenario !== 'SUCCESS')
      return {
        status: 'REJECTED',
        errorCode: 'DIAGNOSTIC_SCENARIO_SIMULATOR_ONLY',
      };

    const recipient =
      command.payload.template.key === 'ADAPTER_DIAGNOSTIC'
        ? secret.diagnosticRecipient
        : command.payload.recipient;
    const response = await fetch(`${this.config.baseUrl}/emails`, {
      method: 'POST',
      signal,
      headers: {
        Authorization: `Bearer ${secret.apiKey}`,
        'Content-Type': 'application/json',
        'Idempotency-Key': command.idempotencyKey,
        'User-Agent': 'uinventario-api/1.0',
      },
      body: JSON.stringify({
        from: secret.from,
        to: [recipient],
        subject: command.payload.title,
        text: command.payload.body,
      }),
    });
    const result = (await response.json().catch(() => ({}))) as ResendResponse;
    if (response.ok && result.id)
      return { status: 'SUCCEEDED', providerReference: result.id };
    if (
      response.status === 408 ||
      response.status === 429 ||
      response.status >= 500 ||
      (response.status === 409 &&
        result.name === 'concurrent_idempotent_requests')
    ) {
      return {
        status: 'RETRYABLE_FAILURE',
        errorCode:
          response.status === 429
            ? 'EMAIL_PROVIDER_RATE_LIMITED'
            : 'EMAIL_PROVIDER_UNAVAILABLE',
      };
    }
    return { status: 'REJECTED', errorCode: 'EMAIL_PROVIDER_REJECTED' };
  }
}
