import { Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { DataSource, EntityManager, QueryFailedError } from 'typeorm';
import type { ResultSetHeader } from 'mysql2';
import { CreateProductDto } from './dto/create-product.dto';
import {
  ProductIdentifierConflictError,
  ProductVersionConflictError,
} from './catalog.errors';
import { CatalogOptionsResponse, ProductData } from './catalog.types';
import { ListProductsDto, ProductStatusFilter } from './dto/list-products.dto';
import { UpdateProductDto } from './dto/update-product.dto';

interface ProductRow {
  id: string;
  name: string;
  sku: string;
  barcode: string | null;
  cost: string;
  price: string;
  active: number | boolean;
  version: number;
  category_id: string | null;
  category_name: string | null;
  brand_id: string | null;
  brand_name: string | null;
}

@Injectable()
export class CatalogRepository {
  constructor(private readonly dataSource: DataSource) {}

  async createProduct(
    tenantId: string,
    dto: CreateProductDto,
  ): Promise<ProductData> {
    try {
      return await this.dataSource.transaction(async (manager) => {
        const categoryId = dto.categoryName
          ? await this.findOrCreateClassification(
              manager,
              'categories',
              tenantId,
              dto.categoryName,
            )
          : null;
        const brandId = dto.brandName
          ? await this.findOrCreateClassification(
              manager,
              'brands',
              tenantId,
              dto.brandName,
            )
          : null;
        const id = randomUUID();
        await manager.query(
          `INSERT INTO products
            (id, tenant_id, name, sku, normalized_sku, barcode, category_id, brand_id, cost, price)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            id,
            tenantId,
            dto.name,
            dto.sku,
            this.normalize(dto.sku),
            dto.barcode ?? null,
            categoryId,
            brandId,
            dto.cost,
            dto.price,
          ],
        );
        const product = await this.findProduct(manager, tenantId, id);
        if (!product) throw new Error('CREATED_PRODUCT_NOT_FOUND');
        return product;
      });
    } catch (error) {
      const constraint = this.duplicateConstraint(error);
      if (constraint?.includes('uq_products_tenant_sku')) {
        throw new ProductIdentifierConflictError('sku');
      }
      if (constraint?.includes('uq_products_tenant_barcode')) {
        throw new ProductIdentifierConflictError('barcode');
      }
      throw error;
    }
  }

  async getOptions(tenantId: string): Promise<CatalogOptionsResponse['data']> {
    const [categories, brands] = await Promise.all([
      this.dataSource.query<Array<{ id: string; name: string }>>(
        'SELECT id, name FROM categories WHERE tenant_id = ? ORDER BY name',
        [tenantId],
      ),
      this.dataSource.query<Array<{ id: string; name: string }>>(
        'SELECT id, name FROM brands WHERE tenant_id = ? ORDER BY name',
        [tenantId],
      ),
    ]);
    return { categories, brands };
  }

  async updateProduct(
    tenantId: string,
    id: string,
    dto: UpdateProductDto,
  ): Promise<ProductData | null> {
    try {
      return await this.dataSource.transaction(async (manager) => {
        const categoryId = dto.categoryName
          ? await this.findOrCreateClassification(
              manager,
              'categories',
              tenantId,
              dto.categoryName,
            )
          : null;
        const brandId = dto.brandName
          ? await this.findOrCreateClassification(
              manager,
              'brands',
              tenantId,
              dto.brandName,
            )
          : null;
        const result = await manager.query<ResultSetHeader>(
          `UPDATE products
           SET name = ?, sku = ?, normalized_sku = ?, barcode = ?,
               category_id = ?, brand_id = ?, cost = ?, price = ?, version = version + 1
           WHERE id = ? AND tenant_id = ? AND version = ?`,
          [
            dto.name,
            dto.sku,
            this.normalize(dto.sku),
            dto.barcode ?? null,
            categoryId,
            brandId,
            dto.cost,
            dto.price,
            id,
            tenantId,
            dto.version,
          ],
        );
        if (result.affectedRows === 0) {
          const current = await this.findProduct(manager, tenantId, id);
          if (!current) return null;
          throw new ProductVersionConflictError(current.version);
        }
        return this.findProduct(manager, tenantId, id);
      });
    } catch (error) {
      const constraint = this.duplicateConstraint(error);
      if (constraint?.includes('uq_products_tenant_sku')) {
        throw new ProductIdentifierConflictError('sku');
      }
      if (constraint?.includes('uq_products_tenant_barcode')) {
        throw new ProductIdentifierConflictError('barcode');
      }
      throw error;
    }
  }

  async listProducts(
    tenantId: string,
    query: ListProductsDto,
  ): Promise<{ products: ProductData[]; total: number }> {
    const search = query.q ? `%${query.q.trim()}%` : null;
    const conditions = ['p.tenant_id = ?'];
    const parameters: Array<string | number> = [tenantId];
    if (query.status !== ProductStatusFilter.ALL) {
      conditions.push('p.active = ?');
      parameters.push(query.status === ProductStatusFilter.ACTIVE ? 1 : 0);
    }
    if (search) {
      conditions.push(
        '(p.name LIKE ? OR p.normalized_sku LIKE ? OR p.barcode LIKE ?)',
      );
      parameters.push(search, search.toUpperCase(), search);
    }
    const where = conditions.join(' AND ');
    const offset = (query.page - 1) * query.pageSize;
    const [rows, countRows] = await Promise.all([
      this.dataSource.query<ProductRow[]>(
        `${this.productSelect()} WHERE ${where}
         ORDER BY p.created_at DESC, p.id DESC LIMIT ? OFFSET ?`,
        [...parameters, query.pageSize, offset],
      ),
      this.dataSource.query<Array<{ total: number | string }>>(
        `SELECT COUNT(*) AS total FROM products p WHERE ${where}`,
        parameters,
      ),
    ]);
    return {
      products: rows.map((row) => this.toProduct(row)),
      total: Number(countRows[0]?.total ?? 0),
    };
  }

  async getProduct(tenantId: string, id: string): Promise<ProductData | null> {
    const rows = await this.dataSource.query<ProductRow[]>(
      `${this.productSelect()} WHERE p.id = ? AND p.tenant_id = ? LIMIT 1`,
      [id, tenantId],
    );
    return rows[0] ? this.toProduct(rows[0]) : null;
  }

  async retireProduct(
    tenantId: string,
    id: string,
  ): Promise<{
    outcome: 'DELETED' | 'DEACTIVATED';
    product: ProductData | null;
  } | null> {
    return this.dataSource.transaction(async (manager) => {
      const products = await manager.query<
        Array<{
          id: string;
          active: number | boolean;
          sku: string;
          barcode: string | null;
          name: string;
          category_id: string | null;
          brand_id: string | null;
          price: string;
          version: number;
        }>
      >(
        `SELECT id, active, sku, barcode, name, category_id, brand_id, price, version
         FROM products WHERE id = ? AND tenant_id = ? FOR UPDATE`,
        [id, tenantId],
      );
      if (!products[0]) return null;

      const [references] = await manager.query<
        Array<{
          has_movements: number | string;
          has_sales: number | string;
          has_stock: number | string;
        }>
      >(
        `SELECT
           EXISTS(SELECT 1 FROM inventory_movements WHERE tenant_id = ? AND product_id = ?) AS has_movements,
           EXISTS(SELECT 1 FROM sale_lines WHERE tenant_id = ? AND product_id = ?) AS has_sales,
           EXISTS(SELECT 1 FROM inventory_balances WHERE tenant_id = ? AND product_id = ? AND quantity <> 0) AS has_stock`,
        [tenantId, id, tenantId, id, tenantId, id],
      );
      const mustPreserve =
        Number(references.has_movements) === 1 ||
        Number(references.has_sales) === 1 ||
        Number(references.has_stock) === 1;
      if (mustPreserve) {
        if (products[0].active) {
          await manager.query(
            `UPDATE products SET active = FALSE, version = version + 1
             WHERE id = ? AND tenant_id = ?`,
            [id, tenantId],
          );
        }
        return {
          outcome: 'DEACTIVATED',
          product: await this.findProduct(manager, tenantId, id),
        };
      }

      const removed = products[0];
      await manager.query(
        `INSERT INTO offline_sync_tombstones
          (change_id, tenant_id, entity_kind, entity_id, payload)
         VALUES (?, ?, 'PRODUCT', ?, ?)`,
        [
          randomUUID(),
          tenantId,
          id,
          JSON.stringify({
            sku: removed.sku,
            barcode: removed.barcode,
            name: removed.name,
            categoryId: removed.category_id,
            brandId: removed.brand_id,
            price: Number(removed.price).toFixed(2),
            version: Number(removed.version) + 1,
            active: false,
          }),
        ],
      );
      await manager.query(
        'DELETE FROM products WHERE id = ? AND tenant_id = ?',
        [id, tenantId],
      );
      return { outcome: 'DELETED', product: null };
    });
  }

  private async findOrCreateClassification(
    manager: EntityManager,
    table: 'categories' | 'brands',
    tenantId: string,
    name: string,
  ): Promise<string> {
    const normalizedName = this.normalize(name);
    await manager.query(
      `INSERT INTO ${table} (id, tenant_id, name, normalized_name)
       VALUES (?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE name = VALUES(name)`,
      [randomUUID(), tenantId, name, normalizedName],
    );
    const rows = await manager.query<Array<{ id: string }>>(
      `SELECT id FROM ${table} WHERE tenant_id = ? AND normalized_name = ? LIMIT 1`,
      [tenantId, normalizedName],
    );
    return rows[0].id;
  }

  private async findProduct(
    manager: EntityManager,
    tenantId: string,
    id: string,
  ): Promise<ProductData | null> {
    const rows = await manager.query<ProductRow[]>(
      `${this.productSelect()} WHERE p.id = ? AND p.tenant_id = ? LIMIT 1`,
      [id, tenantId],
    );
    const [row] = rows;
    return row ? this.toProduct(row) : null;
  }

  private productSelect(): string {
    return `SELECT p.id, p.name, p.sku, p.barcode, p.cost, p.price, p.active, p.version,
                   c.id AS category_id, c.name AS category_name,
                   b.id AS brand_id, b.name AS brand_name
            FROM products p
            LEFT JOIN categories c ON c.id = p.category_id AND c.tenant_id = p.tenant_id
            LEFT JOIN brands b ON b.id = p.brand_id AND b.tenant_id = p.tenant_id`;
  }

  private toProduct(row: ProductRow): ProductData {
    return {
      id: row.id,
      name: row.name,
      sku: row.sku,
      barcode: row.barcode,
      category:
        row.category_id && row.category_name
          ? { id: row.category_id, name: row.category_name }
          : null,
      brand:
        row.brand_id && row.brand_name
          ? { id: row.brand_id, name: row.brand_name }
          : null,
      cost: row.cost,
      price: row.price,
      active: Boolean(row.active),
      version: Number(row.version),
    };
  }

  private normalize(value: string): string {
    return value.normalize('NFKC').toUpperCase();
  }

  private duplicateConstraint(error: unknown): string | null {
    if (!(error instanceof QueryFailedError)) return null;
    const driverError = error.driverError as {
      errno?: number;
      sqlMessage?: string;
    };
    return driverError.errno === 1062 ? (driverError.sqlMessage ?? '') : null;
  }
}
