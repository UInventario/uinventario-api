import { Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { DataSource, QueryFailedError } from 'typeorm';
import { ListCustomersDto } from './dto/list-customers.dto';
import { ListCustomerHistoryDto } from './dto/list-customer-history.dto';
import { SaveCustomerDto, UpdateCustomerDto } from './dto/save-customer.dto';
import { ConfigureCustomerCreditDto } from './dto/configure-customer-credit.dto';
import {
  CustomerCreditStatementData,
  CustomerData,
  CustomerHistoryData,
} from './customer.types';

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

interface CreditAccountRow {
  id: string;
  sale_id: string;
  receipt_number: string;
  original_amount: string;
  due_date: Date | string;
  canceled_at: Date | string | null;
  balance: string;
}

interface CreditInstallmentRow {
  id: string;
  account_id: string;
  installment_number: number | string;
  due_date: Date | string;
  amount: string;
  paid_amount: string;
}

interface CreditPaymentRow {
  id: string;
  receipt_number: string;
  currency: string;
  amount: string;
  method: 'CASH' | 'CARD' | 'TRANSFER';
  status: 'COMPLETED' | 'REVERSED';
  external_reference: string | null;
  provider: string;
  provider_reference: string | null;
  created_by_user_id: string;
  created_by_email: string;
  branch_id: string;
  branch_name: string;
  cash_register_id: string;
  cash_register_name: string;
  cash_register_code: string;
  reversal_reason: string | null;
  reversal_provider_reference: string | null;
  reversed_by_user_id: string | null;
  reversed_by_email: string | null;
  reversed_at: Date | string | null;
  created_at: Date | string;
}

interface CreditPaymentAllocationRow {
  payment_id: string;
  account_id: string;
  installment_id: string;
  installment_number: number | string;
  amount: string;
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
    const credit = await this.creditStatement(tenantId, customer.id);
    return {
      total,
      history: {
        customer,
        credit,
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

  async creditStatement(
    tenantId: string,
    customerId: string,
  ): Promise<CustomerCreditStatementData | null> {
    const customer = await this.findById(tenantId, customerId);
    if (!customer?.credit) return null;
    const [accounts, installments, payments, allocations] = await Promise.all([
      this.dataSource.query<CreditAccountRow[]>(
        `SELECT account.id, account.sale_id, sale.receipt_number,
                account.original_amount, account.due_date, account.canceled_at,
                COALESCE(SUM(CASE WHEN ledger.entry_type = 'DEBIT'
                  THEN ledger.amount ELSE -ledger.amount END), 0) AS balance
         FROM customer_credit_accounts account
         INNER JOIN sales sale
           ON sale.id = account.sale_id AND sale.tenant_id = account.tenant_id
         LEFT JOIN customer_debt_ledger ledger
           ON ledger.account_id = account.id AND ledger.tenant_id = account.tenant_id
         WHERE account.tenant_id = ? AND account.customer_id = ?
         GROUP BY account.id, account.sale_id, sale.receipt_number,
                  account.original_amount, account.due_date, account.canceled_at,
                  account.created_at
         ORDER BY account.created_at DESC, account.id DESC`,
        [tenantId, customerId],
      ),
      this.dataSource.query<CreditInstallmentRow[]>(
        `SELECT installment.id, installment.account_id,
                installment.installment_number, installment.due_date,
                installment.amount,
                COALESCE(SUM(CASE WHEN payment.status = 'COMPLETED'
                  THEN allocation.amount ELSE 0 END), 0) AS paid_amount
         FROM customer_credit_installments installment
         INNER JOIN customer_credit_accounts account
           ON account.id = installment.account_id
          AND account.tenant_id = installment.tenant_id
         LEFT JOIN customer_credit_payment_allocations allocation
           ON allocation.installment_id = installment.id
          AND allocation.tenant_id = installment.tenant_id
         LEFT JOIN customer_credit_payments payment
           ON payment.id = allocation.payment_id
          AND payment.tenant_id = allocation.tenant_id
         WHERE installment.tenant_id = ? AND account.customer_id = ?
         GROUP BY installment.id, installment.account_id,
                  installment.installment_number, installment.due_date,
                  installment.amount
         ORDER BY installment.due_date, installment.installment_number`,
        [tenantId, customerId],
      ),
      this.dataSource.query<CreditPaymentRow[]>(
        `SELECT payment.id, payment.receipt_number, payment.currency,
                payment.amount, payment.method, payment.status,
                payment.external_reference, payment.provider,
                payment.provider_reference, payment.created_by_user_id,
                creator.email AS created_by_email,
                branch.id AS branch_id, branch.name AS branch_name,
                cash_register.id AS cash_register_id,
                cash_register.name AS cash_register_name,
                cash_register.code AS cash_register_code,
                payment.reversal_reason, payment.reversal_provider_reference,
                payment.reversed_by_user_id,
                reversal_user.email AS reversed_by_email,
                payment.reversed_at, payment.created_at
         FROM customer_credit_payments payment
         INNER JOIN users creator
           ON creator.id = payment.created_by_user_id
          AND creator.tenant_id = payment.tenant_id
         LEFT JOIN users reversal_user
           ON reversal_user.id = payment.reversed_by_user_id
          AND reversal_user.tenant_id = payment.tenant_id
         INNER JOIN cash_register_shifts shift
           ON shift.id = payment.cash_register_shift_id
          AND shift.tenant_id = payment.tenant_id
         INNER JOIN branches branch
           ON branch.id = shift.branch_id AND branch.tenant_id = shift.tenant_id
         INNER JOIN cash_registers cash_register
           ON cash_register.id = shift.cash_register_id
          AND cash_register.tenant_id = shift.tenant_id
         WHERE payment.tenant_id = ? AND payment.customer_id = ?
         ORDER BY payment.created_at DESC, payment.id DESC`,
        [tenantId, customerId],
      ),
      this.dataSource.query<CreditPaymentAllocationRow[]>(
        `SELECT allocation.payment_id, allocation.account_id,
                allocation.installment_id, installment.installment_number,
                allocation.amount
         FROM customer_credit_payment_allocations allocation
         INNER JOIN customer_credit_installments installment
           ON installment.id = allocation.installment_id
          AND installment.tenant_id = allocation.tenant_id
         INNER JOIN customer_credit_payments payment
           ON payment.id = allocation.payment_id
          AND payment.tenant_id = allocation.tenant_id
         WHERE allocation.tenant_id = ? AND payment.customer_id = ?
         ORDER BY installment.due_date, installment.installment_number`,
        [tenantId, customerId],
      ),
    ]);
    const today = new Date().toISOString().slice(0, 10);
    const accountData = accounts.map((account) => {
      const canceled = account.canceled_at !== null;
      const accountInstallments = installments
        .filter(({ account_id }) => account_id === account.id)
        .map((installment) => {
          const amount = this.toMoneyCents(installment.amount);
          const paid = this.toMoneyCents(installment.paid_amount);
          const balance = amount > paid ? amount - paid : 0n;
          const dueDate = this.date(installment.due_date);
          return {
            id: installment.id,
            number: Number(installment.installment_number),
            dueDate,
            amount: this.fromMoneyCents(amount),
            paidAmount: this.fromMoneyCents(paid > amount ? amount : paid),
            balance: this.fromMoneyCents(balance),
            status: canceled
              ? ('CANCELLED' as const)
              : balance === 0n
                ? ('PAID' as const)
                : paid > 0n
                  ? dueDate < today
                    ? ('OVERDUE' as const)
                    : ('PARTIAL' as const)
                  : dueDate < today
                    ? ('OVERDUE' as const)
                    : ('OPEN' as const),
          };
        });
      const original = this.toMoneyCents(account.original_amount);
      const rawBalance = this.toMoneyCents(account.balance);
      const balance = rawBalance > 0n ? rawBalance : 0n;
      return {
        id: account.id,
        sale: { id: account.sale_id, receiptNumber: account.receipt_number },
        originalAmount: this.fromMoneyCents(original),
        balance: this.fromMoneyCents(balance),
        dueDate: this.date(account.due_date),
        status: canceled
          ? ('CANCELLED' as const)
          : balance === 0n
            ? ('PAID' as const)
            : accountInstallments.some(({ status }) => status === 'OVERDUE')
              ? ('OVERDUE' as const)
              : balance < original
                ? ('PARTIAL' as const)
                : ('OPEN' as const),
        installments: accountInstallments,
      };
    });
    return {
      currency: customer.credit.currency,
      balance: customer.credit.balance,
      overdueAmount: customer.credit.overdueAmount,
      status: customer.credit.status,
      accounts: accountData,
      payments: payments.map((payment) => ({
        id: payment.id,
        receiptNumber: payment.receipt_number,
        currency: payment.currency,
        amount: this.money(payment.amount),
        method: payment.method,
        status: payment.status,
        reference: payment.external_reference,
        provider: payment.provider,
        providerReference: payment.provider_reference,
        responsible: {
          id: payment.created_by_user_id,
          email: payment.created_by_email,
        },
        context: {
          branch: { id: payment.branch_id, name: payment.branch_name },
          cashRegister: {
            id: payment.cash_register_id,
            name: payment.cash_register_name,
            code: payment.cash_register_code,
          },
        },
        allocations: allocations
          .filter(({ payment_id }) => payment_id === payment.id)
          .map((allocation) => ({
            accountId: allocation.account_id,
            installmentId: allocation.installment_id,
            installmentNumber: Number(allocation.installment_number),
            amount: this.money(allocation.amount),
          })),
        reversal:
          payment.status === 'REVERSED' &&
          payment.reversal_reason &&
          payment.reversed_by_user_id &&
          payment.reversed_by_email &&
          payment.reversed_at
            ? {
                reason: payment.reversal_reason,
                user: {
                  id: payment.reversed_by_user_id,
                  email: payment.reversed_by_email,
                },
                providerReference: payment.reversal_provider_reference,
                reversedAt: new Date(payment.reversed_at).toISOString(),
              }
            : null,
        createdAt: new Date(payment.created_at).toISOString(),
      })),
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

  private date(value: Date | string): string {
    if (value instanceof Date) return value.toISOString().slice(0, 10);
    return String(value).slice(0, 10);
  }
}
