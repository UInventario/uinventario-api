import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { CustomerRepository } from './customer.repository';
import { ListCustomersDto } from './dto/list-customers.dto';
import { ListCustomerHistoryDto } from './dto/list-customer-history.dto';
import { SaveCustomerDto, UpdateCustomerDto } from './dto/save-customer.dto';
import { ConfigureCustomerCreditDto } from './dto/configure-customer-credit.dto';

@Injectable()
export class CustomerService {
  constructor(private readonly customers: CustomerRepository) {}

  async create(tenantId: string, dto: SaveCustomerDto) {
    this.consent(dto);
    try {
      return {
        data: await this.customers.create(tenantId, dto),
        meta: { apiVersion: '1' as const },
      };
    } catch (error) {
      if (this.customers.isDuplicate(error)) throw this.duplicate();
      throw error;
    }
  }

  async update(tenantId: string, id: string, dto: UpdateCustomerDto) {
    this.consent(dto);
    try {
      const result = await this.customers.update(tenantId, id, dto);
      if (!result) throw new NotFoundException();
      if (result === 'CONFLICT')
        throw new ConflictException({
          code: 'CUSTOMER_VERSION_CONFLICT',
          message: 'El cliente cambió; recarga antes de guardar.',
        });
      return { data: result, meta: { apiVersion: '1' as const } };
    } catch (error) {
      if (this.customers.isDuplicate(error)) throw this.duplicate();
      throw error;
    }
  }

  async list(tenantId: string, query: ListCustomersDto) {
    const result = await this.customers.list(tenantId, query);
    return {
      data: result.items,
      meta: {
        apiVersion: '1' as const,
        pagination: {
          page: query.page,
          pageSize: query.pageSize,
          total: result.total,
          totalPages: Math.ceil(result.total / query.pageSize),
        },
      },
    };
  }

  async get(tenantId: string, id: string) {
    const customer = await this.customers.findById(tenantId, id);
    if (!customer) throw new NotFoundException();
    return { data: customer, meta: { apiVersion: '1' as const } };
  }

  async creditStatement(tenantId: string, id: string) {
    const customer = await this.customers.findById(tenantId, id);
    if (!customer) throw new NotFoundException();
    return {
      data: await this.customers.creditStatement(tenantId, id),
      meta: { apiVersion: '1' as const },
    };
  }

  async history(
    tenantId: string,
    branchId: string,
    id: string,
    query: ListCustomerHistoryDto,
  ) {
    if (query.dateFrom && query.dateTo && query.dateFrom > query.dateTo) {
      throw new BadRequestException({
        code: 'INVALID_CUSTOMER_HISTORY_DATE_RANGE',
        message: 'La fecha inicial no puede ser posterior a la final.',
      });
    }
    const customer = await this.customers.findById(tenantId, id);
    if (!customer) throw new NotFoundException();
    const result = await this.customers.history(
      tenantId,
      branchId,
      customer,
      query,
    );
    return {
      data: result.history,
      meta: {
        apiVersion: '1' as const,
        scope: { branchId },
        pagination: {
          page: query.page,
          pageSize: query.pageSize,
          total: result.total,
          totalPages: Math.ceil(result.total / query.pageSize),
        },
      },
    };
  }

  async deactivate(tenantId: string, id: string) {
    const customer = await this.customers.deactivate(tenantId, id);
    if (!customer) throw new NotFoundException();
    return { data: customer, meta: { apiVersion: '1' as const } };
  }

  async configureCredit(
    tenantId: string,
    customerId: string,
    userId: string,
    dto: ConfigureCustomerCreditDto,
  ) {
    const result = await this.customers.configureCredit(
      tenantId,
      customerId,
      userId,
      dto,
    );
    if (!result) throw new NotFoundException();
    if (result === 'CONFLICT')
      throw new ConflictException({
        code: 'CUSTOMER_VERSION_CONFLICT',
        message: 'El cliente cambiÃ³; recarga antes de guardar.',
      });
    return { data: result, meta: { apiVersion: '1' as const } };
  }

  private consent(dto: SaveCustomerDto): void {
    if ((dto.email || dto.phone) && !dto.dataProcessingConsent)
      throw new BadRequestException({
        code: 'CUSTOMER_CONSENT_REQUIRED',
        message: 'El consentimiento es obligatorio para guardar contacto.',
      });
  }

  private duplicate() {
    return new ConflictException({
      code: 'CUSTOMER_DUPLICATE',
      message: 'Ya existe un cliente con ese identificador o contacto.',
    });
  }
}
