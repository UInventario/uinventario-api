import {
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { CatalogRepository } from './catalog.repository';
import { ProductIdentifierConflictError } from './catalog.errors';
import {
  CatalogOptionsResponse,
  ProductListResponse,
  ProductResponse,
} from './catalog.types';
import { CreateProductDto } from './dto/create-product.dto';
import { ListProductsDto } from './dto/list-products.dto';

@Injectable()
export class CatalogService {
  constructor(private readonly catalog: CatalogRepository) {}

  async createProduct(
    tenantId: string,
    dto: CreateProductDto,
  ): Promise<ProductResponse> {
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
}
