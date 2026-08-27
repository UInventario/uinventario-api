import {
  Body,
  Controller,
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
import { CreateSupplierProductDto } from './dto/create-supplier-product.dto';
import { ListSupplierProductsDto } from './dto/list-supplier-products.dto';
import { UpdateSupplierProductDto } from './dto/update-supplier-product.dto';
import { SupplierProductService } from './supplier-product.service';

@Controller('supplier-products')
@UseGuards(SessionGuard, PermissionGuard)
@RequirePermissions('SUPPLIERS_MANAGE')
export class SupplierProductController {
  constructor(
    private readonly links: SupplierProductService,
    private readonly audit: AuditService,
  ) {}

  @Get()
  list(
    @Req() request: AuthenticatedRequest,
    @Query() query: ListSupplierProductsDto,
  ) {
    return this.links.list(request.principal.tenant.id, query);
  }

  @Get(':id')
  get(
    @Req() request: AuthenticatedRequest,
    @Param('id', new ParseUUIDPipe()) id: string,
  ) {
    return this.links.get(request.principal.tenant.id, id);
  }

  @Post()
  async create(
    @Req() request: AuthenticatedRequest,
    @Body() dto: CreateSupplierProductDto,
  ) {
    const result = await this.links.create(
      request.principal.tenant.id,
      request.principal.user.id,
      dto,
    );
    await this.audit.record({
      tenantId: request.principal.tenant.id,
      actorUserId: request.principal.user.id,
      action: 'SUPPLIER_PRODUCT_LINKED',
      entityType: 'SUPPLIER_PRODUCT',
      entityId: result.data.id,
      correlationId: request.requestId!,
      after: {
        supplierId: result.data.supplier.id,
        productId: result.data.product.id,
        currency: result.data.prices[0].currency,
        unitCost: result.data.prices[0].unitCost,
      },
    });
    return result;
  }

  @Patch(':id')
  async update(
    @Req() request: AuthenticatedRequest,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() dto: UpdateSupplierProductDto,
  ) {
    const before = await this.links.get(request.principal.tenant.id, id);
    const result = await this.links.update(
      request.principal.tenant.id,
      request.principal.user.id,
      id,
      dto,
    );
    await this.audit.record({
      tenantId: request.principal.tenant.id,
      actorUserId: request.principal.user.id,
      action: 'SUPPLIER_PRICE_CHANGED',
      entityType: 'SUPPLIER_PRODUCT',
      entityId: id,
      correlationId: request.requestId!,
      before: {
        currency: before.data.prices[0].currency,
        unitCost: before.data.prices[0].unitCost,
      },
      after: {
        currency: result.data.prices[0].currency,
        unitCost: result.data.prices[0].unitCost,
      },
    });
    return result;
  }
}
