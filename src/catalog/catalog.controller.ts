import {
  Body,
  Controller,
  Delete,
  Get,
  Headers,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  Req,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { SessionGuard } from '../auth/session/session.guard';
import type { AuthenticatedRequest } from '../auth/session/session.types';
import { CatalogService } from './catalog.service';
import { CreateProductDto } from './dto/create-product.dto';
import { ListProductsDto } from './dto/list-products.dto';
import { UpdateProductDto } from './dto/update-product.dto';
import { ProductAccessGuard } from './product-access.guard';
import { AuditService } from '../audit/audit.service';
import { ResolveProductCodeDto } from './dto/resolve-product-code.dto';
import { PermissionGuard } from '../auth/authorization/permission.guard';
import { RequirePermissions } from '../auth/authorization/require-permissions.decorator';
import {
  ProductImportService,
  type ProductImportFile,
} from './product-import.service';

@Controller('products')
@UseGuards(SessionGuard, ProductAccessGuard)
export class CatalogController {
  constructor(
    private readonly catalog: CatalogService,
    private readonly audit: AuditService,
    private readonly productImports: ProductImportService,
  ) {}

  @Post('imports/preview')
  @UseGuards(PermissionGuard)
  @RequirePermissions('PRODUCTS_MANAGE')
  @UseInterceptors(
    FileInterceptor('file', {
      limits: { fileSize: 2 * 1024 * 1024, files: 1 },
    }),
  )
  previewImport(
    @Req() request: AuthenticatedRequest,
    @UploadedFile() file: ProductImportFile | undefined,
  ) {
    return this.productImports.preview({
      tenantId: request.principal.tenant.id,
      userId: request.principal.user.id,
      file,
    });
  }

  @Get('imports/:importId')
  @UseGuards(PermissionGuard)
  @RequirePermissions('PRODUCTS_MANAGE')
  getImport(
    @Req() request: AuthenticatedRequest,
    @Param('importId', ParseUUIDPipe) importId: string,
  ) {
    return this.productImports.get(request.principal.tenant.id, importId);
  }

  @Post('imports/:importId/confirm')
  @UseGuards(PermissionGuard)
  @RequirePermissions('PRODUCTS_MANAGE')
  async confirmImport(
    @Req() request: AuthenticatedRequest,
    @Param('importId', ParseUUIDPipe) importId: string,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
  ) {
    const result = await this.productImports.confirm({
      tenantId: request.principal.tenant.id,
      userId: request.principal.user.id,
      id: importId,
      idempotencyKey,
    });
    await this.audit.record({
      tenantId: request.principal.tenant.id,
      actorUserId: request.principal.user.id,
      action: 'PRODUCT_IMPORT_CONFIRMED',
      entityType: 'PRODUCT_IMPORT',
      entityId: importId,
      correlationId: request.requestId!,
      deduplicate: true,
      after: result.data.summary,
    });
    return result;
  }

  @Get('imports/:importId/result')
  @UseGuards(PermissionGuard)
  @RequirePermissions('PRODUCTS_MANAGE')
  importResult(
    @Req() request: AuthenticatedRequest,
    @Param('importId', ParseUUIDPipe) importId: string,
  ) {
    return this.productImports.result(request.principal.tenant.id, importId);
  }

  @Get('options')
  getOptions(@Req() request: AuthenticatedRequest) {
    return this.catalog.getOptions(request.principal.tenant.id);
  }

  @Get()
  listProducts(
    @Req() request: AuthenticatedRequest,
    @Query() query: ListProductsDto,
  ) {
    return this.catalog.listProducts(request.principal.tenant.id, query);
  }

  @Get('resolve-code')
  resolveCode(
    @Req() request: AuthenticatedRequest,
    @Query() query: ResolveProductCodeDto,
  ) {
    return this.catalog.resolveCode(request.principal.tenant.id, query.code);
  }

  @Get(':id')
  getProduct(
    @Req() request: AuthenticatedRequest,
    @Param('id', new ParseUUIDPipe()) id: string,
  ) {
    return this.catalog.getProduct(request.principal.tenant.id, id);
  }

  @Post()
  async createProduct(
    @Req() request: AuthenticatedRequest,
    @Body() dto: CreateProductDto,
  ) {
    const result = await this.catalog.createProduct(
      request.principal.tenant.id,
      dto,
    );
    await this.audit.record({
      tenantId: request.principal.tenant.id,
      actorUserId: request.principal.user.id,
      action: 'PRODUCT_CREATED',
      entityType: 'PRODUCT',
      entityId: result.data.id,
      correlationId: request.requestId!,
      deduplicate: true,
    });
    return result;
  }

  @Patch(':id')
  async updateProduct(
    @Req() request: AuthenticatedRequest,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() dto: UpdateProductDto,
  ) {
    const result = await this.catalog.updateProduct(
      request.principal.tenant.id,
      id,
      dto,
    );
    await this.audit.record({
      tenantId: request.principal.tenant.id,
      actorUserId: request.principal.user.id,
      action: 'PRODUCT_UPDATED',
      entityType: 'PRODUCT',
      entityId: result.data.id,
      correlationId: request.requestId!,
    });
    return result;
  }

  @Delete(':id')
  async retireProduct(
    @Req() request: AuthenticatedRequest,
    @Param('id', new ParseUUIDPipe()) id: string,
  ) {
    const result = await this.catalog.retireProduct(
      request.principal.tenant.id,
      id,
    );
    await this.audit.record({
      tenantId: request.principal.tenant.id,
      actorUserId: request.principal.user.id,
      action:
        result.data.outcome === 'DELETED'
          ? 'PRODUCT_DELETED'
          : 'PRODUCT_DEACTIVATED',
      entityType: 'PRODUCT',
      entityId: id,
      correlationId: request.requestId!,
    });
    return result;
  }
}
