import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { CreateSupplierProductDto } from './dto/create-supplier-product.dto';
import { ListSupplierProductsDto } from './dto/list-supplier-products.dto';
import { UpdateSupplierProductDto } from './dto/update-supplier-product.dto';
import { SupplierProductRepository } from './supplier-product.repository';
import {
  SupplierProductConflictError,
  SupplierProductReferenceError,
  SupplierProductVersionConflictError,
} from './supplier.errors';
import {
  SupplierProductListResponse,
  SupplierProductResponse,
} from './supplier-product.types';

@Injectable()
export class SupplierProductService {
  constructor(private readonly links: SupplierProductRepository) {}

  async create(
    tenantId: string,
    actorUserId: string,
    dto: CreateSupplierProductDto,
  ): Promise<SupplierProductResponse> {
    this.validateDates(dto);
    try {
      return {
        data: await this.links.create(tenantId, actorUserId, dto),
        meta: { apiVersion: '1' },
      };
    } catch (error) {
      this.rethrow(error);
    }
  }

  async update(
    tenantId: string,
    actorUserId: string,
    id: string,
    dto: UpdateSupplierProductDto,
  ): Promise<SupplierProductResponse> {
    this.validateDates(dto);
    try {
      const link = await this.links.update(tenantId, actorUserId, id, dto);
      if (!link) throw new NotFoundException();
      return { data: link, meta: { apiVersion: '1' } };
    } catch (error) {
      this.rethrow(error);
    }
  }

  async list(
    tenantId: string,
    query: ListSupplierProductsDto,
  ): Promise<SupplierProductListResponse> {
    const { links, total } = await this.links.list(tenantId, query);
    return {
      data: links,
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

  async get(tenantId: string, id: string): Promise<SupplierProductResponse> {
    const link = await this.links.findById(tenantId, id);
    if (!link) throw new NotFoundException();
    return { data: link, meta: { apiVersion: '1' } };
  }

  private validateDates(dto: CreateSupplierProductDto): void {
    if (dto.validTo && dto.validTo < dto.validFrom) {
      throw new BadRequestException({
        code: 'INVALID_SUPPLIER_PRICE_VALIDITY',
        message: 'La vigencia final no puede ser anterior a la inicial.',
      });
    }
  }

  private rethrow(error: unknown): never {
    if (error instanceof SupplierProductReferenceError) {
      throw new BadRequestException({
        code: `INVALID_${error.reference}`,
        field: error.reference === 'SUPPLIER' ? 'supplierId' : 'productId',
        message:
          error.reference === 'SUPPLIER'
            ? 'El proveedor no existe, está inactivo o pertenece a otra empresa.'
            : 'El producto no existe, está inactivo o pertenece a otra empresa.',
      });
    }
    if (error instanceof SupplierProductVersionConflictError) {
      throw new ConflictException({
        code: 'SUPPLIER_PRODUCT_VERSION_CONFLICT',
        currentVersion: error.currentVersion,
        message:
          'La relación cambió desde que la abriste. Recarga antes de guardar.',
      });
    }
    if (error instanceof SupplierProductConflictError) {
      const response = {
        RELATION: {
          code: 'SUPPLIER_PRODUCT_ALREADY_EXISTS',
          message: 'Ese producto ya está relacionado con el proveedor.',
        },
        SUPPLIER_CODE: {
          code: 'SUPPLIER_CODE_ALREADY_EXISTS',
          message: 'Ese código ya identifica otro producto para el proveedor.',
        },
        PRICE_DATE: {
          code: 'SUPPLIER_PRICE_DATE_CONFLICT',
          message: 'La nueva vigencia debe comenzar después del último precio.',
        },
      }[error.code];
      throw new ConflictException(response);
    }
    throw error;
  }
}
