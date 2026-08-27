import {
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { CreateBranchDto } from './dto/create-branch.dto';
import { CreateWarehouseDto } from './dto/create-warehouse.dto';
import { UpdateBranchDto } from './dto/update-branch.dto';
import { UpdateWarehouseDto } from './dto/update-warehouse.dto';
import {
  InitialOrganizationTargetError,
  OrganizationInUseError,
  OrganizationNameConflictError,
  OrganizationTargetNotFoundError,
} from './organization.errors';
import { OrganizationRepository } from './organization.repository';
import {
  OrganizationBranchResponse,
  OrganizationListResponse,
  OrganizationRetirementResponse,
  OrganizationWarehouseResponse,
} from './organization.types';

@Injectable()
export class OrganizationService {
  constructor(private readonly organization: OrganizationRepository) {}

  async list(
    tenantId: string,
    userId: string,
    administrator: boolean,
  ): Promise<OrganizationListResponse> {
    return {
      data: await this.organization.list(tenantId, userId, administrator),
      meta: { apiVersion: '1' },
    };
  }

  async createBranch(
    tenantId: string,
    dto: CreateBranchDto,
  ): Promise<OrganizationBranchResponse> {
    return this.mapErrors(async () => ({
      data: await this.organization.createBranch(tenantId, dto),
      meta: { apiVersion: '1' },
    }));
  }

  async updateBranch(
    tenantId: string,
    branchId: string,
    dto: UpdateBranchDto,
  ): Promise<OrganizationBranchResponse> {
    return this.mapErrors(async () => ({
      data: await this.organization.updateBranch(tenantId, branchId, dto),
      meta: { apiVersion: '1' },
    }));
  }

  async createWarehouse(
    tenantId: string,
    branchId: string,
    dto: CreateWarehouseDto,
  ): Promise<OrganizationWarehouseResponse> {
    return this.mapErrors(async () => ({
      data: await this.organization.createWarehouse(tenantId, branchId, dto),
      meta: { apiVersion: '1' },
    }));
  }

  async updateWarehouse(
    tenantId: string,
    warehouseId: string,
    dto: UpdateWarehouseDto,
  ): Promise<OrganizationWarehouseResponse> {
    return this.mapErrors(async () => ({
      data: await this.organization.updateWarehouse(tenantId, warehouseId, dto),
      meta: { apiVersion: '1' },
    }));
  }

  async retireBranch(
    tenantId: string,
    branchId: string,
  ): Promise<OrganizationRetirementResponse> {
    return this.mapErrors(async () => {
      await this.organization.retireBranch(tenantId, branchId);
      return {
        data: { id: branchId, active: false },
        meta: { apiVersion: '1' },
      };
    });
  }

  async retireWarehouse(
    tenantId: string,
    warehouseId: string,
  ): Promise<OrganizationRetirementResponse> {
    return this.mapErrors(async () => {
      await this.organization.retireWarehouse(tenantId, warehouseId);
      return {
        data: { id: warehouseId, active: false },
        meta: { apiVersion: '1' },
      };
    });
  }

  private async mapErrors<T>(operation: () => Promise<T>): Promise<T> {
    try {
      return await operation();
    } catch (error) {
      if (error instanceof OrganizationTargetNotFoundError)
        throw new NotFoundException();
      if (error instanceof OrganizationNameConflictError) {
        throw new ConflictException({
          code: 'ORGANIZATION_NAME_CONFLICT',
          message: 'Ya existe una sucursal o bodega con ese nombre.',
        });
      }
      if (error instanceof OrganizationInUseError) {
        throw new ConflictException({
          code: 'ORGANIZATION_IN_USE',
          message:
            'La sucursal o bodega tiene operaciones o una sesión activa.',
        });
      }
      if (error instanceof InitialOrganizationTargetError) {
        throw new ConflictException({
          code: 'INITIAL_ORGANIZATION_TARGET',
          message: 'La estructura inicial no puede desactivarse.',
        });
      }
      throw error;
    }
  }
}
