import { Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { DataSource, QueryFailedError } from 'typeorm';
import { ListCustomersDto } from './dto/list-customers.dto';
import { SaveCustomerDto, UpdateCustomerDto } from './dto/save-customer.dto';
import { CustomerData } from './customer.types';

interface CustomerRow {
  id: string;
  name: string;
  identifier: string | null;
  email: string | null;
  phone: string | null;
  data_processing_consent: number | boolean;
  active: number | boolean;
  version: number | string;
  created_at: Date | string;
  updated_at: Date | string;
}

@Injectable()
export class CustomerRepository {
  constructor(private readonly dataSource: DataSource) {}

  async create(tenantId: string, dto: SaveCustomerDto): Promise<CustomerData> {
    const id = randomUUID();
    await this.dataSource.query(
      `INSERT INTO customers
        (id, tenant_id, name, normalized_name, identifier, normalized_identifier,
         email, normalized_email, phone, normalized_phone,
         data_processing_consent, active)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      this.values(id, tenantId, dto),
    );
    return (await this.findById(tenantId, id))!;
  }

  async update(
    tenantId: string,
    id: string,
    dto: UpdateCustomerDto,
  ): Promise<CustomerData | 'CONFLICT' | null> {
    const result = await this.dataSource.query<{ affectedRows?: number }>(
      `UPDATE customers SET name = ?, normalized_name = ?, identifier = ?,
         normalized_identifier = ?, email = ?, normalized_email = ?, phone = ?,
         normalized_phone = ?, data_processing_consent = ?, active = ?, version = version + 1
       WHERE id = ? AND tenant_id = ? AND version = ?`,
      [
        dto.name,
        this.normalize(dto.name),
        dto.identifier ?? null,
        dto.identifier ? this.normalize(dto.identifier) : null,
        dto.email ?? null,
        dto.email ?? null,
        dto.phone ?? null,
        dto.phone ? this.phone(dto.phone) : null,
        dto.dataProcessingConsent,
        dto.active ?? true,
        id,
        tenantId,
        dto.version,
      ],
    );
    if (Number(result.affectedRows ?? 0) > 0)
      return this.findById(tenantId, id);
    return (await this.findById(tenantId, id)) ? 'CONFLICT' : null;
  }

  async deactivate(tenantId: string, id: string): Promise<CustomerData | null> {
    const result = await this.dataSource.query<{ affectedRows?: number }>(
      `UPDATE customers SET active = FALSE, version = version + 1
       WHERE id = ? AND tenant_id = ? AND active = TRUE`,
      [id, tenantId],
    );
    if (Number(result.affectedRows ?? 0) === 0)
      return this.findById(tenantId, id);
    return this.findById(tenantId, id);
  }

  async findById(tenantId: string, id: string): Promise<CustomerData | null> {
    const [row] = await this.dataSource.query<CustomerRow[]>(
      `${this.select()} WHERE id = ? AND tenant_id = ? LIMIT 1`,
      [id, tenantId],
    );
    return row ? this.data(row) : null;
  }

  async findActive(tenantId: string, id: string): Promise<CustomerData | null> {
    const customer = await this.findById(tenantId, id);
    return customer?.active ? customer : null;
  }

  async list(tenantId: string, query: ListCustomersDto) {
    const filters = ['tenant_id = ?'];
    const parameters: Array<string | number> = [tenantId];
    if (query.status !== 'ALL')
      filters.push(`active = ${query.status === 'ACTIVE' ? 'TRUE' : 'FALSE'}`);
    if (query.q) {
      const search = `%${this.normalize(query.q)}%`;
      const normalizedPhone = this.phone(query.q);
      const phoneSearch = normalizedPhone
        ? `%${normalizedPhone}%`
        : '__no_phone_match__';
      filters.push(
        `(normalized_name LIKE ? OR normalized_identifier LIKE ? OR normalized_email LIKE ? OR normalized_phone LIKE ?)`,
      );
      parameters.push(search, search, search, phoneSearch);
    }
    const where = filters.join(' AND ');
    const [[count], rows] = await Promise.all([
      this.dataSource.query<Array<{ total: number | string }>>(
        `SELECT COUNT(*) AS total FROM customers WHERE ${where}`,
        parameters,
      ),
      this.dataSource.query<CustomerRow[]>(
        `${this.select()} WHERE ${where} ORDER BY normalized_name, id LIMIT ? OFFSET ?`,
        [...parameters, query.pageSize, (query.page - 1) * query.pageSize],
      ),
    ]);
    return {
      items: rows.map((row) => this.data(row)),
      total: Number(count.total),
    };
  }

  isDuplicate(error: unknown): boolean {
    return (
      error instanceof QueryFailedError &&
      (error.driverError as { errno?: number }).errno === 1062
    );
  }

  private values(id: string, tenantId: string, dto: SaveCustomerDto) {
    return [
      id,
      tenantId,
      dto.name,
      this.normalize(dto.name),
      dto.identifier ?? null,
      dto.identifier ? this.normalize(dto.identifier) : null,
      dto.email ?? null,
      dto.email ?? null,
      dto.phone ?? null,
      dto.phone ? this.phone(dto.phone) : null,
      dto.dataProcessingConsent,
      dto.active ?? true,
    ];
  }

  private select() {
    return `SELECT id, name, identifier, email, phone, data_processing_consent,
                   active, version, created_at, updated_at FROM customers`;
  }

  private data(row: CustomerRow): CustomerData {
    return {
      id: row.id,
      name: row.name,
      identifier: row.identifier,
      email: row.email,
      phone: row.phone,
      dataProcessingConsent: Boolean(row.data_processing_consent),
      active: Boolean(row.active),
      version: Number(row.version),
      createdAt: new Date(row.created_at).toISOString(),
      updatedAt: new Date(row.updated_at).toISOString(),
    };
  }

  private normalize(value: string): string {
    return value.normalize('NFKC').trim().toLocaleLowerCase('es-MX');
  }

  private phone(value: string): string {
    return `${value.startsWith('+') ? '+' : ''}${value.replace(/\D/g, '')}`;
  }
}
