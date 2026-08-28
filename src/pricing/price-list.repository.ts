import { Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { ResultSetHeader } from 'mysql2';
import { DataSource, EntityManager } from 'typeorm';
import {
  SavePriceListDto,
  UpdatePriceListDto,
} from './dto/save-price-list.dto';
import { PriceChannel, PriceListData, ResolvedPrice } from './price-list.types';

interface ListRow {
  id: string;
  name: string;
  currency: string;
  branch_id: string | null;
  branch_name: string | null;
  customer_id: string | null;
  customer_name: string | null;
  channel: PriceChannel | null;
  priority: number | string;
  valid_from: Date | string;
  valid_to: Date | string | null;
  active: number | boolean;
  version: number | string;
  created_at: Date | string;
  updated_at: Date | string;
}

@Injectable()
export class PriceListRepository {
  constructor(private readonly dataSource: DataSource) {}

  async list(tenantId: string): Promise<PriceListData[]> {
    return this.withItems(
      this.dataSource.manager,
      tenantId,
      await this.rows(this.dataSource.manager, tenantId),
    );
  }

  async create(
    tenantId: string,
    dto: SavePriceListDto,
  ): Promise<PriceListData> {
    return this.dataSource.transaction(async (manager) => {
      await this.assertReferences(manager, tenantId, dto);
      const id = randomUUID();
      await manager.query(
        `INSERT INTO price_lists
          (id, tenant_id, name, currency, branch_id, customer_id, channel,
           priority, valid_from, valid_to, active)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          id,
          tenantId,
          dto.name,
          dto.currency,
          dto.branchId ?? null,
          dto.customerId ?? null,
          dto.channel ?? null,
          dto.priority,
          new Date(dto.validFrom),
          dto.validTo ? new Date(dto.validTo) : null,
          dto.active,
        ],
      );
      await this.replaceItems(manager, tenantId, id, dto.items);
      return (await this.find(manager, tenantId, id))!;
    });
  }

  async update(
    tenantId: string,
    id: string,
    dto: UpdatePriceListDto,
  ): Promise<PriceListData | 'CONFLICT' | null> {
    return this.dataSource.transaction(async (manager) => {
      await this.assertReferences(manager, tenantId, dto);
      const result = await manager.query<ResultSetHeader>(
        `UPDATE price_lists SET name = ?, currency = ?, branch_id = ?,
           customer_id = ?, channel = ?, priority = ?, valid_from = ?,
           valid_to = ?, active = ?, version = version + 1
         WHERE id = ? AND tenant_id = ? AND version = ?`,
        [
          dto.name,
          dto.currency,
          dto.branchId ?? null,
          dto.customerId ?? null,
          dto.channel ?? null,
          dto.priority,
          new Date(dto.validFrom),
          dto.validTo ? new Date(dto.validTo) : null,
          dto.active,
          id,
          tenantId,
          dto.version,
        ],
      );
      if (result.affectedRows === 0)
        return (await this.find(manager, tenantId, id)) ? 'CONFLICT' : null;
      await manager.query(
        'DELETE FROM price_list_items WHERE tenant_id = ? AND price_list_id = ?',
        [tenantId, id],
      );
      await this.replaceItems(manager, tenantId, id, dto.items);
      return (await this.find(manager, tenantId, id))!;
    });
  }

  async resolve(input: {
    tenantId: string;
    branchId: string;
    customerId?: string;
    channel: PriceChannel;
    currency: string;
    productIds: string[];
  }): Promise<Map<string, ResolvedPrice>> {
    if (input.productIds.length === 0) return new Map();
    const placeholders = input.productIds.map(() => '?').join(', ');
    const rows = await this.dataSource.query<
      Array<{
        product_id: string;
        price: string;
        price_list_id: string;
        price_list_name: string;
      }>
    >(
      `SELECT pli.product_id, pli.price, pl.id AS price_list_id, pl.name AS price_list_name
       FROM price_list_items pli
       INNER JOIN price_lists pl ON pl.id = pli.price_list_id AND pl.tenant_id = pli.tenant_id
       WHERE pl.tenant_id = ? AND pl.currency = ? AND pl.active = TRUE
         AND pl.valid_from <= CURRENT_TIMESTAMP(6)
         AND (pl.valid_to IS NULL OR pl.valid_to > CURRENT_TIMESTAMP(6))
         AND (pl.branch_id IS NULL OR pl.branch_id = ?)
         AND (pl.customer_id IS NULL OR pl.customer_id = ?)
         AND (pl.channel IS NULL OR pl.channel = ?)
         AND pli.product_id IN (${placeholders})
       ORDER BY pli.product_id, pl.priority DESC,
         ((pl.branch_id IS NOT NULL) + (pl.customer_id IS NOT NULL) + (pl.channel IS NOT NULL)) DESC,
         pl.valid_from DESC, pl.id ASC`,
      [
        input.tenantId,
        input.currency,
        input.branchId,
        input.customerId ?? '',
        input.channel,
        ...input.productIds,
      ],
    );
    const resolved = new Map<string, ResolvedPrice>();
    for (const row of rows) {
      if (resolved.has(row.product_id)) continue;
      resolved.set(row.product_id, {
        price: this.money(row.price),
        source: 'PRICE_LIST',
        priceList: { id: row.price_list_id, name: row.price_list_name },
      });
    }
    return resolved;
  }

  private async assertReferences(
    manager: EntityManager,
    tenantId: string,
    dto: SavePriceListDto,
  ): Promise<void> {
    if (dto.validTo && new Date(dto.validTo) <= new Date(dto.validFrom))
      throw new Error('PRICE_LIST_INVALID_VALIDITY');
    const productIds = dto.items.map((item) => item.productId);
    const placeholders = productIds.map(() => '?').join(', ');
    const [state] = await manager.query<
      Array<{
        products: number | string;
        branch_exists: number | string;
        customer_exists: number | string;
      }>
    >(
      `SELECT
        (SELECT COUNT(*) FROM products WHERE tenant_id = ? AND active = TRUE AND id IN (${placeholders})) AS products,
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
      throw new Error('PRICE_LIST_PRODUCT_NOT_AVAILABLE');
    if (!Number(state.branch_exists))
      throw new Error('PRICE_LIST_BRANCH_NOT_AVAILABLE');
    if (!Number(state.customer_exists))
      throw new Error('PRICE_LIST_CUSTOMER_NOT_AVAILABLE');
  }

  private async replaceItems(
    manager: EntityManager,
    tenantId: string,
    priceListId: string,
    items: SavePriceListDto['items'],
  ): Promise<void> {
    await manager.query(
      `INSERT INTO price_list_items (id, tenant_id, price_list_id, product_id, price)
       VALUES ${items.map(() => '(?, ?, ?, ?, ?)').join(', ')}`,
      items.flatMap((item) => [
        randomUUID(),
        tenantId,
        priceListId,
        item.productId,
        item.price,
      ]),
    );
  }

  private async find(
    manager: EntityManager,
    tenantId: string,
    id: string,
  ): Promise<PriceListData | null> {
    const rows = await this.rows(manager, tenantId, id);
    return rows[0] ? (await this.withItems(manager, tenantId, rows))[0] : null;
  }

  private rows(
    manager: EntityManager,
    tenantId: string,
    id?: string,
  ): Promise<ListRow[]> {
    return manager.query<ListRow[]>(
      `SELECT pl.id, pl.name, pl.currency, pl.branch_id, b.name AS branch_name,
              pl.customer_id, c.name AS customer_name, pl.channel, pl.priority,
              pl.valid_from, pl.valid_to, pl.active, pl.version, pl.created_at, pl.updated_at
       FROM price_lists pl
       LEFT JOIN branches b ON b.id = pl.branch_id AND b.tenant_id = pl.tenant_id
       LEFT JOIN customers c ON c.id = pl.customer_id AND c.tenant_id = pl.tenant_id
       WHERE pl.tenant_id = ?${id ? ' AND pl.id = ?' : ''}
       ORDER BY pl.priority DESC, pl.updated_at DESC, pl.id`,
      id ? [tenantId, id] : [tenantId],
    );
  }

  private async withItems(
    manager: EntityManager,
    tenantId: string,
    rows: ListRow[],
  ): Promise<PriceListData[]> {
    if (rows.length === 0) return [];
    const items = await manager.query<
      Array<{
        id: string;
        price_list_id: string;
        product_id: string;
        product_name: string;
        product_sku: string;
        price: string;
      }>
    >(
      `SELECT pli.id, pli.price_list_id, p.id AS product_id,
              p.name AS product_name, p.sku AS product_sku, pli.price
       FROM price_list_items pli
       INNER JOIN products p ON p.id = pli.product_id AND p.tenant_id = pli.tenant_id
       WHERE pli.tenant_id = ? AND pli.price_list_id IN (${rows.map(() => '?').join(', ')})
       ORDER BY p.name, p.sku`,
      [tenantId, ...rows.map((row) => row.id)],
    );
    return rows.map((row) => ({
      id: row.id,
      name: row.name,
      currency: row.currency,
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
      validFrom: new Date(row.valid_from).toISOString(),
      validTo: row.valid_to ? new Date(row.valid_to).toISOString() : null,
      active: Boolean(row.active),
      version: Number(row.version),
      items: items
        .filter((item) => item.price_list_id === row.id)
        .map((item) => ({
          id: item.id,
          product: {
            id: item.product_id,
            name: item.product_name,
            sku: item.product_sku,
          },
          price: this.money(item.price),
        })),
      createdAt: new Date(row.created_at).toISOString(),
      updatedAt: new Date(row.updated_at).toISOString(),
    }));
  }

  private money(value: string): string {
    const [whole, fraction = ''] = value.split('.');
    return `${whole}.${fraction.padEnd(2, '0').slice(0, 2)}`;
  }
}
