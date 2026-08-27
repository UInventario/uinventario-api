import { ConflictException, Injectable } from '@nestjs/common';
import { CatalogRepository } from './catalog.repository';
import { ProductIdentifierConflictError } from './catalog.errors';
import { CatalogOptionsResponse, ProductResponse } from './catalog.types';
import { CreateProductDto } from './dto/create-product.dto';

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
}
