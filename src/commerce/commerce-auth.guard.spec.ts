import { ForbiddenException, HttpException } from '@nestjs/common';
import type { ExecutionContext } from '@nestjs/common';
import type { Reflector } from '@nestjs/core';
import { createHash } from 'node:crypto';
import type { AuditService, RecordAuditEvent } from '../audit/audit.service';
import { CommerceAuthGuard } from './commerce-auth.guard';
import type { CommerceRepository } from './commerce.repository';
import type { CommercePrincipal } from './commerce.types';

describe('CommerceAuthGuard', () => {
  const rawKey = `uic_12345678_${'a'.repeat(43)}`;
  const principal: CommercePrincipal = {
    credentialId: '10000000-0000-4000-8000-000000000001',
    tenantId: '20000000-0000-4000-8000-000000000001',
    actorUserId: '30000000-0000-4000-8000-000000000001',
    scopes: ['CATALOG_READ'],
    keyHash: createHash('sha256').update(rawKey).digest('hex'),
    rateLimitPerMinute: 10,
    context: {
      branchId: 'b',
      warehouseId: 'w',
      cashRegisterId: 'r',
      locationId: 'l',
      customerId: 'c',
    },
  };
  const repository = {
    authenticate: jest.fn(),
    consumeRateLimit: jest.fn(),
  };
  const reflector = { getAllAndOverride: jest.fn() };
  const audit = {
    record: jest
      .fn<Promise<void>, [RecordAuditEvent]>()
      .mockResolvedValue(undefined),
  };
  const guard = new CommerceAuthGuard(
    repository as unknown as CommerceRepository,
    reflector as unknown as Reflector,
    audit as unknown as AuditService,
  );

  beforeEach(() => {
    jest.clearAllMocks();
    repository.authenticate.mockResolvedValue(principal);
    repository.consumeRateLimit.mockResolvedValue(1);
    reflector.getAllAndOverride.mockReturnValue(['CATALOG_READ']);
  });

  it('authenticates the hash, enforces scope and attaches the tenant principal', async () => {
    const { context, request } = execution(`Bearer ${rawKey}`);

    await expect(guard.canActivate(context)).resolves.toBe(true);

    expect(repository.authenticate).toHaveBeenCalledWith(
      'uic_12345678',
      principal.keyHash,
    );
    expect(request.commercePrincipal).toBe(principal);
    expect(audit.record).toHaveBeenCalled();
    const recorded = audit.record.mock.calls[0][0];
    expect(recorded).toMatchObject({
      tenantId: principal.tenantId,
      entityId: principal.credentialId,
    });
    expect(recorded.after).toMatchObject({ scopes: ['CATALOG_READ'] });
  });

  it('rejects credentials without the required scope', async () => {
    reflector.getAllAndOverride.mockReturnValue(['ORDERS_WRITE']);
    await expect(
      guard.canActivate(execution(`Bearer ${rawKey}`).context),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('rejects the request after its atomic minute limit is exceeded', async () => {
    repository.consumeRateLimit.mockResolvedValue(11);
    const rejection = guard.canActivate(execution(`Bearer ${rawKey}`).context);
    await expect(rejection).rejects.toBeInstanceOf(HttpException);
    await expect(rejection).rejects.toMatchObject({ status: 429 });
  });
});

function execution(authorization: string) {
  const request: {
    headers: { authorization: string };
    method: string;
    path: string;
    commercePrincipal?: CommercePrincipal;
  } = {
    headers: { authorization },
    method: 'GET',
    path: '/external/v1/catalog',
  };
  const context = {
    switchToHttp: () => ({ getRequest: () => request }),
    getHandler: () => undefined,
    getClass: () => undefined,
  } as unknown as ExecutionContext;
  return { context, request };
}
