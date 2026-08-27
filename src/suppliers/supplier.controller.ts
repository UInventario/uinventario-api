import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { AuditService } from '../audit/audit.service';
import { PermissionGuard } from '../auth/authorization/permission.guard';
import { RequirePermissions } from '../auth/authorization/require-permissions.decorator';
import { SessionGuard } from '../auth/session/session.guard';
import type { AuthenticatedRequest } from '../auth/session/session.types';
import { CreateSupplierDto } from './dto/create-supplier.dto';
import { ListSuppliersDto } from './dto/list-suppliers.dto';
import { UpdateSupplierDto } from './dto/update-supplier.dto';
import { SupplierService } from './supplier.service';

@Controller('suppliers')
@UseGuards(SessionGuard, PermissionGuard)
@RequirePermissions('SUPPLIERS_MANAGE')
export class SupplierController {
  constructor(
    private readonly suppliers: SupplierService,
    private readonly audit: AuditService,
  ) {}

  @Get()
  list(@Req() request: AuthenticatedRequest, @Query() query: ListSuppliersDto) {
    return this.suppliers.list(request.principal.tenant.id, query);
  }

  @Get(':id')
  get(
    @Req() request: AuthenticatedRequest,
    @Param('id', new ParseUUIDPipe()) id: string,
  ) {
    return this.suppliers.get(request.principal.tenant.id, id);
  }

  @Post()
  async create(
    @Req() request: AuthenticatedRequest,
    @Body() dto: CreateSupplierDto,
  ) {
    const result = await this.suppliers.create(
      request.principal.tenant.id,
      dto,
    );
    await this.audit.record({
      tenantId: request.principal.tenant.id,
      actorUserId: request.principal.user.id,
      action: 'SUPPLIER_CREATED',
      entityType: 'SUPPLIER',
      entityId: result.data.id,
      correlationId: request.requestId!,
      after: { legalName: result.data.legalName, active: result.data.active },
    });
    return result;
  }

  @Patch(':id')
  async update(
    @Req() request: AuthenticatedRequest,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() dto: UpdateSupplierDto,
  ) {
    const before = await this.suppliers.get(request.principal.tenant.id, id);
    const result = await this.suppliers.update(
      request.principal.tenant.id,
      id,
      dto,
    );
    await this.audit.record({
      tenantId: request.principal.tenant.id,
      actorUserId: request.principal.user.id,
      action: 'SUPPLIER_UPDATED',
      entityType: 'SUPPLIER',
      entityId: id,
      correlationId: request.requestId!,
      before: { legalName: before.data.legalName, active: before.data.active },
      after: { legalName: result.data.legalName, active: result.data.active },
    });
    return result;
  }

  @Delete(':id')
  async deactivate(
    @Req() request: AuthenticatedRequest,
    @Param('id', new ParseUUIDPipe()) id: string,
  ) {
    const before = await this.suppliers.get(request.principal.tenant.id, id);
    const result = await this.suppliers.deactivate(
      request.principal.tenant.id,
      id,
    );
    await this.audit.record({
      tenantId: request.principal.tenant.id,
      actorUserId: request.principal.user.id,
      action: 'SUPPLIER_DEACTIVATED',
      entityType: 'SUPPLIER',
      entityId: id,
      correlationId: request.requestId!,
      deduplicate: true,
      before: { active: before.data.active },
      after: { active: false },
    });
    return result;
  }
}
