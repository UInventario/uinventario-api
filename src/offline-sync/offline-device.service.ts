import { createHash } from 'node:crypto';
import {
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { DataSource } from 'typeorm';
import type { SessionIdentity } from '../auth/session/session.types';

interface OfflineDeviceRow {
  device_id: string;
  user_id: string;
  email?: string;
  first_seen_at: Date | string;
  last_seen_at: Date | string;
  last_sync_at: Date | string | null;
  last_cursor_hash: string | null;
  last_correlation_id: string | null;
  revoked_at: Date | string | null;
  bootstrap_required_at: Date | string | null;
  last_sequence?: string | number | null;
  pending_commands?: string | number;
  error_commands?: string | number;
  conflict_commands?: string | number;
  retry_count?: string | number;
  oldest_pending_at?: Date | string | null;
}

type DeviceAccess = 'BOOTSTRAP' | 'SYNC';

@Injectable()
export class OfflineDeviceService {
  constructor(private readonly dataSource: DataSource) {}

  async touchOrAssert(
    principal: SessionIdentity,
    deviceId: string,
    access: DeviceAccess = 'SYNC',
  ): Promise<void> {
    await this.dataSource.query(
      `INSERT IGNORE INTO offline_devices
         (tenant_id, user_id, device_id, bootstrap_required_at)
       VALUES (?, ?, ?, ?)`,
      [
        principal.tenant.id,
        principal.user.id,
        deviceId,
        access === 'BOOTSTRAP' ? new Date() : null,
      ],
    );
    const [device] = await this.dataSource.query<OfflineDeviceRow[]>(
      `SELECT device_id, user_id, first_seen_at, last_seen_at, last_sync_at,
              last_cursor_hash, last_correlation_id, revoked_at, bootstrap_required_at
       FROM offline_devices WHERE tenant_id = ? AND user_id = ? AND device_id = ? LIMIT 1`,
      [principal.tenant.id, principal.user.id, deviceId],
    );
    if (!device) throw new NotFoundException();
    if (device.revoked_at) {
      const [session] = await this.dataSource.query<
        Array<{ created_at: Date | string }>
      >('SELECT created_at FROM sessions WHERE id = ? LIMIT 1', [
        principal.sessionId,
      ]);
      if (
        access !== 'BOOTSTRAP' ||
        !session ||
        new Date(session.created_at).getTime() <=
          new Date(device.revoked_at).getTime()
      ) {
        throw new ForbiddenException({
          code: 'OFFLINE_DEVICE_REVOKED',
          message: 'Este dispositivo ya no está autorizado para sincronizar.',
        });
      }
      await this.dataSource.query(
        `UPDATE offline_devices SET revoked_at = NULL
         WHERE tenant_id = ? AND user_id = ? AND device_id = ?`,
        [principal.tenant.id, principal.user.id, deviceId],
      );
    }
    if (device.bootstrap_required_at && access !== 'BOOTSTRAP') {
      throw new ForbiddenException({
        code: 'OFFLINE_BOOTSTRAP_REQUIRED',
        message:
          'Descarga un bootstrap nuevo antes de sincronizar operaciones.',
      });
    }
    await this.dataSource.query(
      `UPDATE offline_devices SET last_seen_at = CURRENT_TIMESTAMP(6)
       WHERE tenant_id = ? AND user_id = ? AND device_id = ? AND revoked_at IS NULL`,
      [principal.tenant.id, principal.user.id, deviceId],
    );
  }

  async markSync(input: {
    principal: SessionIdentity;
    deviceId: string;
    cursor: string;
    correlationId: string;
    bootstrapComplete?: boolean;
  }): Promise<void> {
    const cursorHash = createHash('sha256').update(input.cursor).digest('hex');
    await this.dataSource.query(
      `UPDATE offline_devices SET last_seen_at = CURRENT_TIMESTAMP(6),
         last_sync_at = CURRENT_TIMESTAMP(6), last_cursor_hash = ?,
         last_correlation_id = ?,
         bootstrap_required_at = CASE WHEN ? THEN NULL ELSE bootstrap_required_at END
       WHERE tenant_id = ? AND user_id = ? AND device_id = ? AND revoked_at IS NULL`,
      [
        cursorHash,
        input.correlationId,
        input.bootstrapComplete ? 1 : 0,
        input.principal.tenant.id,
        input.principal.user.id,
        input.deviceId,
      ],
    );
  }

  async markActivity(
    principal: SessionIdentity,
    deviceId: string,
    correlationId: string,
  ): Promise<void> {
    await this.dataSource.query(
      `UPDATE offline_devices SET last_seen_at = CURRENT_TIMESTAMP(6),
         last_correlation_id = ?
       WHERE tenant_id = ? AND user_id = ? AND device_id = ? AND revoked_at IS NULL`,
      [correlationId, principal.tenant.id, principal.user.id, deviceId],
    );
  }

  async list(principal: SessionIdentity) {
    const rows = await this.dataSource.query<OfflineDeviceRow[]>(
      `SELECT d.device_id, d.user_id, u.email, d.first_seen_at, d.last_seen_at,
              d.last_sync_at, d.last_cursor_hash, d.last_correlation_id,
              d.revoked_at, d.bootstrap_required_at, s.last_sequence,
              COALESCE(SUM(c.status = 'PENDING'), 0) AS pending_commands,
              COALESCE(SUM(c.status = 'ERROR'), 0) AS error_commands,
              COALESCE(SUM(c.status = 'ERROR' AND JSON_EXTRACT(c.error_json, '$.conflict') IS NOT NULL), 0) AS conflict_commands,
              COALESCE(SUM(c.replay_count), 0) AS retry_count,
              MIN(CASE WHEN c.status = 'PENDING' THEN c.received_at END) AS oldest_pending_at
       FROM offline_devices d
       INNER JOIN users u ON u.id = d.user_id AND u.tenant_id = d.tenant_id
       LEFT JOIN offline_device_sequences s ON s.tenant_id = d.tenant_id
         AND s.user_id = d.user_id AND s.device_id = d.device_id
       LEFT JOIN offline_commands c ON c.tenant_id = d.tenant_id
         AND c.user_id = d.user_id AND c.device_id = d.device_id
       WHERE d.tenant_id = ?
       GROUP BY d.device_id, d.user_id, u.email, d.first_seen_at, d.last_seen_at,
                d.last_sync_at, d.last_cursor_hash, d.last_correlation_id,
                d.revoked_at, d.bootstrap_required_at, s.last_sequence
       ORDER BY d.last_seen_at DESC, d.device_id`,
      [principal.tenant.id],
    );
    const now = Date.now();
    return {
      data: rows.map((row) => {
        const lastSyncAt = this.iso(row.last_sync_at);
        const revokedAt = this.iso(row.revoked_at);
        const bootstrapRequiredAt = this.iso(row.bootstrap_required_at);
        return {
          deviceId: row.device_id,
          user: { id: row.user_id, email: row.email ?? '' },
          firstSeenAt: this.iso(row.first_seen_at)!,
          lastSeenAt: this.iso(row.last_seen_at)!,
          lastSyncAt,
          cursorFingerprint: row.last_cursor_hash?.slice(0, 12) ?? null,
          correlationId: row.last_correlation_id,
          revokedAt,
          bootstrapRequiredAt,
          health: revokedAt
            ? ('REVOKED' as const)
            : bootstrapRequiredAt
              ? ('BOOTSTRAP_REQUIRED' as const)
              : lastSyncAt
                ? ('HEALTHY' as const)
                : ('NEVER_SYNCED' as const),
          lagSeconds: lastSyncAt
            ? Math.max(
                0,
                Math.floor((now - new Date(lastSyncAt).getTime()) / 1000),
              )
            : null,
          lastSequence: Number(row.last_sequence ?? 0),
          metrics: {
            pending: Number(row.pending_commands ?? 0),
            errors: Number(row.error_commands ?? 0),
            conflicts: Number(row.conflict_commands ?? 0),
            retries: Number(row.retry_count ?? 0),
            oldestPendingAt: this.iso(row.oldest_pending_at),
          },
        };
      }),
      meta: { apiVersion: '1' as const },
    };
  }

  async revoke(principal: SessionIdentity, deviceId: string): Promise<void> {
    const result = await this.dataSource.query<{ affectedRows?: number }>(
      `UPDATE offline_devices SET revoked_at = COALESCE(revoked_at, CURRENT_TIMESTAMP(6)),
         bootstrap_required_at = COALESCE(bootstrap_required_at, CURRENT_TIMESTAMP(6))
       WHERE tenant_id = ? AND device_id = ?`,
      [principal.tenant.id, deviceId],
    );
    if (!result.affectedRows) throw new NotFoundException();
  }

  private iso(value: Date | string | null | undefined): string | null {
    return value ? new Date(value).toISOString() : null;
  }
}
