import { Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { ResultSetHeader } from 'mysql2';
import { DataSource, EntityManager, QueryFailedError } from 'typeorm';
import { ListPurchaseOrdersDto } from './dto/list-purchase-orders.dto';
import {
  PurchaseOrderLineDto,
  SavePurchaseOrderDto,
} from './dto/save-purchase-order.dto';
import { UpdatePurchaseOrderDto } from './dto/update-purchase-order.dto';
import {
  PurchaseOrderReferenceError,
  PurchaseOrderIdempotencyConflictError,
  PurchaseOrderNotFoundError,
  PurchaseOrderStateError,
  PurchaseOrderVersionConflictError,
} from './purchase-order.errors';
import {
  PurchaseOrderData,
  PurchaseOrderLineData,
  PurchaseOrderStatus,
  PurchaseOrderTransitionData,
} from './purchase-order.types';

interface OrderRow {
  id: string;
  folio: string;
  supplier_id: string;
  supplier_name: string;
  currency: string;
  status: PurchaseOrderStatus;
  notes: string | null;
  subtotal: string;
  total: string;
  version: number | string;
  created_at: Date | string;
  updated_at: Date | string;
  approved_at: Date | string | null;
  sent_at: Date | string | null;
  cancelled_at: Date | string | null;
  cancellation_reason: string | null;
}

interface TransitionRow {
  id: string;
  purchase_order_id: string;
  from_status: PurchaseOrderStatus;
  to_status: PurchaseOrderStatus;
  reason: string | null;
  delivery_mode: 'SIMULATED' | null;
  delivery_recipient: string | null;
  created_at: Date | string;
}

interface IdempotencyRow {
  purchase_order_id: string;
  to_status: PurchaseOrderStatus;
  request_fingerprint: string;
}

interface LineRow {
  id: string;
  purchase_order_id: string;
  supplier_product_id: string;
  product_id: string;
  product_name: string;
  product_sku: string;
  supplier_code: string;
  quantity: string;
  received_quantity: string;
  unit_cost: string;
  subtotal: string;
  notes: string | null;
}

interface ReceiptRow {
  id: string;
  purchase_order_id: string;
  document_reference: string;
  overage_reason: string | null;
  location_id: string;
  location_name: string;
  location_code: string;
  responsible_id: string;
  responsible_email: string;
  created_at: Date | string;
}

interface ReceiptLineRow {
  id: string;
  receipt_id: string;
  purchase_order_line_id: string;
  received_quantity: string;
  overage_quantity: string;
  unit_cost: string;
  total_cost: string;
  previous_catalog_cost: string;
  resulting_catalog_cost: string;
  returned_quantity: string;
}

interface ReturnRow {
  id: string;
  purchase_order_id: string;
  purchase_receipt_id: string;
  document_reference: string;
  reason: string;
  status: 'CREDIT_PENDING' | 'CREDIT_RECEIVED';
  expected_credit_total: string;
  credit_document_reference: string | null;
  location_id: string;
  location_name: string;
  location_code: string;
  responsible_id: string;
  responsible_email: string;
  created_at: Date | string;
}

interface ReturnLineRow {
  id: string;
  purchase_return_id: string;
  purchase_receipt_line_id: string;
  product_id: string;
  returned_quantity: string;
  unit_cost: string;
  total_cost: string;
}

interface LineReferenceRow {
  id: string;
  product_id: string;
  product_name: string;
  product_sku: string;
  supplier_code: string;
  price_currency: string | null;
}

interface PersistedLine {
  input: PurchaseOrderLineDto;
  reference: LineReferenceRow;
  subtotal: string;
}

@Injectable()
export class PurchaseOrderRepository {
  constructor(private readonly dataSource: DataSource) {}

  async create(
    tenantId: string,
    actorUserId: string,
    dto: SavePurchaseOrderDto,
  ): Promise<PurchaseOrderData> {
    return this.dataSource.transaction(async (manager) => {
      const lines = await this.prepareLines(manager, tenantId, dto);
      const total = this.total(lines);
      const id = randomUUID();
      const folio = await this.nextFolio(manager, tenantId);
      await manager.query(
        `INSERT INTO purchase_orders
          (id, tenant_id, folio, supplier_id, currency, status, notes,
           subtotal, total, created_by_user_id)
         VALUES (?, ?, ?, ?, ?, 'DRAFT', ?, ?, ?, ?)`,
        [
          id,
          tenantId,
          folio,
          dto.supplierId,
          dto.currency,
          dto.notes ?? null,
          total,
          total,
          actorUserId,
        ],
      );
      await this.insertLines(manager, tenantId, id, lines);
      return (await this.find(manager, tenantId, id))!;
    });
  }

  async update(
    tenantId: string,
    id: string,
    dto: UpdatePurchaseOrderDto,
  ): Promise<PurchaseOrderData | null> {
    return this.dataSource.transaction(async (manager) => {
      const current = await this.find(manager, tenantId, id, true);
      if (!current) return null;
      if (current.version !== dto.version) {
        throw new PurchaseOrderVersionConflictError(current.version);
      }
      if (current.status !== 'DRAFT') {
        throw new PurchaseOrderStateError(current.status);
      }
      const lines = await this.prepareLines(manager, tenantId, dto);
      const total = this.total(lines);
      const result = await manager.query<ResultSetHeader>(
        `UPDATE purchase_orders
         SET supplier_id = ?, currency = ?, notes = ?, subtotal = ?, total = ?,
             version = version + 1
         WHERE id = ? AND tenant_id = ? AND version = ? AND status = 'DRAFT'`,
        [
          dto.supplierId,
          dto.currency,
          dto.notes ?? null,
          total,
          total,
          id,
          tenantId,
          dto.version,
        ],
      );
      if (result.affectedRows === 0) {
        const fresh = await this.find(manager, tenantId, id);
        if (!fresh) return null;
        if (fresh.status !== 'DRAFT')
          throw new PurchaseOrderStateError(fresh.status);
        throw new PurchaseOrderVersionConflictError(fresh.version);
      }
      await manager.query(
        'DELETE FROM purchase_order_lines WHERE purchase_order_id = ? AND tenant_id = ?',
        [id, tenantId],
      );
      await this.insertLines(manager, tenantId, id, lines);
      return this.find(manager, tenantId, id);
    });
  }

  async transition(input: {
    tenantId: string;
    orderId: string;
    actorUserId: string;
    version: number;
    from: PurchaseOrderStatus[];
    to: PurchaseOrderStatus;
    reason?: string;
    delivery?: { mode: 'SIMULATED'; recipient: string | null };
    idempotencyKey: string;
    fingerprint: string;
  }): Promise<{ order: PurchaseOrderData; replay: boolean }> {
    const replay = await this.findTransitionRequest(input);
    if (replay) return replay;
    try {
      return await this.dataSource.transaction(async (manager) => {
        const current = await this.find(
          manager,
          input.tenantId,
          input.orderId,
          true,
        );
        if (!current) throw new PurchaseOrderNotFoundError();
        if (current.version !== input.version) {
          throw new PurchaseOrderVersionConflictError(current.version);
        }
        if (!input.from.includes(current.status)) {
          throw new PurchaseOrderStateError(current.status);
        }
        const metadata = this.transitionMetadata(input);
        const result = await manager.query<ResultSetHeader>(
          `UPDATE purchase_orders
           SET status = ?, version = version + 1, ${metadata.clause}
           WHERE id = ? AND tenant_id = ? AND version = ? AND status = ?`,
          [
            input.to,
            ...metadata.parameters,
            input.orderId,
            input.tenantId,
            input.version,
            current.status,
          ],
        );
        if (result.affectedRows === 0) {
          const fresh = await this.find(manager, input.tenantId, input.orderId);
          if (!fresh) throw new PurchaseOrderNotFoundError();
          if (fresh.version !== input.version) {
            throw new PurchaseOrderVersionConflictError(fresh.version);
          }
          throw new PurchaseOrderStateError(fresh.status);
        }
        await manager.query(
          `INSERT INTO purchase_order_transitions
            (id, tenant_id, purchase_order_id, from_status, to_status, reason,
             delivery_mode, delivery_recipient, idempotency_key,
             request_fingerprint, actor_user_id)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            randomUUID(),
            input.tenantId,
            input.orderId,
            current.status,
            input.to,
            input.reason ?? null,
            input.delivery?.mode ?? null,
            input.delivery?.recipient ?? null,
            input.idempotencyKey,
            input.fingerprint,
            input.actorUserId,
          ],
        );
        return {
          order: (await this.find(manager, input.tenantId, input.orderId))!,
          replay: false,
        };
      });
    } catch (error) {
      if (
        this.isDuplicate(error) ||
        error instanceof PurchaseOrderVersionConflictError ||
        error instanceof PurchaseOrderStateError
      ) {
        const racedReplay = await this.findTransitionRequest(input);
        if (racedReplay) return racedReplay;
      }
      throw error;
    }
  }

  async findSupplierEmail(
    tenantId: string,
    orderId: string,
  ): Promise<string | null> {
    const [row] = await this.dataSource.query<Array<{ email: string | null }>>(
      `SELECT sc.email FROM purchase_orders po
       LEFT JOIN supplier_contacts sc ON sc.supplier_id = po.supplier_id
         AND sc.tenant_id = po.tenant_id AND sc.email IS NOT NULL
       WHERE po.id = ? AND po.tenant_id = ?
       ORDER BY sc.is_primary DESC, sc.created_at, sc.id LIMIT 1`,
      [orderId, tenantId],
    );
    return row?.email ?? null;
  }

  async list(
    tenantId: string,
    query: ListPurchaseOrdersDto,
  ): Promise<{ orders: PurchaseOrderData[]; total: number }> {
    const parameters: Array<string | number> = [tenantId];
    let filter = '';
    if (query.q) {
      filter =
        ' AND (po.folio LIKE ? OR s.legal_name LIKE ? OR s.trade_name LIKE ?)';
      const search = `%${query.q}%`;
      parameters.push(search, search, search);
    }
    const offset = (query.page - 1) * query.pageSize;
    const [rows, [count]] = await Promise.all([
      this.dataSource.query<OrderRow[]>(
        `${this.select()} WHERE po.tenant_id = ?${filter}
         ORDER BY po.updated_at DESC, po.id DESC LIMIT ? OFFSET ?`,
        [...parameters, query.pageSize, offset],
      ),
      this.dataSource.query<Array<{ total: number | string }>>(
        `SELECT COUNT(*) AS total FROM purchase_orders po
         INNER JOIN suppliers s ON s.id = po.supplier_id AND s.tenant_id = po.tenant_id
         WHERE po.tenant_id = ?${filter}`,
        parameters,
      ),
    ]);
    return {
      orders: await this.withLines(this.dataSource.manager, tenantId, rows),
      total: Number(count.total),
    };
  }

  findById(tenantId: string, id: string): Promise<PurchaseOrderData | null> {
    return this.find(this.dataSource.manager, tenantId, id);
  }

  private async prepareLines(
    manager: EntityManager,
    tenantId: string,
    dto: SavePurchaseOrderDto,
  ): Promise<PersistedLine[]> {
    const [supplier] = await manager.query<
      Array<{ exists_value: number | string }>
    >(
      `SELECT EXISTS(
         SELECT 1 FROM suppliers WHERE id = ? AND tenant_id = ? AND active = TRUE
       ) AS exists_value`,
      [dto.supplierId, tenantId],
    );
    if (!Number(supplier.exists_value))
      throw new PurchaseOrderReferenceError('SUPPLIER');

    const ids = dto.lines.map((line) => line.supplierProductId);
    const references = await manager.query<LineReferenceRow[]>(
      `SELECT sp.id, sp.product_id, p.name AS product_name, p.sku AS product_sku,
              sp.supplier_code,
              (SELECT spp.currency FROM supplier_product_prices spp
               WHERE spp.tenant_id = sp.tenant_id AND spp.supplier_product_id = sp.id
               ORDER BY spp.valid_from DESC, spp.created_at DESC, spp.id DESC LIMIT 1
              ) AS price_currency
       FROM supplier_products sp
       INNER JOIN products p ON p.id = sp.product_id AND p.tenant_id = sp.tenant_id
       WHERE sp.tenant_id = ? AND sp.supplier_id = ? AND sp.active = TRUE
         AND p.active = TRUE AND sp.id IN (${ids.map(() => '?').join(',')})`,
      [tenantId, dto.supplierId, ...ids],
    );
    const byId = new Map(
      references.map((reference) => [reference.id, reference]),
    );
    return dto.lines.map((input) => {
      const reference = byId.get(input.supplierProductId);
      if (!reference) throw new PurchaseOrderReferenceError('SUPPLIER_PRODUCT');
      if (reference.price_currency !== dto.currency) {
        throw new PurchaseOrderReferenceError('CURRENCY');
      }
      return {
        input,
        reference,
        subtotal: this.lineSubtotal(input.quantity, input.unitCost),
      };
    });
  }

  private async nextFolio(
    manager: EntityManager,
    tenantId: string,
  ): Promise<string> {
    await manager.query(
      `INSERT INTO purchase_order_sequences (tenant_id, next_number)
       VALUES (?, 1) ON DUPLICATE KEY UPDATE tenant_id = VALUES(tenant_id)`,
      [tenantId],
    );
    const [sequence] = await manager.query<
      Array<{ next_number: number | string }>
    >(
      'SELECT next_number FROM purchase_order_sequences WHERE tenant_id = ? FOR UPDATE',
      [tenantId],
    );
    const number = BigInt(sequence.next_number);
    await manager.query(
      'UPDATE purchase_order_sequences SET next_number = next_number + 1 WHERE tenant_id = ?',
      [tenantId],
    );
    return `OC-${number.toString().padStart(6, '0')}`;
  }

  private async insertLines(
    manager: EntityManager,
    tenantId: string,
    orderId: string,
    lines: PersistedLine[],
  ): Promise<void> {
    for (const [index, line] of lines.entries()) {
      await manager.query(
        `INSERT INTO purchase_order_lines
          (id, tenant_id, purchase_order_id, supplier_product_id, product_id,
           position, supplier_code, product_name, product_sku, quantity,
           unit_cost, subtotal, notes)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          randomUUID(),
          tenantId,
          orderId,
          line.reference.id,
          line.reference.product_id,
          index + 1,
          line.reference.supplier_code,
          line.reference.product_name,
          line.reference.product_sku,
          line.input.quantity,
          line.input.unitCost,
          line.subtotal,
          line.input.notes ?? null,
        ],
      );
    }
  }

  private async find(
    manager: EntityManager,
    tenantId: string,
    id: string,
    lock = false,
  ): Promise<PurchaseOrderData | null> {
    const rows = await manager.query<OrderRow[]>(
      `${this.select()} WHERE po.id = ? AND po.tenant_id = ? LIMIT 1${lock ? ' FOR UPDATE' : ''}`,
      [id, tenantId],
    );
    if (!rows[0]) return null;
    return (await this.withLines(manager, tenantId, rows))[0];
  }

  private async withLines(
    manager: EntityManager,
    tenantId: string,
    rows: OrderRow[],
  ): Promise<PurchaseOrderData[]> {
    if (rows.length === 0) return [];
    const placeholders = rows.map(() => '?').join(',');
    const parameters = [tenantId, ...rows.map((row) => row.id)];
    const [lines, transitions, receipts, returns] = await Promise.all([
      manager.query<LineRow[]>(
        `SELECT id, purchase_order_id, supplier_product_id, product_id,
                product_name, product_sku, supplier_code, quantity,
                received_quantity, unit_cost, subtotal, notes
         FROM purchase_order_lines
         WHERE tenant_id = ? AND purchase_order_id IN (${placeholders})
         ORDER BY purchase_order_id, position`,
        parameters,
      ),
      manager.query<TransitionRow[]>(
        `SELECT id, purchase_order_id, from_status, to_status, reason,
                delivery_mode, delivery_recipient, created_at
         FROM purchase_order_transitions
         WHERE tenant_id = ? AND purchase_order_id IN (${placeholders})
         ORDER BY purchase_order_id, created_at, id`,
        parameters,
      ),
      manager.query<ReceiptRow[]>(
        `SELECT pr.id, pr.purchase_order_id, pr.document_reference,
                pr.overage_reason, pr.location_id, l.name AS location_name,
                l.code AS location_code, pr.received_by_user_id AS responsible_id,
                u.email AS responsible_email, pr.created_at
         FROM purchase_receipts pr
         INNER JOIN locations l ON l.id = pr.location_id AND l.tenant_id = pr.tenant_id
         INNER JOIN users u ON u.id = pr.received_by_user_id AND u.tenant_id = pr.tenant_id
         WHERE pr.tenant_id = ? AND pr.purchase_order_id IN (${placeholders})
         ORDER BY pr.purchase_order_id, pr.created_at, pr.id`,
        parameters,
      ),
      manager.query<ReturnRow[]>(
        `SELECT pr.id, pr.purchase_order_id, pr.purchase_receipt_id,
                pr.document_reference, pr.reason, pr.status,
                pr.expected_credit_total, pr.credit_document_reference,
                pr.location_id, l.name AS location_name, l.code AS location_code,
                pr.returned_by_user_id AS responsible_id,
                u.email AS responsible_email, pr.created_at
         FROM purchase_returns pr
         INNER JOIN locations l ON l.id = pr.location_id AND l.tenant_id = pr.tenant_id
         INNER JOIN users u ON u.id = pr.returned_by_user_id AND u.tenant_id = pr.tenant_id
         WHERE pr.tenant_id = ? AND pr.purchase_order_id IN (${placeholders})
         ORDER BY pr.purchase_order_id, pr.created_at, pr.id`,
        parameters,
      ),
    ]);
    const receiptLines = receipts.length
      ? await manager.query<ReceiptLineRow[]>(
          `SELECT prl.id, prl.receipt_id, prl.purchase_order_line_id,
                  prl.received_quantity, prl.overage_quantity, prl.unit_cost,
                  prl.total_cost, prl.previous_catalog_cost,
                  prl.resulting_catalog_cost,
                  COALESCE((SELECT SUM(returned_quantity)
                    FROM purchase_return_lines
                    WHERE tenant_id = prl.tenant_id
                      AND purchase_receipt_line_id = prl.id), 0) AS returned_quantity
           FROM purchase_receipt_lines prl
           WHERE prl.tenant_id = ? AND prl.receipt_id IN (${receipts.map(() => '?').join(',')})
           ORDER BY prl.receipt_id, prl.line_number`,
          [tenantId, ...receipts.map((receipt) => receipt.id)],
        )
      : [];
    const returnLines = returns.length
      ? await manager.query<ReturnLineRow[]>(
          `SELECT id, purchase_return_id, purchase_receipt_line_id, product_id,
                  returned_quantity, unit_cost, total_cost
           FROM purchase_return_lines
           WHERE tenant_id = ? AND purchase_return_id IN (${returns.map(() => '?').join(',')})
           ORDER BY purchase_return_id, line_number`,
          [tenantId, ...returns.map((purchaseReturn) => purchaseReturn.id)],
        )
      : [];
    return rows.map((row) =>
      this.toData(
        row,
        lines,
        transitions,
        receipts,
        receiptLines,
        returns,
        returnLines,
      ),
    );
  }

  private toData(
    row: OrderRow,
    lines: LineRow[],
    transitions: TransitionRow[],
    receipts: ReceiptRow[],
    receiptLines: ReceiptLineRow[],
    returns: ReturnRow[],
    returnLines: ReturnLineRow[],
  ): PurchaseOrderData {
    return {
      id: row.id,
      folio: row.folio,
      supplier: { id: row.supplier_id, name: row.supplier_name },
      currency: row.currency,
      status: row.status,
      notes: row.notes,
      subtotal: row.subtotal,
      total: row.total,
      version: Number(row.version),
      approvedAt: this.dateTime(row.approved_at),
      sentAt: this.dateTime(row.sent_at),
      cancelledAt: this.dateTime(row.cancelled_at),
      cancellationReason: row.cancellation_reason,
      transitions: transitions
        .filter((transition) => transition.purchase_order_id === row.id)
        .map((transition): PurchaseOrderTransitionData => ({
          id: transition.id,
          fromStatus: transition.from_status,
          toStatus: transition.to_status,
          reason: transition.reason,
          delivery: transition.delivery_mode
            ? {
                mode: transition.delivery_mode,
                recipient: transition.delivery_recipient,
              }
            : null,
          createdAt: new Date(transition.created_at).toISOString(),
        })),
      receipts: receipts
        .filter((receipt) => receipt.purchase_order_id === row.id)
        .map((receipt) => ({
          id: receipt.id,
          documentReference: receipt.document_reference,
          location: {
            id: receipt.location_id,
            name: receipt.location_name,
            code: receipt.location_code,
          },
          responsible: {
            id: receipt.responsible_id,
            email: receipt.responsible_email,
          },
          overageReason: receipt.overage_reason,
          lines: receiptLines
            .filter((line) => line.receipt_id === receipt.id)
            .map((line) => ({
              id: line.id,
              purchaseOrderLineId: line.purchase_order_line_id,
              receivedQuantity: line.received_quantity,
              overageQuantity: line.overage_quantity,
              unitCost: line.unit_cost,
              totalCost: line.total_cost,
              previousCatalogCost: line.previous_catalog_cost,
              resultingCatalogCost: line.resulting_catalog_cost,
              returnedQuantity: line.returned_quantity,
              returnableQuantity: this.quantity(
                this.decimal(line.received_quantity, 3) -
                  this.decimal(line.returned_quantity, 3),
              ),
            })),
          createdAt: new Date(receipt.created_at).toISOString(),
        })),
      returns: returns
        .filter((purchaseReturn) => purchaseReturn.purchase_order_id === row.id)
        .map((purchaseReturn) => ({
          id: purchaseReturn.id,
          purchaseReceiptId: purchaseReturn.purchase_receipt_id,
          documentReference: purchaseReturn.document_reference,
          reason: purchaseReturn.reason,
          status: purchaseReturn.status,
          expectedCreditTotal: purchaseReturn.expected_credit_total,
          creditDocumentReference: purchaseReturn.credit_document_reference,
          location: {
            id: purchaseReturn.location_id,
            name: purchaseReturn.location_name,
            code: purchaseReturn.location_code,
          },
          responsible: {
            id: purchaseReturn.responsible_id,
            email: purchaseReturn.responsible_email,
          },
          lines: returnLines
            .filter((line) => line.purchase_return_id === purchaseReturn.id)
            .map((line) => ({
              id: line.id,
              purchaseReceiptLineId: line.purchase_receipt_line_id,
              productId: line.product_id,
              returnedQuantity: line.returned_quantity,
              unitCost: line.unit_cost,
              totalCost: line.total_cost,
            })),
          createdAt: new Date(purchaseReturn.created_at).toISOString(),
        })),
      lines: lines
        .filter((line) => line.purchase_order_id === row.id)
        .map((line): PurchaseOrderLineData => {
          const ordered = this.decimal(line.quantity, 3);
          const received = this.decimal(line.received_quantity, 3);
          return {
            id: line.id,
            supplierProductId: line.supplier_product_id,
            productId: line.product_id,
            productName: line.product_name,
            productSku: line.product_sku,
            supplierCode: line.supplier_code,
            quantity: line.quantity,
            receivedQuantity: line.received_quantity,
            remainingQuantity: this.quantity(
              ordered > received ? ordered - received : 0n,
            ),
            overageQuantity: this.quantity(
              received > ordered ? received - ordered : 0n,
            ),
            unitCost: line.unit_cost,
            subtotal: line.subtotal,
            notes: line.notes,
          };
        }),
      createdAt: new Date(row.created_at).toISOString(),
      updatedAt: new Date(row.updated_at).toISOString(),
    };
  }

  private select(): string {
    return `SELECT po.id, po.folio, po.supplier_id,
                   COALESCE(s.trade_name, s.legal_name) AS supplier_name,
                   po.currency, po.status, po.notes, po.subtotal, po.total,
                   po.version, po.created_at, po.updated_at, po.approved_at,
                   po.sent_at, po.cancelled_at, po.cancellation_reason
            FROM purchase_orders po
            INNER JOIN suppliers s ON s.id = po.supplier_id AND s.tenant_id = po.tenant_id`;
  }

  private lineSubtotal(quantity: string, unitCost: string): string {
    const quantityMilli = this.decimal(quantity, 3);
    const costCents = this.decimal(unitCost, 2);
    const subtotalCents = (quantityMilli * costCents + 500n) / 1000n;
    return this.money(subtotalCents);
  }

  private total(lines: PersistedLine[]): string {
    return this.money(
      lines.reduce((sum, line) => sum + this.decimal(line.subtotal, 2), 0n),
    );
  }

  private decimal(value: string, scale: number): bigint {
    const [whole, fraction = ''] = value.split('.');
    return BigInt(`${whole}${fraction.padEnd(scale, '0')}`);
  }

  private money(cents: bigint): string {
    return `${cents / 100n}.${(cents % 100n).toString().padStart(2, '0')}`;
  }

  private quantity(milliunits: bigint): string {
    return `${milliunits / 1000n}.${(milliunits % 1000n).toString().padStart(3, '0')}`;
  }

  private transitionMetadata(input: {
    to: PurchaseOrderStatus;
    actorUserId: string;
    reason?: string;
  }): { clause: string; parameters: Array<string | null> } {
    if (input.to === 'APPROVED') {
      return {
        clause: 'approved_at = CURRENT_TIMESTAMP(6), approved_by_user_id = ?',
        parameters: [input.actorUserId],
      };
    }
    if (input.to === 'SENT') {
      return { clause: 'sent_at = CURRENT_TIMESTAMP(6)', parameters: [] };
    }
    return {
      clause:
        'cancelled_at = CURRENT_TIMESTAMP(6), cancelled_by_user_id = ?, cancellation_reason = ?',
      parameters: [input.actorUserId, input.reason ?? null],
    };
  }

  private async findTransitionRequest(input: {
    tenantId: string;
    orderId: string;
    to: PurchaseOrderStatus;
    idempotencyKey: string;
    fingerprint: string;
  }): Promise<{ order: PurchaseOrderData; replay: true } | null> {
    const [row] = await this.dataSource.query<IdempotencyRow[]>(
      `SELECT purchase_order_id, to_status, request_fingerprint
       FROM purchase_order_transitions
       WHERE tenant_id = ? AND idempotency_key = ? LIMIT 1`,
      [input.tenantId, input.idempotencyKey],
    );
    if (!row) return null;
    if (
      row.purchase_order_id !== input.orderId ||
      row.to_status !== input.to ||
      row.request_fingerprint !== input.fingerprint
    ) {
      throw new PurchaseOrderIdempotencyConflictError();
    }
    const order = await this.findById(input.tenantId, input.orderId);
    if (!order) throw new PurchaseOrderIdempotencyConflictError();
    return { order, replay: true };
  }

  private isDuplicate(error: unknown): boolean {
    return (
      error instanceof QueryFailedError &&
      (error.driverError as { errno?: number }).errno === 1062
    );
  }

  private dateTime(value: Date | string | null): string | null {
    return value ? new Date(value).toISOString() : null;
  }
}
