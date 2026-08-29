import { Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { DataSource, EntityManager, QueryFailedError } from 'typeorm';
import type { ResultSetHeader } from 'mysql2';
import { CreateProductDto } from './dto/create-product.dto';
import {
  CatalogClassificationConflictError,
  ProductCodeAmbiguousError,
  ProductIdentifierConflictError,
  ProductVersionConflictError,
  ProductLotTrackingLockedError,
  ProductQuantityPolicyLockedError,
  ProductVariantConfigurationError,
  ProductVariantsRequireZeroStockError,
} from './catalog.errors';
import {
  CatalogClassificationData,
  CatalogOptionsResponse,
  ProductData,
} from './catalog.types';
import { ListProductsDto, ProductStatusFilter } from './dto/list-products.dto';
import { UpdateProductDto } from './dto/update-product.dto';
import {
  CatalogClassificationKind,
  UpdateCatalogClassificationDto,
} from './dto/catalog-classification.dto';
import { UpdateProductVariantsDto } from './dto/update-product-variants.dto';
import {
  assertProductQuantityPolicy,
  quantityToUnits,
  ProductBaseUnit,
  QuantityRoundingMode,
} from '../common/quantity-policy';

interface ProductRow {
  id: string;
  name: string;
  sku: string;
  barcode: string | null;
  base_unit: ProductBaseUnit;
  quantity_precision: number;
  quantity_rounding: QuantityRoundingMode;
  minimum_quantity: string;
  track_lots: number | boolean;
  lot_expiration_policy: 'NONE' | 'OPTIONAL' | 'REQUIRED';
  lot_expiration_alert_days: number;
  allow_expired_stock_override: number | boolean;
  track_serials: number | boolean;
  cost: string;
  price: string;
  active: number | boolean;
  version: number;
  category_id: string | null;
  category_name: string | null;
  brand_id: string | null;
  brand_name: string | null;
  parent_product_id: string | null;
  variant_schema: string | Array<{ name: string; values: string[] }> | null;
  variant_values: string | Array<{ attribute: string; value: string }> | null;
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
        const specificLotPolicy = await this.specificLotPolicy(
          manager,
          tenantId,
        );
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
            (id, tenant_id, name, sku, normalized_sku, barcode, base_unit,
             quantity_precision, quantity_rounding, minimum_quantity, track_lots,
             lot_expiration_policy, lot_expiration_alert_days,
             allow_expired_stock_override, track_serials, category_id, brand_id,
             cost, price)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            id,
            tenantId,
            dto.name,
            dto.sku,
            this.normalize(dto.sku),
            dto.barcode ?? null,
            dto.baseUnit ?? 'UNIT',
            dto.quantityPrecision ?? (dto.trackSerials ? 0 : 3),
            dto.quantityRounding ?? 'HALF_UP',
            dto.minimumQuantity ?? (dto.trackSerials ? '1.000' : '0.001'),
            specificLotPolicy || (dto.trackLots ?? false),
            dto.lotExpirationPolicy ?? 'NONE',
            dto.lotExpirationAlertDays ?? 30,
            dto.allowExpiredStockOverride ?? false,
            dto.trackSerials ?? false,
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
        'SELECT id, name FROM categories WHERE tenant_id = ? AND active = TRUE ORDER BY name',
        [tenantId],
      ),
      this.dataSource.query<Array<{ id: string; name: string }>>(
        'SELECT id, name FROM brands WHERE tenant_id = ? AND active = TRUE ORDER BY name',
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
        const [currentTracking] = await manager.query<
          Array<{
            track_lots: number | boolean;
            lot_expiration_policy: 'NONE' | 'OPTIONAL' | 'REQUIRED';
            lot_expiration_alert_days: number;
            allow_expired_stock_override: number | boolean;
            track_serials: number | boolean;
            base_unit: ProductBaseUnit;
            quantity_precision: number;
            quantity_rounding: QuantityRoundingMode;
            minimum_quantity: string;
            has_movements: number | string;
            specific_lot_policy: number | string;
          }>
        >(
          `SELECT p.track_lots, p.track_serials, p.base_unit,
                  p.quantity_precision, p.quantity_rounding, p.minimum_quantity,
                  EXISTS(SELECT 1 FROM inventory_movements im
                         WHERE im.tenant_id = p.tenant_id
                           AND (im.product_id = p.id OR im.product_id IN (
                             SELECT child.id FROM products child
                             WHERE child.tenant_id = p.tenant_id
                               AND child.parent_product_id = p.id
                           ))) AS has_movements,
                  EXISTS(SELECT 1 FROM inventory_valuation_policies ivp
                         WHERE ivp.tenant_id = p.tenant_id
                           AND ivp.method = 'SPECIFIC_LOT') AS specific_lot_policy
           FROM products p WHERE p.id = ? AND p.tenant_id = ? LIMIT 1 FOR UPDATE`,
          [id, tenantId],
        );
        if (!currentTracking) return null;
        if (
          dto.trackLots !== undefined &&
          dto.trackLots !== Boolean(currentTracking.track_lots) &&
          (Number(currentTracking.has_movements) === 1 ||
            Number(currentTracking.specific_lot_policy) === 1)
        ) {
          throw new ProductLotTrackingLockedError();
        }
        if (
          dto.trackSerials !== undefined &&
          dto.trackSerials !== Boolean(currentTracking.track_serials) &&
          Number(currentTracking.has_movements) === 1
        ) {
          throw new ProductLotTrackingLockedError();
        }
        const nextQuantityPolicy = {
          baseUnit:
            dto.baseUnit ??
            (dto.trackSerials === true ? 'UNIT' : currentTracking.base_unit),
          precision:
            dto.quantityPrecision ??
            (dto.trackSerials === true
              ? 0
              : Number(currentTracking.quantity_precision)),
          rounding: dto.quantityRounding ?? currentTracking.quantity_rounding,
          minimumQuantity:
            dto.minimumQuantity ??
            (dto.trackSerials === true
              ? '1.000'
              : currentTracking.minimum_quantity),
        };
        assertProductQuantityPolicy(
          nextQuantityPolicy,
          dto.trackSerials ?? Boolean(currentTracking.track_serials),
        );
        const quantityPolicyChanged =
          nextQuantityPolicy.baseUnit !== currentTracking.base_unit ||
          nextQuantityPolicy.precision !==
            Number(currentTracking.quantity_precision) ||
          nextQuantityPolicy.rounding !== currentTracking.quantity_rounding ||
          quantityToUnits(nextQuantityPolicy.minimumQuantity) !==
            quantityToUnits(currentTracking.minimum_quantity);
        if (
          quantityPolicyChanged &&
          Number(currentTracking.has_movements) === 1
        ) {
          throw new ProductQuantityPolicyLockedError();
        }
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
               track_lots = COALESCE(?, track_lots),
               lot_expiration_policy = COALESCE(?, lot_expiration_policy),
               lot_expiration_alert_days = COALESCE(?, lot_expiration_alert_days),
               allow_expired_stock_override = COALESCE(?, allow_expired_stock_override),
               track_serials = COALESCE(?, track_serials),
               base_unit = COALESCE(?, base_unit),
               quantity_precision = COALESCE(?, quantity_precision),
               quantity_rounding = COALESCE(?, quantity_rounding),
               minimum_quantity = COALESCE(?, minimum_quantity),
               category_id = ?, brand_id = ?, cost = ?, price = ?, version = version + 1
           WHERE id = ? AND tenant_id = ? AND version = ?`,
          [
            dto.name,
            dto.sku,
            this.normalize(dto.sku),
            dto.barcode ?? null,
            dto.trackLots ?? null,
            dto.lotExpirationPolicy ?? null,
            dto.lotExpirationAlertDays ?? null,
            dto.allowExpiredStockOverride ?? null,
            dto.trackSerials ?? null,
            dto.baseUnit ?? (dto.trackSerials === true ? 'UNIT' : null),
            dto.quantityPrecision ?? (dto.trackSerials === true ? 0 : null),
            dto.quantityRounding ?? null,
            dto.minimumQuantity ?? (dto.trackSerials === true ? '1.000' : null),
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
        await manager.query(
          `UPDATE products child
           INNER JOIN products parent
             ON parent.id = child.parent_product_id
            AND parent.tenant_id = child.tenant_id
           SET child.track_lots = parent.track_lots,
               child.lot_expiration_policy = parent.lot_expiration_policy,
               child.lot_expiration_alert_days = parent.lot_expiration_alert_days,
               child.allow_expired_stock_override = parent.allow_expired_stock_override,
               child.base_unit = parent.base_unit,
               child.quantity_precision = parent.quantity_precision,
               child.quantity_rounding = parent.quantity_rounding,
               child.minimum_quantity = parent.minimum_quantity,
               child.version = child.version + 1
           WHERE child.tenant_id = ? AND parent.id = ?`,
          [tenantId, id],
        );
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
    if (query.categoryId) {
      conditions.push('p.category_id = ?');
      parameters.push(query.categoryId);
    }
    if (query.brandId) {
      conditions.push('p.brand_id = ?');
      parameters.push(query.brandId);
    }
    if (query.sellableOnly) conditions.push('p.variant_schema IS NULL');
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
    if (!rows[0]) return null;
    const product = this.toProduct(rows[0]);
    if (product.variantAttributes.length > 0) {
      const variants = await this.dataSource.query<ProductRow[]>(
        `${this.productSelect()} WHERE p.parent_product_id = ? AND p.tenant_id = ?
         ORDER BY p.created_at, p.id`,
        [id, tenantId],
      );
      product.variants = variants.map((row) => this.toProduct(row));
    }
    return product;
  }

  async resolveCode(
    tenantId: string,
    code: string,
  ): Promise<ProductData | null> {
    const rows = await this.dataSource.query<ProductRow[]>(
      `${this.productSelect()} WHERE p.tenant_id = ?
         AND p.variant_schema IS NULL
         AND (p.normalized_sku = ? OR p.barcode = ?)
       ORDER BY p.id LIMIT 2`,
      [tenantId, this.normalize(code), code],
    );
    if (rows.length > 1) throw new ProductCodeAmbiguousError();
    return rows[0] ? this.toProduct(rows[0]) : null;
  }

  async updateProductVariants(
    tenantId: string,
    parentId: string,
    dto: UpdateProductVariantsDto,
  ): Promise<ProductData | null> {
    try {
      return await this.dataSource.transaction(async (manager) => {
        const [parent] = await manager.query<
          Array<{
            id: string;
            name: string;
            category_id: string | null;
            brand_id: string | null;
            track_lots: number | boolean;
            lot_expiration_policy: 'NONE' | 'OPTIONAL' | 'REQUIRED';
            lot_expiration_alert_days: number;
            allow_expired_stock_override: number | boolean;
            track_serials: number | boolean;
            base_unit: ProductBaseUnit;
            quantity_precision: number;
            quantity_rounding: QuantityRoundingMode;
            minimum_quantity: string;
            active: number | boolean;
            version: number;
            parent_product_id: string | null;
            variant_schema: unknown;
          }>
        >(
          `SELECT id, name, category_id, brand_id, track_lots, base_unit,
                  quantity_precision, quantity_rounding, minimum_quantity,
                  lot_expiration_policy, lot_expiration_alert_days,
                  allow_expired_stock_override, track_serials, active,
                  version, parent_product_id, variant_schema
           FROM products WHERE id = ? AND tenant_id = ? LIMIT 1 FOR UPDATE`,
          [parentId, tenantId],
        );
        if (!parent) return null;
        if (parent.parent_product_id) {
          throw new ProductVariantConfigurationError(
            'Una variante no puede contener otras variantes.',
          );
        }
        if (!parent.active) {
          throw new ProductVariantConfigurationError(
            'Activa el producto padre antes de modificar sus variantes.',
          );
        }
        if (Number(parent.version) !== dto.version) {
          throw new ProductVersionConflictError(Number(parent.version));
        }

        const attributes = this.validateVariantConfiguration(dto);
        if (parent.variant_schema === null) {
          const [stock] = await manager.query<
            Array<{ has_stock: number | string }>
          >(
            `SELECT EXISTS(
               SELECT 1 FROM inventory_balances
               WHERE tenant_id = ? AND product_id = ? AND quantity <> 0
             ) AS has_stock`,
            [tenantId, parentId],
          );
          if (Number(stock.has_stock) === 1) {
            throw new ProductVariantsRequireZeroStockError();
          }
        }

        const existing = await manager.query<
          Array<{
            id: string;
            version: number;
            active: number | boolean;
            variant_values: unknown;
          }>
        >(
          `SELECT id, version, active, variant_values FROM products
           WHERE tenant_id = ? AND parent_product_id = ? FOR UPDATE`,
          [tenantId, parentId],
        );
        const existingById = new Map(existing.map((row) => [row.id, row]));
        const retainedIds = new Set<string>();
        for (const input of dto.variants) {
          const variantValues = attributes.map((attribute, index) => ({
            attribute: attribute.name,
            value: input.values[index],
          }));
          const name = `${parent.name} · ${input.values.join(' / ')}`;
          if (input.id) {
            if (retainedIds.has(input.id)) {
              throw new ProductVariantConfigurationError(
                'Una variante existente no puede asignarse a dos combinaciones.',
              );
            }
            const current = existingById.get(input.id);
            if (!current || input.version === undefined) {
              throw new ProductVariantConfigurationError(
                'La variante indicada no pertenece a este producto.',
              );
            }
            if (Number(current.version) !== input.version) {
              throw new ProductVersionConflictError(Number(current.version));
            }
            await manager.query(
              `UPDATE products SET name = ?, sku = ?, normalized_sku = ?, barcode = ?,
                 variant_values = ?, cost = ?, price = ?, active = ?, version = version + 1
               WHERE id = ? AND tenant_id = ? AND parent_product_id = ?`,
              [
                name,
                input.sku,
                this.normalize(input.sku),
                input.barcode ?? null,
                JSON.stringify(variantValues),
                input.cost,
                input.price,
                input.active,
                input.id,
                tenantId,
                parentId,
              ],
            );
            retainedIds.add(input.id);
          } else {
            const id = randomUUID();
            await manager.query(
              `INSERT INTO products
                (id, tenant_id, parent_product_id, name, sku, normalized_sku, barcode,
                 variant_values, track_lots, track_serials, base_unit,
                 quantity_precision, quantity_rounding, minimum_quantity,
                 category_id, brand_id,
                 lot_expiration_policy, lot_expiration_alert_days,
                 allow_expired_stock_override, cost, price, active)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
              [
                id,
                tenantId,
                parentId,
                name,
                input.sku,
                this.normalize(input.sku),
                input.barcode ?? null,
                JSON.stringify(variantValues),
                parent.track_lots,
                parent.track_serials,
                parent.base_unit,
                parent.quantity_precision,
                parent.quantity_rounding,
                parent.minimum_quantity,
                parent.category_id,
                parent.brand_id,
                parent.lot_expiration_policy,
                parent.lot_expiration_alert_days,
                parent.allow_expired_stock_override,
                input.cost,
                input.price,
                input.active,
              ],
            );
            retainedIds.add(id);
          }
        }

        const removedIds = existing
          .map(({ id }) => id)
          .filter(
            (id) =>
              !retainedIds.has(id) && Boolean(existingById.get(id)?.active),
          );
        if (removedIds.length > 0) {
          await manager.query(
            `UPDATE products SET active = FALSE, version = version + 1
             WHERE tenant_id = ? AND parent_product_id = ?
               AND id IN (${removedIds.map(() => '?').join(',')})`,
            [tenantId, parentId, ...removedIds],
          );
        }
        await manager.query(
          `UPDATE products SET variant_schema = ?, version = version + 1
           WHERE id = ? AND tenant_id = ? AND version = ?`,
          [JSON.stringify(attributes), parentId, tenantId, dto.version],
        );
        const product = await this.findProduct(manager, tenantId, parentId);
        if (!product) throw new Error('UPDATED_PRODUCT_NOT_FOUND');
        const variantRows = await manager.query<ProductRow[]>(
          `${this.productSelect()} WHERE p.parent_product_id = ? AND p.tenant_id = ?
           ORDER BY p.created_at, p.id`,
          [parentId, tenantId],
        );
        product.variants = variantRows.map((row) => this.toProduct(row));
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
          has_variants: number | string;
        }>
      >(
        `SELECT
           EXISTS(SELECT 1 FROM inventory_movements WHERE tenant_id = ? AND product_id = ?) AS has_movements,
           EXISTS(SELECT 1 FROM sale_lines WHERE tenant_id = ? AND product_id = ?) AS has_sales,
           EXISTS(SELECT 1 FROM inventory_balances WHERE tenant_id = ? AND product_id = ? AND quantity <> 0) AS has_stock,
           EXISTS(SELECT 1 FROM products WHERE tenant_id = ? AND parent_product_id = ?) AS has_variants`,
        [tenantId, id, tenantId, id, tenantId, id, tenantId, id],
      );
      const mustPreserve =
        Number(references.has_movements) === 1 ||
        Number(references.has_sales) === 1 ||
        Number(references.has_stock) === 1 ||
        Number(references.has_variants) === 1;
      if (mustPreserve) {
        await manager.query(
          `UPDATE products SET active = FALSE, version = version + 1
           WHERE tenant_id = ? AND active = TRUE
             AND (id = ? OR parent_product_id = ?)`,
          [tenantId, id, id],
        );
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

  async listClassifications(
    tenantId: string,
    kind: CatalogClassificationKind,
    includeInactive: boolean,
  ): Promise<CatalogClassificationData[]> {
    const { table, productColumn } = this.classification(kind);
    const rows = await this.dataSource.query<
      Array<{
        id: string;
        name: string;
        active: number | boolean;
        product_count: string | number;
      }>
    >(
      `SELECT x.id, x.name, x.active, COUNT(p.id) AS product_count
       FROM ${table} x
       LEFT JOIN products p ON p.tenant_id = x.tenant_id AND p.${productColumn} = x.id
       WHERE x.tenant_id = ?${includeInactive ? '' : ' AND x.active = TRUE'}
       GROUP BY x.id, x.name, x.active
       ORDER BY x.active DESC, x.name`,
      [tenantId],
    );
    return rows.map((row) => ({
      id: row.id,
      name: row.name,
      active: Boolean(row.active),
      productCount: Number(row.product_count),
    }));
  }

  async createClassification(
    tenantId: string,
    kind: CatalogClassificationKind,
    name: string,
  ): Promise<CatalogClassificationData> {
    const { table } = this.classification(kind);
    const id = randomUUID();
    try {
      await this.dataSource.query(
        `INSERT INTO ${table} (id, tenant_id, name, normalized_name)
         VALUES (?, ?, ?, ?)`,
        [id, tenantId, name, this.normalize(name)],
      );
    } catch (error) {
      if (this.duplicateConstraint(error)) {
        throw new CatalogClassificationConflictError();
      }
      throw error;
    }
    return { id, name, active: true, productCount: 0 };
  }

  async updateClassification(
    tenantId: string,
    kind: CatalogClassificationKind,
    id: string,
    dto: UpdateCatalogClassificationDto,
  ): Promise<CatalogClassificationData | null> {
    const { table } = this.classification(kind);
    try {
      const result = await this.dataSource.query<ResultSetHeader>(
        `UPDATE ${table} SET
           name = COALESCE(?, name),
           normalized_name = COALESCE(?, normalized_name),
           active = COALESCE(?, active)
         WHERE tenant_id = ? AND id = ?`,
        [
          dto.name ?? null,
          dto.name ? this.normalize(dto.name) : null,
          dto.active === undefined ? null : dto.active,
          tenantId,
          id,
        ],
      );
      if (!result.affectedRows) {
        const existing = await this.classificationById(tenantId, kind, id);
        return existing;
      }
      return this.classificationById(tenantId, kind, id);
    } catch (error) {
      if (this.duplicateConstraint(error)) {
        throw new CatalogClassificationConflictError();
      }
      throw error;
    }
  }

  async deactivateClassification(
    tenantId: string,
    kind: CatalogClassificationKind,
    id: string,
    replacementId?: string,
  ): Promise<{
    classification: CatalogClassificationData;
    reassignedProducts: number;
  } | null> {
    const { table, productColumn } = this.classification(kind);
    return this.dataSource.transaction(async (manager) => {
      const current = await manager.query<Array<{ id: string }>>(
        `SELECT id FROM ${table} WHERE tenant_id = ? AND id = ? FOR UPDATE`,
        [tenantId, id],
      );
      if (!current[0]) return null;
      if (replacementId === id) throw new CatalogClassificationConflictError();
      if (replacementId) {
        const replacement = await manager.query<Array<{ id: string }>>(
          `SELECT id FROM ${table}
           WHERE tenant_id = ? AND id = ? AND active = TRUE FOR UPDATE`,
          [tenantId, replacementId],
        );
        if (!replacement[0]) return null;
      }
      const reassigned = await manager.query<ResultSetHeader>(
        `UPDATE products SET ${productColumn} = ?, version = version + 1
         WHERE tenant_id = ? AND ${productColumn} = ?`,
        [replacementId ?? null, tenantId, id],
      );
      await manager.query(
        `UPDATE ${table} SET active = FALSE WHERE tenant_id = ? AND id = ?`,
        [tenantId, id],
      );
      const classification = await this.classificationById(
        tenantId,
        kind,
        id,
        manager,
      );
      if (!classification) throw new Error('CLASSIFICATION_NOT_FOUND');
      return {
        classification,
        reassignedProducts: reassigned.affectedRows,
      };
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
       ON DUPLICATE KEY UPDATE name = VALUES(name), active = TRUE`,
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
    return `SELECT p.id, p.name, p.sku, p.barcode, p.base_unit,
                   p.quantity_precision, p.quantity_rounding, p.minimum_quantity,
                   p.track_lots,
                   p.lot_expiration_policy, p.lot_expiration_alert_days,
                   p.allow_expired_stock_override, p.track_serials,
                   p.cost, p.price, p.active, p.version,
                   p.parent_product_id, p.variant_schema, p.variant_values,
                   c.id AS category_id, c.name AS category_name,
                   b.id AS brand_id, b.name AS brand_name
            FROM products p
            LEFT JOIN categories c ON c.id = p.category_id AND c.tenant_id = p.tenant_id
            LEFT JOIN brands b ON b.id = p.brand_id AND b.tenant_id = p.tenant_id`;
  }

  private async specificLotPolicy(
    manager: EntityManager,
    tenantId: string,
  ): Promise<boolean> {
    const [row] = await manager.query<Array<{ active: number | string }>>(
      `SELECT EXISTS(SELECT 1 FROM inventory_valuation_policies
                     WHERE tenant_id = ? AND method = 'SPECIFIC_LOT') AS active`,
      [tenantId],
    );
    return Number(row.active) === 1;
  }

  private classification(kind: CatalogClassificationKind) {
    return kind === CatalogClassificationKind.CATEGORIES
      ? ({ table: 'categories', productColumn: 'category_id' } as const)
      : ({ table: 'brands', productColumn: 'brand_id' } as const);
  }

  private async classificationById(
    tenantId: string,
    kind: CatalogClassificationKind,
    id: string,
    source: DataSource | EntityManager = this.dataSource,
  ): Promise<CatalogClassificationData | null> {
    const { table, productColumn } = this.classification(kind);
    const rows = await source.query<
      Array<{
        id: string;
        name: string;
        active: number | boolean;
        product_count: string | number;
      }>
    >(
      `SELECT x.id, x.name, x.active, COUNT(p.id) AS product_count
       FROM ${table} x
       LEFT JOIN products p ON p.tenant_id = x.tenant_id AND p.${productColumn} = x.id
       WHERE x.tenant_id = ? AND x.id = ?
       GROUP BY x.id, x.name, x.active LIMIT 1`,
      [tenantId, id],
    );
    const row = rows[0];
    return row
      ? {
          id: row.id,
          name: row.name,
          active: Boolean(row.active),
          productCount: Number(row.product_count),
        }
      : null;
  }

  private toProduct(row: ProductRow): ProductData {
    return {
      id: row.id,
      name: row.name,
      sku: row.sku,
      barcode: row.barcode,
      baseUnit: row.base_unit,
      quantityPrecision: Number(row.quantity_precision),
      quantityRounding: row.quantity_rounding,
      minimumQuantity: row.minimum_quantity,
      trackLots: Boolean(row.track_lots),
      lotExpirationPolicy: row.lot_expiration_policy,
      lotExpirationAlertDays: Number(row.lot_expiration_alert_days),
      allowExpiredStockOverride: Boolean(row.allow_expired_stock_override),
      trackSerials: Boolean(row.track_serials),
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
      parentProductId: row.parent_product_id,
      variantAttributes: this.jsonValue(row.variant_schema),
      variantValues: this.jsonValue(row.variant_values),
      sellable: row.variant_schema === null,
      variants: [],
    };
  }

  private validateVariantConfiguration(dto: UpdateProductVariantsDto) {
    const normalizedNames = new Set<string>();
    const attributes = dto.attributes.map((attribute) => {
      const normalizedName = this.normalize(attribute.name);
      if (normalizedNames.has(normalizedName)) {
        throw new ProductVariantConfigurationError(
          'Los nombres de atributo no pueden repetirse.',
        );
      }
      normalizedNames.add(normalizedName);
      const normalizedValues = new Set<string>();
      for (const value of attribute.values) {
        const normalized = this.normalize(value);
        if (normalizedValues.has(normalized)) {
          throw new ProductVariantConfigurationError(
            `El atributo ${attribute.name} contiene valores repetidos.`,
          );
        }
        normalizedValues.add(normalized);
      }
      return { name: attribute.name, values: attribute.values };
    });
    const combinationCount = attributes.reduce(
      (total, attribute) => total * attribute.values.length,
      1,
    );
    if (combinationCount > 100) {
      throw new ProductVariantConfigurationError(
        'La configuración genera más de 100 combinaciones.',
      );
    }
    if (dto.variants.length !== combinationCount) {
      throw new ProductVariantConfigurationError(
        'Debes configurar exactamente una variante por combinación.',
      );
    }
    const expected = new Set(
      this.cartesian(attributes.map(({ values }) => values)),
    );
    const received = new Set<string>();
    for (const variant of dto.variants) {
      if (variant.values.length !== attributes.length) {
        throw new ProductVariantConfigurationError(
          'Cada variante debe seleccionar un valor por atributo.',
        );
      }
      const key = variant.values
        .map((value) => this.normalize(value))
        .join('\u0000');
      if (!expected.has(key) || received.has(key)) {
        throw new ProductVariantConfigurationError(
          'Las combinaciones son inválidas o están repetidas.',
        );
      }
      received.add(key);
    }
    return attributes;
  }

  private cartesian(values: string[][]): string[] {
    return values
      .reduce<string[][]>(
        (combinations, options) =>
          combinations.flatMap((combination) =>
            options.map((option) => [...combination, this.normalize(option)]),
          ),
        [[]],
      )
      .map((combination) => combination.join('\u0000'));
  }

  private jsonValue<T>(value: string | T | null): T {
    if (value === null) return [] as T;
    return (typeof value === 'string' ? JSON.parse(value) : value) as T;
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
