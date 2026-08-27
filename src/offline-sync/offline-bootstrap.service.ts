import { BadRequestException, Injectable } from '@nestjs/common';
import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import type { SessionIdentity } from '../auth/session/session.types';
import { PosService } from '../pos/pos.service';
import { OfflineBootstrapQueryDto } from './dto/offline-bootstrap-query.dto';
import { OfflineBootstrapRepository } from './offline-bootstrap.repository';
import {
  assertOfflineSyncPageSize,
  OFFLINE_SYNC_PROTOCOL_VERSION,
  OfflineBootstrapResponseV1,
  OfflineSyncScopeV1,
} from './offline-sync-v1.contract';

export interface OfflineServerCursorV1 {
  kind: 'bootstrap';
  protocolVersion: '1.0';
  sessionBinding: string;
  tenantId: string;
  userId: string;
  deviceId: string;
  offset: number;
  snapshotAt: string;
  authorizedBranchIds: string[];
  authorizedCashRegisterIds: string[];
  administrator: boolean;
}

@Injectable()
export class OfflineBootstrapService {
  constructor(
    private readonly repository: OfflineBootstrapRepository,
    private readonly pos: PosService,
  ) {}

  async bootstrap(
    principal: SessionIdentity,
    query: OfflineBootstrapQueryDto,
  ): Promise<OfflineBootstrapResponseV1> {
    assertOfflineSyncPageSize(query.pageSize);
    const cursor = query.cursor
      ? this.decodeCursor(query.cursor, principal, query.deviceId)
      : this.initialCursor(principal, query.deviceId);
    const scope: OfflineSyncScopeV1 = {
      tenantId: principal.tenant.id,
      userId: principal.user.id,
      deviceId: query.deviceId,
      branchId: principal.context.branch?.id ?? null,
      cashRegisterId: principal.context.cashRegister?.id ?? null,
    };
    const entities = await this.repository.entities({
      scope,
      administrator: principal.user.roles.includes('ADMIN'),
      permissions: principal.user.permissions,
      snapshotAt: cursor.snapshotAt
        .slice(0, 23)
        .replace('T', ' ')
        .replace('Z', ''),
    });
    const { branch, warehouse, cashRegister } = principal.context;
    let posPolicy: OfflineBootstrapResponseV1['posPolicy'] = null;
    if (
      branch &&
      warehouse &&
      cashRegister &&
      principal.user.permissions.includes('SALES_MANAGE')
    ) {
      const policy = await this.pos.offlinePolicy({
        tenantId: principal.tenant.id,
        branchId: branch.id,
        warehouseId: warehouse.id,
        cashRegisterId: cashRegister.id,
        userId: principal.user.id,
      });
      if (policy) {
        posPolicy = {
          kind: 'POS_POLICY',
          id: policy.shift.id,
          tenantId: principal.tenant.id,
          version: Math.max(1, new Date(policy.shift.openedAt).getTime()),
          updatedAt: policy.shift.openedAt,
          branchId: branch.id,
          warehouseId: warehouse.id,
          cashRegisterId: cashRegister.id,
          shiftId: policy.shift.id,
          shiftOpenedAt: policy.shift.openedAt,
          currency: policy.currency,
          taxRate: policy.taxRate,
          paymentMethods: ['CASH'],
          negativeStock: policy.negativeStock,
        };
      }
    }
    const pageEntities = entities.slice(
      cursor.offset,
      cursor.offset + query.pageSize,
    );
    const nextOffset = cursor.offset + pageEntities.length;
    const complete = nextOffset >= entities.length;
    return {
      protocolVersion: OFFLINE_SYNC_PROTOCOL_VERSION,
      generatedAt: new Date().toISOString(),
      scope,
      identity: {
        tenant: principal.tenant,
        user: {
          id: principal.user.id,
          roles: principal.user.roles,
          permissions: principal.user.permissions,
        },
      },
      posPolicy,
      page: {
        initialSyncCursor: this.encode(
          {
            ...cursor,
            kind: 'bootstrap',
            offset: 0,
            authorizedBranchIds: entities
              .filter(({ kind }) => kind === 'BRANCH')
              .map(({ id }) => id)
              .sort(),
            authorizedCashRegisterIds: entities
              .filter(({ kind }) => kind === 'CASH_REGISTER')
              .map(({ id }) => id)
              .sort(),
          },
          principal.sessionId,
        ),
        cursor: this.encode(cursor, principal.sessionId),
        nextCursor: complete
          ? null
          : this.encode({ ...cursor, offset: nextOffset }, principal.sessionId),
        complete,
        entities: pageEntities,
      },
    };
  }

  private initialCursor(
    principal: SessionIdentity,
    deviceId: string,
  ): OfflineServerCursorV1 {
    return {
      kind: 'bootstrap',
      protocolVersion: OFFLINE_SYNC_PROTOCOL_VERSION,
      sessionBinding: this.sessionBinding(principal.sessionId),
      tenantId: principal.tenant.id,
      userId: principal.user.id,
      deviceId,
      offset: 0,
      snapshotAt: new Date().toISOString(),
      authorizedBranchIds: [],
      authorizedCashRegisterIds: [],
      administrator: principal.user.roles.includes('ADMIN'),
    };
  }

  private decodeCursor(
    value: string,
    principal: SessionIdentity,
    deviceId: string,
  ): OfflineServerCursorV1 {
    try {
      const [encoded, signature] = value.split('.');
      if (!encoded || !signature) throw new Error('INVALID_CURSOR');
      const expected = this.signature(encoded, principal.sessionId);
      const actualBuffer = Buffer.from(signature, 'base64url');
      const expectedBuffer = Buffer.from(expected, 'base64url');
      if (
        actualBuffer.length !== expectedBuffer.length ||
        !timingSafeEqual(actualBuffer, expectedBuffer)
      )
        throw new Error('INVALID_CURSOR');
      const cursor = JSON.parse(
        Buffer.from(encoded, 'base64url').toString('utf8'),
      ) as OfflineServerCursorV1;
      if (
        cursor.kind !== 'bootstrap' ||
        cursor.protocolVersion !== OFFLINE_SYNC_PROTOCOL_VERSION ||
        cursor.sessionBinding !== this.sessionBinding(principal.sessionId) ||
        cursor.tenantId !== principal.tenant.id ||
        cursor.userId !== principal.user.id ||
        cursor.deviceId !== deviceId ||
        !Number.isInteger(cursor.offset) ||
        cursor.offset < 0 ||
        Number.isNaN(new Date(cursor.snapshotAt).getTime())
      )
        throw new Error('INVALID_CURSOR');
      return cursor;
    } catch {
      throw new BadRequestException({
        code: 'INVALID_OFFLINE_BOOTSTRAP_CURSOR',
        message:
          'El cursor no pertenece a esta sesión, tenant, usuario o dispositivo.',
      });
    }
  }

  private encode(cursor: OfflineServerCursorV1, sessionId: string): string {
    const encoded = Buffer.from(JSON.stringify(cursor)).toString('base64url');
    return `${encoded}.${this.signature(encoded, sessionId)}`;
  }

  private signature(encoded: string, sessionId: string): string {
    return createHmac('sha256', sessionId).update(encoded).digest('base64url');
  }

  private sessionBinding(sessionId: string): string {
    return createHash('sha256').update(sessionId).digest('base64url');
  }
}
