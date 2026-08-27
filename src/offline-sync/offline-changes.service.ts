import { BadRequestException, GoneException, Injectable } from '@nestjs/common';
import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import type { SessionIdentity } from '../auth/session/session.types';
import { OfflineChangesQueryDto } from './dto/offline-changes-query.dto';
import { OfflineBootstrapRepository } from './offline-bootstrap.repository';
import type { OfflineServerCursorV1 } from './offline-bootstrap.service';
import { OfflineChangesRepository } from './offline-changes.repository';
import {
  assertOfflineSyncPageSize,
  OFFLINE_SYNC_PROTOCOL_VERSION,
  OfflineChangeV1,
  OfflineChangesResponseV1,
  OfflineSyncScopeV1,
} from './offline-sync-v1.contract';

interface ChangesCursor extends OfflineServerCursorV1 {
  watermarkAt?: string;
}

@Injectable()
export class OfflineChangesService {
  constructor(
    private readonly bootstrapRepository: OfflineBootstrapRepository,
    private readonly changesRepository: OfflineChangesRepository,
  ) {}

  async changes(
    principal: SessionIdentity,
    query: OfflineChangesQueryDto,
  ): Promise<OfflineChangesResponseV1> {
    assertOfflineSyncPageSize(query.pageSize);
    const cursor = this.decode(query.cursor, principal, query.deviceId);
    if (
      Date.now() - new Date(cursor.snapshotAt).getTime() >
      7 * 24 * 60 * 60_000
    ) {
      throw new GoneException({
        code: 'OFFLINE_SYNC_CURSOR_EXPIRED',
        message: 'El cursor venció. Descarga un bootstrap nuevo.',
      });
    }
    const watermarkAt = cursor.watermarkAt ?? new Date().toISOString();
    const scope: OfflineSyncScopeV1 = {
      tenantId: principal.tenant.id,
      userId: principal.user.id,
      deviceId: query.deviceId,
      branchId: principal.context.branch?.id ?? null,
      cashRegisterId: principal.context.cashRegister?.id ?? null,
    };
    const entities = await this.bootstrapRepository.entities({
      scope,
      administrator: principal.user.roles.includes('ADMIN'),
      permissions: principal.user.permissions,
      snapshotAt: this.sqlDate(watermarkAt),
    });
    const branchIds = entities
      .filter(({ kind }) => kind === 'BRANCH')
      .map(({ id }) => id)
      .sort();
    const cashRegisterIds = entities
      .filter(({ kind }) => kind === 'CASH_REGISTER')
      .map(({ id }) => id)
      .sort();
    if (
      !cursor.administrator &&
      (!this.same(branchIds, cursor.authorizedBranchIds) ||
        !this.same(cashRegisterIds, cursor.authorizedCashRegisterIds))
    ) {
      throw new GoneException({
        code: 'OFFLINE_SYNC_SCOPE_CHANGED',
        message: 'Tus accesos cambiaron. Descarga un bootstrap nuevo.',
      });
    }
    const since = this.sqlDate(cursor.snapshotAt);
    const until = this.sqlDate(watermarkAt);
    const catalogAllowed = principal.user.permissions.some((permission) =>
      ['PRODUCTS_MANAGE', 'SALES_MANAGE', 'INVENTORY_VIEW'].includes(
        permission,
      ),
    );
    const tombstones = await this.changesRepository.tombstones({
      tenantId: scope.tenantId,
      since,
      until,
      branchIds: [...new Set([...branchIds, ...cursor.authorizedBranchIds])],
      catalogAllowed,
    });
    const candidates = [
      ...entities
        .filter(
          ({ updatedAt }) =>
            updatedAt > cursor.snapshotAt && updatedAt <= watermarkAt,
        )
        .map((entity) => ({ entity, operation: 'UPSERT' as const })),
      ...tombstones.map((entity) => ({ entity, operation: 'DELETE' as const })),
    ].sort(
      (left, right) =>
        left.entity.updatedAt.localeCompare(right.entity.updatedAt) ||
        left.entity.kind.localeCompare(right.entity.kind) ||
        left.entity.id.localeCompare(right.entity.id),
    );
    const page = candidates.slice(
      cursor.offset,
      cursor.offset + query.pageSize,
    );
    const nextOffset = cursor.offset + page.length;
    const hasMore = nextOffset < candidates.length;
    const next: ChangesCursor = hasMore
      ? { ...cursor, watermarkAt, offset: nextOffset }
      : {
          ...cursor,
          snapshotAt: watermarkAt,
          watermarkAt: undefined,
          offset: 0,
          authorizedBranchIds: branchIds,
          authorizedCashRegisterIds: cashRegisterIds,
        };
    const changes: OfflineChangeV1[] = page.map(({ entity, operation }) => ({
      changeId: createHash('sha256')
        .update(`${entity.updatedAt}:${entity.kind}:${entity.id}:${operation}`)
        .digest('hex'),
      operation,
      occurredAt: entity.updatedAt,
      entity,
    }));
    return {
      protocolVersion: OFFLINE_SYNC_PROTOCOL_VERSION,
      scope,
      cursor: query.cursor,
      nextCursor: this.encode(next, principal.sessionId),
      hasMore,
      changes,
    };
  }

  private decode(
    value: string,
    principal: SessionIdentity,
    deviceId: string,
  ): ChangesCursor {
    try {
      const [encoded, signature] = value.split('.');
      if (!encoded || !signature) throw new Error();
      const expected = Buffer.from(
        this.signature(encoded, principal.sessionId),
        'base64url',
      );
      const actual = Buffer.from(signature, 'base64url');
      if (
        actual.length !== expected.length ||
        !timingSafeEqual(actual, expected)
      )
        throw new Error();
      const cursor = JSON.parse(
        Buffer.from(encoded, 'base64url').toString('utf8'),
      ) as ChangesCursor;
      if (
        cursor.protocolVersion !== OFFLINE_SYNC_PROTOCOL_VERSION ||
        cursor.sessionBinding !== this.sessionBinding(principal.sessionId) ||
        cursor.tenantId !== principal.tenant.id ||
        cursor.userId !== principal.user.id ||
        cursor.deviceId !== deviceId ||
        !Number.isInteger(cursor.offset) ||
        cursor.offset < 0 ||
        !Array.isArray(cursor.authorizedBranchIds) ||
        !Array.isArray(cursor.authorizedCashRegisterIds) ||
        Number.isNaN(new Date(cursor.snapshotAt).getTime())
      )
        throw new Error();
      return cursor;
    } catch {
      throw new BadRequestException({
        code: 'INVALID_OFFLINE_SYNC_CURSOR',
        message:
          'El cursor no es válido para esta sesión, tenant, usuario o dispositivo.',
      });
    }
  }

  private encode(cursor: ChangesCursor, sessionId: string): string {
    const encoded = Buffer.from(JSON.stringify(cursor)).toString('base64url');
    return `${encoded}.${this.signature(encoded, sessionId)}`;
  }

  private signature(encoded: string, sessionId: string): string {
    return createHmac('sha256', sessionId).update(encoded).digest('base64url');
  }

  private sessionBinding(sessionId: string): string {
    return createHash('sha256').update(sessionId).digest('base64url');
  }

  private sqlDate(value: string): string {
    return value.slice(0, 23).replace('T', ' ').replace('Z', '');
  }

  private same(left: string[], right: string[]): boolean {
    return (
      left.length === right.length &&
      left.every((value, index) => value === right[index])
    );
  }
}
