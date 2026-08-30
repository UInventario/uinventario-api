import { Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { ResultSetHeader } from 'mysql2';
import { DataSource, EntityManager } from 'typeorm';
import { SavePromotionDto, UpdatePromotionDto } from './dto/save-promotion.dto';
import { PromotionData, PromotionType } from './promotion.types';
import type { PriceChannel } from '../pricing/price-list.types';

interface PromotionRow {
  id: string;
  name: string;
  type: PromotionType;
  branch_id: string | null;
  branch_name: string | null;
  customer_id: string | null;
  customer_name: string | null;
  channel: PriceChannel | null;
  priority: number | string;
  stackable: number | boolean;
  valid_from: Date | string;
  valid_to: Date | string | null;
  active: number | boolean;
  discount_percent: string | null;
  fixed_price: string | null;
  buy_quantity: string | null;
  reward_quantity: string | null;
  version: number | string;
  created_at: Date | string;
  updated_at: Date | string;
}

@Injectable()
export class PromotionRepository {
  constructor(private readonly dataSource: DataSource) {}

  async list(tenantId: string): Promise<PromotionData[]> {
    return this.hydrate(
      this.dataSource.manager,
      tenantId,
      await this.rows(this.dataSource.manager, tenantId),
    );
  }

  async create(
    tenantId: string,
    dto: SavePromotionDto,
  ): Promise<PromotionData> {
    return this.dataSource.transaction(async (manager) => {
      await this.validate(manager, tenantId, dto);
      const id = randomUUID();
      await manager.query(
        `INSERT INTO promotions
          (id, tenant_id, name, type, branch_id, customer_id, channel, priority,
           stackable, valid_from, valid_to, active, discount_percent, fixed_price,
           buy_quantity, reward_quantity)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          id,
          tenantId,
          dto.name,
          dto.type,
          dto.branchId ?? null,
          dto.customerId ?? null,
          dto.channel ?? null,
          dto.priority,
          dto.stackable,
          new Date(dto.validFrom),
          dto.validTo ? new Date(dto.validTo) : null,
          dto.active,
          dto.discountPercent ?? null,
          dto.fixedPrice ?? null,
          dto.buyQuantity ?? null,
          dto.rewardQuantity ?? null,
        ],
      );
      await this.replaceRules(manager, tenantId, id, dto);
      return (await this.find(manager, tenantId, id))!;
    });
  }

  async update(
    tenantId: string,
    id: string,
    dto: UpdatePromotionDto,
  ): Promise<PromotionData | 'CONFLICT' | null> {
    return this.dataSource.transaction(async (manager) => {
      await this.validate(manager, tenantId, dto);
      const result = await manager.query<ResultSetHeader>(
        `UPDATE promotions SET name = ?, type = ?, branch_id = ?, customer_id = ?,
           channel = ?, priority = ?, stackable = ?, valid_from = ?, valid_to = ?,
           active = ?, discount_percent = ?, fixed_price = ?, buy_quantity = ?,
           reward_quantity = ?, version = version + 1
         WHERE id = ? AND tenant_id = ? AND version = ?`,
        [
          dto.name,
          dto.type,
          dto.branchId ?? null,
          dto.customerId ?? null,
          dto.channel ?? null,
          dto.priority,
          dto.stackable,
          new Date(dto.validFrom),
          dto.validTo ? new Date(dto.validTo) : null,
          dto.active,
          dto.discountPercent ?? null,
          dto.fixedPrice ?? null,
          dto.buyQuantity ?? null,
          dto.rewardQuantity ?? null,
          id,
          tenantId,
          dto.version,
        ],
      );
      if (result.affectedRows === 0)
        return (await this.find(manager, tenantId, id)) ? 'CONFLICT' : null;
      await manager.query(
        'DELETE FROM promotion_products WHERE tenant_id = ? AND promotion_id = ?',
        [tenantId, id],
      );
      await manager.query(
        'DELETE FROM promotion_quantity_tiers WHERE tenant_id = ? AND promotion_id = ?',
        [tenantId, id],
      );
      await this.replaceRules(manager, tenantId, id, dto);
      return (await this.find(manager, tenantId, id))!;
    });
  }

  async applicable(input: {
    tenantId: string;
    branchId: string;
    customerId?: string;
    channel: PriceChannel;
    productIds: string[];
    at: Date;
  }): Promise<PromotionData[]> {
    if (!input.productIds.length) return [];
    const rows = await this.dataSource.query<PromotionRow[]>(
      `${this.select()}
       WHERE pr.tenant_id = ? AND pr.active = TRUE
         AND pr.valid_from <= ? AND (pr.valid_to IS NULL OR pr.valid_to > ?)
         AND (pr.branch_id IS NULL OR pr.branch_id = ?)
         AND (pr.customer_id IS NULL OR pr.customer_id = ?)
         AND (pr.channel IS NULL OR pr.channel = ?)
         AND EXISTS (SELECT 1 FROM promotion_products pp
           WHERE pp.tenant_id = pr.tenant_id AND pp.promotion_id = pr.id
             AND pp.product_id IN (${input.productIds.map(() => '?').join(',')}))
       ORDER BY pr.priority DESC,
         ((pr.branch_id IS NOT NULL) + (pr.customer_id IS NOT NULL) + (pr.channel IS NOT NULL)) DESC,
         pr.valid_from DESC, pr.id ASC`,
      [
        input.tenantId,
        input.at,
        input.at,
        input.branchId,
        input.customerId ?? '',
        input.channel,
        ...input.productIds,
      ],
    );
    return this.hydrate(this.dataSource.manager, input.tenantId, rows);
  }

  private async validate(
    manager: EntityManager,
    tenantId: string,
    dto: SavePromotionDto,
  ): Promise<void> {
    if (dto.validTo && new Date(dto.validTo) <= new Date(dto.validFrom))
      throw new Error('PROMOTION_INVALID_VALIDITY');
    const single = dto.type !== 'BUNDLE_FIXED';
    if (
      (single && dto.products.length !== 1) ||
      (!single && dto.products.length < 2)
    )
      throw new Error('PROMOTION_INVALID_PRODUCTS');
    if (dto.type === 'BUY_X_GET_Y') {
      if (!dto.buyQuantity || !dto.rewardQuantity || !dto.discountPercent)
        throw new Error('PROMOTION_INVALID_RULE');
      if (this.quantity(dto.rewardQuantity) > this.quantity(dto.buyQuantity))
        throw new Error('PROMOTION_INVALID_RULE');
    } else if (dto.type === 'SECOND_UNIT_PERCENT') {
      if (!dto.discountPercent) throw new Error('PROMOTION_INVALID_RULE');
    } else if (dto.type === 'BUNDLE_FIXED') {
      if (!dto.fixedPrice) throw new Error('PROMOTION_INVALID_RULE');
    } else if (!dto.tiers.length) throw new Error('PROMOTION_INVALID_RULE');
    if (dto.type !== 'QUANTITY_PERCENT' && dto.tiers.length)
      throw new Error('PROMOTION_INVALID_RULE');
    if (
      dto.type === 'QUANTITY_PERCENT' &&
      dto.tiers.some((tier) => this.percent(tier.discountPercent) > 500000n)
    )
      throw new Error('PROMOTION_MARGIN_LIMIT');
    const productIds = dto.products.map(({ productId }) => productId);
    const [state] = await manager.query<
      Array<{
        products: number | string;
        branch_exists: number | string;
        customer_exists: number | string;
      }>
    >(
      `SELECT
         (SELECT COUNT(*) FROM products WHERE tenant_id = ? AND active = TRUE
           AND variant_schema IS NULL AND id IN (${productIds.map(() => '?').join(',')})) AS products,
         ${dto.branchId ? 'EXISTS(SELECT 1 FROM branches WHERE tenant_id = ? AND id = ? AND active = TRUE)' : '1'} AS branch_exists,
         ${dto.customerId ? 'EXISTS(SELECT 1 FROM customers WHERE tenant_id = ? AND id = ? AND active = TRUE)' : '1'} AS customer_exists`,
      [
        tenantId,
        ...productIds,
        ...(dto.branchId ? [tenantId, dto.branchId] : []),
        ...(dto.customerId ? [tenantId, dto.customerId] : []),
      ],
    );
    if (Number(state.products) !== productIds.length)
      throw new Error('PROMOTION_PRODUCT_NOT_AVAILABLE');
    if (!Number(state.branch_exists))
      throw new Error('PROMOTION_BRANCH_NOT_AVAILABLE');
    if (!Number(state.customer_exists))
      throw new Error('PROMOTION_CUSTOMER_NOT_AVAILABLE');
  }

  private async replaceRules(
    manager: EntityManager,
    tenantId: string,
    promotionId: string,
    dto: SavePromotionDto,
  ): Promise<void> {
    await manager.query(
      `INSERT INTO promotion_products (id, tenant_id, promotion_id, product_id, quantity, position)
       VALUES ${dto.products.map(() => '(?, ?, ?, ?, ?, ?)').join(',')}`,
      dto.products.flatMap((item, index) => [
        randomUUID(),
        tenantId,
        promotionId,
        item.productId,
        item.quantity,
        index,
      ]),
    );
    if (dto.tiers.length) {
      await manager.query(
        `INSERT INTO promotion_quantity_tiers
          (id, tenant_id, promotion_id, minimum_quantity, discount_percent)
         VALUES ${dto.tiers.map(() => '(?, ?, ?, ?, ?)').join(',')}`,
        dto.tiers.flatMap((tier) => [
          randomUUID(),
          tenantId,
          promotionId,
          tier.minimumQuantity,
          tier.discountPercent,
        ]),
      );
    }
  }

  private async find(
    manager: EntityManager,
    tenantId: string,
    id: string,
  ): Promise<PromotionData | null> {
    const rows = await this.rows(manager, tenantId, id);
    return rows[0] ? (await this.hydrate(manager, tenantId, rows))[0] : null;
  }

  private rows(
    manager: EntityManager,
    tenantId: string,
    id?: string,
  ): Promise<PromotionRow[]> {
    return manager.query<PromotionRow[]>(
      `${this.select()} WHERE pr.tenant_id = ?${id ? ' AND pr.id = ?' : ''} ORDER BY pr.priority DESC, pr.updated_at DESC, pr.id`,
      id ? [tenantId, id] : [tenantId],
    );
  }

  private select(): string {
    return `SELECT pr.*, b.name AS branch_name, c.name AS customer_name
      FROM promotions pr
      LEFT JOIN branches b ON b.id = pr.branch_id AND b.tenant_id = pr.tenant_id
      LEFT JOIN customers c ON c.id = pr.customer_id AND c.tenant_id = pr.tenant_id`;
  }

  private async hydrate(
    manager: EntityManager,
    tenantId: string,
    rows: PromotionRow[],
  ): Promise<PromotionData[]> {
    if (!rows.length) return [];
    const ids = rows.map(({ id }) => id);
    const products = await manager.query<
      Array<{
        promotion_id: string;
        product_id: string;
        name: string;
        sku: string;
        quantity: string;
      }>
    >(
      `SELECT pp.promotion_id, p.id AS product_id, p.name, p.sku, pp.quantity
       FROM promotion_products pp INNER JOIN products p ON p.id = pp.product_id AND p.tenant_id = pp.tenant_id
       WHERE pp.tenant_id = ? AND pp.promotion_id IN (${ids.map(() => '?').join(',')})
       ORDER BY pp.promotion_id, pp.position, pp.id`,
      [tenantId, ...ids],
    );
    const tiers = await manager.query<
      Array<{
        promotion_id: string;
        minimum_quantity: string;
        discount_percent: string;
      }>
    >(
      `SELECT promotion_id, minimum_quantity, discount_percent FROM promotion_quantity_tiers
       WHERE tenant_id = ? AND promotion_id IN (${ids.map(() => '?').join(',')})
       ORDER BY promotion_id, minimum_quantity`,
      [tenantId, ...ids],
    );
    return rows.map((row) => ({
      id: row.id,
      name: row.name,
      type: row.type,
      scope: {
        branch: row.branch_id
          ? { id: row.branch_id, name: row.branch_name! }
          : null,
        customer: row.customer_id
          ? { id: row.customer_id, name: row.customer_name! }
          : null,
        channel: row.channel,
      },
      priority: Number(row.priority),
      stackable: Boolean(row.stackable),
      validFrom: new Date(row.valid_from).toISOString(),
      validTo: row.valid_to ? new Date(row.valid_to).toISOString() : null,
      active: Boolean(row.active),
      discountPercent: row.discount_percent,
      fixedPrice: row.fixed_price,
      buyQuantity: row.buy_quantity,
      rewardQuantity: row.reward_quantity,
      version: Number(row.version),
      products: products
        .filter((item) => item.promotion_id === row.id)
        .map((item) => ({
          product: { id: item.product_id, name: item.name, sku: item.sku },
          quantity: item.quantity,
        })),
      tiers: tiers
        .filter((item) => item.promotion_id === row.id)
        .map((item) => ({
          minimumQuantity: item.minimum_quantity,
          discountPercent: item.discount_percent,
        })),
      createdAt: new Date(row.created_at).toISOString(),
      updatedAt: new Date(row.updated_at).toISOString(),
    }));
  }

  private quantity(value: string): bigint {
    const [whole, fraction = ''] = value.split('.');
    return BigInt(whole) * 1000n + BigInt(fraction.padEnd(3, '0'));
  }

  private percent(value: string): bigint {
    const [whole, fraction = ''] = value.split('.');
    return BigInt(whole) * 10000n + BigInt(fraction.padEnd(4, '0'));
  }
}
