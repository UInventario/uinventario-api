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
  expires_at?: Date;
  roles: string | null;
  branch_id: string | null;
  branch_name: string | null;
  warehouse_id: string | null;
  warehouse_name: string | null;
  cash_register_id: string | null;
  cash_register_name: string | null;
  cash_register_code: string | null;
}

export interface LoginIdentity extends Omit<
  SessionIdentity,
  'sessionId' | 'expiresAt'
> {
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
          b.id AS branch_id,
          b.name AS branch_name,
          w.id AS warehouse_id,
          w.name AS warehouse_name,
          cr.id AS cash_register_id,
          cr.name AS cash_register_name,
          cr.code AS cash_register_code,
          GROUP_CONCAT(r.code ORDER BY r.code) AS roles
        FROM users u
        INNER JOIN tenants t ON t.id = u.tenant_id
        LEFT JOIN branches b ON b.tenant_id = t.id AND b.onboarding_key = 'INITIAL' AND b.active = TRUE
        LEFT JOIN warehouses w ON w.tenant_id = t.id AND w.branch_id = b.id AND w.onboarding_key = 'INITIAL' AND w.active = TRUE
        LEFT JOIN cash_registers cr ON cr.tenant_id = t.id AND cr.branch_id = b.id AND cr.onboarding_key = 'INITIAL'
        LEFT JOIN user_roles ur ON ur.user_id = u.id
        LEFT JOIN roles r ON r.id = ur.role_id
        WHERE u.normalized_email = ?
        GROUP BY u.id, u.email, u.password_hash, t.id, t.name, t.onboarding_completed_at, b.id, b.name, w.id, w.name, cr.id, cr.name, cr.code
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
        permissions: this.permissionsFor(row.roles),
      },
      tenant: { id: row.tenant_id, name: row.tenant_name },
      context: this.toContext(row),
      nextStep: row.onboarding_completed_at ? 'APPLICATION' : 'ONBOARDING',
    };
  }

  async createSession(input: {
    tokenHash: string;
    userId: string;
    tenantId: string;
    expiresAt: Date;
    activeBranchId: string | null;
    activeWarehouseId: string | null;
    activeCashRegisterId: string | null;
  }): Promise<string> {
    const id = randomUUID();
    await this.dataSource.manager.insert(SessionEntity, {
      id,
      tokenHash: input.tokenHash,
      userId: input.userId,
      tenantId: input.tenantId,
      expiresAt: input.expiresAt,
      revokedAt: null,
      activeBranchId: input.activeBranchId,
      activeWarehouseId: input.activeWarehouseId,
      activeCashRegisterId: input.activeCashRegisterId,
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
          s.expires_at,
          u.id AS user_id,
          u.email,
          t.id AS tenant_id,
          t.name AS tenant_name,
          t.onboarding_completed_at,
          b.id AS branch_id,
          b.name AS branch_name,
          w.id AS warehouse_id,
          w.name AS warehouse_name,
          cr.id AS cash_register_id,
          cr.name AS cash_register_name,
          cr.code AS cash_register_code,
          GROUP_CONCAT(r.code ORDER BY r.code) AS roles
        FROM sessions s
        INNER JOIN users u ON u.id = s.user_id AND u.tenant_id = s.tenant_id
        INNER JOIN tenants t ON t.id = s.tenant_id
        LEFT JOIN branches b ON b.id = COALESCE(
          s.active_branch_id,
          (SELECT initial_branch.id FROM branches initial_branch
           WHERE initial_branch.tenant_id = s.tenant_id AND initial_branch.onboarding_key = 'INITIAL' LIMIT 1)
        ) AND b.tenant_id = s.tenant_id AND b.active = TRUE
        LEFT JOIN warehouses w ON w.id = COALESCE(
          s.active_warehouse_id,
          (SELECT initial_warehouse.id FROM warehouses initial_warehouse
           WHERE initial_warehouse.tenant_id = s.tenant_id AND initial_warehouse.onboarding_key = 'INITIAL' LIMIT 1)
        ) AND w.tenant_id = s.tenant_id AND w.branch_id = b.id AND w.active = TRUE
        LEFT JOIN cash_registers cr ON cr.id = COALESCE(
          s.active_cash_register_id,
          (SELECT initial_register.id FROM cash_registers initial_register
           WHERE initial_register.tenant_id = s.tenant_id AND initial_register.onboarding_key = 'INITIAL' LIMIT 1)
        ) AND cr.tenant_id = s.tenant_id AND cr.branch_id = b.id
        LEFT JOIN user_roles ur ON ur.user_id = u.id
        LEFT JOIN roles r ON r.id = ur.role_id AND r.tenant_id = s.tenant_id
        WHERE s.token_hash = ? AND s.revoked_at IS NULL AND s.expires_at > ?
        GROUP BY s.id, u.id, u.email, t.id, t.name, t.onboarding_completed_at, b.id, b.name, w.id, w.name, cr.id, cr.name, cr.code
        LIMIT 1
      `,
      [tokenHash, now],
    );

    if (!row?.session_id) {
      return null;
    }

    return {
      sessionId: row.session_id,
      expiresAt: new Date(row.expires_at!),
      user: {
        id: row.user_id,
        email: row.email,
        roles: this.parseRoles(row.roles),
        permissions: this.permissionsFor(row.roles),
      },
      tenant: { id: row.tenant_id, name: row.tenant_name },
      context: this.toContext(row),
      nextStep: row.onboarding_completed_at ? 'APPLICATION' : 'ONBOARDING',
    };
  }

  async rotateSession(
    sessionId: string,
    currentTokenHash: string,
    nextTokenHash: string,
    expiresAt: Date,
    now: Date,
  ): Promise<boolean> {
    const result = await this.dataSource
      .createQueryBuilder()
      .update(SessionEntity)
      .set({ tokenHash: nextTokenHash, expiresAt })
      .where('id = :sessionId', { sessionId })
      .andWhere('token_hash = :currentTokenHash', { currentTokenHash })
      .andWhere('revoked_at IS NULL')
      .andWhere('expires_at > :now', { now })
      .execute();

    return result.affected === 1;
  }

  async revokeSession(sessionId: string, revokedAt: Date): Promise<void> {
    await this.dataSource
      .createQueryBuilder()
      .update(SessionEntity)
      .set({ revokedAt })
      .where('id = :sessionId', { sessionId })
      .andWhere('revoked_at IS NULL')
      .execute();
  }

  async changeContext(
    sessionId: string,
    tenantId: string,
    branchId: string,
    warehouseId: string,
  ): Promise<SessionIdentity['context'] | null> {
    return this.dataSource.transaction('READ COMMITTED', async (manager) => {
      const [row] = await manager.query<
        Array<{
          branch_id: string;
          branch_name: string;
          warehouse_id: string;
          warehouse_name: string;
          cash_register_id: string | null;
          cash_register_name: string | null;
          cash_register_code: string | null;
        }>
      >(
        `SELECT b.id AS branch_id, b.name AS branch_name,
                w.id AS warehouse_id, w.name AS warehouse_name,
                cr.id AS cash_register_id, cr.name AS cash_register_name,
                cr.code AS cash_register_code
         FROM branches b
         INNER JOIN warehouses w ON w.id = ? AND w.tenant_id = b.tenant_id
           AND w.branch_id = b.id AND w.active = TRUE
         LEFT JOIN cash_registers cr ON cr.id = (
           SELECT candidate.id FROM cash_registers candidate
           WHERE candidate.tenant_id = b.tenant_id AND candidate.branch_id = b.id
           ORDER BY (candidate.onboarding_key = 'INITIAL') DESC, candidate.created_at, candidate.id
           LIMIT 1
         )
         WHERE b.id = ? AND b.tenant_id = ? AND b.active = TRUE
         LIMIT 1 FOR UPDATE`,
        [warehouseId, branchId, tenantId],
      );
      if (!row) return null;
      const result = await manager.query<{ affectedRows?: number }>(
        `UPDATE sessions
         SET active_branch_id = ?, active_warehouse_id = ?, active_cash_register_id = ?
         WHERE id = ? AND tenant_id = ? AND revoked_at IS NULL
           AND expires_at > ?`,
        [
          row.branch_id,
          row.warehouse_id,
          row.cash_register_id,
          sessionId,
          tenantId,
          new Date(),
        ],
      );
      if (Number(result.affectedRows ?? 0) !== 1) return null;
      return {
        branch: { id: row.branch_id, name: row.branch_name },
        warehouse: { id: row.warehouse_id, name: row.warehouse_name },
        cashRegister:
          row.cash_register_id &&
          row.cash_register_name &&
          row.cash_register_code
            ? {
                id: row.cash_register_id,
                name: row.cash_register_name,
                code: row.cash_register_code,
              }
            : null,
      };
    });
  }

  private parseRoles(roles: string | null): string[] {
    return roles ? roles.split(',') : [];
  }

  private permissionsFor(roles: string | null): string[] {
    return this.parseRoles(roles).includes('ADMIN')
      ? ['TENANT_MANAGE', 'PRODUCTS_MANAGE', 'STOCK_MANAGE', 'SALES_MANAGE']
      : [];
  }

  private toContext(row: IdentityRow): SessionIdentity['context'] {
    return {
      branch:
        row.branch_id && row.branch_name
          ? { id: row.branch_id, name: row.branch_name }
          : null,
      warehouse:
        row.warehouse_id && row.warehouse_name
          ? { id: row.warehouse_id, name: row.warehouse_name }
          : null,
      cashRegister:
        row.cash_register_id && row.cash_register_name && row.cash_register_code
          ? {
              id: row.cash_register_id,
              name: row.cash_register_name,
              code: row.cash_register_code,
            }
          : null,
    };
  }
}
