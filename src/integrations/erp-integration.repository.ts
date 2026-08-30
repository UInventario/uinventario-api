import { ConflictException, Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { DataSource, EntityManager } from 'typeorm';
import type { ErpMappingRecordDto } from './dto/import-erp-mappings.dto';
import type {
  ErpExportRow,
  ErpMappingResult,
  ErpResource,
} from './erp-integration.types';

interface ExportDefinition {
  table: string;
  alias: string;
  changedAt: string;
  payload: string;
}

interface ImportRunRow {
  id: string;
  provider: string;
  request_fingerprint: string;
  status: 'PENDING' | 'COMPLETED';
  result: string | ErpMappingResult[];
  created_at: Date | string;
  updated_at: Date | string;
}

@Injectable()
export class ErpIntegrationRepository {
  constructor(private readonly dataSource: DataSource) {}

  exportRows(input: {
    tenantId: string;
    provider: string;
    resource: ErpResource;
    cursor: { changedAt: string; id: string } | null;
    limit: number;
  }) {
    const definition = this.definition(input.resource);
    const cursorSql = input.cursor
      ? `AND (${definition.changedAt} > ? OR (${definition.changedAt} = ? AND ${definition.alias}.id > ?))`
      : '';
    const cursorParams = input.cursor
      ? [input.cursor.changedAt, input.cursor.changedAt, input.cursor.id]
      : [];
    return this.dataSource.query<ErpExportRow[]>(
      `SELECT ${definition.alias}.id, mapping.external_id,
              ${definition.changedAt} AS changed_at,
              DATE_FORMAT(${definition.changedAt}, '%Y-%m-%d %H:%i:%s.%f') AS changed_cursor,
              ${definition.payload} AS payload
       FROM ${definition.table} ${definition.alias}
       LEFT JOIN erp_external_mappings mapping
         ON mapping.tenant_id = ${definition.alias}.tenant_id
        AND mapping.provider = ? AND mapping.resource = ?
        AND mapping.internal_id = ${definition.alias}.id
       WHERE ${definition.alias}.tenant_id = ? ${cursorSql}
       ORDER BY ${definition.changedAt}, ${definition.alias}.id
       LIMIT ?`,
      [
        input.provider,
        input.resource,
        input.tenantId,
        ...cursorParams,
        input.limit,
      ],
    );
  }

  async importMappings(input: {
    tenantId: string;
    provider: string;
    idempotencyKey: string;
    fingerprint: string;
    records: ErpMappingRecordDto[];
  }): Promise<{ runId: string; results: ErpMappingResult[]; replay: boolean }> {
    return this.dataSource.transaction(async (manager) => {
      await manager.query('SELECT id FROM tenants WHERE id = ? FOR UPDATE', [
        input.tenantId,
      ]);
      const runId = randomUUID();
      const inserted = await manager.query<{ affectedRows?: number }>(
        `INSERT IGNORE INTO erp_mapping_import_runs
          (id, tenant_id, provider, idempotency_key, request_fingerprint, status, result)
         VALUES (?, ?, ?, ?, ?, 'PENDING', JSON_ARRAY())`,
        [
          runId,
          input.tenantId,
          input.provider,
          input.idempotencyKey,
          input.fingerprint,
        ],
      );
      if (Number(inserted.affectedRows ?? 0) === 0) {
        const existing = await this.runByKey(
          manager,
          input.tenantId,
          input.idempotencyKey,
        );
        if (
          !existing ||
          existing.provider !== input.provider ||
          existing.request_fingerprint !== input.fingerprint
        ) {
          throw new ConflictException('ERP_IMPORT_IDEMPOTENCY_CONFLICT');
        }
        return {
          runId: existing.id,
          results: this.json<ErpMappingResult[]>(existing.result),
          replay: true,
        };
      }

      const results: ErpMappingResult[] = [];
      for (const [index, record] of input.records.entries()) {
        results.push(
          await this.linkRecord(manager, {
            ...input,
            ...record,
            index,
          }),
        );
      }
      await manager.query(
        `UPDATE erp_mapping_import_runs SET status = 'COMPLETED', result = ?
         WHERE id = ? AND tenant_id = ?`,
        [JSON.stringify(results), runId, input.tenantId],
      );
      return { runId, results, replay: false };
    });
  }

  async mappings(tenantId: string, provider: string) {
    return this.dataSource.query<
      Array<{
        id: string;
        resource: ErpResource;
        external_id: string;
        internal_id: string;
        created_at: Date | string;
        updated_at: Date | string;
      }>
    >(
      `SELECT id, resource, external_id, internal_id, created_at, updated_at
       FROM erp_external_mappings
       WHERE tenant_id = ? AND provider = ?
       ORDER BY updated_at DESC, id DESC LIMIT 200`,
      [tenantId, provider],
    );
  }

  async runs(tenantId: string, provider: string) {
    const rows = await this.dataSource.query<ImportRunRow[]>(
      `SELECT id, provider, request_fingerprint, status, result, created_at, updated_at
       FROM erp_mapping_import_runs
       WHERE tenant_id = ? AND provider = ?
       ORDER BY updated_at DESC, id DESC LIMIT 50`,
      [tenantId, provider],
    );
    return rows.map((row) => ({
      id: row.id,
      provider: row.provider,
      status: row.status,
      results: this.json<ErpMappingResult[]>(row.result),
      createdAt: new Date(row.created_at).toISOString(),
      updatedAt: new Date(row.updated_at).toISOString(),
    }));
  }

  private async linkRecord(
    manager: EntityManager,
    input: {
      tenantId: string;
      provider: string;
      resource: ErpResource;
      externalId: string;
      internalId: string;
      index: number;
    },
  ): Promise<ErpMappingResult> {
    const definition = this.definition(input.resource);
    const [source] = await manager.query<Array<{ id: string }>>(
      `SELECT id FROM ${definition.table} WHERE tenant_id = ? AND id = ? LIMIT 1`,
      [input.tenantId, input.internalId],
    );
    if (!source) return this.error(input, 'INTERNAL_RECORD_NOT_FOUND');
    const mappings = await manager.query<
      Array<{ external_id: string; internal_id: string }>
    >(
      `SELECT external_id, internal_id FROM erp_external_mappings
       WHERE tenant_id = ? AND provider = ? AND resource = ?
         AND (external_id = ? OR internal_id = ?) FOR UPDATE`,
      [
        input.tenantId,
        input.provider,
        input.resource,
        input.externalId,
        input.internalId,
      ],
    );
    if (
      mappings.length === 1 &&
      mappings[0].external_id === input.externalId &&
      mappings[0].internal_id === input.internalId
    ) {
      return this.success(input, true);
    }
    if (mappings.length > 0) return this.error(input, 'MAPPING_CONFLICT');
    await manager.query(
      `INSERT INTO erp_external_mappings
        (id, tenant_id, provider, resource, external_id, internal_id)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [
        randomUUID(),
        input.tenantId,
        input.provider,
        input.resource,
        input.externalId,
        input.internalId,
      ],
    );
    return this.success(input, false);
  }

  private runByKey(
    manager: EntityManager,
    tenantId: string,
    idempotencyKey: string,
  ) {
    return manager
      .query<ImportRunRow[]>(
        `SELECT id, provider, request_fingerprint, status, result, created_at, updated_at
         FROM erp_mapping_import_runs
         WHERE tenant_id = ? AND idempotency_key = ? LIMIT 1 FOR UPDATE`,
        [tenantId, idempotencyKey],
      )
      .then(([row]) => row);
  }

  private success(
    input: {
      index: number;
      resource: ErpResource;
      externalId: string;
      internalId: string;
    },
    replay: boolean,
  ): ErpMappingResult {
    return { ...input, status: 'LINKED', replay, errorCode: null };
  }

  private error(
    input: {
      index: number;
      resource: ErpResource;
      externalId: string;
      internalId: string;
    },
    errorCode: ErpMappingResult['errorCode'],
  ): ErpMappingResult {
    return { ...input, status: 'ERROR', replay: false, errorCode };
  }

  private json<T>(value: string | T): T {
    return typeof value === 'string' ? (JSON.parse(value) as T) : value;
  }

  private definition(resource: ErpResource): ExportDefinition {
    const definitions: Record<ErpResource, ExportDefinition> = {
      PRODUCT: {
        table: 'products',
        alias: 'product',
        changedAt: 'product.updated_at',
        payload: `JSON_OBJECT('name', product.name, 'sku', product.sku,
          'barcode', product.barcode, 'cost', product.cost, 'price', product.price,
          'active', product.active)`,
      },
      SUPPLIER: {
        table: 'suppliers',
        alias: 'supplier',
        changedAt: 'supplier.updated_at',
        payload: `JSON_OBJECT('legalName', supplier.legal_name, 'tradeName', supplier.trade_name,
          'countryCode', supplier.country_code, 'identifierType', supplier.identifier_type,
          'taxIdentifier', supplier.tax_identifier, 'active', supplier.active)`,
      },
      CUSTOMER: {
        table: 'customers',
        alias: 'customer',
        changedAt: 'customer.updated_at',
        payload: `JSON_OBJECT('name', customer.name, 'identifier', customer.identifier,
          'active', customer.active)`,
      },
      PURCHASE_ORDER: {
        table: 'purchase_orders',
        alias: 'purchase_order',
        changedAt: 'purchase_order.updated_at',
        payload: `JSON_OBJECT('folio', purchase_order.folio,
          'supplierId', purchase_order.supplier_id, 'currency', purchase_order.currency,
          'status', purchase_order.status, 'subtotal', purchase_order.subtotal,
          'total', purchase_order.total, 'version', purchase_order.version)`,
      },
      PURCHASE_RECEIPT: {
        table: 'purchase_receipts',
        alias: 'purchase_receipt',
        changedAt: 'purchase_receipt.created_at',
        payload: `JSON_OBJECT('purchaseOrderId', purchase_receipt.purchase_order_id,
          'locationId', purchase_receipt.location_id,
          'documentReference', purchase_receipt.document_reference)`,
      },
      SALE: {
        table: 'sales',
        alias: 'sale',
        changedAt: 'COALESCE(sale.voided_at, sale.created_at)',
        payload: `JSON_OBJECT('receiptNumber', sale.receipt_number, 'branchId', sale.branch_id,
          'customerId', sale.customer_id, 'currency', sale.currency, 'status', sale.status,
          'subtotal', sale.subtotal, 'tax', sale.tax_total, 'total', sale.total)`,
      },
    };
    return definitions[resource];
  }
}
