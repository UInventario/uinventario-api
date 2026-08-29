import type { ExternalAdapterCommand } from './external-adapter.types';
import {
  SimulatedEmailExternalAdapter,
  SimulatedPushExternalAdapter,
} from './simulated-notification.adapter';

describe.each([
  ['email', new SimulatedEmailExternalAdapter()],
  ['push', new SimulatedPushExternalAdapter()],
])('versioned %s simulator contract', (_name, adapter) => {
  const command = (scenario: ExternalAdapterCommand['scenario'], attempt = 1) =>
    ({
      apiVersion: '1',
      tenantId: 'tenant-1',
      capability: adapter.capability,
      idempotencyKey: `diagnostic-${scenario}`,
      correlationId: 'request-1',
      attempt,
      scenario,
      payload: {
        recipient: 'diagnostic@example.invalid',
        title: 'Diagnostic',
        body: 'No business data',
      },
    }) satisfies ExternalAdapterCommand;

  it('supports success and deterministic idempotency', async () => {
    const first = await adapter.execute(
      command('SUCCESS'),
      new AbortController().signal,
    );
    const repeated = await adapter.execute(
      command('SUCCESS'),
      new AbortController().signal,
    );
    expect(first).toEqual(repeated);
    expect(first.status).toBe('SUCCEEDED');
  });

  it('maps rejection and retryable outcomes', async () => {
    await expect(
      adapter.execute(command('REJECT'), new AbortController().signal),
    ).resolves.toEqual({
      status: 'REJECTED',
      errorCode: 'SIMULATED_REJECTED',
    });
    await expect(
      adapter.execute(command('RETRY'), new AbortController().signal),
    ).resolves.toEqual({
      status: 'RETRYABLE_FAILURE',
      errorCode: 'SIMULATED_PROVIDER_UNAVAILABLE',
    });
    await expect(
      adapter.execute(command('RETRY', 2), new AbortController().signal),
    ).resolves.toMatchObject({ status: 'SUCCEEDED' });
  });

  it('honors cancellation used by the framework timeout', async () => {
    const controller = new AbortController();
    const pending = adapter.execute(command('TIMEOUT'), controller.signal);
    controller.abort();
    await expect(pending).rejects.toThrow('ADAPTER_ABORTED');
  });
});
