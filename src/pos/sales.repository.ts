import { Injectable } from '@nestjs/common';
import { createHash, randomUUID } from 'node:crypto';
import { DataSource, EntityManager, QueryFailedError } from 'typeorm';
import { applyInventoryValuation } from '../inventory/inventory-valuation';
import { applyInventoryLotTracking } from '../inventory/inventory-lot-tracking';
import { applyInventorySerialTracking } from '../inventory/inventory-serial-tracking';
import {
  PosIdempotencyConflictError,
  PaymentReferenceConflictError,
  CustomerCreditLimitExceededError,
  CustomerCreditNotAvailableError,
  PosCustomerNotAvailableError,
  PosInsufficientStockError,
  PosReservationNotAvailableError,
  SaleAlreadyVoidedError,
  SaleVoidNotAllowedError,
} from './pos.errors';
import { ListSalesDto } from './dto/list-sales.dto';
import { CashRegisterShiftRequiredError } from './cash-register-shift.errors';
import {
  CashSaleData,
  PosCartQuoteResponse,
  SalePaymentData,
  SaleDetailData,
  SaleSummaryData,
} from './pos.types';
import type { PaymentMethod } from './pos.types';
import { AuditService } from '../audit/audit.service';
import { SaleReceiptRepository } from './sale-receipt.repository';
import { SuspendedSaleStateError } from './suspended-sale.errors';
import type { SuspendedSaleStatus } from './suspended-sale.types';

interface SaleRow {
  id: string;
  receipt_number: string;
  status: 'COMPLETED' | 'VOIDED';
  created_by_user_id: string;
  customer_id: string | null;
  customer_name: string | null;
  customer_identifier: string | null;
  quotation_id: string | null;
  quotation_number: string | null;
  currency: string;
  tax_rate: string;
  gross_total: string;
  line_discount_total: string;
  sale_discount_total: string;
  discount_total: string;
  discount_type: 'PERCENT' | 'AMOUNT' | null;
  discount_value: string | null;
  discount_reason: string | null;
  subtotal: string;
  tax_total: string;
  total: string;
  request_fingerprint: string;
  created_at: Date | string;
  branch_id: string;
  branch_name: string;
  warehouse_id: string;
  warehouse_name: string;
  cash_register_id: string;
  cash_register_name: string;
  cash_register_code: string;
  voided_by_user_id: string | null;
  voided_by_email: string | null;
  void_reason: string | null;
  voided_at: Date | string | null;
}

interface StockAllocation {
  locationId: string;
  quantityChange: string;
  resultingQuantity: string;
  resultingAvailableQuantity: string;
  resultingReservedQuantity: string;
  reservationLineId?: string;
  serialNumbers?: string[];
}

@Injectable()
export class SalesRepository {
  constructor(
    private readonly dataSource: DataSource,
    private readonly audit: AuditService,
    private readonly receipts: SaleReceiptRepository,
  ) {}

  async listSales(
    tenantId: string,
    branchId: string,
    query: ListSalesDto,
  ): Promise<{ items: SaleSummaryData[]; total: number }> {
    const filters = ['s.tenant_id = ?', 's.branch_id = ?'];
    const parameters: unknown[] = [tenantId, branchId];
    if (query.dateFrom) {
      filters.push('s.created_at >= ?');
      parameters.push(`${query.dateFrom} 00:00:00`);
    }
    if (query.dateTo) {
      filters.push('s.created_at < DATE_ADD(?, INTERVAL 1 DAY)');
      parameters.push(`${query.dateTo} 00:00:00`);
    }
    if (query.cashRegisterId) {
      filters.push('s.cash_register_id = ?');
      parameters.push(query.cashRegisterId);
    }
    if (query.userId) {
      filters.push('s.created_by_user_id = ?');
      parameters.push(query.userId);
    }
    const where = filters.join(' AND ');
    const offset = (query.page - 1) * query.pageSize;
    const [rows, countRows] = await Promise.all([
      this.dataSource.query<
        Array<{
          id: string;
          receipt_number: string;
          status: 'COMPLETED' | 'VOIDED';
          user_id: string;
          user_email: string;
          customer_id: string | null;
          customer_name: string | null;
          customer_identifier: string | null;
          cash_register_id: string;
          cash_register_name: string;
          cash_register_code: string;
          currency: string;
          total: string;
          created_at: Date | string;
          payment_method: PaymentMethod | 'MIXED';
        }>
      >(
        `SELECT s.id, s.receipt_number, s.status,
                u.id AS user_id, u.email AS user_email,
                c.id AS customer_id, c.name AS customer_name,
                c.identifier AS customer_identifier,
                cr.id AS cash_register_id, cr.name AS cash_register_name,
                cr.code AS cash_register_code, s.currency, s.total, s.created_at,
                (SELECT CASE WHEN COUNT(*) = 1 THEN MAX(sp.method) ELSE 'MIXED' END
                 FROM sale_payments sp
                 WHERE sp.sale_id = s.id AND sp.tenant_id = s.tenant_id) AS payment_method
         FROM sales s
         INNER JOIN users u ON u.id = s.created_by_user_id AND u.tenant_id = s.tenant_id
         LEFT JOIN customers c ON c.id = s.customer_id AND c.tenant_id = s.tenant_id
         INNER JOIN cash_registers cr ON cr.id = s.cash_register_id AND cr.tenant_id = s.tenant_id
         WHERE ${where}
         ORDER BY s.created_at DESC, s.id DESC LIMIT ? OFFSET ?`,
        [...parameters, query.pageSize, offset],
      ),
      this.dataSource.query<Array<{ total: number | string }>>(
        `SELECT COUNT(*) AS total FROM sales s WHERE ${where}`,
        parameters,
      ),
    ]);
    return {
      items: rows.map((row) => ({
        id: row.id,
        receiptNumber: row.receipt_number,
        status: row.status,
        user: { id: row.user_id, email: row.user_email },
        customer: row.customer_id
          ? {
              id: row.customer_id,
              name: row.customer_name!,
              identifier: row.customer_identifier,
            }
          : null,
        cashRegister: {
          id: row.cash_register_id,
          name: row.cash_register_name,
          code: row.cash_register_code,
        },
        currency: row.currency,
        total: this.decimal(row.total, 2),
        paymentMethod: row.payment_method,
        createdAt: new Date(row.created_at).toISOString(),
      })),
      total: Number(countRows[0]?.total ?? 0),
    };
  }

  async getSaleDetail(
    tenantId: string,
    branchId: string,
    saleId: string,
  ): Promise<SaleDetailData | null> {
    const keys = await this.dataSource.query<
      Array<{ idempotency_key: string; user_email: string }>
    >(
      `SELECT s.idempotency_key, u.email AS user_email
       FROM sales s
       INNER JOIN users u ON u.id = s.created_by_user_id AND u.tenant_id = s.tenant_id
       WHERE s.id = ? AND s.tenant_id = ? AND s.branch_id = ? LIMIT 1`,
      [saleId, tenantId, branchId],
    );
    if (!keys[0]) return null;
    const found = await this.findWithManager(
      this.dataSource.manager,
      tenantId,
      keys[0].idempotency_key,
    );
    if (!found) return null;
    const movements = await this.dataSource.query<
      Array<{
        id: string;
        type: 'SALE' | 'SALE_VOID' | 'SALE_RETURN';
        sale_line_id: string;
        product_id: string;
        product_name: string;
        product_sku: string;
        location_id: string;
        location_name: string;
        location_code: string;
        quantity_change: string;
        resulting_quantity: string;
        reference: string;
        created_at: Date | string;
      }>
    >(
      `SELECT im.id, im.type, im.sale_line_id, p.id AS product_id,
              p.name AS product_name, p.sku AS product_sku,
              l.id AS location_id, l.name AS location_name, l.code AS location_code,
              im.quantity_change, im.resulting_quantity, im.reference, im.created_at
       FROM inventory_movements im
       INNER JOIN products p ON p.id = im.product_id AND p.tenant_id = im.tenant_id
       INNER JOIN locations l ON l.id = im.location_id AND l.tenant_id = im.tenant_id
       WHERE im.tenant_id = ? AND im.sale_id = ?
         AND im.type IN ('SALE', 'SALE_VOID', 'SALE_RETURN')
       ORDER BY im.created_at, im.id`,
      [tenantId, saleId],
    );
    const { userId, ...sale } = found.sale;
    return {
      ...sale,
      user: { id: userId, email: keys[0].user_email },
      movements: movements.map((movement) => ({
        id: movement.id,
        type: movement.type,
        saleLineId: movement.sale_line_id,
        product: {
          id: movement.product_id,
          name: movement.product_name,
          sku: movement.product_sku,
        },
        location: {
          id: movement.location_id,
          name: movement.location_name,
          code: movement.location_code,
        },
        quantityChange: this.decimal(movement.quantity_change, 3),
        resultingQuantity: this.decimal(movement.resulting_quantity, 3),
        reference: movement.reference,
        createdAt: new Date(movement.created_at).toISOString(),
      })),
    };
  }

  async findByIdempotency(
    tenantId: string,
    idempotencyKey: string,
  ): Promise<{ sale: CashSaleData; fingerprint: string } | null> {
    return this.findWithManager(
      this.dataSource.manager,
      tenantId,
      idempotencyKey,
    );
  }

  async voidSale(input: {
    tenantId: string;
    branchId: string;
    cashRegisterId: string;
    saleId: string;
    userId: string;
    reason: string;
    idempotencyKey: string;
    fingerprint: string;
    correlationId: string;
  }): Promise<{ saleId: string; replay: boolean } | null> {
    try {
      return await this.dataSource.transaction(
        'READ COMMITTED',
        async (manager) => {
          const existing = await this.findVoidByKey(
            manager,
            input.tenantId,
            input.idempotencyKey,
          );
          if (existing) {
            if (
              existing.saleId !== input.saleId ||
              existing.fingerprint !== input.fingerprint
            ) {
              throw new PosIdempotencyConflictError();
            }
            return { saleId: existing.saleId, replay: true };
          }

          const [sale] = await manager.query<
            Array<{
              id: string;
              receipt_number: string;
              status: 'COMPLETED' | 'VOIDED';
              cash_register_shift_id: string;
              void_idempotency_key: string | null;
              void_request_fingerprint: string | null;
            }>
          >(
            `SELECT id, receipt_number, status, cash_register_shift_id,
                    void_idempotency_key, void_request_fingerprint
             FROM sales
             WHERE id = ? AND tenant_id = ? AND branch_id = ? AND cash_register_id = ?
             LIMIT 1 FOR UPDATE`,
            [
              input.saleId,
              input.tenantId,
              input.branchId,
              input.cashRegisterId,
            ],
          );
          if (!sale) return null;
          if (sale.status === 'VOIDED') {
            if (
              sale.void_idempotency_key === input.idempotencyKey &&
              sale.void_request_fingerprint === input.fingerprint
            ) {
              return { saleId: sale.id, replay: true };
            }
            throw new SaleAlreadyVoidedError();
          }
          const [saleReturn] = await manager.query<Array<{ id: string }>>(
            `SELECT id FROM sale_returns
             WHERE tenant_id = ? AND sale_id = ? LIMIT 1 FOR UPDATE`,
            [input.tenantId, sale.id],
          );
          if (saleReturn) throw new SaleVoidNotAllowedError();

          const [shift] = await manager.query<
            Array<{ status: 'OPEN' | 'CLOSED' }>
          >(
            `SELECT status FROM cash_register_shifts
             WHERE id = ? AND tenant_id = ? AND branch_id = ? AND cash_register_id = ?
             LIMIT 1 FOR UPDATE`,
            [
              sale.cash_register_shift_id,
              input.tenantId,
              input.branchId,
              input.cashRegisterId,
            ],
          );
          if (!shift || shift.status !== 'OPEN') {
            throw new SaleVoidNotAllowedError();
          }

          const movements = await manager.query<
            Array<{
              id: string;
              product_id: string;
              location_id: string;
              sale_line_id: string;
              quantity_change: string;
            }>
          >(
            `SELECT id, product_id, location_id, sale_line_id, quantity_change
             FROM inventory_movements
             WHERE tenant_id = ? AND sale_id = ? AND type = 'SALE'
             ORDER BY product_id, location_id, id FOR UPDATE`,
            [input.tenantId, sale.id],
          );
          for (const movement of movements) {
            const [balance] = await manager.query<
              Array<{ quantity: string; available_quantity: string }>
            >(
              `SELECT quantity, available_quantity FROM inventory_balances
               WHERE tenant_id = ? AND product_id = ? AND location_id = ?
               LIMIT 1 FOR UPDATE`,
              [input.tenantId, movement.product_id, movement.location_id],
            );
            if (!balance) throw new Error('SALE_VOID_BALANCE_NOT_FOUND');
            const restored = -this.toQuantityUnits(movement.quantity_change);
            if (restored <= 0n) throw new Error('SALE_VOID_INVALID_MOVEMENT');
            const resultingQuantity =
              this.toQuantityUnits(balance.quantity) + restored;
            const resultingAvailable =
              this.toQuantityUnits(balance.available_quantity) + restored;
            const voidMovementId = randomUUID();
            await manager.query(
              `UPDATE inventory_balances
               SET quantity = ?, available_quantity = ?
               WHERE tenant_id = ? AND product_id = ? AND location_id = ?`,
              [
                this.fromQuantityUnits(resultingQuantity),
                this.fromQuantityUnits(resultingAvailable),
                input.tenantId,
                movement.product_id,
                movement.location_id,
              ],
            );
            const movementKey = `sale-void:${sale.id}:${movement.id}`;
            const movementFingerprint = createHash('sha256')
              .update(
                JSON.stringify({
                  saleId: sale.id,
                  originalMovementId: movement.id,
                  quantityChange: this.fromQuantityUnits(restored),
                }),
              )
              .digest('hex');
            await manager.query(
              `INSERT INTO inventory_movements
                (id, tenant_id, product_id, location_id, type, quantity_change,
                 resulting_quantity, reason, reference, idempotency_key,
                 request_fingerprint, created_by_user_id, sale_id, sale_line_id)
               VALUES (?, ?, ?, ?, 'SALE_VOID', ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
              [
                voidMovementId,
                input.tenantId,
                movement.product_id,
                movement.location_id,
                this.fromQuantityUnits(restored),
                this.fromQuantityUnits(resultingQuantity),
                `Anulación ${sale.receipt_number}: ${input.reason}`,
                sale.receipt_number,
                movementKey,
                movementFingerprint,
                input.userId,
                sale.id,
                movement.sale_line_id,
              ],
            );
            await applyInventoryValuation(manager, voidMovementId);
            await applyInventoryLotTracking(manager, voidMovementId);
            await applyInventorySerialTracking(manager, voidMovementId);
          }
          const [creditAccount] = await manager.query<
            Array<{
              id: string;
              customer_id: string;
              canceled_at: Date | string | null;
              balance: string;
            }>
          >(
            `SELECT cca.id, cca.customer_id, cca.canceled_at,
                    COALESCE(SUM(CASE WHEN cdl.entry_type = 'DEBIT'
                      THEN cdl.amount ELSE -cdl.amount END), 0) AS balance
             FROM customer_credit_accounts cca
             LEFT JOIN customer_debt_ledger cdl
               ON cdl.account_id = cca.id AND cdl.tenant_id = cca.tenant_id
             WHERE cca.tenant_id = ? AND cca.sale_id = ?
             GROUP BY cca.id, cca.customer_id, cca.canceled_at
             LIMIT 1 FOR UPDATE`,
            [input.tenantId, sale.id],
          );
          if (creditAccount && !creditAccount.canceled_at) {
            const balance = this.toMoney(creditAccount.balance);
            if (balance > 0n) {
              await manager.query(
                `INSERT INTO customer_debt_ledger
                  (id, tenant_id, customer_id, account_id, sale_id, entry_type,
                   amount, reference_type, idempotency_key, created_by_user_id)
                 VALUES (?, ?, ?, ?, ?, 'CREDIT', ?, 'VOID', ?, ?)`,
                [
                  randomUUID(),
                  input.tenantId,
                  creditAccount.customer_id,
                  creditAccount.id,
                  sale.id,
                  this.money(balance),
                  `sale-void:${input.idempotencyKey}`,
                  input.userId,
                ],
              );
            }
            await manager.query(
              `UPDATE customer_credit_accounts
               SET canceled_at = CURRENT_TIMESTAMP(6)
               WHERE id = ? AND tenant_id = ? AND canceled_at IS NULL`,
              [creditAccount.id, input.tenantId],
            );
          }
          const paymentUpdate = await manager.query<{ affectedRows?: number }>(
            `UPDATE sale_payments
             SET status = 'REVERSED', reversed_by_user_id = ?, reversed_at = CURRENT_TIMESTAMP(6)
             WHERE tenant_id = ? AND sale_id = ? AND status IN ('COMPLETED', 'PENDING')`,
            [input.userId, input.tenantId, sale.id],
          );
          if (Number(paymentUpdate.affectedRows ?? 0) < 1) {
            throw new Error('SALE_VOID_PAYMENT_NOT_REVERSED');
          }
          const saleUpdate = await manager.query<{ affectedRows?: number }>(
            `UPDATE sales SET status = 'VOIDED', voided_by_user_id = ?, void_reason = ?,
               void_idempotency_key = ?, void_request_fingerprint = ?,
               voided_at = CURRENT_TIMESTAMP(6)
             WHERE id = ? AND tenant_id = ? AND status = 'COMPLETED'`,
            [
              input.userId,
              input.reason,
              input.idempotencyKey,
              input.fingerprint,
              sale.id,
              input.tenantId,
            ],
          );
          if (Number(saleUpdate.affectedRows ?? 0) !== 1) {
            throw new Error('SALE_VOID_STATUS_NOT_UPDATED');
          }
          await this.audit.recordInTransaction(manager, {
            tenantId: input.tenantId,
            actorUserId: input.userId,
            action: 'SALE_VOIDED',
            entityType: 'SALE',
            entityId: sale.id,
            correlationId: input.correlationId,
            deduplicate: true,
            before: {
              status: 'COMPLETED',
              paymentStatus: creditAccount ? 'PENDING' : 'COMPLETED',
            },
            after: {
              status: 'VOIDED',
              paymentStatus: 'REVERSED',
              reason: input.reason,
              restoredMovementCount: movements.length,
              ...(creditAccount ? { creditReversed: true } : {}),
            },
          });
          return { saleId: sale.id, replay: false };
        },
      );
    } catch (error) {
      if (!this.isDuplicate(error)) throw error;
      const existing = await this.findVoidByKey(
        this.dataSource.manager,
        input.tenantId,
        input.idempotencyKey,
      );
      if (
        !existing ||
        existing.saleId !== input.saleId ||
        existing.fingerprint !== input.fingerprint
      ) {
        throw new PosIdempotencyConflictError();
      }
      return { saleId: existing.saleId, replay: true };
    }
  }

  async persistSale(input: {
    tenantId: string;
    userId: string;
    idempotencyKey: string;
    fingerprint: string;
    cashRegisterShiftId: string;
    customerId?: string | null;
    reservationId?: string | null;
    suspendedSaleId?: string | null;
    quotationId?: string | null;
    quote: PosCartQuoteResponse['data'];
    payments: Array<{
      method: PaymentMethod;
      amountReceived: string;
      amountApplied: string;
      change: string;
      reference: string | null;
      provider: string;
      providerReference: string | null;
      authorizationCode: string | null;
    }>;
    credit?: { installmentCount: number } | null;
  }): Promise<{ sale: CashSaleData; replay: boolean }> {
    try {
      return await this.dataSource.transaction(
        'READ COMMITTED',
        async (manager) => {
          const replay = await this.findWithManager(
            manager,
            input.tenantId,
            input.idempotencyKey,
          );
          if (replay) {
            if (replay.fingerprint !== input.fingerprint)
              throw new PosIdempotencyConflictError();
            return { sale: replay.sale, replay: true };
          }
          if (input.suspendedSaleId) {
            const [suspended] = await manager.query<
              Array<{ status: SuspendedSaleStatus; expired: number | boolean }>
            >(
              `SELECT status, expires_at <= CURRENT_TIMESTAMP(6) AS expired
               FROM suspended_sales
               WHERE id = ? AND tenant_id = ? AND branch_id = ? AND warehouse_id = ?
                 AND cash_register_id = ? AND created_by_user_id = ? LIMIT 1 FOR UPDATE`,
              [
                input.suspendedSaleId,
                input.tenantId,
                input.quote.context.branch.id,
                input.quote.context.warehouse.id,
                input.quote.context.cashRegister.id,
                input.userId,
              ],
            );
            if (!suspended) throw new SuspendedSaleStateError('CANCELLED');
            if (
              suspended.status === 'ACTIVE' &&
              Number(suspended.expired) === 1
            ) {
              await manager.query(
                `UPDATE suspended_sales SET status = 'EXPIRED' WHERE id = ? AND tenant_id = ?`,
                [input.suspendedSaleId, input.tenantId],
              );
              throw new SuspendedSaleStateError('EXPIRED');
            }
            if (suspended.status !== 'ACTIVE')
              throw new SuspendedSaleStateError(suspended.status);
          }
          let effectiveCustomerId = input.customerId ?? null;
          let creditProfile: {
            credit_limit: string;
            currency: string;
            term_days: number | string;
            max_installments: number | string;
          } | null = null;
          let reservedLocationId: string | null = null;
          const reservationLines = new Map<
            string,
            { id: string; quantity: string }
          >();
          if (input.reservationId) {
            const [reservation] = await manager.query<
              Array<{
                customer_id: string;
                location_id: string;
                status: string;
                expired: number | boolean;
              }>
            >(
              `SELECT customer_id, location_id, status,
                      expires_at <= CURRENT_TIMESTAMP(6) AS expired
               FROM product_reservations
               WHERE id = ? AND tenant_id = ? AND branch_id = ? AND warehouse_id = ?
               LIMIT 1 FOR UPDATE`,
              [
                input.reservationId,
                input.tenantId,
                input.quote.context.branch.id,
                input.quote.context.warehouse.id,
              ],
            );
            if (!reservation) throw new PosReservationNotAvailableError();
            if (reservation.status !== 'ACTIVE')
              throw new PosReservationNotAvailableError(reservation.status);
            if (Number(reservation.expired) === 1)
              throw new PosReservationNotAvailableError('EXPIRED');
            if (
              effectiveCustomerId &&
              effectiveCustomerId !== reservation.customer_id
            )
              throw new PosReservationNotAvailableError('CUSTOMER_MISMATCH');
            effectiveCustomerId = reservation.customer_id;
            reservedLocationId = reservation.location_id;
            const lines = await manager.query<
              Array<{ id: string; product_id: string; quantity: string }>
            >(
              `SELECT id, product_id, quantity FROM product_reservation_lines
               WHERE reservation_id = ? AND tenant_id = ? ORDER BY product_id FOR UPDATE`,
              [input.reservationId, input.tenantId],
            );
            for (const line of lines)
              reservationLines.set(line.product_id, {
                id: line.id,
                quantity: line.quantity,
              });
            const quoteLines = new Map(
              input.quote.lines.map((line) => [line.product.id, line.quantity]),
            );
            if (
              quoteLines.size !== reservationLines.size ||
              [...reservationLines].some(
                ([productId, line]) =>
                  this.toQuantityUnits(quoteLines.get(productId) ?? '0') !==
                  this.toQuantityUnits(line.quantity),
              )
            )
              throw new PosReservationNotAvailableError('LINES_MISMATCH');
          }
          if (effectiveCustomerId) {
            const [customer] = await manager.query<
              Array<{
                id: string;
                enabled: number | boolean | null;
                credit_limit: string | null;
                currency: string | null;
                term_days: number | string | null;
                max_installments: number | string | null;
              }>
            >(
              `SELECT c.id, ccp.enabled, ccp.credit_limit, ccp.currency,
                      ccp.term_days, ccp.max_installments
               FROM customers c
               LEFT JOIN customer_credit_profiles ccp
                 ON ccp.customer_id = c.id AND ccp.tenant_id = c.tenant_id
               WHERE c.id = ? AND c.tenant_id = ? AND c.active = TRUE
                 AND c.privacy_status = 'ACTIVE' FOR UPDATE`,
              [effectiveCustomerId, input.tenantId],
            );
            if (!customer) throw new PosCustomerNotAvailableError();
            if (input.credit) {
              if (
                !customer.enabled ||
                !customer.credit_limit ||
                !customer.currency ||
                customer.term_days === null ||
                customer.max_installments === null
              )
                throw new CustomerCreditNotAvailableError('DISABLED');
              if (customer.currency !== input.quote.currency)
                throw new CustomerCreditNotAvailableError('CURRENCY');
              if (
                input.credit.installmentCount >
                Number(customer.max_installments)
              )
                throw new CustomerCreditNotAvailableError('INSTALLMENTS');
              creditProfile = {
                credit_limit: customer.credit_limit,
                currency: customer.currency,
                term_days: customer.term_days,
                max_installments: customer.max_installments,
              };
              const [exposure] = await manager.query<
                Array<{ balance: string }>
              >(
                `SELECT COALESCE(SUM(CASE WHEN entry_type = 'DEBIT'
                    THEN amount ELSE -amount END), 0) AS balance
                 FROM customer_debt_ledger
                 WHERE tenant_id = ? AND customer_id = ?`,
                [input.tenantId, effectiveCustomerId],
              );
              const currentBalance = this.toMoney(exposure?.balance ?? '0');
              const limit = this.toMoney(customer.credit_limit);
              const requested = this.toMoney(input.quote.totals.total);
              if (currentBalance + requested > limit) {
                throw new CustomerCreditLimitExceededError(
                  this.money(currentBalance),
                  this.money(limit),
                );
              }
            }
          }
          const [openShift] = await manager.query<Array<{ id: string }>>(
            `SELECT id FROM cash_register_shifts
             WHERE id = ? AND tenant_id = ? AND branch_id = ?
               AND cash_register_id = ? AND opened_by_user_id = ?
               AND status = 'OPEN' LIMIT 1 FOR UPDATE`,
            [
              input.cashRegisterShiftId,
              input.tenantId,
              input.quote.context.branch.id,
              input.quote.context.cashRegister.id,
              input.userId,
            ],
          );
          if (!openShift) throw new CashRegisterShiftRequiredError();
          const allocations = new Map<string, StockAllocation[]>();
          let insufficientProductId: string | null = null;
          for (const line of [...input.quote.lines].sort((left, right) =>
            left.product.id.localeCompare(right.product.id),
          )) {
            const serialsByLocation = new Map<string, string[]>();
            if (line.serialNumbers.length > 0) {
              const placeholders = line.serialNumbers.map(() => '?').join(',');
              const serialRows = await manager.query<
                Array<{ serial_number: string; current_location_id: string }>
              >(
                `SELECT serial_number, current_location_id FROM inventory_serials
                 WHERE tenant_id = ? AND product_id = ?
                   AND status = ?
                   AND normalized_serial IN (${placeholders})
                 ORDER BY normalized_serial FOR UPDATE`,
                [
                  input.tenantId,
                  line.product.id,
                  input.reservationId ? 'RESERVED' : 'AVAILABLE',
                  ...line.serialNumbers.map((value) =>
                    value.trim().toUpperCase(),
                  ),
                ],
              );
              for (const serial of serialRows) {
                serialsByLocation.set(serial.current_location_id, [
                  ...(serialsByLocation.get(serial.current_location_id) ?? []),
                  serial.serial_number,
                ]);
              }
            }
            const balances = await manager.query<
              Array<{
                location_id: string;
                quantity: string;
                available_quantity: string;
                reserved_quantity: string;
                lot_quantity: string | null;
              }>
            >(
              `SELECT ib.location_id, ib.quantity, ib.available_quantity, ib.reserved_quantity,
                      CASE WHEN ? IS NULL THEN
                        CASE WHEN p.track_lots THEN COALESCE((
                          SELECT SUM(ilb.quantity) FROM inventory_lot_balances ilb
                          INNER JOIN inventory_lots il
                            ON il.id = ilb.lot_id AND il.tenant_id = ilb.tenant_id
                          WHERE ilb.tenant_id = ib.tenant_id
                            AND ilb.location_id = ib.location_id
                            AND il.product_id = ib.product_id
                            AND (il.expires_on IS NULL OR il.expires_on >= ?)
                        ), 0) ELSE NULL END
                      ELSE COALESCE((
                        SELECT ilb.quantity FROM inventory_lot_balances ilb
                        INNER JOIN inventory_lots il
                          ON il.id = ilb.lot_id AND il.tenant_id = ilb.tenant_id
                        WHERE ilb.tenant_id = ib.tenant_id
                          AND ilb.location_id = ib.location_id
                          AND il.product_id = ib.product_id AND il.id = ?
                      ), 0) END AS lot_quantity

             FROM inventory_balances ib
             INNER JOIN locations l ON l.id = ib.location_id AND l.tenant_id = ib.tenant_id
             INNER JOIN products p ON p.id = ib.product_id AND p.tenant_id = ib.tenant_id
             WHERE ib.tenant_id = ? AND ib.product_id = ? AND l.warehouse_id = ?
               AND (? IS NULL OR ib.location_id = ?)
             ORDER BY l.created_at, l.id FOR UPDATE`,
              [
                line.lotId,
                input.quote.context.businessDate ??
                  new Date().toISOString().slice(0, 10),
                line.lotId,
                input.tenantId,
                line.product.id,
                input.quote.context.warehouse.id,
                reservedLocationId,
                reservedLocationId,
              ],
            );
            let remaining = this.toQuantityUnits(line.quantity);
            const lineAllocations: StockAllocation[] = [];
            for (const balance of balances) {
              if (remaining === 0n) break;
              const available = this.toQuantityUnits(
                input.reservationId
                  ? balance.reserved_quantity
                  : balance.available_quantity,
              );
              const lotAvailable =
                balance.lot_quantity !== null
                  ? this.toQuantityUnits(balance.lot_quantity)
                  : available;
              const total = this.toQuantityUnits(balance.quantity);
              const currentAvailable = this.toQuantityUnits(
                balance.available_quantity,
              );
              const currentReserved = this.toQuantityUnits(
                balance.reserved_quantity,
              );
              const effectiveAvailable =
                available < lotAvailable ? available : lotAvailable;
              const serialNumbers = serialsByLocation.get(balance.location_id);
              const serialAvailable = line.serialNumbers.length
                ? BigInt(serialNumbers?.length ?? 0) * 1000n
                : effectiveAvailable;
              const selectableAvailable =
                effectiveAvailable < serialAvailable
                  ? effectiveAvailable
                  : serialAvailable;
              const taken =
                selectableAvailable < remaining
                  ? selectableAvailable
                  : remaining;
              if (taken === 0n) continue;
              lineAllocations.push({
                locationId: balance.location_id,
                quantityChange: this.fromQuantityUnits(-taken),
                resultingQuantity: this.fromQuantityUnits(total - taken),
                resultingAvailableQuantity: this.fromQuantityUnits(
                  input.reservationId
                    ? currentAvailable
                    : currentAvailable - taken,
                ),
                resultingReservedQuantity: this.fromQuantityUnits(
                  input.reservationId
                    ? currentReserved - taken
                    : currentReserved,
                ),
                reservationLineId: reservationLines.get(line.product.id)?.id,
                serialNumbers: serialNumbers?.slice(0, Number(taken / 1000n)),
              });
              if (serialNumbers) {
                serialsByLocation.set(
                  balance.location_id,
                  serialNumbers.slice(Number(taken / 1000n)),
                );
              }
              remaining -= taken;
            }
            allocations.set(line.product.id, lineAllocations);
            if (remaining > 0n) insufficientProductId = line.product.id;
          }
          const replayAfterLock = await this.findWithManager(
            manager,
            input.tenantId,
            input.idempotencyKey,
          );
          if (replayAfterLock) {
            if (replayAfterLock.fingerprint !== input.fingerprint)
              throw new PosIdempotencyConflictError();
            return { sale: replayAfterLock.sale, replay: true };
          }
          if (insufficientProductId) {
            throw new PosInsufficientStockError(insufficientProductId);
          }
          const saleId = randomUUID();
          const receiptNumber = `V-${saleId.replaceAll('-', '').slice(0, 12).toUpperCase()}`;
          await manager.query(
            `INSERT INTO sales
            (id, tenant_id, branch_id, warehouse_id, cash_register_id,
             cash_register_shift_id, created_by_user_id, customer_id, reservation_id, quotation_id,
             receipt_number, currency, tax_rate, gross_total, line_discount_total,
             sale_discount_total, discount_total, discount_type, discount_value,
             discount_reason, subtotal, tax_total, total, status, idempotency_key,
             request_fingerprint)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'COMPLETED', ?, ?)`,
            [
              saleId,
              input.tenantId,
              input.quote.context.branch.id,
              input.quote.context.warehouse.id,
              input.quote.context.cashRegister.id,
              input.cashRegisterShiftId,
              input.userId,
              effectiveCustomerId,
              input.reservationId ?? null,
              input.quotationId ?? null,
              receiptNumber,
              input.quote.currency,
              input.quote.taxRate,
              input.quote.totals.gross,
              input.quote.totals.lineDiscount,
              input.quote.totals.saleDiscount,
              input.quote.totals.discount,
              input.quote.discount?.type ?? null,
              input.quote.discount?.value ?? null,
              input.quote.discount?.reason ?? null,
              input.quote.totals.subtotal,
              input.quote.totals.tax,
              input.quote.totals.total,
              input.idempotencyKey,
              input.fingerprint,
            ],
          );
          for (const [index, line] of input.quote.lines.entries()) {
            const saleLineId = randomUUID();
            const [productCost] = await manager.query<Array<{ cost: string }>>(
              `SELECT cost FROM products WHERE id = ? AND tenant_id = ? LIMIT 1`,
              [line.product.id, input.tenantId],
            );
            if (!productCost) throw new Error('SALE_PRODUCT_COST_NOT_FOUND');
            await manager.query(
              `INSERT INTO sale_lines
              (id, tenant_id, sale_id, line_number, product_id, product_name,
               product_sku, quantity, unit_price, price_source, price_list_id,
               price_list_name, unit_cost, gross_total, line_discount_total,
               sale_discount_total, discount_total, discount_type, discount_value,
               discount_reason, expired_lot_override_reason, subtotal, tax, total)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
              [
                saleLineId,
                input.tenantId,
                saleId,
                index + 1,
                line.product.id,
                line.product.name,
                line.product.sku,
                line.quantity,
                line.unitPrice,
                line.priceSource,
                line.priceList?.id ?? null,
                line.priceList?.name ?? null,
                productCost.cost,
                line.grossTotal,
                line.discount.line?.amount ?? '0.00',
                line.discount.sale?.amount ?? '0.00',
                line.discount.total,
                line.discount.line?.type ?? null,
                line.discount.line?.value ?? null,
                line.discount.line?.reason ?? null,
                line.expiredLotOverrideReason,
                line.subtotal,
                line.tax,
                line.total,
              ],
            );
            for (const [allocationIndex, allocation] of (
              allocations.get(line.product.id) ?? []
            ).entries()) {
              const movementId = randomUUID();
              await manager.query(
                `UPDATE inventory_balances
                 SET quantity = ?, available_quantity = ?, reserved_quantity = ?
               WHERE tenant_id = ? AND product_id = ? AND location_id = ?`,
                [
                  allocation.resultingQuantity,
                  allocation.resultingAvailableQuantity,
                  allocation.resultingReservedQuantity,
                  input.tenantId,
                  line.product.id,
                  allocation.locationId,
                ],
              );
              const movementKey = `sale:${saleId}:${index + 1}:${allocationIndex + 1}`;
              const movementFingerprint = createHash('sha256')
                .update(
                  JSON.stringify({
                    saleId,
                    saleLineId,
                    productId: line.product.id,
                    locationId: allocation.locationId,
                    quantityChange: allocation.quantityChange,
                  }),
                )
                .digest('hex');
              await manager.query(
                `INSERT INTO inventory_movements
                (id, tenant_id, product_id, location_id, type, quantity_change,
                 resulting_quantity, reason, reference, idempotency_key,
                 request_fingerprint, created_by_user_id, sale_id, sale_line_id,
                 reservation_id, reservation_line_id)
               VALUES (?, ?, ?, ?, 'SALE', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                [
                  movementId,
                  input.tenantId,
                  line.product.id,
                  allocation.locationId,
                  allocation.quantityChange,
                  allocation.resultingQuantity,
                  `Venta ${receiptNumber}`,
                  receiptNumber,
                  movementKey,
                  movementFingerprint,
                  input.userId,
                  saleId,
                  saleLineId,
                  input.reservationId ?? null,
                  allocation.reservationLineId ?? null,
                ],
              );
              await applyInventoryValuation(manager, movementId);
              await applyInventoryLotTracking(manager, movementId, {
                preferredLotId: line.lotId ?? undefined,
                allowExpired: Boolean(line.expiredLotOverrideReason),
              });
              await applyInventorySerialTracking(manager, movementId, {
                serialNumbers: allocation.serialNumbers,
              });
            }
          }
          let creditAccountId: string | null = null;
          if (input.credit && effectiveCustomerId && creditProfile) {
            creditAccountId = randomUUID();
            const termDays = Number(creditProfile.term_days);
            await manager.query(
              `INSERT INTO customer_credit_accounts
                (id, tenant_id, customer_id, sale_id, currency, original_amount,
                 installment_count, term_days, due_date, created_by_user_id)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, DATE_ADD(CURRENT_DATE(), INTERVAL ? DAY), ?)`,
              [
                creditAccountId,
                input.tenantId,
                effectiveCustomerId,
                saleId,
                creditProfile.currency,
                input.quote.totals.total,
                input.credit.installmentCount,
                termDays,
                termDays,
                input.userId,
              ],
            );
            const totalCents = this.toMoney(input.quote.totals.total);
            const count = BigInt(input.credit.installmentCount);
            const baseAmount = totalCents / count;
            const remainder = totalCents % count;
            for (
              let index = 0;
              index < input.credit.installmentCount;
              index++
            ) {
              const amount = baseAmount + (BigInt(index) < remainder ? 1n : 0n);
              const dueOffset = Math.ceil(
                (termDays * (index + 1)) / input.credit.installmentCount,
              );
              await manager.query(
                `INSERT INTO customer_credit_installments
                  (id, tenant_id, account_id, installment_number, due_date, amount)
                 VALUES (?, ?, ?, ?, DATE_ADD(CURRENT_DATE(), INTERVAL ? DAY), ?)`,
                [
                  randomUUID(),
                  input.tenantId,
                  creditAccountId,
                  index + 1,
                  dueOffset,
                  this.money(amount),
                ],
              );
            }
            await manager.query(
              `INSERT INTO customer_debt_ledger
                (id, tenant_id, customer_id, account_id, sale_id, entry_type,
                 amount, reference_type, idempotency_key, created_by_user_id)
               VALUES (?, ?, ?, ?, ?, 'DEBIT', ?, 'SALE', ?, ?)`,
              [
                randomUUID(),
                input.tenantId,
                effectiveCustomerId,
                creditAccountId,
                saleId,
                input.quote.totals.total,
                `sale-credit:${input.idempotencyKey}`,
                input.userId,
              ],
            );
            await manager.query(
              `INSERT INTO sale_payments
                (id, tenant_id, sale_id, method, provider, external_reference,
                 provider_reference, authorization_code, authorization_status,
                 currency, amount_received, amount_applied, change_amount, status)
               VALUES (?, ?, ?, 'CREDIT', 'CUSTOMER_CREDIT', NULL, ?, NULL,
                 'PENDING', ?, 0, ?, 0, 'PENDING')`,
              [
                randomUUID(),
                input.tenantId,
                saleId,
                creditAccountId,
                input.quote.currency,
                input.quote.totals.total,
              ],
            );
          }
          for (const payment of input.payments) {
            await manager.query(
              `INSERT INTO sale_payments
              (id, tenant_id, sale_id, method, provider, external_reference,
               provider_reference, authorization_code, authorization_status,
               currency, amount_received, amount_applied, change_amount)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'APPROVED', ?, ?, ?, ?)`,
              [
                randomUUID(),
                input.tenantId,
                saleId,
                payment.method,
                payment.provider,
                payment.reference,
                payment.providerReference,
                payment.authorizationCode,
                input.quote.currency,
                payment.amountReceived,
                payment.amountApplied,
                payment.change,
              ],
            );
          }
          if (input.suspendedSaleId) {
            const resumed = await manager.query<{ affectedRows?: number }>(
              `UPDATE suspended_sales
               SET status = 'RESUMED', resumed_at = CURRENT_TIMESTAMP(6), completed_sale_id = ?
               WHERE id = ? AND tenant_id = ? AND status = 'ACTIVE'`,
              [saleId, input.suspendedSaleId, input.tenantId],
            );
            if (Number(resumed.affectedRows ?? 0) !== 1)
              throw new SuspendedSaleStateError('CANCELLED');
          }
          await this.receipts.createSnapshot(manager, input.tenantId, saleId);
          if (input.reservationId) {
            const closed = await manager.query<{ affectedRows?: number }>(
              `UPDATE product_reservations
               SET status = 'CONSUMED', closed_by_user_id = ?,
                   closed_at = CURRENT_TIMESTAMP(6), closure_reason = ?,
                   closed_idempotency_key = ?, closed_request_fingerprint = ?, sale_id = ?
               WHERE id = ? AND tenant_id = ? AND status = 'ACTIVE'`,
              [
                input.userId,
                `Consumida en venta ${receiptNumber}`,
                input.idempotencyKey,
                input.fingerprint,
                saleId,
                input.reservationId,
                input.tenantId,
              ],
            );
            if (Number(closed.affectedRows ?? 0) !== 1)
              throw new PosReservationNotAvailableError();
          }
          const created = await this.findWithManager(
            manager,
            input.tenantId,
            input.idempotencyKey,
          );
          if (!created) throw new Error('CREATED_SALE_NOT_FOUND');
          return { sale: created.sale, replay: false };
        },
      );
    } catch (error) {
      if (!this.isDuplicate(error)) throw error;
      const replay = await this.findByIdempotency(
        input.tenantId,
        input.idempotencyKey,
      );
      if (!replay) throw new PaymentReferenceConflictError();
      if (replay.fingerprint !== input.fingerprint)
        throw new PosIdempotencyConflictError();
      return { sale: replay.sale, replay: true };
    }
  }

  private async findWithManager(
    manager: EntityManager,
    tenantId: string,
    idempotencyKey: string,
  ): Promise<{ sale: CashSaleData; fingerprint: string } | null> {
    const rows = await manager.query<SaleRow[]>(
      `SELECT s.id, s.receipt_number, s.status, s.created_by_user_id,
              c.id AS customer_id, c.name AS customer_name,
              c.identifier AS customer_identifier,
              q.id AS quotation_id, q.quotation_number,
              s.currency, s.tax_rate, s.gross_total, s.line_discount_total,
              s.sale_discount_total, s.discount_total, s.discount_type,
              s.discount_value, s.discount_reason, s.subtotal, s.tax_total, s.total,
              s.request_fingerprint, s.created_at, s.voided_by_user_id,
              vu.email AS voided_by_email, s.void_reason, s.voided_at,
              b.id AS branch_id, b.name AS branch_name,
              w.id AS warehouse_id, w.name AS warehouse_name,
              cr.id AS cash_register_id, cr.name AS cash_register_name,
              cr.code AS cash_register_code
       FROM sales s
       INNER JOIN branches b ON b.id = s.branch_id AND b.tenant_id = s.tenant_id
       INNER JOIN warehouses w ON w.id = s.warehouse_id AND w.tenant_id = s.tenant_id
       INNER JOIN cash_registers cr ON cr.id = s.cash_register_id AND cr.tenant_id = s.tenant_id
       LEFT JOIN users vu ON vu.id = s.voided_by_user_id AND vu.tenant_id = s.tenant_id
       LEFT JOIN customers c ON c.id = s.customer_id AND c.tenant_id = s.tenant_id
       LEFT JOIN sales_quotations q ON q.id = s.quotation_id AND q.tenant_id = s.tenant_id
       WHERE s.tenant_id = ? AND s.idempotency_key = ? LIMIT 1`,
      [tenantId, idempotencyKey],
    );
    if (!rows[0]) return null;
    const row = rows[0];
    const lines = await manager.query<
      Array<{
        id: string;
        product_id: string;
        product_name: string;
        product_sku: string;
        quantity: string;
        unit_price: string;
        price_source: 'BASE' | 'PRICE_LIST';
        price_list_id: string | null;
        price_list_name: string | null;
        unit_cost: string;
        gross_total: string;
        line_discount_total: string;
        sale_discount_total: string;
        discount_total: string;
        discount_type: 'PERCENT' | 'AMOUNT' | null;
        discount_value: string | null;
        discount_reason: string | null;
        expired_lot_override_reason: string | null;
        subtotal: string;
        tax: string;
        total: string;
      }>
    >(
      `SELECT id, product_id, product_name, product_sku, quantity, unit_price,
              price_source, price_list_id, price_list_name, unit_cost,
              gross_total, line_discount_total, sale_discount_total,
              discount_total, discount_type, discount_value, discount_reason,
              expired_lot_override_reason,
              subtotal, tax, total
       FROM sale_lines WHERE tenant_id = ? AND sale_id = ? ORDER BY line_number`,
      [tenantId, row.id],
    );
    const paymentRows = await manager.query<
      Array<{
        id: string;
        method: PaymentMethod;
        status: 'COMPLETED' | 'PENDING' | 'REVERSED';
        amount_received: string;
        amount_applied: string;
        change_amount: string;
        external_reference: string | null;
        provider: string;
        authorization_code: string | null;
      }>
    >(
      `SELECT id, method, status, amount_received, amount_applied, change_amount,
              external_reference, provider, authorization_code
       FROM sale_payments WHERE tenant_id = ? AND sale_id = ? ORDER BY created_at, id`,
      [tenantId, row.id],
    );
    const payments: SalePaymentData[] = paymentRows.map((payment) => ({
      id: payment.id,
      method: payment.method,
      status: payment.status,
      amountReceived: this.decimal(payment.amount_received, 2),
      amountApplied: this.decimal(payment.amount_applied, 2),
      change: this.decimal(payment.change_amount, 2),
      reference: payment.external_reference,
      provider: payment.provider,
      authorizationCode: payment.authorization_code,
    }));
    if (!payments[0]) throw new Error('SALE_PAYMENT_NOT_FOUND');
    const [creditAccount] = await manager.query<
      Array<{
        id: string;
        currency: string;
        original_amount: string;
        term_days: number | string;
        due_date: Date | string;
        canceled_at: Date | string | null;
        balance: string;
        overdue_amount: string;
      }>
    >(
      `SELECT cca.id, cca.currency, cca.original_amount, cca.term_days,
              cca.due_date, cca.canceled_at,
              COALESCE((SELECT SUM(CASE WHEN cdl.entry_type = 'DEBIT'
                THEN cdl.amount ELSE -cdl.amount END)
                FROM customer_debt_ledger cdl
                WHERE cdl.account_id = cca.id AND cdl.tenant_id = cca.tenant_id), 0)
                AS balance,
              GREATEST(COALESCE((SELECT SUM(cci.amount)
                FROM customer_credit_installments cci
                WHERE cci.account_id = cca.id AND cci.tenant_id = cca.tenant_id
                  AND cci.due_date < CURRENT_DATE()), 0)
                - GREATEST(cca.original_amount - COALESCE((SELECT SUM(
                  CASE WHEN cdl.entry_type = 'DEBIT' THEN cdl.amount ELSE -cdl.amount END)
                  FROM customer_debt_ledger cdl
                  WHERE cdl.account_id = cca.id AND cdl.tenant_id = cca.tenant_id), 0), 0), 0)
                AS overdue_amount
       FROM customer_credit_accounts cca
       WHERE cca.tenant_id = ? AND cca.sale_id = ?
       LIMIT 1`,
      [tenantId, row.id],
    );
    const creditInstallments = creditAccount
      ? await manager.query<
          Array<{
            installment_number: number | string;
            due_date: Date | string;
            amount: string;
          }>
        >(
          `SELECT installment_number, due_date, amount
           FROM customer_credit_installments
           WHERE tenant_id = ? AND account_id = ?
           ORDER BY installment_number`,
          [tenantId, creditAccount.id],
        )
      : [];
    const creditBalance = this.toMoney(creditAccount?.balance ?? '0');
    const creditOverdue = this.toMoney(creditAccount?.overdue_amount ?? '0');
    const credit = creditAccount
      ? {
          accountId: creditAccount.id,
          originalAmount: this.decimal(creditAccount.original_amount, 2),
          balance: this.money(creditBalance),
          currency: creditAccount.currency,
          termDays: Number(creditAccount.term_days),
          status: creditAccount.canceled_at
            ? ('CANCELLED' as const)
            : creditBalance <= 0n
              ? ('PAID' as const)
              : creditOverdue > 0n
                ? ('OVERDUE' as const)
                : ('OPEN' as const),
          dueDate: this.date(creditAccount.due_date),
          installments: creditInstallments.map((installment) => ({
            number: Number(installment.installment_number),
            dueDate: this.date(installment.due_date),
            amount: this.decimal(installment.amount, 2),
          })),
        }
      : null;
    const grossProfit = lines.reduce(
      (sum, line) =>
        sum +
        this.toMoney(line.subtotal) -
        this.roundDivide(
          this.toMoney(line.unit_cost) * this.toQuantityUnits(line.quantity),
          1000n,
        ),
      0n,
    );
    return {
      fingerprint: row.request_fingerprint,
      sale: {
        id: row.id,
        receiptNumber: row.receipt_number,
        status: row.status,
        context: {
          branch: { id: row.branch_id, name: row.branch_name },
          warehouse: { id: row.warehouse_id, name: row.warehouse_name },
          cashRegister: {
            id: row.cash_register_id,
            name: row.cash_register_name,
            code: row.cash_register_code,
          },
        },
        userId: row.created_by_user_id,
        customer: row.customer_id
          ? {
              id: row.customer_id,
              name: row.customer_name!,
              identifier: row.customer_identifier,
            }
          : null,
        quotation: row.quotation_id
          ? { id: row.quotation_id, quotationNumber: row.quotation_number! }
          : null,
        currency: row.currency,
        taxRate: this.decimal(row.tax_rate, 4),
        discount: row.discount_type
          ? {
              type: row.discount_type,
              value: this.decimal(row.discount_value!, 2),
              reason: row.discount_reason!,
              amount: this.decimal(row.sale_discount_total, 2),
            }
          : null,
        lines: lines.map((line) => ({
          id: line.id,
          product: {
            id: line.product_id,
            name: line.product_name,
            sku: line.product_sku,
          },
          quantity: this.decimal(line.quantity, 3),
          expiredLotOverrideReason: line.expired_lot_override_reason,
          unitPrice: this.decimal(line.unit_price, 2),
          priceSource: line.price_source,
          priceList: line.price_list_id
            ? { id: line.price_list_id, name: line.price_list_name! }
            : null,
          grossTotal: this.decimal(line.gross_total, 2),
          discount: {
            line: line.discount_type
              ? {
                  type: line.discount_type,
                  value: this.decimal(line.discount_value!, 2),
                  reason: line.discount_reason!,
                  amount: this.decimal(line.line_discount_total, 2),
                }
              : null,
            sale: row.discount_type
              ? {
                  type: row.discount_type,
                  value: this.decimal(row.discount_value!, 2),
                  reason: row.discount_reason!,
                  amount: this.decimal(line.sale_discount_total, 2),
                }
              : null,
            total: this.decimal(line.discount_total, 2),
          },
          subtotal: this.decimal(line.subtotal, 2),
          tax: this.decimal(line.tax, 2),
          total: this.decimal(line.total, 2),
          grossProfit: this.money(
            this.toMoney(line.subtotal) -
              this.roundDivide(
                this.toMoney(line.unit_cost) *
                  this.toQuantityUnits(line.quantity),
                1000n,
              ),
          ),
        })),
        totals: {
          gross: this.decimal(row.gross_total, 2),
          lineDiscount: this.decimal(row.line_discount_total, 2),
          saleDiscount: this.decimal(row.sale_discount_total, 2),
          discount: this.decimal(row.discount_total, 2),
          subtotal: this.decimal(row.subtotal, 2),
          tax: this.decimal(row.tax_total, 2),
          total: this.decimal(row.total, 2),
          grossProfit: this.money(grossProfit),
        },
        payment: payments[0],
        payments,
        credit,
        createdAt: new Date(row.created_at).toISOString(),
        void:
          row.voided_by_user_id &&
          row.voided_by_email &&
          row.void_reason &&
          row.voided_at
            ? {
                reason: row.void_reason,
                user: { id: row.voided_by_user_id, email: row.voided_by_email },
                voidedAt: new Date(row.voided_at).toISOString(),
              }
            : null,
      },
    };
  }

  private async findVoidByKey(
    manager: EntityManager,
    tenantId: string,
    idempotencyKey: string,
  ): Promise<{ saleId: string; fingerprint: string } | null> {
    const [row] = await manager.query<
      Array<{ id: string; void_request_fingerprint: string }>
    >(
      `SELECT id, void_request_fingerprint FROM sales
       WHERE tenant_id = ? AND void_idempotency_key = ? LIMIT 1`,
      [tenantId, idempotencyKey],
    );
    return row
      ? { saleId: row.id, fingerprint: row.void_request_fingerprint }
      : null;
  }

  private decimal(value: string, scale: number): string {
    const [whole, fraction = ''] = value.split('.');
    return `${whole}.${fraction.padEnd(scale, '0').slice(0, scale)}`;
  }

  private date(value: Date | string): string {
    if (value instanceof Date) return value.toISOString().slice(0, 10);
    return String(value).slice(0, 10);
  }

  private toQuantityUnits(value: string): bigint {
    const negative = value.startsWith('-');
    const unsigned = negative ? value.slice(1) : value;
    const [whole, fraction = ''] = unsigned.split('.');
    const units = BigInt(whole) * 1000n + BigInt(fraction.padEnd(3, '0'));
    return negative ? -units : units;
  }

  private fromQuantityUnits(value: bigint): string {
    const sign = value < 0n ? '-' : '';
    const absolute = value < 0n ? -value : value;
    return `${sign}${absolute / 1000n}.${String(absolute % 1000n).padStart(3, '0')}`;
  }

  private toMoney(value: string): bigint {
    const negative = value.startsWith('-');
    const unsigned = negative ? value.slice(1) : value;
    const [whole, fraction = ''] = unsigned.split('.');
    const cents = BigInt(whole) * 100n + BigInt(fraction.padEnd(2, '0'));
    return negative ? -cents : cents;
  }

  private money(value: bigint): string {
    const sign = value < 0n ? '-' : '';
    const absolute = value < 0n ? -value : value;
    return `${sign}${absolute / 100n}.${String(absolute % 100n).padStart(2, '0')}`;
  }

  private roundDivide(numerator: bigint, denominator: bigint): bigint {
    return (numerator + denominator / 2n) / denominator;
  }

  private isDuplicate(error: unknown): boolean {
    return (
      error instanceof QueryFailedError &&
      (error.driverError as { errno?: number }).errno === 1062
    );
  }
}
