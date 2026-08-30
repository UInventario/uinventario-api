import { Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { ResultSetHeader } from 'mysql2';
import { DataSource, EntityManager, QueryFailedError } from 'typeorm';
import { CreateSupplierProductDto } from './dto/create-supplier-product.dto';
import { ListSupplierProductsDto } from './dto/list-supplier-products.dto';
import { UpdateSupplierProductDto } from './dto/update-supplier-product.dto';
import {
  SupplierProductConflictError,
  SupplierProductReferenceError,
  SupplierProductVersionConflictError,
} from './supplier.errors';
import {
  SupplierPriceData,
  SupplierProductData,
} from './supplier-product.types';

interface LinkRow {
  id: string;
  supplier_id: string;
  supplier_name: string;
  product_id: string;
  product_name: string;
  product_sku: string;
  catalog_cost: string;
  catalog_price: string;
  base_unit: import('../common/quantity-policy').ProductBaseUnit;
  quantity_precision: number;
  product_minimum_quantity: string;
  supplier_code: string;
  minimum_quantity: string | null;
  active: number | boolean;
  version: number | string;
  created_at: Date | string;
  updated_at: Date | string;
}

interface PriceRow {
  id: string;
  supplier_product_id: string;
  currency: string;
  unit_cost: string;
  valid_from: Date | string;
  valid_to: Date | string | null;
  created_at: Date | string;
}

@Injectable()
export class SupplierProductRepository {
  constructor(private readonly dataSource: DataSource) {}

  async create(
    tenantId: string,
    actorUserId: string,
    dto: CreateSupplierProductDto,
  ): Promise<SupplierProductData> {
    try {
      return await this.dataSource.transaction(async (manager) => {
        await this.assertReferences(
          manager,
          tenantId,
          dto.supplierId,
          dto.productId,
        );
        const id = randomUUID();
        await manager.query(
          `INSERT INTO supplier_products
            (id, tenant_id, supplier_id, product_id, supplier_code,
             normalized_supplier_code, minimum_quantity)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
          [
            id,
            tenantId,
            dto.supplierId,
            dto.productId,
            dto.supplierCode,
            this.normalize(dto.supplierCode),
            dto.minimumQuantity ?? null,
          ],
        );
        await this.insertPrice(manager, tenantId, actorUserId, id, dto);
        return (await this.find(manager, tenantId, id))!;
      });
    } catch (error) {
      this.rethrowDuplicate(error);
    }
  }

  async update(
    tenantId: string,
    actorUserId: string,
    id: string,
    dto: UpdateSupplierProductDto,
  ): Promise<SupplierProductData | null> {
    try {
      return await this.dataSource.transaction(async (manager) => {
        const current = await this.find(manager, tenantId, id, true);
        if (!current) return null;
        if (current.version !== dto.version) {
          throw new SupplierProductVersionConflictError(current.version);
        }
        if (
          current.supplier.id !== dto.supplierId ||
          current.product.id !== dto.productId
        ) {
          throw new SupplierProductConflictError('RELATION');
        }
        const latest = current.prices[0];
        if (!latest || dto.validFrom <= latest.validFrom) {
          throw new SupplierProductConflictError('PRICE_DATE');
        }
        if (dto.validTo && dto.validTo < dto.validFrom) {
          throw new SupplierProductConflictError('PRICE_DATE');
        }
        const result = await manager.query<ResultSetHeader>(
          `UPDATE supplier_products
           SET supplier_code = ?, normalized_supplier_code = ?, minimum_quantity = ?,
               version = version + 1
           WHERE id = ? AND tenant_id = ? AND version = ?`,
          [
            dto.supplierCode,
            this.normalize(dto.supplierCode),
            dto.minimumQuantity ?? null,
            id,
            tenantId,
            dto.version,
          ],
        );
        if (result.affectedRows === 0) {
          const fresh = await this.find(manager, tenantId, id);
          if (!fresh) return null;
          throw new SupplierProductVersionConflictError(fresh.version);
        }
        await manager.query(
          `UPDATE supplier_product_prices
           SET valid_to = CASE
             WHEN valid_to IS NULL OR valid_to >= ? THEN DATE_SUB(?, INTERVAL 1 DAY)
             ELSE valid_to
           END
           WHERE id = ? AND tenant_id = ?`,
          [dto.validFrom, dto.validFrom, latest.id, tenantId],
        );
        await this.insertPrice(manager, tenantId, actorUserId, id, dto);
        return this.find(manager, tenantId, id);
      });
    } catch (error) {
      this.rethrowDuplicate(error);
    }
  }

  async list(
    tenantId: string,
    query: ListSupplierProductsDto,
  ): Promise<{ links: SupplierProductData[]; total: number }> {
    const clauses = ['sp.tenant_id = ?'];
    const parameters: Array<string | number> = [tenantId];
    if (query.supplierId) {
      clauses.push('sp.supplier_id = ?');
      parameters.push(query.supplierId);
    }
    if (query.productId) {
      clauses.push('sp.product_id = ?');
      parameters.push(query.productId);
    }
    if (query.q) {
      const search = `%${query.q}%`;
      clauses.push(`(
        s.legal_name LIKE ? OR s.trade_name LIKE ? OR p.name LIKE ?
        OR p.sku LIKE ? OR sp.supplier_code LIKE ?
      )`);
      parameters.push(search, search, search, search, search);
    }
    const where = clauses.join(' AND ');
    const offset = (query.page - 1) * query.pageSize;
    const [rows, [count]] = await Promise.all([
      this.dataSource.query<LinkRow[]>(
        `${this.select()} WHERE ${where}
         ORDER BY sp.updated_at DESC, sp.id DESC LIMIT ? OFFSET ?`,
        [...parameters, query.pageSize, offset],
      ),
      this.dataSource.query<Array<{ total: number | string }>>(
        `SELECT COUNT(*) AS total FROM supplier_products sp
         INNER JOIN suppliers s ON s.id = sp.supplier_id AND s.tenant_id = sp.tenant_id
         INNER JOIN products p ON p.id = sp.product_id AND p.tenant_id = sp.tenant_id
         WHERE ${where}`,
        parameters,
      ),
    ]);
    return {
      links: await this.withPrices(this.dataSource.manager, tenantId, rows),
      total: Number(count.total),
    };
  }

  findById(tenantId: string, id: string): Promise<SupplierProductData | null> {
    return this.find(this.dataSource.manager, tenantId, id);
  }

  private async assertReferences(
    manager: EntityManager,
    tenantId: string,
    supplierId: string,
    productId: string,
  ): Promise<void> {
    const [state] = await manager.query<
      Array<{
        supplier_exists: number | string;
        product_exists: number | string;
      }>
    >(
      `SELECT
         EXISTS(SELECT 1 FROM suppliers WHERE id = ? AND tenant_id = ? AND active = TRUE) AS supplier_exists,
         EXISTS(SELECT 1 FROM products WHERE id = ? AND tenant_id = ? AND active = TRUE
           AND variant_schema IS NULL
           AND NOT EXISTS (
             SELECT 1 FROM product_kits pk
             WHERE pk.tenant_id = products.tenant_id AND pk.product_id = products.id
               AND pk.stock_mode = 'DERIVED'
           )) AS product_exists`,
      [supplierId, tenantId, productId, tenantId],
    );
    if (!Number(state.supplier_exists))
      throw new SupplierProductReferenceError('SUPPLIER');
    if (!Number(state.product_exists))
      throw new SupplierProductReferenceError('PRODUCT');
  }

  private async insertPrice(
    manager: EntityManager,
    tenantId: string,
    actorUserId: string,
    linkId: string,
    dto: CreateSupplierProductDto,
  ): Promise<void> {
    await manager.query(
      `INSERT INTO supplier_product_prices
        (id, tenant_id, supplier_product_id, currency, unit_cost, valid_from,
         valid_to, created_by_user_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        randomUUID(),
        tenantId,
        linkId,
        dto.currency,
        dto.unitCost,
        dto.validFrom,
        dto.validTo ?? null,
        actorUserId,
      ],
    );
  }

  private async find(
    manager: EntityManager,
    tenantId: string,
    id: string,
    lock = false,
  ): Promise<SupplierProductData | null> {
    const rows = await manager.query<LinkRow[]>(
      `${this.select()} WHERE sp.id = ? AND sp.tenant_id = ? LIMIT 1${lock ? ' FOR UPDATE' : ''}`,
      [id, tenantId],
    );
    if (!rows[0]) return null;
    return (await this.withPrices(manager, tenantId, rows))[0];
  }

  private async withPrices(
    manager: EntityManager,
    tenantId: string,
    rows: LinkRow[],
  ): Promise<SupplierProductData[]> {
    if (rows.length === 0) return [];
    const prices = await manager.query<PriceRow[]>(
      `SELECT id, supplier_product_id, currency, unit_cost, valid_from, valid_to, created_at
       FROM supplier_product_prices
       WHERE tenant_id = ? AND supplier_product_id IN (${rows.map(() => '?').join(',')})
       ORDER BY valid_from DESC, created_at DESC, id DESC`,
      [tenantId, ...rows.map((row) => row.id)],
    );
    return rows.map((row) => this.toData(row, prices));
  }

  private toData(row: LinkRow, prices: PriceRow[]): SupplierProductData {
    return {
      id: row.id,
      supplier: { id: row.supplier_id, name: row.supplier_name },
      product: {
        id: row.product_id,
        name: row.product_name,
        sku: row.product_sku,
        catalogCost: row.catalog_cost,
        catalogPrice: row.catalog_price,
        baseUnit: row.base_unit,
        quantityPrecision: Number(row.quantity_precision),
        minimumQuantity: row.product_minimum_quantity,
      },
      supplierCode: row.supplier_code,
      minimumQuantity: row.minimum_quantity,
      active: Boolean(row.active),
      version: Number(row.version),
      prices: prices
        .filter((price) => price.supplier_product_id === row.id)
        .map((price): SupplierPriceData => ({
          id: price.id,
          currency: price.currency,
          unitCost: price.unit_cost,
          validFrom: this.dateOnly(price.valid_from),
          validTo: price.valid_to ? this.dateOnly(price.valid_to) : null,
          createdAt: new Date(price.created_at).toISOString(),
        })),
      createdAt: new Date(row.created_at).toISOString(),
      updatedAt: new Date(row.updated_at).toISOString(),
    };
  }

  private select(): string {
    return `SELECT sp.id, sp.supplier_id,
                   COALESCE(s.trade_name, s.legal_name) AS supplier_name,
                   sp.product_id, p.name AS product_name, p.sku AS product_sku,
                   p.cost AS catalog_cost, p.price AS catalog_price,
                   p.base_unit, p.quantity_precision,
                   p.minimum_quantity AS product_minimum_quantity,
                   sp.supplier_code, sp.minimum_quantity, sp.active, sp.version,
                   sp.created_at, sp.updated_at
            FROM supplier_products sp
            INNER JOIN suppliers s ON s.id = sp.supplier_id AND s.tenant_id = sp.tenant_id
            INNER JOIN products p ON p.id = sp.product_id AND p.tenant_id = sp.tenant_id`;
  }

  private normalize(value: string): string {
    return value.normalize('NFKC').toUpperCase().replace(/\s+/g, '');
  }

  private dateOnly(value: Date | string): string {
    return typeof value === 'string'
      ? value.slice(0, 10)
      : value.toISOString().slice(0, 10);
  }

  private rethrowDuplicate(error: unknown): never {
    if (error instanceof QueryFailedError) {
      const driver = error.driverError as {
        errno?: number;
        sqlMessage?: string;
      };
      if (driver.errno === 1062) {
        if (
          driver.sqlMessage?.includes('uq_supplier_products_supplier_product')
        ) {
          throw new SupplierProductConflictError('RELATION');
        }
        if (driver.sqlMessage?.includes('uq_supplier_products_supplier_code')) {
          throw new SupplierProductConflictError('SUPPLIER_CODE');
        }
        if (driver.sqlMessage?.includes('uq_supplier_product_prices_date')) {
          throw new SupplierProductConflictError('PRICE_DATE');
        }
      }
    }
    throw error;
  }
}
