import { Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { DataSource, QueryFailedError } from 'typeorm';
import { ListCustomersDto } from './dto/list-customers.dto';
import { ListCustomerHistoryDto } from './dto/list-customer-history.dto';
import { SaveCustomerDto, UpdateCustomerDto } from './dto/save-customer.dto';
import { ConfigureCustomerCreditDto } from './dto/configure-customer-credit.dto';
import { CustomerData, CustomerHistoryData } from './customer.types';

interface CustomerRow {
  id: string;
  name: string;
  identifier: string | null;
  email: string | null;
  phone: string | null;
  data_processing_consent: number | boolean;
  privacy_status: 'ACTIVE' | 'ANONYMIZED';
  anonymized_at: Date | string | null;
  privacy_retention_until: Date | string | null;
  active: number | boolean;
  version: number | string;
  created_at: Date | string;
  updated_at: Date | string;
  credit_enabled: number | boolean | null;
  credit_limit: string | null;
  credit_currency: string | null;
  credit_term_days: number | string | null;
  credit_max_installments: number | string | null;
  credit_balance: string;
  credit_overdue_amount: string;
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

  async configureCredit(
    tenantId: string,
    customerId: string,
    userId: string,
    dto: ConfigureCustomerCreditDto,
  ): Promise<CustomerData | 'CONFLICT' | null> {
    return this.dataSource.transaction('READ COMMITTED', async (manager) => {
      const [customer] = await manager.query<
        Array<{ version: number | string }>
      >(
        `SELECT version FROM customers
         WHERE id = ? AND tenant_id = ? LIMIT 1 FOR UPDATE`,
        [customerId, tenantId],
      );
      if (!customer) return null;
      if (Number(customer.version) !== dto.version) return 'CONFLICT';
      await manager.query(
        `INSERT INTO customer_credit_profiles
          (customer_id, tenant_id, enabled, credit_limit, currency, term_days,
           max_installments, configured_by_user_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE enabled = VALUES(enabled),
           credit_limit = VALUES(credit_limit), currency = VALUES(currency),
           term_days = VALUES(term_days),
           max_installments = VALUES(max_installments),
           configured_by_user_id = VALUES(configured_by_user_id)`,
        [
          customerId,
          tenantId,
          dto.enabled,
          dto.creditLimit,
          dto.currency,
          dto.termDays,
          dto.maxInstallments,
          userId,
        ],
      );
      await manager.query(
        `UPDATE customers SET version = version + 1
         WHERE id = ? AND tenant_id = ?`,
        [customerId, tenantId],
      );
      const [row] = await manager.query<CustomerRow[]>(
        `${this.select()} WHERE id = ? AND tenant_id = ? LIMIT 1`,
        [customerId, tenantId],
      );
      return this.data(row);
    });
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
    return customer?.active && customer.privacyStatus === 'ACTIVE'
      ? customer
      : null;
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
                   privacy_status, anonymized_at, privacy_retention_until,
                   active, version, created_at, updated_at,
                   (SELECT enabled FROM customer_credit_profiles ccp
                    WHERE ccp.customer_id = customers.id
                      AND ccp.tenant_id = customers.tenant_id) AS credit_enabled,
                   (SELECT credit_limit FROM customer_credit_profiles ccp
                    WHERE ccp.customer_id = customers.id
                      AND ccp.tenant_id = customers.tenant_id) AS credit_limit,
                   (SELECT currency FROM customer_credit_profiles ccp
                    WHERE ccp.customer_id = customers.id
                      AND ccp.tenant_id = customers.tenant_id) AS credit_currency,
                   (SELECT term_days FROM customer_credit_profiles ccp
                    WHERE ccp.customer_id = customers.id
                      AND ccp.tenant_id = customers.tenant_id) AS credit_term_days,
                   (SELECT max_installments FROM customer_credit_profiles ccp
                    WHERE ccp.customer_id = customers.id
                      AND ccp.tenant_id = customers.tenant_id) AS credit_max_installments,
                   COALESCE((SELECT SUM(CASE WHEN entry_type = 'DEBIT' THEN amount ELSE -amount END)
                    FROM customer_debt_ledger cdl WHERE cdl.customer_id = customers.id
                      AND cdl.tenant_id = customers.tenant_id), 0) AS credit_balance,
                   COALESCE((SELECT SUM(GREATEST(
                     COALESCE((SELECT SUM(cci.amount)
                       FROM customer_credit_installments cci
                       WHERE cci.account_id = cca.id AND cci.tenant_id = cca.tenant_id
                         AND cci.due_date < CURRENT_DATE()), 0)
                     - GREATEST(cca.original_amount - COALESCE((
                       SELECT SUM(CASE WHEN entry_type = 'DEBIT' THEN amount ELSE -amount END)
                       FROM customer_debt_ledger cdl
                       WHERE cdl.account_id = cca.id AND cdl.tenant_id = cca.tenant_id
                     ), 0), 0), 0)) FROM customer_credit_accounts cca
                    WHERE cca.customer_id = customers.id
                      AND cca.tenant_id = customers.tenant_id
                      AND cca.canceled_at IS NULL), 0)
                    AS credit_overdue_amount
            FROM customers`;
  }

  private data(row: CustomerRow): CustomerData {
    const balance = this.toMoneyCents(row.credit_balance ?? '0');
    const limit = this.toMoneyCents(row.credit_limit ?? '0');
    const overdue = this.toMoneyCents(row.credit_overdue_amount ?? '0');
    const available = limit > balance ? limit - balance : 0n;
    const enabled = Boolean(row.credit_enabled);
    return {
      id: row.id,
      name: row.name,
      identifier: row.identifier,
      email: row.email,
      phone: row.phone,
      dataProcessingConsent: Boolean(row.data_processing_consent),
      privacyStatus: row.privacy_status,
      anonymizedAt: row.anonymized_at
        ? new Date(row.anonymized_at).toISOString()
        : null,
      privacyRetentionUntil: row.privacy_retention_until
        ? new Date(row.privacy_retention_until).toISOString()
        : null,
      active: Boolean(row.active),
      version: Number(row.version),
      createdAt: new Date(row.created_at).toISOString(),
      updatedAt: new Date(row.updated_at).toISOString(),
      credit:
        row.credit_limit === null || row.credit_currency === null
          ? null
          : {
              enabled,
              limit: this.money(row.credit_limit),
              currency: row.credit_currency,
              termDays: Number(row.credit_term_days),
              maxInstallments: Number(row.credit_max_installments),
              balance: this.fromMoneyCents(balance),
              available: this.fromMoneyCents(available),
              overdueAmount: this.fromMoneyCents(overdue),
              status: !enabled
                ? 'DISABLED'
                : overdue > 0n
                  ? 'OVERDUE'
                  : available === 0n
                    ? 'LIMIT_REACHED'
                    : 'AVAILABLE',
            },
    };
  }

  private toMoneyCents(value: string): bigint {
    const [whole, fraction = ''] = value.split('.');
    return BigInt(whole) * 100n + BigInt(fraction.padEnd(2, '0').slice(0, 2));
  }

  private fromMoneyCents(value: bigint): string {
    return `${value / 100n}.${(value % 100n).toString().padStart(2, '0')}`;
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
