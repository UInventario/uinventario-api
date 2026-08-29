import { ResendEmailExternalAdapter } from './resend-email.adapter';
import type { ExternalAdapterCommand } from './external-adapter.types';

describe('ResendEmailExternalAdapter', () => {
  const secret = {
    apiKey: 're_test_value',
    from: 'UInventario <noreply@example.com>',
    diagnosticRecipient: 'sandbox@example.com',
    webhookSecret: 'whsec_dGVzdA==',
  };
  const command: ExternalAdapterCommand = {
    apiVersion: '1',
    tenantId: 'tenant-1',
    capability: 'NOTIFICATION_EMAIL',
    idempotencyKey: 'password-reset:request-1',
    correlationId: 'request-1',
    attempt: 1,
    secretReference: 'uinventario-dev-resend-config',
    payload: {
      recipient: 'recipient@example.com',
      title: 'Subject',
      body: 'Body',
      template: { key: 'PASSWORD_RESET', version: '1' },
    },
  };

  afterEach(() => jest.restoreAllMocks());

  it('sends an idempotent plaintext email without returning credentials', async () => {
    const request = jest
      .spyOn(global, 'fetch')
      .mockResolvedValue(new Response(JSON.stringify({ id: 'email-1' })));
    const adapter = new ResendEmailExternalAdapter({
      baseUrl: 'https://api.resend.com',
      secretReference: 'uinventario-dev-resend-config',
      resend: secret,
    });

    await expect(
      adapter.execute(command, new AbortController().signal),
    ).resolves.toEqual({
      status: 'SUCCEEDED',
      providerReference: 'email-1',
    });
    const [, init] = request.mock.calls[0];
    expect(init?.headers).toMatchObject({
      'Idempotency-Key': command.idempotencyKey,
      'User-Agent': 'uinventario-api/1.0',
    });
    expect(typeof init?.body).toBe('string');
    expect(JSON.parse(init?.body as string) as unknown).toEqual({
      from: secret.from,
      to: [command.payload.recipient],
      subject: command.payload.title,
      text: command.payload.body,
    });
  });

  it('uses the sandbox recipient for diagnostics and rejects simulator-only scenarios', async () => {
    const request = jest
      .spyOn(global, 'fetch')
      .mockResolvedValue(new Response(JSON.stringify({ id: 'email-2' })));
    const adapter = new ResendEmailExternalAdapter({
      baseUrl: 'https://api.resend.com',
      secretReference: 'uinventario-dev-resend-config',
      resend: secret,
    });
    await adapter.execute(
      {
        ...command,
        scenario: 'SUCCESS',
        payload: {
          ...command.payload,
          recipient: 'diagnostic@example.invalid',
          template: { key: 'ADAPTER_DIAGNOSTIC', version: '1' },
        },
      },
      new AbortController().signal,
    );
    const diagnosticBody = request.mock.calls[0][1]?.body;
    expect(typeof diagnosticBody).toBe('string');
    expect(
      (JSON.parse(diagnosticBody as string) as { to: string[] }).to,
    ).toEqual([secret.diagnosticRecipient]);
    await expect(
      adapter.execute(
        { ...command, scenario: 'REJECT' },
        new AbortController().signal,
      ),
    ).resolves.toEqual({
      status: 'REJECTED',
      errorCode: 'DIAGNOSTIC_SCENARIO_SIMULATOR_ONLY',
    });
  });

  it('normalizes missing secrets, rate limits and permanent rejections', async () => {
    const missing = new ResendEmailExternalAdapter({
      baseUrl: 'https://api.resend.com',
      secretReference: 'uinventario-dev-resend-config',
      resend: null,
    });
    await expect(
      missing.execute(command, new AbortController().signal),
    ).resolves.toEqual({
      status: 'REJECTED',
      errorCode: 'EMAIL_PROVIDER_NOT_CONFIGURED',
    });

    const request = jest
      .spyOn(global, 'fetch')
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ name: 'rate_limit_exceeded' }), {
          status: 429,
        }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ name: 'validation_error' }), {
          status: 422,
        }),
      );
    const adapter = new ResendEmailExternalAdapter({
      baseUrl: 'https://api.resend.com',
      secretReference: 'uinventario-dev-resend-config',
      resend: secret,
    });
    await expect(
      adapter.execute(command, new AbortController().signal),
    ).resolves.toEqual({
      status: 'RETRYABLE_FAILURE',
      errorCode: 'EMAIL_PROVIDER_RATE_LIMITED',
    });
    await expect(
      adapter.execute(command, new AbortController().signal),
    ).resolves.toEqual({
      status: 'REJECTED',
      errorCode: 'EMAIL_PROVIDER_REJECTED',
    });
    expect(request).toHaveBeenCalledTimes(2);
  });
});
