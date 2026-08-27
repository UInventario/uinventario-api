import { Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { DataSource, EntityManager, QueryFailedError } from 'typeorm';
import { CreateProductDto } from './dto/create-product.dto';
import { ProductIdentifierConflictError } from './catalog.errors';
import { CatalogOptionsResponse, ProductData } from './catalog.types';

interface ProductRow {
  id: string;
  name: string;
  sku: string;
  barcode: string | null;
  cost: string;
  price: string;
  active: number | boolean;
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
      `SELECT p.id, p.name, p.sku, p.barcode, p.cost, p.price, p.active,
              c.id AS category_id, c.name AS category_name,
              b.id AS brand_id, b.name AS brand_name
       FROM products p
       LEFT JOIN categories c ON c.id = p.category_id AND c.tenant_id = p.tenant_id
       LEFT JOIN brands b ON b.id = p.brand_id AND b.tenant_id = p.tenant_id
       WHERE p.id = ? AND p.tenant_id = ? LIMIT 1`,
      [id, tenantId],
    );
    const [row] = rows;
    if (!row) return null;
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
