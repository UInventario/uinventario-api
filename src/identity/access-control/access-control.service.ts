import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { argon2id, hash } from 'argon2';
import { CreateAccessRoleDto } from './dto/create-access-role.dto';
import { CreateAccessUserDto } from './dto/create-access-user.dto';
import { UpdateUserAccessDto } from './dto/update-user-access.dto';
import { AccessControlRepository } from './access-control.repository';
import {
  AccessUserConflictError,
  AccessUserNotFoundError,
  InvalidAccessAssignmentError,
} from './access-control.errors';

@Injectable()
export class AccessControlService {
  constructor(private readonly access: AccessControlRepository) {}

  async listRoles(tenantId: string) {
    return {
      data: await this.access.listRoles(tenantId),
      meta: { apiVersion: '1' as const },
    };
  }

  async createRole(tenantId: string, dto: CreateAccessRoleDto) {
    return {
      data: await this.access.createRole(tenantId, dto.name, dto.permissions),
      meta: { apiVersion: '1' as const },
    };
  }

  async listUsers(tenantId: string, actorUserId: string) {
    return {
      data: await this.access.listUsers(tenantId, actorUserId),
      meta: { apiVersion: '1' as const },
    };
  }

  async createUser(
    tenantId: string,
    actorUserId: string,
    dto: CreateAccessUserDto,
  ) {
    const passwordHash = await hash(dto.password, {
      type: argon2id,
      memoryCost: 19_456,
      timeCost: 2,
      parallelism: 1,
    });
    return this.mapErrors(async () => ({
      data: await this.access.createUser({
        tenantId,
        actorUserId,
        email: dto.email,
        normalizedEmail: dto.email,
        passwordHash,
        roleIds: dto.roleIds,
        branchIds: dto.branchIds,
      }),
      meta: { apiVersion: '1' as const },
    }));
  }

  async updateUser(
    tenantId: string,
    actorUserId: string,
    userId: string,
    dto: UpdateUserAccessDto,
  ) {
    return this.mapErrors(async () => ({
      data: await this.access.updateUser({
        tenantId,
        actorUserId,
        userId,
        roleIds: dto.roleIds,
        branchIds: dto.branchIds,
      }),
      meta: { apiVersion: '1' as const },
    }));
  }

  private async mapErrors<T>(operation: () => Promise<T>): Promise<T> {
    try {
      return await operation();
    } catch (error) {
      if (error instanceof InvalidAccessAssignmentError) {
        throw new BadRequestException({
          code: 'INVALID_ACCESS_ASSIGNMENT',
          message: 'Los roles o sucursales seleccionados no son válidos.',
        });
      }
      if (error instanceof AccessUserConflictError) {
        throw new ConflictException({
          code: 'ACCESS_USER_NOT_AVAILABLE',
          message:
            'No fue posible crear el usuario con los datos proporcionados.',
        });
      }
      if (error instanceof AccessUserNotFoundError)
        throw new NotFoundException();
      throw error;
    }
  }
}
