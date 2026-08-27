import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseEnumPipe,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { AuditService } from '../audit/audit.service';
import { SessionGuard } from '../auth/session/session.guard';
import type { AuthenticatedRequest } from '../auth/session/session.types';
import { CatalogService } from './catalog.service';
import {
  CatalogClassificationKind,
  CreateCatalogClassificationDto,
  DeactivateCatalogClassificationDto,
  ListCatalogClassificationsDto,
  UpdateCatalogClassificationDto,
} from './dto/catalog-classification.dto';
import { ProductAccessGuard } from './product-access.guard';

@Controller('catalog')
@UseGuards(SessionGuard, ProductAccessGuard)
export class CatalogClassificationController {
  constructor(
    private readonly catalog: CatalogService,
    private readonly audit: AuditService,
  ) {}

  @Get(':kind')
  async list(
    @Req() request: AuthenticatedRequest,
    @Param('kind', new ParseEnumPipe(CatalogClassificationKind))
    kind: CatalogClassificationKind,
    @Query() query: ListCatalogClassificationsDto,
  ) {
    return {
      data: await this.catalog.listClassifications(
        request.principal.tenant.id,
        kind,
        query.includeInactive,
      ),
      meta: { apiVersion: '1' as const },
    };
  }

  @Post(':kind')
  async create(
    @Req() request: AuthenticatedRequest,
    @Param('kind', new ParseEnumPipe(CatalogClassificationKind))
    kind: CatalogClassificationKind,
    @Body() dto: CreateCatalogClassificationDto,
  ) {
    const data = await this.catalog.createClassification(
      request.principal.tenant.id,
      kind,
      dto.name,
    );
    await this.record(request, kind, data.id, 'CREATED');
    return { data, meta: { apiVersion: '1' as const } };
  }

  @Patch(':kind/:id')
  async update(
    @Req() request: AuthenticatedRequest,
    @Param('kind', new ParseEnumPipe(CatalogClassificationKind))
    kind: CatalogClassificationKind,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() dto: UpdateCatalogClassificationDto,
  ) {
    const data = await this.catalog.updateClassification(
      request.principal.tenant.id,
      kind,
      id,
      dto,
    );
    await this.record(request, kind, id, 'UPDATED');
    return { data, meta: { apiVersion: '1' as const } };
  }

  @Delete(':kind/:id')
  async deactivate(
    @Req() request: AuthenticatedRequest,
    @Param('kind', new ParseEnumPipe(CatalogClassificationKind))
    kind: CatalogClassificationKind,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Query() query: DeactivateCatalogClassificationDto,
  ) {
    const data = await this.catalog.deactivateClassification(
      request.principal.tenant.id,
      kind,
      id,
      query.replacementId,
    );
    await this.record(request, kind, id, 'DEACTIVATED');
    return { data, meta: { apiVersion: '1' as const } };
  }

  private record(
    request: AuthenticatedRequest,
    kind: CatalogClassificationKind,
    id: string,
    action: string,
  ) {
    return this.audit.record({
      tenantId: request.principal.tenant.id,
      actorUserId: request.principal.user.id,
      action: `CATALOG_${kind === CatalogClassificationKind.CATEGORIES ? 'CATEGORY' : 'BRAND'}_${action}`,
      entityType:
        kind === CatalogClassificationKind.CATEGORIES ? 'CATEGORY' : 'BRAND',
      entityId: id,
      correlationId: request.requestId!,
    });
  }
}
