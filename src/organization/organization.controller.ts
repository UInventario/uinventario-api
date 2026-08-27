import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import { AuditService } from '../audit/audit.service';
import { SessionGuard } from '../auth/session/session.guard';
import type { AuthenticatedRequest } from '../auth/session/session.types';
import { CreateBranchDto } from './dto/create-branch.dto';
import { CreateWarehouseDto } from './dto/create-warehouse.dto';
import { UpdateBranchDto } from './dto/update-branch.dto';
import { UpdateWarehouseDto } from './dto/update-warehouse.dto';
import { OrganizationAccessGuard } from './organization-access.guard';
import { OrganizationService } from './organization.service';

@Controller('organization')
@UseGuards(SessionGuard)
export class OrganizationController {
  constructor(
    private readonly organization: OrganizationService,
    private readonly audit: AuditService,
  ) {}

  @Get('branches')
  list(@Req() request: AuthenticatedRequest) {
    return this.organization.list(request.principal.tenant.id);
  }

  @Post('branches')
  @UseGuards(OrganizationAccessGuard)
  async createBranch(
    @Req() request: AuthenticatedRequest,
    @Body() dto: CreateBranchDto,
  ) {
    const result = await this.organization.createBranch(
      request.principal.tenant.id,
      dto,
    );
    await this.record(request, 'BRANCH_CREATED', 'BRANCH', result.data.id);
    return result;
  }

  @Patch('branches/:branchId')
  @UseGuards(OrganizationAccessGuard)
  async updateBranch(
    @Req() request: AuthenticatedRequest,
    @Param('branchId', new ParseUUIDPipe()) branchId: string,
    @Body() dto: UpdateBranchDto,
  ) {
    const result = await this.organization.updateBranch(
      request.principal.tenant.id,
      branchId,
      dto,
    );
    await this.record(request, 'BRANCH_UPDATED', 'BRANCH', result.data.id);
    return result;
  }

  @Delete('branches/:branchId')
  @UseGuards(OrganizationAccessGuard)
  async retireBranch(
    @Req() request: AuthenticatedRequest,
    @Param('branchId', new ParseUUIDPipe()) branchId: string,
  ) {
    const result = await this.organization.retireBranch(
      request.principal.tenant.id,
      branchId,
    );
    await this.record(request, 'BRANCH_RETIRED', 'BRANCH', branchId);
    return result;
  }

  @Post('branches/:branchId/warehouses')
  @UseGuards(OrganizationAccessGuard)
  async createWarehouse(
    @Req() request: AuthenticatedRequest,
    @Param('branchId', new ParseUUIDPipe()) branchId: string,
    @Body() dto: CreateWarehouseDto,
  ) {
    const result = await this.organization.createWarehouse(
      request.principal.tenant.id,
      branchId,
      dto,
    );
    await this.record(
      request,
      'WAREHOUSE_CREATED',
      'WAREHOUSE',
      result.data.id,
    );
    return result;
  }

  @Patch('warehouses/:warehouseId')
  @UseGuards(OrganizationAccessGuard)
  async updateWarehouse(
    @Req() request: AuthenticatedRequest,
    @Param('warehouseId', new ParseUUIDPipe()) warehouseId: string,
    @Body() dto: UpdateWarehouseDto,
  ) {
    const result = await this.organization.updateWarehouse(
      request.principal.tenant.id,
      warehouseId,
      dto,
    );
    await this.record(
      request,
      'WAREHOUSE_UPDATED',
      'WAREHOUSE',
      result.data.id,
    );
    return result;
  }

  @Delete('warehouses/:warehouseId')
  @UseGuards(OrganizationAccessGuard)
  async retireWarehouse(
    @Req() request: AuthenticatedRequest,
    @Param('warehouseId', new ParseUUIDPipe()) warehouseId: string,
  ) {
    const result = await this.organization.retireWarehouse(
      request.principal.tenant.id,
      warehouseId,
    );
    await this.record(request, 'WAREHOUSE_RETIRED', 'WAREHOUSE', warehouseId);
    return result;
  }

  private async record(
    request: AuthenticatedRequest,
    action: string,
    entityType: string,
    entityId: string,
  ): Promise<void> {
    await this.audit.record({
      tenantId: request.principal.tenant.id,
      actorUserId: request.principal.user.id,
      action,
      entityType,
      entityId,
      correlationId: request.requestId!,
    });
  }
}
