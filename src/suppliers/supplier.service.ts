import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { CreateSupplierDto } from './dto/create-supplier.dto';
import { ListSuppliersDto } from './dto/list-suppliers.dto';
import { UpdateSupplierDto } from './dto/update-supplier.dto';
import {
  SupplierIdentifierConflictError,
  SupplierVersionConflictError,
} from './supplier.errors';
import { SupplierRepository } from './supplier.repository';
import { SupplierListResponse, SupplierResponse } from './supplier.types';

interface IdentifierPolicy {
  type: string;
  normalize(value: string): string;
  valid(value: string): boolean;
  example: string;
}

const compact = (value: string) =>
  value
    .normalize('NFKC')
    .toUpperCase()
    .replace(/[.\-\s]/g, '');

const POLICIES: Record<string, IdentifierPolicy> = {
  MX: {
    type: 'RFC',
    normalize: compact,
    valid: (value) => /^[A-ZÑ&]{3,4}\d{6}[A-Z0-9]{3}$/.test(value),
    example: 'ABC010203AB1',
  },
  CL: {
    type: 'RUT',
    normalize: compact,
    valid: (value) => /^\d{7,8}[0-9K]$/.test(value),
    example: '123456785',
  },
  DEFAULT: {
    type: 'TAX_ID',
    normalize: compact,
    valid: (value) => /^[A-Z0-9]{5,32}$/.test(value),
    example: 'TAX12345',
  },
};

@Injectable()
export class SupplierService {
  constructor(private readonly suppliers: SupplierRepository) {}

  async create(
    tenantId: string,
    dto: CreateSupplierDto,
  ): Promise<SupplierResponse> {
    this.validateContacts(dto);
    const identity = await this.identity(tenantId, dto.taxIdentifier);
    try {
      return {
        data: await this.suppliers.create(
          tenantId,
          identity.countryCode,
          identity.type,
          identity.normalized,
          dto,
        ),
        meta: { apiVersion: '1' },
      };
    } catch (error) {
      this.rethrow(error);
    }
  }

  async update(
    tenantId: string,
    id: string,
    dto: UpdateSupplierDto,
  ): Promise<SupplierResponse> {
    this.validateContacts(dto);
    const identity = await this.identity(tenantId, dto.taxIdentifier);
    try {
      const supplier = await this.suppliers.update(
        tenantId,
        id,
        identity.countryCode,
        identity.type,
        identity.normalized,
        dto,
      );
      if (!supplier) throw new NotFoundException();
      return { data: supplier, meta: { apiVersion: '1' } };
    } catch (error) {
      this.rethrow(error);
    }
  }

  async list(
    tenantId: string,
    query: ListSuppliersDto,
  ): Promise<SupplierListResponse> {
    const { suppliers, total } = await this.suppliers.list(tenantId, query);
    return {
      data: suppliers,
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

  async get(tenantId: string, id: string): Promise<SupplierResponse> {
    const supplier = await this.suppliers.findById(tenantId, id);
    if (!supplier) throw new NotFoundException();
    return { data: supplier, meta: { apiVersion: '1' } };
  }

  async deactivate(tenantId: string, id: string): Promise<SupplierResponse> {
    const supplier = await this.suppliers.deactivate(tenantId, id);
    if (!supplier) throw new NotFoundException();
    return { data: supplier, meta: { apiVersion: '1' } };
  }

  private validateContacts(dto: CreateSupplierDto): void {
    if (dto.contacts.filter((contact) => contact.primary).length > 1) {
      throw new BadRequestException({
        code: 'MULTIPLE_PRIMARY_SUPPLIER_CONTACTS',
        message: 'Sólo un contacto puede ser principal.',
      });
    }
  }

  private async identity(tenantId: string, value: string) {
    const countryCode = await this.suppliers.tenantCountry(tenantId);
    if (!countryCode) {
      throw new BadRequestException({
        code: 'TENANT_COUNTRY_REQUIRED',
        message:
          'Configura el país de la empresa antes de registrar proveedores.',
      });
    }
    const policy = POLICIES[countryCode] ?? POLICIES.DEFAULT;
    const normalized = policy.normalize(value);
    if (!policy.valid(normalized)) {
      throw new BadRequestException({
        code: 'INVALID_SUPPLIER_TAX_IDENTIFIER',
        field: 'taxIdentifier',
        identifierType: policy.type,
        example: policy.example,
        message: `La identificación ${policy.type} no tiene un formato válido para ${countryCode}.`,
      });
    }
    return { countryCode, type: policy.type, normalized };
  }

  private rethrow(error: unknown): never {
    if (error instanceof SupplierIdentifierConflictError) {
      throw new ConflictException({
        code: 'SUPPLIER_IDENTIFIER_ALREADY_EXISTS',
        field: 'taxIdentifier',
        message: 'Ya existe un proveedor con esa identificación en la empresa.',
      });
    }
    if (error instanceof SupplierVersionConflictError) {
      throw new ConflictException({
        code: 'SUPPLIER_VERSION_CONFLICT',
        currentVersion: error.currentVersion,
        message:
          'El proveedor cambió desde que lo abriste. Recarga antes de guardar.',
      });
    }
    throw error;
  }
}
