import { Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { DataSource, EntityManager, QueryFailedError } from 'typeorm';
import type { AppPermission } from '../../auth/authorization/authorization.types';
import {
  AccessUserConflictError,
  AccessUserNotFoundError,
  InvalidAccessAssignmentError,
} from './access-control.errors';
import type { AccessRoleData, AccessUserData } from './access-control.types';

@Injectable()
export class AccessControlRepository {
  constructor(private readonly dataSource: DataSource) {}

  async listRoles(tenantId: string): Promise<AccessRoleData[]> {
    const rows = await this.dataSource.query<
      Array<{ id: string; name: string; permission: AppPermission }>
    >(
      `SELECT r.id, r.name, rp.permission
       FROM roles r
       INNER JOIN role_permissions rp ON rp.role_id = r.id AND rp.tenant_id = r.tenant_id
       WHERE r.tenant_id = ? AND r.code <> 'ADMIN'
       ORDER BY r.name, r.id, rp.permission`,
      [tenantId],
    );
    const roles = new Map<string, AccessRoleData>();
    for (const row of rows) {
      const role = roles.get(row.id) ?? {
        id: row.id,
        name: row.name,
        permissions: [],
      };
      role.permissions.push(row.permission);
      roles.set(row.id, role);
    }
    return [...roles.values()];
  }

  async createRole(
    tenantId: string,
    name: string,
    permissions: AppPermission[],
  ): Promise<AccessRoleData> {
    const id = randomUUID();
    await this.dataSource.transaction(async (manager) => {
      await manager.query(
        `INSERT INTO roles (id, tenant_id, code, name)
         VALUES (?, ?, ?, ?)`,
        [id, tenantId, `CUSTOM_${id.replaceAll('-', '').slice(0, 20)}`, name],
      );
      await this.insertPermissions(manager, tenantId, id, permissions);
    });
    return { id, name, permissions: [...permissions].sort() };
  }

  async listUsers(
    tenantId: string,
    actorUserId: string,
  ): Promise<AccessUserData[]> {
    const users = await this.dataSource.query<
      Array<{ id: string; email: string; administrator: number | string }>
    >(
      `SELECT u.id, u.email,
              EXISTS (
                SELECT 1 FROM user_roles ur
                INNER JOIN roles r ON r.id = ur.role_id AND r.tenant_id = ur.tenant_id
                WHERE ur.user_id = u.id AND ur.tenant_id = u.tenant_id AND r.code = 'ADMIN'
              ) AS administrator
       FROM users u WHERE u.tenant_id = ? ORDER BY u.email, u.id`,
      [tenantId],
    );
    return Promise.all(
      users.map(async (user) => ({
        id: user.id,
        email: user.email,
        roles: await this.userRoles(this.dataSource.manager, tenantId, user.id),
        branches: await this.userBranches(
          this.dataSource.manager,
          tenantId,
          user.id,
        ),
        manageable: user.id !== actorUserId && Number(user.administrator) === 0,
      })),
    );
  }

  async createUser(input: {
    tenantId: string;
    actorUserId: string;
    email: string;
    normalizedEmail: string;
    passwordHash: string;
    roleIds: string[];
    branchIds: string[];
  }): Promise<AccessUserData> {
    const id = randomUUID();
    try {
      return await this.dataSource.transaction(async (manager) => {
        await this.assertAssignment(
          manager,
          input.tenantId,
          input.roleIds,
          input.branchIds,
        );
        await manager.query(
          `INSERT INTO users (id, tenant_id, email, normalized_email, password_hash)
           VALUES (?, ?, ?, ?, ?)`,
          [
            id,
            input.tenantId,
            input.email,
            input.normalizedEmail,
            input.passwordHash,
          ],
        );
        await this.replaceAssignment(
          manager,
          input.tenantId,
          id,
          input.roleIds,
          input.branchIds,
        );
        return this.findUser(manager, input.tenantId, input.actorUserId, id);
      });
    } catch (error) {
      if (this.isDuplicate(error)) throw new AccessUserConflictError();
      throw error;
    }
  }

  async updateUser(input: {
    tenantId: string;
    actorUserId: string;
    userId: string;
    roleIds: string[];
    branchIds: string[];
  }): Promise<AccessUserData> {
    if (input.userId === input.actorUserId)
      throw new InvalidAccessAssignmentError();
    return this.dataSource.transaction(async (manager) => {
      const [target] = await manager.query<
        Array<{ administrator: number | string }>
      >(
        `SELECT EXISTS (
           SELECT 1 FROM user_roles ur
           INNER JOIN roles r ON r.id = ur.role_id AND r.tenant_id = ur.tenant_id
           WHERE ur.user_id = u.id AND ur.tenant_id = u.tenant_id AND r.code = 'ADMIN'
         ) AS administrator
         FROM users u WHERE u.id = ? AND u.tenant_id = ? FOR UPDATE`,
        [input.userId, input.tenantId],
      );
      if (!target) throw new AccessUserNotFoundError();
      if (Number(target.administrator) !== 0)
        throw new InvalidAccessAssignmentError();
      await this.assertAssignment(
        manager,
        input.tenantId,
        input.roleIds,
        input.branchIds,
      );
      await this.replaceAssignment(
        manager,
        input.tenantId,
        input.userId,
        input.roleIds,
        input.branchIds,
      );
      await manager.query(
        `UPDATE sessions SET revoked_at = CURRENT_TIMESTAMP(6)
         WHERE user_id = ? AND tenant_id = ? AND revoked_at IS NULL`,
        [input.userId, input.tenantId],
      );
      return this.findUser(
        manager,
        input.tenantId,
        input.actorUserId,
        input.userId,
      );
    });
  }

  private async assertAssignment(
    manager: EntityManager,
    tenantId: string,
    roleIds: string[],
    branchIds: string[],
  ): Promise<void> {
    const [[roles], [branches]] = await Promise.all([
      manager.query<Array<{ total: number | string }>>(
        `SELECT COUNT(*) AS total FROM roles
         WHERE tenant_id = ? AND code <> 'ADMIN' AND id IN (?)`,
        [tenantId, roleIds],
      ),
      manager.query<Array<{ total: number | string }>>(
        `SELECT COUNT(*) AS total FROM branches
         WHERE tenant_id = ? AND active = TRUE AND id IN (?)`,
        [tenantId, branchIds],
      ),
    ]);
    if (
      Number(roles.total) !== roleIds.length ||
      Number(branches.total) !== branchIds.length
    ) {
      throw new InvalidAccessAssignmentError();
    }
  }

  private async replaceAssignment(
    manager: EntityManager,
    tenantId: string,
    userId: string,
    roleIds: string[],
    branchIds: string[],
  ): Promise<void> {
    await manager.query(
      'DELETE FROM user_roles WHERE user_id = ? AND tenant_id = ?',
      [userId, tenantId],
    );
    await manager.query(
      'DELETE FROM user_branch_access WHERE user_id = ? AND tenant_id = ?',
      [userId, tenantId],
    );
    for (const roleId of roleIds) {
      await manager.query(
        'INSERT INTO user_roles (user_id, role_id, tenant_id) VALUES (?, ?, ?)',
        [userId, roleId, tenantId],
      );
    }
    for (const branchId of branchIds) {
      await manager.query(
        `INSERT INTO user_branch_access (user_id, tenant_id, branch_id)
         VALUES (?, ?, ?)`,
        [userId, tenantId, branchId],
      );
    }
  }

  private async findUser(
    manager: EntityManager,
    tenantId: string,
    actorUserId: string,
    userId: string,
  ): Promise<AccessUserData> {
    const [user] = await manager.query<Array<{ id: string; email: string }>>(
      'SELECT id, email FROM users WHERE id = ? AND tenant_id = ?',
      [userId, tenantId],
    );
    if (!user) throw new AccessUserNotFoundError();
    return {
      id: user.id,
      email: user.email,
      roles: await this.userRoles(manager, tenantId, userId),
      branches: await this.userBranches(manager, tenantId, userId),
      manageable: user.id !== actorUserId,
    };
  }

  private async userRoles(
    manager: EntityManager,
    tenantId: string,
    userId: string,
  ): Promise<AccessRoleData[]> {
    const rows = await manager.query<
      Array<{ id: string; name: string; permission: AppPermission }>
    >(
      `SELECT r.id, r.name, rp.permission FROM user_roles ur
       INNER JOIN roles r ON r.id = ur.role_id AND r.tenant_id = ur.tenant_id
       INNER JOIN role_permissions rp ON rp.role_id = r.id AND rp.tenant_id = r.tenant_id
       WHERE ur.user_id = ? AND ur.tenant_id = ?
       ORDER BY r.name, r.id, rp.permission`,
      [userId, tenantId],
    );
    const roles = new Map<string, AccessRoleData>();
    for (const row of rows) {
      const role = roles.get(row.id) ?? {
        id: row.id,
        name: row.name,
        permissions: [],
      };
      role.permissions.push(row.permission);
      roles.set(row.id, role);
    }
    return [...roles.values()];
  }

  private userBranches(
    manager: EntityManager,
    tenantId: string,
    userId: string,
  ) {
    return manager.query<Array<{ id: string; name: string }>>(
      `SELECT b.id, b.name FROM user_branch_access uba
       INNER JOIN branches b ON b.id = uba.branch_id AND b.tenant_id = uba.tenant_id
       WHERE uba.user_id = ? AND uba.tenant_id = ? AND b.active = TRUE
       ORDER BY b.name, b.id`,
      [userId, tenantId],
    );
  }

  private async insertPermissions(
    manager: EntityManager,
    tenantId: string,
    roleId: string,
    permissions: AppPermission[],
  ): Promise<void> {
    for (const permission of permissions) {
      await manager.query(
        `INSERT INTO role_permissions (role_id, tenant_id, permission)
         VALUES (?, ?, ?)`,
        [roleId, tenantId, permission],
      );
    }
  }

  private isDuplicate(error: unknown): boolean {
    return (
      error instanceof QueryFailedError &&
      (error.driverError as { errno?: number }).errno === 1062
    );
  }
}
