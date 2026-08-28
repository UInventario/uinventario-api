import { Injectable } from '@nestjs/common';
import { DataSource, EntityManager } from 'typeorm';
import type {
  SaleReceiptData,
  SaleReceiptLine,
  SaleReceiptPayment,
} from './sale-receipt.types';

interface ReceiptRow {
  sale_id: string;
  receipt_number: string;
  merchant_name: string;
  merchant_legal_name: string | null;
  country_code: string | null;
  branch_name: string;
  cash_register_name: string;
  cash_register_code: string;
  seller_email: string;
  customer_name: string | null;
  customer_identifier: string | null;
  currency: string;
  tax_rate: string;
  subtotal: string;
  tax_total: string;
  total: string;
  receipt_lines: string | SaleReceiptLine[];
  receipt_payments: string | SaleReceiptPayment[];
  issued_at: Date | string;
  sale_status: 'COMPLETED' | 'VOIDED';
  void_reason: string | null;
  voided_at: Date | string | null;
}

@Injectable()
export class SaleReceiptRepository {
  constructor(private readonly dataSource: DataSource) {}

  async createSnapshot(
    manager: EntityManager,
    tenantId: string,
    saleId: string,
  ): Promise<void> {
    await manager.query(
      `INSERT INTO sale_receipt_snapshots
        (sale_id, tenant_id, receipt_number, merchant_name, merchant_legal_name,
         country_code, branch_name, cash_register_name, cash_register_code,
         seller_email, customer_name, customer_identifier, currency, tax_rate,
         subtotal, tax_total, total, receipt_lines, receipt_payments, issued_at)
       SELECT sale.id, sale.tenant_id, sale.receipt_number, tenant.name,
              tenant.legal_name, tenant.country_code, branch.name,
              register.name, register.code, seller.email, customer.name,
              customer.identifier, sale.currency, sale.tax_rate, sale.subtotal,
              sale.tax_total, sale.total,
              COALESCE((
                SELECT JSON_ARRAYAGG(JSON_OBJECT(
                  'lineNumber', line.line_number,
                  'productName', line.product_name,
                  'productSku', line.product_sku,
                  'quantity', line.quantity,
                  'unitPrice', line.unit_price,
                  'subtotal', line.subtotal,
                  'tax', line.tax,
                  'total', line.total
                )) FROM sale_lines line
                WHERE line.sale_id = sale.id AND line.tenant_id = sale.tenant_id
              ), JSON_ARRAY()),
              COALESCE((
                SELECT JSON_ARRAYAGG(JSON_OBJECT(
                  'method', payment.method,
                  'amountReceived', payment.amount_received,
                  'amountApplied', payment.amount_applied,
                  'change', payment.change_amount,
                  'reference', payment.external_reference,
                  'provider', payment.provider,
                  'authorizationCode', payment.authorization_code
                )) FROM sale_payments payment
                WHERE payment.sale_id = sale.id AND payment.tenant_id = sale.tenant_id
              ), JSON_ARRAY()),
              sale.created_at
       FROM sales sale
       INNER JOIN tenants tenant ON tenant.id = sale.tenant_id
       INNER JOIN branches branch
         ON branch.id = sale.branch_id AND branch.tenant_id = sale.tenant_id
       INNER JOIN cash_registers register
         ON register.id = sale.cash_register_id AND register.tenant_id = sale.tenant_id
       INNER JOIN users seller
         ON seller.id = sale.created_by_user_id AND seller.tenant_id = sale.tenant_id
       LEFT JOIN customers customer
         ON customer.id = sale.customer_id AND customer.tenant_id = sale.tenant_id
       WHERE sale.id = ? AND sale.tenant_id = ?`,
      [saleId, tenantId],
    );
  }

  async get(
    tenantId: string,
    branchId: string,
    saleId: string,
  ): Promise<SaleReceiptData | null> {
    const [row] = await this.dataSource.query<ReceiptRow[]>(
      `SELECT receipt.sale_id, receipt.receipt_number, receipt.merchant_name,
              receipt.merchant_legal_name, receipt.country_code,
              receipt.branch_name, receipt.cash_register_name,
              receipt.cash_register_code, receipt.seller_email,
              receipt.customer_name, receipt.customer_identifier,
              receipt.currency, receipt.tax_rate, receipt.subtotal,
              receipt.tax_total, receipt.total, receipt.receipt_lines,
              receipt.receipt_payments, receipt.issued_at, sale.status AS sale_status,
              sale.void_reason, sale.voided_at
       FROM sale_receipt_snapshots receipt
       INNER JOIN sales sale
         ON sale.id = receipt.sale_id AND sale.tenant_id = receipt.tenant_id
       WHERE receipt.sale_id = ? AND receipt.tenant_id = ? AND sale.branch_id = ?
       LIMIT 1`,
      [saleId, tenantId, branchId],
    );
    return row ? this.toData(row) : null;
  }

  private toData(row: ReceiptRow): SaleReceiptData {
    const lines = this.json<SaleReceiptLine[]>(row.receipt_lines).sort(
      (left, right) => left.lineNumber - right.lineNumber,
    );
    return {
      saleId: row.sale_id,
      receiptNumber: row.receipt_number,
      documentType: 'NON_FISCAL_SALE_RECEIPT',
      fiscalNotice: 'COMPROBANTE NO FISCAL',
      merchant: {
        name: row.merchant_name,
        legalName: row.merchant_legal_name,
        countryCode: row.country_code,
      },
      branchName: row.branch_name,
      cashRegister: {
        name: row.cash_register_name,
        code: row.cash_register_code,
      },
      sellerEmail: row.seller_email,
      customer: row.customer_name
        ? { name: row.customer_name, identifier: row.customer_identifier }
        : null,
      currency: row.currency,
      taxRate: this.decimal(row.tax_rate, 4),
      lines: lines.map((line) => ({
        ...line,
        quantity: this.decimal(String(line.quantity), 3),
        unitPrice: this.decimal(String(line.unitPrice), 2),
        subtotal: this.decimal(String(line.subtotal), 2),
        tax: this.decimal(String(line.tax), 2),
        total: this.decimal(String(line.total), 2),
      })),
      payments: this.json<SaleReceiptPayment[]>(row.receipt_payments).map(
        (payment) => ({
          ...payment,
          amountReceived: this.decimal(String(payment.amountReceived), 2),
          amountApplied: this.decimal(String(payment.amountApplied), 2),
          change: this.decimal(String(payment.change), 2),
        }),
      ),
      totals: {
        subtotal: this.decimal(row.subtotal, 2),
        tax: this.decimal(row.tax_total, 2),
        total: this.decimal(row.total, 2),
      },
      issuedAt: new Date(row.issued_at).toISOString(),
      saleStatus: row.sale_status,
      void:
        row.sale_status === 'VOIDED' && row.void_reason && row.voided_at
          ? {
              reason: row.void_reason,
              voidedAt: new Date(row.voided_at).toISOString(),
            }
          : null,
    };
  }

  private json<T>(value: string | T): T {
    return typeof value === 'string' ? (JSON.parse(value) as T) : value;
  }

  private decimal(value: string, scale: number): string {
    const [whole, fraction = ''] = value.split('.');
    return `${whole}.${fraction.padEnd(scale, '0').slice(0, scale)}`;
  }
}
