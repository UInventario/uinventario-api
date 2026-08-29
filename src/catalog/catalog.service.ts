import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { CatalogRepository } from './catalog.repository';
import {
  CatalogClassificationConflictError,
  ProductCodeAmbiguousError,
  ProductIdentifierConflictError,
  ProductVersionConflictError,
  ProductLotTrackingLockedError,
  ProductVariantConfigurationError,
  ProductVariantsRequireZeroStockError,
} from './catalog.errors';
import {
  CatalogOptionsResponse,
  ProductListResponse,
  ProductRetirementResponse,
  ProductResponse,
} from './catalog.types';
import { CreateProductDto } from './dto/create-product.dto';
import { ListProductsDto } from './dto/list-products.dto';
import { UpdateProductDto } from './dto/update-product.dto';
import {
  CatalogClassificationKind,
  UpdateCatalogClassificationDto,
} from './dto/catalog-classification.dto';
import { UpdateProductVariantsDto } from './dto/update-product-variants.dto';

@Injectable()
export class CatalogService {
  constructor(private readonly catalog: CatalogRepository) {}

  async createProduct(
    tenantId: string,
    dto: CreateProductDto,
  ): Promise<ProductResponse> {
    this.assertLotExpirationPolicy(dto, true);
    try {
      return {
        data: await this.catalog.createProduct(tenantId, dto),
        meta: { apiVersion: '1' },
      };
    } catch (error) {
      if (error instanceof ProductIdentifierConflictError) {
        throw new ConflictException({
          code:
            error.field === 'sku'
              ? 'SKU_ALREADY_EXISTS'
              : 'BARCODE_ALREADY_EXISTS',
          field: error.field,
          message:
            error.field === 'sku'
              ? 'Ya existe un producto con ese SKU en la empresa.'
              : 'Ya existe un producto con ese código de barras en la empresa.',
        });
      }
      throw error;
    }
  }

  async getOptions(tenantId: string): Promise<CatalogOptionsResponse> {
    return {
      data: await this.catalog.getOptions(tenantId),
      meta: { apiVersion: '1' },
    };
  }

  async updateProduct(
    tenantId: string,
    id: string,
    dto: UpdateProductDto,
  ): Promise<ProductResponse> {
    this.assertLotExpirationPolicy(dto);
    try {
      const product = await this.catalog.updateProduct(tenantId, id, dto);
      if (!product) throw new NotFoundException();
      return { data: product, meta: { apiVersion: '1' } };
    } catch (error) {
      if (error instanceof ProductIdentifierConflictError) {
        this.throwIdentifierConflict(error);
      }
      if (error instanceof ProductVersionConflictError) {
        throw new ConflictException({
          code: 'PRODUCT_VERSION_CONFLICT',
          currentVersion: error.currentVersion,
          message:
            'El producto cambió desde que lo abriste. Recarga antes de guardar.',
        });
      }
      if (error instanceof ProductLotTrackingLockedError) {
        throw new ConflictException({
          code: 'PRODUCT_LOT_TRACKING_LOCKED',
          message:
            'El control por lotes no puede cambiar después del primer movimiento de inventario.',
        });
      }
      throw error;
    }
  }

  async listProducts(
    tenantId: string,
    query: ListProductsDto,
  ): Promise<ProductListResponse> {
    const { products, total } = await this.catalog.listProducts(
      tenantId,
      query,
    );
    return {
      data: products,
      meta: {
        apiVersion: '1',
        pagination: {
          page: query.page,
          pageSize: query.pageSize,
          total,
          totalPages: Math.ceil(total / query.pageSize),
        },
      },
    };
  }

  async getProduct(tenantId: string, id: string): Promise<ProductResponse> {
    const product = await this.catalog.getProduct(tenantId, id);
    if (!product) throw new NotFoundException();
    return { data: product, meta: { apiVersion: '1' } };
  }

  async updateProductVariants(
    tenantId: string,
    id: string,
    dto: UpdateProductVariantsDto,
  ): Promise<ProductResponse> {
    try {
      const product = await this.catalog.updateProductVariants(
        tenantId,
        id,
        dto,
      );
      if (!product) throw new NotFoundException();
      return { data: product, meta: { apiVersion: '1' } };
    } catch (error) {
      if (error instanceof ProductIdentifierConflictError) {
        this.throwIdentifierConflict(error);
      }
      if (error instanceof ProductVersionConflictError) {
        throw new ConflictException({
          code: 'PRODUCT_VERSION_CONFLICT',
          currentVersion: error.currentVersion,
          message:
            'El producto o una variante cambió. Recarga antes de guardar.',
        });
      }
      if (error instanceof ProductVariantsRequireZeroStockError) {
        throw new ConflictException({
          code: 'PRODUCT_VARIANTS_REQUIRE_ZERO_STOCK',
          message:
            'El producto padre debe quedar sin existencias antes de habilitar variantes.',
        });
      }
      if (error instanceof ProductVariantConfigurationError) {
        throw new BadRequestException({
          code: 'PRODUCT_VARIANT_CONFIGURATION_INVALID',
          message: error.reason,
        });
      }
      throw error;
    }
  }

  async resolveCode(tenantId: string, code: string): Promise<ProductResponse> {
    try {
      const product = await this.catalog.resolveCode(tenantId, code);
      if (!product) {
        throw new NotFoundException({
          code: 'PRODUCT_CODE_NOT_FOUND',
          message: 'No existe un producto con ese SKU, código de barras o QR.',
        });
      }
      return { data: product, meta: { apiVersion: '1' } };
    } catch (error) {
      if (error instanceof ProductCodeAmbiguousError) {
        throw new ConflictException({
          code: 'PRODUCT_CODE_AMBIGUOUS',
          message:
            'El código coincide con más de un producto. Corrige los identificadores.',
        });
      }
      throw error;
    }
  }

  async retireProduct(
    tenantId: string,
    id: string,
  ): Promise<ProductRetirementResponse> {
    const retirement = await this.catalog.retireProduct(tenantId, id);
    if (!retirement) throw new NotFoundException();
    return { data: retirement, meta: { apiVersion: '1' } };
  }

  listClassifications(
    tenantId: string,
    kind: CatalogClassificationKind,
    includeInactive: boolean,
  ) {
    return this.catalog.listClassifications(tenantId, kind, includeInactive);
  }

  async createClassification(
    tenantId: string,
    kind: CatalogClassificationKind,
    name: string,
  ) {
    this.assertClassificationName(kind, name);
    try {
      return await this.catalog.createClassification(tenantId, kind, name);
    } catch (error) {
      this.mapClassificationError(error);
    }
  }

  async updateClassification(
    tenantId: string,
    kind: CatalogClassificationKind,
    id: string,
    dto: UpdateCatalogClassificationDto,
  ) {
    if (dto.name) this.assertClassificationName(kind, dto.name);
    try {
      const result = await this.catalog.updateClassification(
        tenantId,
        kind,
        id,
        dto,
      );
      if (!result) throw new NotFoundException();
      return result;
    } catch (error) {
      this.mapClassificationError(error);
    }
  }

  async deactivateClassification(
    tenantId: string,
    kind: CatalogClassificationKind,
    id: string,
    replacementId?: string,
  ) {
    try {
      const result = await this.catalog.deactivateClassification(
        tenantId,
        kind,
        id,
        replacementId,
      );
      if (!result) throw new NotFoundException();
      return result;
    } catch (error) {
      this.mapClassificationError(error);
    }
  }

  private throwIdentifierConflict(
    error: ProductIdentifierConflictError,
  ): never {
    throw new ConflictException({
      code:
        error.field === 'sku' ? 'SKU_ALREADY_EXISTS' : 'BARCODE_ALREADY_EXISTS',
      field: error.field,
      message:
        error.field === 'sku'
          ? 'Ya existe un producto con ese SKU en la empresa.'
          : 'Ya existe un producto con ese código de barras en la empresa.',
    });
  }

  private assertClassificationName(
    kind: CatalogClassificationKind,
    name: string,
  ): void {
    if (kind === CatalogClassificationKind.CATEGORIES && name.length > 80) {
      throw new BadRequestException({
        code: 'CATEGORY_NAME_TOO_LONG',
        message: 'La categoría admite hasta 80 caracteres.',
      });
    }
  }

  private assertLotExpirationPolicy(
    dto: CreateProductDto,
    creating = false,
  ): void {
    const policy = dto.lotExpirationPolicy ?? 'NONE';
    if (
      policy !== 'NONE' &&
      (dto.trackLots === false || (creating && dto.trackLots !== true))
    ) {
      throw new BadRequestException({
        code: 'LOT_EXPIRATION_REQUIRES_TRACKING',
        message: 'La política de caducidad requiere control por lotes.',
      });
    }
    const days = dto.lotExpirationAlertDays ?? 30;
    if (days < 1 || days > 365) {
      throw new BadRequestException({
        code: 'INVALID_LOT_EXPIRATION_ALERT_DAYS',
        message: 'El horizonte de alertas debe estar entre 1 y 365 días.',
      });
    }
    if (dto.allowExpiredStockOverride && policy === 'NONE') {
      throw new BadRequestException({
        code: 'LOT_EXPIRATION_OVERRIDE_REQUIRES_POLICY',
        message: 'La excepción de caducidad requiere una política de lotes.',
      });
    }
  }

  private mapClassificationError(error: unknown): never {
    if (error instanceof CatalogClassificationConflictError) {
      throw new ConflictException({
        code: 'CATALOG_CLASSIFICATION_CONFLICT',
        message:
          'Ya existe ese nombre o la reasignación seleccionada no es válida.',
      });
    }
    throw error;
  }
}
