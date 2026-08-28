import {
  SecurityThrottlerGuard,
  securityThrottleTracker,
} from './security-throttler.guard';

describe(SecurityThrottlerGuard.name, () => {
  it('normalizes login identity without exposing the email in the tracker', () => {
    const first = securityThrottleTracker({
      body: { email: ' User@Example.COM ' },
      ip: '203.0.113.10',
      path: '/api/v1/auth/sessions',
    });
    const second = securityThrottleTracker({
      body: { email: 'user@example.com' },
      ip: '198.51.100.20',
      path: '/api/v1/auth/sessions',
    });

    expect(first).toBe(second);
    expect(first).toMatch(/^[a-f0-9]{64}$/);
    expect(first).not.toContain('user@example.com');
  });

  it('isolates authenticated sessions sharing the same Web proxy address', () => {
    const first = securityThrottleTracker({
      headers: { cookie: 'uinventario_session=session-a' },
      ip: '10.0.0.1',
    });
    const second = securityThrottleTracker({
      headers: { cookie: 'uinventario_session=session-b' },
      ip: '10.0.0.1',
    });

    expect(first).not.toBe(second);
  });

  it('prefers the session for business requests containing an email field', () => {
    const first = securityThrottleTracker({
      body: { email: 'customer-a@example.test' },
      headers: { cookie: 'uinventario_session=session-a' },
      path: '/api/v1/customers/customer-id',
      ip: '10.0.0.1',
    });
    const second = securityThrottleTracker({
      body: { email: 'customer-b@example.test' },
      headers: { cookie: 'uinventario_session=session-a' },
      path: '/api/v1/customers/customer-id',
      ip: '10.0.0.1',
    });

    expect(first).toBe(second);
  });

  it('falls back to network scope when no identity is available', () => {
    expect(securityThrottleTracker({ ip: '203.0.113.10' })).toBe(
      securityThrottleTracker({ socket: { remoteAddress: '203.0.113.10' } }),
    );
  });
});
