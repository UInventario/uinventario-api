import { Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { DataSource, QueryFailedError } from 'typeorm';
import { ListCustomersDto } from './dto/list-customers.dto';
import { ListCustomerHistoryDto } from './dto/list-customer-history.dto';
import { SaveCustomerDto, UpdateCustomerDto } from './dto/save-customer.dto';
import { CustomerData, CustomerHistoryData } from './customer.types';

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

  async history(
    tenantId: string,
    branchId: string,
    customer: CustomerData,
    query: ListCustomerHistoryDto,
  ): Promise<{ history: CustomerHistoryData; total: number }> {
    const filters = ['s.tenant_id = ?', 's.branch_id = ?', 's.customer_id = ?'];
    const parameters: unknown[] = [tenantId, branchId, customer.id];
    if (query.dateFrom) {
      filters.push('s.created_at >= ?');
      parameters.push(`${query.dateFrom} 00:00:00`);
    }
    if (query.dateTo) {
      filters.push('s.created_at < DATE_ADD(?, INTERVAL 1 DAY)');
      parameters.push(`${query.dateTo} 00:00:00`);
    }
    if (query.status !== 'ALL') {
      filters.push('s.status = ?');
      parameters.push(query.status);
    }
    const where = filters.join(' AND ');
    const [rows, [summary]] = await Promise.all([
      this.dataSource.query<
        Array<{
          id: string;
          receipt_number: string;
          status: 'COMPLETED' | 'VOIDED';
          currency: string;
          total: string;
          created_at: Date | string;
          cash_register_id: string;
          cash_register_name: string;
          cash_register_code: string;
          user_id: string;
          user_email: string;
          void_reason: string | null;
          voided_at: Date | string | null;
        }>
      >(
        `SELECT s.id, s.receipt_number, s.status, s.currency, s.total, s.created_at,
                s.void_reason, s.voided_at,
                cr.id AS cash_register_id, cr.name AS cash_register_name,
                cr.code AS cash_register_code,
                u.id AS user_id, u.email AS user_email
         FROM sales s
         INNER JOIN cash_registers cr ON cr.id = s.cash_register_id AND cr.tenant_id = s.tenant_id
         INNER JOIN users u ON u.id = s.created_by_user_id AND u.tenant_id = s.tenant_id
         WHERE ${where}
         ORDER BY s.created_at DESC, s.id DESC LIMIT ? OFFSET ?`,
        [...parameters, query.pageSize, (query.page - 1) * query.pageSize],
      ),
      this.dataSource.query<
        Array<{
          total: number | string;
          completed_count: number | string;
          voided_count: number | string;
          completed_amount: string | null;
          voided_amount: string | null;
          currency: string | null;
        }>
      >(
        `SELECT COUNT(*) AS total,
                SUM(s.status = 'COMPLETED') AS completed_count,
                SUM(s.status = 'VOIDED') AS voided_count,
                COALESCE(SUM(CASE WHEN s.status = 'COMPLETED' THEN s.total ELSE 0 END), 0) AS completed_amount,
                COALESCE(SUM(CASE WHEN s.status = 'VOIDED' THEN s.total ELSE 0 END), 0) AS voided_amount,
                MAX(s.currency) AS currency
         FROM sales s WHERE ${where}`,
        parameters,
      ),
    ]);
    const paymentRows = rows.length
      ? await this.dataSource.query<
          Array<{
            sale_id: string;
            method: string;
            status: 'COMPLETED' | 'REVERSED';
            amount_applied: string;
            amount_received: string;
            change_amount: string;
          }>
        >(
          `SELECT sale_id, method, status, amount_applied, amount_received, change_amount
           FROM sale_payments
           WHERE tenant_id = ? AND sale_id IN (${rows.map(() => '?').join(',')})
           ORDER BY sale_id, id`,
          [tenantId, ...rows.map(({ id }) => id)],
        )
      : [];
    const total = Number(summary?.total ?? 0);
    return {
      total,
      history: {
        customer,
        summary: {
          currency: summary?.currency ?? null,
          salesCount: total,
          completedCount: Number(summary?.completed_count ?? 0),
          voidedCount: Number(summary?.voided_count ?? 0),
          completedAmount: this.money(summary?.completed_amount ?? '0'),
          voidedAmount: this.money(summary?.voided_amount ?? '0'),
        },
        items: rows.map((row) => ({
          id: row.id,
          receiptNumber: row.receipt_number,
          status: row.status,
          currency: row.currency,
          total: this.money(row.total),
          createdAt: new Date(row.created_at).toISOString(),
          cashRegister: {
            id: row.cash_register_id,
            name: row.cash_register_name,
            code: row.cash_register_code,
          },
          responsible: { id: row.user_id, email: row.user_email },
          payments: paymentRows
            .filter(({ sale_id }) => sale_id === row.id)
            .map((payment) => ({
              method: payment.method,
              status: payment.status,
              amountApplied: this.money(payment.amount_applied),
              amountReceived: this.money(payment.amount_received),
              change: this.money(payment.change_amount),
            })),
          reversal:
            row.status === 'VOIDED' && row.void_reason && row.voided_at
              ? {
                  reason: row.void_reason,
                  voidedAt: new Date(row.voided_at).toISOString(),
                }
              : null,
        })),
      },
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

  private money(value: string): string {
    const [whole, fraction = ''] = value.split('.');
    return `${whole}.${fraction.padEnd(2, '0').slice(0, 2)}`;
  }
}
