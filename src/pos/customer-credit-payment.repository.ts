import { Injectable } from '@nestjs/common';
import { createHash, randomUUID } from 'node:crypto';
import { DataSource, EntityManager, QueryFailedError } from 'typeorm';
import { AuditService } from '../audit/audit.service';
import {
  CustomerCreditPaymentAllocationError,
  CustomerCreditPaymentAlreadyReversedError,
  CustomerCreditPaymentAmountError,
  CustomerCreditPaymentCashError,
  CustomerCreditPaymentCurrencyError,
  CustomerCreditPaymentNotFoundError,
  CustomerCreditPaymentRefundError,
  CustomerCreditPaymentShiftError,
} from './customer-credit-payment.errors';
import type { CustomerCreditPaymentData } from './customer-credit-payment.types';
import type {
  CreateCustomerCreditPaymentDto,
  ReverseCustomerCreditPaymentDto,
} from './dto/create-customer-credit-payment.dto';
import { PaymentAuthorizationService } from './payment-authorization.service';
import { PaymentRefundService } from './payment-refund.service';
import { PosIdempotencyConflictError } from './pos.errors';

interface PaymentRow {
  id: string;
  tenant_id: string;
  customer_id: string;
  cash_register_shift_id: string;
  cash_movement_id: string | null;
  receipt_number: string;
  currency: string;
  amount: string;
  method: 'CASH' | 'CARD' | 'TRANSFER';
  status: 'COMPLETED' | 'REVERSED';
  external_reference: string | null;
  provider: string;
  provider_reference: string | null;
  request_fingerprint: string;
  created_by_user_id: string;
  created_by_email: string;
  branch_id: string;
  branch_name: string;
  cash_register_id: string;
  cash_register_name: string;
  cash_register_code: string;
  reversal_reason: string | null;
  reversal_provider_reference: string | null;
  reversal_idempotency_key: string | null;
  reversal_request_fingerprint: string | null;
  reversed_by_user_id: string | null;
  reversed_by_email: string | null;
  reversed_at: Date | string | null;
  created_at: Date | string;
}

interface AllocationRow {
  payment_id: string;
  account_id: string;
  installment_id: string;
  installment_number: number | string;
  amount: string;
}

interface PaymentContext {
  tenantId: string;
  branchId: string;
  cashRegisterId: string;
  userId: string;
  customerId: string;
  idempotencyKey: string;
  fingerprint: string;
  correlationId: string;
}

@Injectable()
export class CustomerCreditPaymentRepository {
  constructor(
    private readonly dataSource: DataSource,
    private readonly audit: AuditService,
    private readonly authorizations: PaymentAuthorizationService,
    private readonly refunds: PaymentRefundService,
  ) {}

  async create(
    input: PaymentContext & { dto: CreateCustomerCreditPaymentDto },
  ): Promise<{ payment: CustomerCreditPaymentData; replay: boolean }> {
    try {
      return await this.dataSource.transaction(
        'READ COMMITTED',
        async (manager) => {
          const existing = await this.findByKey(
            manager,
            input.tenantId,
            input.idempotencyKey,
          );
          if (existing) return this.replay(existing, input);

          const profile = await this.lockCustomer(
            manager,
            input.tenantId,
            input.customerId,
          );
          if (!profile) throw new CustomerCreditPaymentNotFoundError();
          const concurrent = await this.findByKey(
            manager,
            input.tenantId,
            input.idempotencyKey,
          );
          if (concurrent) return this.replay(concurrent, input);
          const shift = await this.lockCurrentShift(manager, input);
          if (!shift) throw new CustomerCreditPaymentShiftError();
          if (shift.currency !== profile.currency)
            throw new CustomerCreditPaymentCurrencyError();

          const amount = this.cents(input.dto.amount);
          const balance = await this.balance(
            manager,
            input.tenantId,
            input.customerId,
          );
          if (amount <= 0n || balance <= 0n || amount > balance)
            throw new CustomerCreditPaymentAmountError();

          const authorization = this.authorizations.authorize({
            method: input.dto.method,
            reference: input.dto.reference,
            amount: this.money(amount),
            currency: profile.currency,
            idempotencyKey: input.idempotencyKey,
          });
          const obligations = await this.openObligations(
            manager,
            input.tenantId,
            input.customerId,
          );
          const allocations: Array<{
            accountId: string;
            saleId: string;
            installmentId: string;
            installmentNumber: number;
            amount: bigint;
          }> = [];
          let pending = amount;
          for (const obligation of obligations) {
            if (pending === 0n) break;
            const outstanding =
              this.cents(obligation.amount) -
              this.cents(obligation.paid_amount);
            if (outstanding <= 0n) continue;
            const applied = pending < outstanding ? pending : outstanding;
            allocations.push({
              accountId: obligation.account_id,
              saleId: obligation.sale_id,
              installmentId: obligation.installment_id,
              installmentNumber: Number(obligation.installment_number),
              amount: applied,
            });
            pending -= applied;
          }
          if (pending !== 0n) throw new CustomerCreditPaymentAllocationError();

          const paymentId = randomUUID();
          const receiptNumber = `CP-${paymentId.replaceAll('-', '').toUpperCase()}`;
          const cashMovementId =
            input.dto.method === 'CASH'
              ? await this.insertCashMovement(manager, {
                  ...input,
                  shiftId: shift.id,
                  amount,
                  reason: `Abono de crédito ${receiptNumber}`,
                  type: 'INCOME',
                  reversalOfId: null,
                })
              : null;
          await manager.query(
            `INSERT INTO customer_credit_payments
              (id, tenant_id, customer_id, cash_register_shift_id,
               cash_movement_id, receipt_number, currency, amount, method,
               status, external_reference, provider, provider_reference,
               authorization_code, idempotency_key, request_fingerprint,
               created_by_user_id)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'COMPLETED', ?, ?, ?, ?, ?, ?, ?)`,
            [
              paymentId,
              input.tenantId,
              input.customerId,
              shift.id,
              cashMovementId,
              receiptNumber,
              profile.currency,
              this.money(amount),
              input.dto.method,
              input.dto.reference ?? null,
              authorization.provider,
              authorization.providerReference,
              authorization.authorizationCode,
              input.idempotencyKey,
              input.fingerprint,
              input.userId,
            ],
          );

          const accountAmounts = new Map<
            string,
            { saleId: string; amount: bigint }
          >();
          for (const allocation of allocations) {
            await manager.query(
              `INSERT INTO customer_credit_payment_allocations
                (id, tenant_id, payment_id, account_id, installment_id, amount)
               VALUES (?, ?, ?, ?, ?, ?)`,
              [
                randomUUID(),
                input.tenantId,
                paymentId,
                allocation.accountId,
                allocation.installmentId,
                this.money(allocation.amount),
              ],
            );
            const account = accountAmounts.get(allocation.accountId);
            accountAmounts.set(allocation.accountId, {
              saleId: allocation.saleId,
              amount: (account?.amount ?? 0n) + allocation.amount,
            });
          }
          for (const [accountId, account] of accountAmounts) {
            await manager.query(
              `INSERT INTO customer_debt_ledger
                (id, tenant_id, customer_id, account_id, sale_id, entry_type,
                 amount, reference_type, idempotency_key, created_by_user_id)
               VALUES (?, ?, ?, ?, ?, 'CREDIT', ?, 'PAYMENT', ?, ?)`,
              [
                randomUUID(),
                input.tenantId,
                input.customerId,
                accountId,
                account.saleId,
                this.money(account.amount),
                `${input.idempotencyKey}:${accountId}`,
                input.userId,
              ],
            );
          }
          await this.audit.recordInTransaction(manager, {
            tenantId: input.tenantId,
            actorUserId: input.userId,
            action: 'CUSTOMER_CREDIT_PAYMENT_COMPLETED',
            entityType: 'CUSTOMER_CREDIT_PAYMENT',
            entityId: paymentId,
            correlationId: input.correlationId,
            deduplicate: true,
            after: {
              customerId: input.customerId,
              receiptNumber,
              method: input.dto.method,
              currency: profile.currency,
              amount: this.money(amount),
              allocations: allocations.length,
            },
          });
          const created = await this.findById(
            manager,
            input.tenantId,
            paymentId,
          );
          if (!created)
            throw new Error('CREDIT_PAYMENT_NOT_FOUND_AFTER_CREATE');
          return { payment: created, replay: false };
        },
      );
    } catch (error) {
      if (!this.isDuplicate(error)) throw error;
      const existing = await this.findByKey(
        this.dataSource.manager,
        input.tenantId,
        input.idempotencyKey,
      );
      if (!existing) throw error;
      return this.replay(existing, input);
    }
  }

  async reverse(
    input: PaymentContext & {
      paymentId: string;
      dto: ReverseCustomerCreditPaymentDto;
    },
  ): Promise<{ payment: CustomerCreditPaymentData; replay: boolean }> {
    try {
      return await this.dataSource.transaction(
        'READ COMMITTED',
        async (manager) => {
          const profile = await this.lockCustomer(
            manager,
            input.tenantId,
            input.customerId,
          );
          if (!profile) throw new CustomerCreditPaymentNotFoundError();
          const payment = await this.findRowForUpdate(manager, input);
          if (!payment) throw new CustomerCreditPaymentNotFoundError();
          if (payment.status === 'REVERSED') {
            if (
              payment.reversal_idempotency_key !== input.idempotencyKey ||
              payment.reversal_request_fingerprint !== input.fingerprint
            )
              throw new CustomerCreditPaymentAlreadyReversedError();
            const replay = await this.findById(
              manager,
              input.tenantId,
              input.paymentId,
            );
            if (!replay) throw new CustomerCreditPaymentNotFoundError();
            return { payment: replay, replay: true };
          }
          const shift = await this.lockCurrentShift(manager, input);
          if (!shift) throw new CustomerCreditPaymentShiftError();
          if (shift.currency !== payment.currency)
            throw new CustomerCreditPaymentCurrencyError();
          const amount = this.cents(payment.amount);
          let reversalCashMovementId: string | null = null;
          let reversalProviderReference: string | null = null;
          if (payment.method === 'CASH') {
            if (!payment.cash_movement_id)
              throw new CustomerCreditPaymentCashError();
            const expectedCash = await this.expectedCash(
              manager,
              input.tenantId,
              shift.id,
            );
            if (expectedCash < amount)
              throw new CustomerCreditPaymentCashError();
            reversalCashMovementId = await this.insertCashMovement(manager, {
              ...input,
              shiftId: shift.id,
              amount,
              reason: input.dto.reason.trim(),
              type: 'REVERSAL',
              reversalOfId: payment.cash_movement_id,
            });
          } else {
            const refund = this.refunds.refund({
              method: payment.method,
              originalExternalReference: payment.external_reference,
              originalProviderReference: payment.provider_reference,
              amount: this.money(amount),
              currency: payment.currency,
              idempotencyKey: input.idempotencyKey,
            });
            if (refund.status !== 'COMPLETED')
              throw new CustomerCreditPaymentRefundError();
            reversalProviderReference = refund.providerReference;
          }
          await manager.query(
            `UPDATE customer_credit_payments
             SET status = 'REVERSED', reversal_reason = ?,
                 reversal_provider_reference = ?, reversal_cash_movement_id = ?,
                 reversal_idempotency_key = ?, reversal_request_fingerprint = ?,
                 reversed_by_user_id = ?, reversed_at = CURRENT_TIMESTAMP(6)
             WHERE id = ? AND tenant_id = ? AND status = 'COMPLETED'`,
            [
              input.dto.reason.trim(),
              reversalProviderReference,
              reversalCashMovementId,
              input.idempotencyKey,
              input.fingerprint,
              input.userId,
              input.paymentId,
              input.tenantId,
            ],
          );
          const accountRows = await manager.query<
            Array<{ account_id: string; sale_id: string; amount: string }>
          >(
            `SELECT allocation.account_id, account.sale_id,
                    SUM(allocation.amount) AS amount
             FROM customer_credit_payment_allocations allocation
             INNER JOIN customer_credit_accounts account
               ON account.id = allocation.account_id
              AND account.tenant_id = allocation.tenant_id
             WHERE allocation.tenant_id = ? AND allocation.payment_id = ?
             GROUP BY allocation.account_id, account.sale_id`,
            [input.tenantId, input.paymentId],
          );
          for (const account of accountRows) {
            await manager.query(
              `INSERT INTO customer_debt_ledger
                (id, tenant_id, customer_id, account_id, sale_id, entry_type,
                 amount, reference_type, idempotency_key, created_by_user_id)
               VALUES (?, ?, ?, ?, ?, 'DEBIT', ?, 'PAYMENT', ?, ?)`,
              [
                randomUUID(),
                input.tenantId,
                input.customerId,
                account.account_id,
                account.sale_id,
                this.money(this.cents(account.amount)),
                `${input.idempotencyKey}:${account.account_id}`,
                input.userId,
              ],
            );
          }
          await this.audit.recordInTransaction(manager, {
            tenantId: input.tenantId,
            actorUserId: input.userId,
            action: 'CUSTOMER_CREDIT_PAYMENT_REVERSED',
            entityType: 'CUSTOMER_CREDIT_PAYMENT',
            entityId: input.paymentId,
            correlationId: input.correlationId,
            deduplicate: true,
            before: { status: 'COMPLETED', amount: payment.amount },
            after: { status: 'REVERSED', reason: input.dto.reason.trim() },
          });
          const reversed = await this.findById(
            manager,
            input.tenantId,
            input.paymentId,
          );
          if (!reversed) throw new CustomerCreditPaymentNotFoundError();
          return { payment: reversed, replay: false };
        },
      );
    } catch (error) {
      if (!this.isDuplicate(error)) throw error;
      const payment = await this.findById(
        this.dataSource.manager,
        input.tenantId,
        input.paymentId,
      );
      if (!payment) throw error;
      const [row] = await this.dataSource.query<PaymentRow[]>(
        `${this.select()} WHERE payment.id = ? AND payment.tenant_id = ? LIMIT 1`,
        [input.paymentId, input.tenantId],
      );
      if (
        !row ||
        row.reversal_idempotency_key !== input.idempotencyKey ||
        row.reversal_request_fingerprint !== input.fingerprint
      )
        throw new CustomerCreditPaymentAlreadyReversedError();
      return { payment, replay: true };
    }
  }

  private replay(existing: PaymentRow, input: PaymentContext) {
    if (
      existing.customer_id !== input.customerId ||
      existing.branch_id !== input.branchId ||
      existing.cash_register_id !== input.cashRegisterId ||
      existing.created_by_user_id !== input.userId ||
      existing.request_fingerprint !== input.fingerprint
    )
      throw new PosIdempotencyConflictError();
    return this.findById(
      this.dataSource.manager,
      input.tenantId,
      existing.id,
    ).then((payment) => {
      if (!payment) throw new CustomerCreditPaymentNotFoundError();
      return { payment, replay: true as const };
    });
  }

  private async lockCustomer(
    manager: EntityManager,
    tenantId: string,
    customerId: string,
  ): Promise<{ currency: string } | null> {
    const [row] = await manager.query<Array<{ currency: string }>>(
      `SELECT profile.currency FROM customers customer
       INNER JOIN customer_credit_profiles profile
         ON profile.customer_id = customer.id AND profile.tenant_id = customer.tenant_id
       WHERE customer.id = ? AND customer.tenant_id = ? LIMIT 1 FOR UPDATE`,
      [customerId, tenantId],
    );
    return row ?? null;
  }

  private async lockCurrentShift(
    manager: EntityManager,
    input: Pick<
      PaymentContext,
      'tenantId' | 'branchId' | 'cashRegisterId' | 'userId'
    >,
  ): Promise<{ id: string; currency: string } | null> {
    const [row] = await manager.query<Array<{ id: string; currency: string }>>(
      `SELECT id, currency FROM cash_register_shifts
       WHERE tenant_id = ? AND branch_id = ? AND cash_register_id = ?
         AND opened_by_user_id = ? AND status = 'OPEN'
       ORDER BY opened_at DESC LIMIT 1 FOR UPDATE`,
      [input.tenantId, input.branchId, input.cashRegisterId, input.userId],
    );
    return row ?? null;
  }

  private async balance(
    manager: EntityManager,
    tenantId: string,
    customerId: string,
  ): Promise<bigint> {
    const [row] = await manager.query<Array<{ balance: string }>>(
      `SELECT COALESCE(SUM(CASE WHEN entry_type = 'DEBIT' THEN amount ELSE -amount END), 0)
         AS balance
       FROM customer_debt_ledger WHERE tenant_id = ? AND customer_id = ?`,
      [tenantId, customerId],
    );
    return this.cents(row.balance);
  }

  private openObligations(
    manager: EntityManager,
    tenantId: string,
    customerId: string,
  ) {
    return manager.query<
      Array<{
        account_id: string;
        sale_id: string;
        installment_id: string;
        installment_number: number | string;
        amount: string;
        paid_amount: string;
      }>
    >(
      `SELECT account.id AS account_id, account.sale_id,
              installment.id AS installment_id,
              installment.installment_number, installment.amount,
              COALESCE(SUM(CASE WHEN payment.status = 'COMPLETED'
                THEN allocation.amount ELSE 0 END), 0) AS paid_amount
       FROM customer_credit_accounts account
       INNER JOIN customer_credit_installments installment
         ON installment.account_id = account.id
        AND installment.tenant_id = account.tenant_id
       LEFT JOIN customer_credit_payment_allocations allocation
         ON allocation.installment_id = installment.id
        AND allocation.tenant_id = installment.tenant_id
       LEFT JOIN customer_credit_payments payment
         ON payment.id = allocation.payment_id
        AND payment.tenant_id = allocation.tenant_id
       WHERE account.tenant_id = ? AND account.customer_id = ?
         AND account.canceled_at IS NULL
       GROUP BY account.id, account.sale_id, account.created_at,
                installment.id, installment.installment_number,
                installment.due_date, installment.amount
       HAVING installment.amount > paid_amount
       ORDER BY installment.due_date, account.created_at,
                installment.installment_number, installment.id`,
      [tenantId, customerId],
    );
  }

  private async insertCashMovement(
    manager: EntityManager,
    input: PaymentContext & {
      shiftId: string;
      amount: bigint;
      reason: string;
      type: 'INCOME' | 'REVERSAL';
      reversalOfId: string | null;
    },
  ): Promise<string> {
    const id = randomUUID();
    const key = `credit:${createHash('sha256')
      .update(`${input.type}:${input.idempotencyKey}`)
      .digest('hex')}`;
    const reason = input.reason;
    const fingerprint = createHash('sha256')
      .update(
        JSON.stringify({
          shiftId: input.shiftId,
          type: input.type,
          amount: this.money(input.amount),
          reason,
          reversalOfId: input.reversalOfId,
        }),
      )
      .digest('hex');
    await manager.query(
      `INSERT INTO cash_register_movements
        (id, tenant_id, cash_register_shift_id, created_by_user_id, type,
         amount, reason, reversal_of_id, idempotency_key, request_fingerprint)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        input.tenantId,
        input.shiftId,
        input.userId,
        input.type,
        this.money(input.amount),
        reason,
        input.reversalOfId,
        key,
        fingerprint,
      ],
    );
    return id;
  }

  private async expectedCash(
    manager: EntityManager,
    tenantId: string,
    shiftId: string,
  ): Promise<bigint> {
    const [row] = await manager.query<Array<{ expected_cash: string }>>(
      `SELECT shift.opening_amount
         + COALESCE((SELECT SUM(payment.amount_applied) FROM sales sale
             INNER JOIN sale_payments payment
               ON payment.sale_id = sale.id AND payment.tenant_id = sale.tenant_id
                AND payment.method = 'CASH'
             WHERE sale.tenant_id = shift.tenant_id
               AND sale.cash_register_shift_id = shift.id
               AND sale.status = 'COMPLETED'), 0)
         - COALESCE((SELECT SUM(settlement.amount)
             FROM sale_return_settlements settlement
             WHERE settlement.tenant_id = shift.tenant_id
               AND settlement.cash_register_shift_id = shift.id
               AND settlement.method = 'CASH'
               AND settlement.status = 'COMPLETED'), 0)
         + COALESCE((SELECT SUM(CASE
             WHEN movement.type = 'INCOME' THEN movement.amount
             WHEN movement.type = 'WITHDRAWAL' THEN -movement.amount
             WHEN original.type = 'INCOME' THEN -movement.amount
             ELSE movement.amount END)
             FROM cash_register_movements movement
             LEFT JOIN cash_register_movements original
               ON original.id = movement.reversal_of_id
              AND original.tenant_id = movement.tenant_id
             WHERE movement.tenant_id = shift.tenant_id
               AND movement.cash_register_shift_id = shift.id), 0) AS expected_cash
       FROM cash_register_shifts shift
       WHERE shift.tenant_id = ? AND shift.id = ? LIMIT 1`,
      [tenantId, shiftId],
    );
    if (!row) throw new CustomerCreditPaymentShiftError();
    return this.cents(row.expected_cash);
  }

  private async findRowForUpdate(
    manager: EntityManager,
    input: Pick<PaymentContext, 'tenantId' | 'customerId'> & {
      paymentId: string;
    },
  ): Promise<PaymentRow | null> {
    const [row] = await manager.query<PaymentRow[]>(
      `${this.select()} WHERE payment.id = ? AND payment.tenant_id = ?
       AND payment.customer_id = ? LIMIT 1 FOR UPDATE`,
      [input.paymentId, input.tenantId, input.customerId],
    );
    return row ?? null;
  }

  private async findByKey(
    manager: EntityManager,
    tenantId: string,
    key: string,
  ): Promise<PaymentRow | null> {
    const [row] = await manager.query<PaymentRow[]>(
      `${this.select()} WHERE payment.tenant_id = ?
       AND payment.idempotency_key = ? LIMIT 1`,
      [tenantId, key],
    );
    return row ?? null;
  }

  private async findById(
    manager: EntityManager,
    tenantId: string,
    id: string,
  ): Promise<CustomerCreditPaymentData | null> {
    const [row] = await manager.query<PaymentRow[]>(
      `${this.select()} WHERE payment.tenant_id = ? AND payment.id = ? LIMIT 1`,
      [tenantId, id],
    );
    if (!row) return null;
    const allocations = await manager.query<AllocationRow[]>(
      `SELECT allocation.payment_id, allocation.account_id,
              allocation.installment_id, installment.installment_number,
              allocation.amount
       FROM customer_credit_payment_allocations allocation
       INNER JOIN customer_credit_installments installment
         ON installment.id = allocation.installment_id
        AND installment.tenant_id = allocation.tenant_id
       WHERE allocation.tenant_id = ? AND allocation.payment_id = ?
       ORDER BY installment.due_date, installment.installment_number`,
      [tenantId, id],
    );
    return this.data(row, allocations);
  }

  private select(): string {
    return `SELECT payment.*, creator.email AS created_by_email,
                   reversal_user.email AS reversed_by_email,
                   branch.id AS branch_id, branch.name AS branch_name,
                   cash_register.id AS cash_register_id,
                   cash_register.name AS cash_register_name,
                   cash_register.code AS cash_register_code
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
             AND cash_register.tenant_id = shift.tenant_id`;
  }

  private data(
    row: PaymentRow,
    allocations: AllocationRow[],
  ): CustomerCreditPaymentData {
    return {
      id: row.id,
      receiptNumber: row.receipt_number,
      currency: row.currency,
      amount: this.decimal(row.amount),
      method: row.method,
      status: row.status,
      reference: row.external_reference,
      provider: row.provider,
      providerReference: row.provider_reference,
      responsible: { id: row.created_by_user_id, email: row.created_by_email },
      context: {
        branch: { id: row.branch_id, name: row.branch_name },
        cashRegister: {
          id: row.cash_register_id,
          name: row.cash_register_name,
          code: row.cash_register_code,
        },
      },
      allocations: allocations.map((allocation) => ({
        accountId: allocation.account_id,
        installmentId: allocation.installment_id,
        installmentNumber: Number(allocation.installment_number),
        amount: this.decimal(allocation.amount),
      })),
      reversal:
        row.status === 'REVERSED' &&
        row.reversal_reason &&
        row.reversed_by_user_id &&
        row.reversed_by_email &&
        row.reversed_at
          ? {
              reason: row.reversal_reason,
              user: {
                id: row.reversed_by_user_id,
                email: row.reversed_by_email,
              },
              providerReference: row.reversal_provider_reference,
              reversedAt: new Date(row.reversed_at).toISOString(),
            }
          : null,
      createdAt: new Date(row.created_at).toISOString(),
    };
  }

  private money(value: bigint): string {
    return `${value / 100n}.${String(value % 100n).padStart(2, '0')}`;
  }

  private decimal(value: string): string {
    return this.money(this.cents(value));
  }

  private cents(value: string): bigint {
    const [whole, fraction = ''] = String(value).split('.');
    return BigInt(whole) * 100n + BigInt(fraction.padEnd(2, '0').slice(0, 2));
  }

  private isDuplicate(error: unknown): boolean {
    if (!(error instanceof QueryFailedError)) return false;
    const driver = error.driverError as { code?: string; errno?: number };
    return driver.code === 'ER_DUP_ENTRY' || driver.errno === 1062;
  }
}
