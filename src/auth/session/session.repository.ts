import { Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { DataSource } from 'typeorm';
import { SessionEntity } from './entities/session.entity';
import { SessionIdentity } from './session.types';

interface IdentityRow {
  session_id?: string;
  user_id: string;
  email: string;
  password_hash?: string;
  tenant_id: string;
  tenant_name: string;
  onboarding_completed_at: Date | null;
  roles: string | null;
}

export interface LoginIdentity extends Omit<SessionIdentity, 'sessionId'> {
  passwordHash: string;
}

@Injectable()
export class SessionRepository {
  constructor(private readonly dataSource: DataSource) {}

  async findLoginIdentity(
    normalizedEmail: string,
  ): Promise<LoginIdentity | null> {
    const [row] = await this.dataSource.query<IdentityRow[]>(
      `
        SELECT
          u.id AS user_id,
          u.email,
          u.password_hash,
          t.id AS tenant_id,
          t.name AS tenant_name,
          t.onboarding_completed_at,
          GROUP_CONCAT(r.code ORDER BY r.code) AS roles
        FROM users u
        INNER JOIN tenants t ON t.id = u.tenant_id
        LEFT JOIN user_roles ur ON ur.user_id = u.id
        LEFT JOIN roles r ON r.id = ur.role_id
        WHERE u.normalized_email = ?
        GROUP BY u.id, u.email, u.password_hash, t.id, t.name, t.onboarding_completed_at
        LIMIT 1
      `,
      [normalizedEmail],
    );

    if (!row?.password_hash) {
      return null;
    }

    return {
      passwordHash: row.password_hash,
      user: {
        id: row.user_id,
        email: row.email,
        roles: this.parseRoles(row.roles),
      },
      tenant: { id: row.tenant_id, name: row.tenant_name },
      nextStep: row.onboarding_completed_at ? 'APPLICATION' : 'ONBOARDING',
    };
  }

  async createSession(input: {
    tokenHash: string;
    userId: string;
    tenantId: string;
    expiresAt: Date;
  }): Promise<string> {
    const id = randomUUID();
    await this.dataSource.manager.insert(SessionEntity, {
      id,
      tokenHash: input.tokenHash,
      userId: input.userId,
      tenantId: input.tenantId,
      expiresAt: input.expiresAt,
      revokedAt: null,
    });
    return id;
  }

  async findActiveSession(
    tokenHash: string,
    now: Date,
  ): Promise<SessionIdentity | null> {
    const [row] = await this.dataSource.query<IdentityRow[]>(
      `
        SELECT
          s.id AS session_id,
          u.id AS user_id,
          u.email,
          t.id AS tenant_id,
          t.name AS tenant_name,
          t.onboarding_completed_at,
          GROUP_CONCAT(r.code ORDER BY r.code) AS roles
        FROM sessions s
        INNER JOIN users u ON u.id = s.user_id AND u.tenant_id = s.tenant_id
        INNER JOIN tenants t ON t.id = s.tenant_id
        LEFT JOIN user_roles ur ON ur.user_id = u.id
        LEFT JOIN roles r ON r.id = ur.role_id AND r.tenant_id = s.tenant_id
        WHERE s.token_hash = ? AND s.revoked_at IS NULL AND s.expires_at > ?
        GROUP BY s.id, u.id, u.email, t.id, t.name, t.onboarding_completed_at
        LIMIT 1
      `,
      [tokenHash, now],
    );

    if (!row?.session_id) {
      return null;
    }

    return {
      sessionId: row.session_id,
      user: {
        id: row.user_id,
        email: row.email,
        roles: this.parseRoles(row.roles),
      },
      tenant: { id: row.tenant_id, name: row.tenant_name },
      nextStep: row.onboarding_completed_at ? 'APPLICATION' : 'ONBOARDING',
    };
  }

  private parseRoles(roles: string | null): string[] {
    return roles ? roles.split(',') : [];
  }
}
