import { Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { DataSource, EntityManager, QueryFailedError } from 'typeorm';
import { RoleEntity } from '../../identity/entities/role.entity';
import { UserRoleEntity } from '../../identity/entities/user-role.entity';
import { UserEntity } from '../../identity/entities/user.entity';
import { TenantEntity } from '../../tenancy/entities/tenant.entity';
import { RegistrationRequestEntity } from './entities/registration-request.entity';
import { RegistrationConflictError } from './registration.errors';
import { RegistrationInput, RegistrationResult } from './registration.types';

@Injectable()
export class RegistrationRepository {
  constructor(private readonly dataSource: DataSource) {}

  async create(input: RegistrationInput): Promise<RegistrationResult> {
    try {
      return await this.dataSource.transaction(async (manager) => {
        await manager.insert(RegistrationRequestEntity, {
          idempotencyKey: input.idempotencyKey,
          requestFingerprint: input.requestFingerprint,
          tenantId: null,
          userId: null,
        });

        const duplicateUser = await manager.existsBy(UserEntity, {
          normalizedEmail: input.normalizedEmail,
        });
        if (duplicateUser) {
          throw new RegistrationConflictError();
        }

        return this.persistAccount(manager, input);
      });
    } catch (error) {
      if (error instanceof RegistrationConflictError) {
        throw error;
      }

      if (this.isDuplicateEntry(error)) {
        const existing = await this.findCompletedRequest(input.idempotencyKey);
        if (
          existing &&
          existing.requestFingerprint === input.requestFingerprint
        ) {
          return existing.result;
        }
        throw new RegistrationConflictError();
      }

      throw error;
    }
  }

  private async persistAccount(
    manager: EntityManager,
    input: RegistrationInput,
  ): Promise<RegistrationResult> {
    const tenant = { id: randomUUID(), name: input.organizationName };
    const role = {
      id: randomUUID(),
      tenantId: tenant.id,
      code: 'ADMIN',
      name: 'Administrador',
    };
    const user = {
      id: randomUUID(),
      tenantId: tenant.id,
      email: input.email,
      normalizedEmail: input.normalizedEmail,
      passwordHash: input.passwordHash,
    };

    await manager.insert(TenantEntity, tenant);
    await manager.insert(RoleEntity, role);
    await manager.insert(UserEntity, user);
    await manager.insert(UserRoleEntity, {
      userId: user.id,
      roleId: role.id,
      tenantId: tenant.id,
    });
    await manager.query(
      `INSERT INTO role_permissions (role_id, tenant_id, permission) VALUES
        (?, ?, 'TENANT_MANAGE'), (?, ?, 'PRODUCTS_MANAGE'),
        (?, ?, 'SALES_MANAGE'), (?, ?, 'SALES_VOID'),
        (?, ?, 'SALES_DISCOUNT'), (?, ?, 'SALE_REPRINT'),
        (?, ?, 'CASH_REGISTER_OPEN'), (?, ?, 'CASH_REGISTER_CLOSE'),
        (?, ?, 'CASH_REGISTER_MOVE'),
        (?, ?, 'ACCESS_MANAGE'),
        (?, ?, 'AUDIT_VIEW'), (?, ?, 'AUDIT_EXPORT'),
        (?, ?, 'SUPPLIERS_MANAGE'),
        (?, ?, 'INVENTORY_VIEW'), (?, ?, 'INVENTORY_ADJUST'),
        (?, ?, 'INVENTORY_TRANSFER'), (?, ?, 'INVENTORY_COUNT'),
        (?, ?, 'INVENTORY_APPROVE')`,
      Array.from({ length: 18 }, () => [role.id, tenant.id]).flat(),
    );
    await manager.update(
      RegistrationRequestEntity,
      { idempotencyKey: input.idempotencyKey },
      { tenantId: tenant.id, userId: user.id },
    );

    return {
      tenant: { id: tenant.id, name: tenant.name },
      user: { id: user.id, email: user.email },
    };
  }

  private async findCompletedRequest(idempotencyKey: string): Promise<{
    requestFingerprint: string;
    result: RegistrationResult;
  } | null> {
    const request = await this.dataSource.manager.findOneBy(
      RegistrationRequestEntity,
      { idempotencyKey },
    );
    if (!request?.tenantId || !request.userId) {
      return null;
    }

    const [tenant, user] = await Promise.all([
      this.dataSource.manager.findOneBy(TenantEntity, {
        id: request.tenantId,
      }),
      this.dataSource.manager.findOneBy(UserEntity, { id: request.userId }),
    ]);
    if (!tenant || !user) {
      return null;
    }

    return {
      requestFingerprint: request.requestFingerprint,
      result: {
        tenant: { id: tenant.id, name: tenant.name },
        user: { id: user.id, email: user.email },
      },
    };
  }

  private isDuplicateEntry(error: unknown): boolean {
    if (!(error instanceof QueryFailedError)) {
      return false;
    }

    const driverError = error.driverError as { errno?: number };
    return driverError.errno === 1062;
  }
}
