import { SimulatorPaymentTerminalAdapter } from './payment-terminal.adapter';

describe('SimulatorPaymentTerminalAdapter', () => {
  const adapter = new SimulatorPaymentTerminalAdapter();
  const input = {
    amount: '119.90',
    currency: 'MXN',
    idempotencyKey: 'terminal-contract-001',
    correlationId: 'request-001',
    scenario: 'SUCCESS' as const,
  };

  it('initiates, authorizes and captures an idempotent payment', async () => {
    const first = await adapter.initiate(input);
    const replay = await adapter.initiate({
      ...input,
      correlationId: 'request-retry-002',
    });
    expect(replay.providerReference).toBe(first.providerReference);

    const authorized = await adapter.authorize({
      ...first,
      scenario: 'SUCCESS',
    });
    expect(authorized.status).toBe('AUTHORIZED');
    expect(typeof authorized.authorizationCode).toBe('string');
    await expect(
      adapter.capture({ ...authorized, scenario: 'SUCCESS' }),
    ).resolves.toMatchObject({ status: 'CAPTURED', errorCode: null });
  });

  it('returns a controlled decline without authorizing or capturing', async () => {
    const initiated = await adapter.initiate({
      ...input,
      idempotencyKey: 'decline',
    });
    await expect(
      adapter.authorize({ ...initiated, scenario: 'REJECT' }),
    ).resolves.toMatchObject({
      status: 'DECLINED',
      authorizationCode: null,
      errorCode: 'SIMULATED_DECLINE',
    });
  });

  it('resolves an indeterminate late response through query and reconciliation', async () => {
    const initiated = await adapter.initiate({
      ...input,
      idempotencyKey: 'late',
    });
    const authorized = await adapter.authorize({
      ...initiated,
      scenario: 'INDETERMINATE',
    });
    const uncertain = await adapter.capture({
      ...authorized,
      scenario: 'INDETERMINATE',
    });
    expect(uncertain.status).toBe('INDETERMINATE');

    await expect(
      adapter.query({ ...uncertain, scenario: 'INDETERMINATE' }),
    ).resolves.toMatchObject({ status: 'CAPTURED', errorCode: null });
    await expect(adapter.reconcile([uncertain])).resolves.toEqual([
      expect.objectContaining({ status: 'CAPTURED' }),
    ]);
  });

  it('cancels an operation without receiving cardholder data', async () => {
    const initiated = await adapter.initiate({
      ...input,
      idempotencyKey: 'cancel',
    });
    expect(Object.keys(input)).toEqual([
      'amount',
      'currency',
      'idempotencyKey',
      'correlationId',
      'scenario',
    ]);
    await expect(adapter.cancel(initiated)).resolves.toMatchObject({
      status: 'CANCELLED',
    });
  });
});
