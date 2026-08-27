import {
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type { SessionIdentity } from '../auth/session/session.types';
import { DataSource } from 'typeorm';

interface OfflineDeviceRow {
  device_id: string;
  first_seen_at: Date | string;
  last_seen_at: Date | string;
  revoked_at: Date | string | null;
}

@Injectable()
export class OfflineDeviceService {
  constructor(private readonly dataSource: DataSource) {}

  async touchOrAssert(
    principal: SessionIdentity,
    deviceId: string,
  ): Promise<void> {
    await this.dataSource.query(
      `INSERT IGNORE INTO offline_devices (tenant_id, user_id, device_id)
       VALUES (?, ?, ?)`,
      [principal.tenant.id, principal.user.id, deviceId],
    );
    const [device] = await this.dataSource.query<OfflineDeviceRow[]>(
      `SELECT device_id, first_seen_at, last_seen_at, revoked_at
       FROM offline_devices WHERE tenant_id = ? AND user_id = ? AND device_id = ? LIMIT 1`,
      [principal.tenant.id, principal.user.id, deviceId],
    );
    if (!device || device.revoked_at) {
      throw new ForbiddenException({
        code: 'OFFLINE_DEVICE_REVOKED',
        message: 'Este dispositivo ya no está autorizado para sincronizar.',
      });
    }
    await this.dataSource.query(
      `UPDATE offline_devices SET last_seen_at = CURRENT_TIMESTAMP(6)
       WHERE tenant_id = ? AND user_id = ? AND device_id = ? AND revoked_at IS NULL`,
      [principal.tenant.id, principal.user.id, deviceId],
    );
  }

  async list(principal: SessionIdentity) {
    const rows = await this.dataSource.query<OfflineDeviceRow[]>(
      `SELECT device_id, first_seen_at, last_seen_at, revoked_at
       FROM offline_devices WHERE tenant_id = ? AND user_id = ?
       ORDER BY last_seen_at DESC, device_id`,
      [principal.tenant.id, principal.user.id],
    );
    return {
      data: rows.map((row) => ({
        deviceId: row.device_id,
        firstSeenAt: new Date(row.first_seen_at).toISOString(),
        lastSeenAt: new Date(row.last_seen_at).toISOString(),
        revokedAt: row.revoked_at
          ? new Date(row.revoked_at).toISOString()
          : null,
      })),
      meta: { apiVersion: '1' as const },
    };
  }

  async revoke(principal: SessionIdentity, deviceId: string): Promise<void> {
    const result = await this.dataSource.query<{ affectedRows?: number }>(
      `UPDATE offline_devices SET revoked_at = COALESCE(revoked_at, CURRENT_TIMESTAMP(6))
       WHERE tenant_id = ? AND user_id = ? AND device_id = ?`,
      [principal.tenant.id, principal.user.id, deviceId],
    );
    if (!result.affectedRows) throw new NotFoundException();
  }
}
