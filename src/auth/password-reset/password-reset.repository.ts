import { Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { DataSource } from 'typeorm';

@Injectable()
export class PasswordResetRepository {
  constructor(private readonly dataSource: DataSource) {}

  async createToken(input: {
    normalizedEmail: string;
    tokenHash: string;
    expiresAt: Date;
    now: Date;
  }): Promise<{ email: string; tenantId: string } | null> {
    return this.dataSource.transaction(async (manager) => {
      const [user] = await manager.query<
        Array<{ id: string; email: string; tenant_id: string }>
      >(
        'SELECT id, email, tenant_id FROM users WHERE normalized_email = ? LIMIT 1',
        [input.normalizedEmail],
      );
      if (!user) return null;
      await manager.query(
        'UPDATE password_reset_tokens SET used_at = ? WHERE user_id = ? AND used_at IS NULL',
        [input.now, user.id],
      );
      await manager.query(
        `INSERT INTO password_reset_tokens (id, user_id, token_hash, expires_at)
         VALUES (?, ?, ?, ?)`,
        [randomUUID(), user.id, input.tokenHash, input.expiresAt],
      );
      return { email: user.email, tenantId: user.tenant_id };
    });
  }

  async consumeToken(input: {
    tokenHash: string;
    passwordHash: string;
    now: Date;
  }): Promise<boolean> {
    return this.dataSource.transaction('READ COMMITTED', async (manager) => {
      const [reset] = await manager.query<
        Array<{ id: string; user_id: string }>
      >(
        `SELECT id, user_id FROM password_reset_tokens
         WHERE token_hash = ? AND used_at IS NULL AND expires_at > ?
         LIMIT 1 FOR UPDATE`,
        [input.tokenHash, input.now],
      );
      if (!reset) return false;
      await manager.query('UPDATE users SET password_hash = ? WHERE id = ?', [
        input.passwordHash,
        reset.user_id,
      ]);
      await manager.query(
        'UPDATE password_reset_tokens SET used_at = ? WHERE user_id = ? AND used_at IS NULL',
        [input.now, reset.user_id],
      );
      await manager.query(
        'UPDATE sessions SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL',
        [input.now, reset.user_id],
      );
      return true;
    });
  }
}
