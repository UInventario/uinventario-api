import 'reflect-metadata';
import {
  assertOfflineSyncPageSize,
  OFFLINE_SYNC_COMPATIBILITY_POLICY_V1,
  OFFLINE_SYNC_ENTITY_KINDS,
  OFFLINE_SYNC_FORBIDDEN_FIELDS,
  supportsOfflineSyncVersion,
} from './offline-sync-v1.contract';
import {
  OFFLINE_BOOTSTRAP_REQUEST_V1_FIXTURE,
  OFFLINE_BOOTSTRAP_RESPONSE_V1_FIXTURE,
} from './offline-sync-v1.fixture';
import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';
import { OfflineBootstrapQueryDto } from './dto/offline-bootstrap-query.dto';

describe('offline sync protocol v1', () => {
  it('keeps every bootstrap entity globally identified, tenant-scoped and versioned', () => {
    const { scope, identity, page } = OFFLINE_BOOTSTRAP_RESPONSE_V1_FIXTURE;
    expect(identity.tenant.id).toBe(scope.tenantId);
    expect(identity.user.id).toBe(scope.userId);
    expect(scope.deviceId).toBe(OFFLINE_BOOTSTRAP_REQUEST_V1_FIXTURE.deviceId);
    expect(page.entities.map(({ kind }) => kind).sort()).toEqual(
      [...OFFLINE_SYNC_ENTITY_KINDS].sort(),
    );
    for (const entity of page.entities) {
      expect(entity.id).toMatch(/^[0-9a-f-]{36}$/i);
      expect(entity.tenantId).toBe(scope.tenantId);
      expect(entity.version).toBeGreaterThan(0);
      expect(new Date(entity.updatedAt).toISOString()).toBe(entity.updatedAt);
    }
  });

  it('defines resumable pages without embedding reusable credentials or secrets', () => {
    const fixture = JSON.stringify(OFFLINE_BOOTSTRAP_RESPONSE_V1_FIXTURE);
    expect(OFFLINE_BOOTSTRAP_RESPONSE_V1_FIXTURE.page.complete).toBe(false);
    expect(OFFLINE_BOOTSTRAP_RESPONSE_V1_FIXTURE.page.nextCursor).toBeTruthy();
    for (const forbidden of OFFLINE_SYNC_FORBIDDEN_FIELDS)
      expect(fixture.toLowerCase()).not.toContain(forbidden.toLowerCase());
  });

  it('accepts additive v1 revisions, rejects breaking versions and bounds pages', () => {
    expect(supportsOfflineSyncVersion('1.0')).toBe(true);
    expect(supportsOfflineSyncVersion('1.12')).toBe(true);
    expect(supportsOfflineSyncVersion('2.0')).toBe(false);
    expect(supportsOfflineSyncVersion('1')).toBe(false);
    expect(() => assertOfflineSyncPageSize(1)).not.toThrow();
    expect(() => assertOfflineSyncPageSize(500)).not.toThrow();
    expect(() => assertOfflineSyncPageSize(0)).toThrow(RangeError);
    expect(() => assertOfflineSyncPageSize(501)).toThrow(RangeError);
  });

  it('keeps the N-1 v1 client request valid during the deprecation window', () => {
    const oldClientRequest = plainToInstance(OfflineBootstrapQueryDto, {
      deviceId: OFFLINE_BOOTSTRAP_REQUEST_V1_FIXTURE.deviceId,
      protocolVersion: '1.0',
      pageSize: 100,
    });
    const breakingClientRequest = plainToInstance(OfflineBootstrapQueryDto, {
      deviceId: OFFLINE_BOOTSTRAP_REQUEST_V1_FIXTURE.deviceId,
      protocolVersion: '2.0',
      pageSize: 100,
    });

    expect(validateSync(oldClientRequest)).toHaveLength(0);
    expect(validateSync(breakingClientRequest)).not.toHaveLength(0);
    expect(OFFLINE_SYNC_COMPATIBILITY_POLICY_V1).toMatchObject({
      apiVersion: 'v1',
      minimumProtocolVersion: '1.0',
      deprecationNoticeDays: 180,
      breakingChangesRequireNewMajor: true,
    });
  });
});
