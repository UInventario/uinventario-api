import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
  StreamableFile,
} from '@nestjs/common';
import { createHash, randomUUID } from 'node:crypto';
import * as ExcelJS from 'exceljs';
import type { ResultSetHeader } from 'mysql2';
import { DataSource, EntityManager, QueryFailedError } from 'typeorm';

export interface ProductImportFile {
  originalname: string;
  size: number;
  buffer: Buffer;
}

interface ParsedRow {
  sourceRow: number;
  name: string;
  sku: string;
  barcode: string | null;
  category: string | null;
  brand: string | null;
  cost: string | null;
  price: string | null;
  active: boolean;
  errors: Array<{ code: string; message: string }>;
}

interface StoredRow extends ParsedRow {
  id: string;
  action: 'CREATE' | 'UPDATE' | 'UNCHANGED' | 'ERROR';
  productId: string | null;
  previewVersion: number | null;
}

const HEADERS = [
  'name',
  'sku',
  'barcode',
  'category',
  'brand',
  'cost',
  'price',
  'active',
] as const;
type Header = (typeof HEADERS)[number];

@Injectable()
export class ProductImportService {
  constructor(private readonly dataSource: DataSource) {}

  async preview(input: {
    tenantId: string;
    userId: string;
    file: ProductImportFile | undefined;
  }) {
    const file = input.file;
    if (!file)
      throw new BadRequestException({ code: 'PRODUCT_IMPORT_FILE_REQUIRED' });
    if (file.size < 1 || file.size > 2 * 1024 * 1024)
      throw new BadRequestException({
        code: 'INVALID_PRODUCT_IMPORT_FILE_SIZE',
      });
    const filename = (
      file.originalname.split(/[\\/]/).pop() || 'productos'
    ).slice(0, 160);
    const extension = filename.split('.').pop()?.toLowerCase();
    if (!['csv', 'xlsx'].includes(extension ?? ''))
      throw new BadRequestException({
        code: 'INVALID_PRODUCT_IMPORT_FILE_TYPE',
      });
    let matrix: string[][];
    try {
      matrix =
        extension === 'xlsx'
          ? await this.workbook(file.buffer)
          : this.csv(file.buffer);
    } catch {
      throw new BadRequestException({ code: 'INVALID_PRODUCT_IMPORT_FILE' });
    }
    const parsed = this.parse(matrix);
    const rows = await this.resolve(input.tenantId, parsed);
    const counts = this.counts(rows);
    const id = randomUUID();
    await this.dataSource.transaction(async (manager) => {
      await manager.query(
        `INSERT INTO product_imports (id, tenant_id, status, template_version, source_filename,
          source_hash, row_count, create_count, update_count, unchanged_count, error_count, created_by_user_id)
         VALUES (?, ?, 'PREVIEWED', '1.0', ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          id,
          input.tenantId,
          filename,
          createHash('sha256').update(file.buffer).digest('hex'),
          rows.length,
          counts.CREATE,
          counts.UPDATE,
          counts.UNCHANGED,
          counts.ERROR,
          input.userId,
        ],
      );
      for (const row of rows) {
        await manager.query(
          `INSERT INTO product_import_rows (id, tenant_id, import_id, source_row, action, product_id,
            preview_version, name, sku, barcode, category_name, brand_name, cost, price, active, errors)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            row.id,
            input.tenantId,
            id,
            row.sourceRow,
            row.action,
            row.productId,
            row.previewVersion,
            row.name,
            row.sku,
            row.barcode,
            row.category,
            row.brand,
            row.cost,
            row.price,
            row.active,
            row.errors.length ? JSON.stringify(row.errors) : null,
          ],
        );
      }
    });
    return this.get(input.tenantId, id);
  }

  async get(tenantId: string, id: string) {
    const batches = await this.dataSource.query<Array<Record<string, unknown>>>(
      'SELECT * FROM product_imports WHERE id = ? AND tenant_id = ?',
      [id, tenantId],
    );
    if (!batches[0]) throw new NotFoundException();
    const rows = await this.dataSource.query<Array<Record<string, unknown>>>(
      `SELECT * FROM product_import_rows WHERE import_id = ? AND tenant_id = ? ORDER BY source_row`,
      [id, tenantId],
    );
    const batch = batches[0];
    return {
      data: {
        id,
        status: batch.status,
        policy: batch.policy,
        templateVersion: batch.template_version,
        sourceFilename: batch.source_filename,
        summary: {
          rows: Number(batch.row_count),
          creates: Number(batch.create_count),
          updates: Number(batch.update_count),
          unchanged: Number(batch.unchanged_count),
          errors: Number(batch.error_count),
        },
        canConfirm:
          batch.status === 'PREVIEWED' && Number(batch.error_count) === 0,
        rows: rows.map((row) => ({
          id: row.id,
          rowNumber: Number(row.source_row),
          action: row.action,
          name: row.name,
          sku: row.sku,
          barcode: row.barcode,
          category: row.category_name,
          brand: row.brand_name,
          cost: row.cost,
          price: row.price,
          active: Boolean(row.active),
          errors:
            this.json<Array<{ code: string; message: string }>>(row.errors) ??
            [],
        })),
      },
      meta: { apiVersion: '1' as const },
    };
  }

  async confirm(input: {
    tenantId: string;
    userId: string;
    id: string;
    idempotencyKey: string | undefined;
  }) {
    const key = input.idempotencyKey;
    if (!key || !/^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/.test(key))
      throw new BadRequestException({ code: 'INVALID_IDEMPOTENCY_KEY' });
    try {
      await this.dataSource.transaction(async (manager) => {
        const batches = await manager.query<Array<Record<string, unknown>>>(
          'SELECT * FROM product_imports WHERE id = ? AND tenant_id = ? FOR UPDATE',
          [input.id, input.tenantId],
        );
        const batch = batches[0];
        if (!batch) throw new NotFoundException();
        if (batch.status === 'CONFIRMED') {
          if (batch.confirmation_key === key) return;
          throw new ConflictException({
            code: 'PRODUCT_IMPORT_ALREADY_CONFIRMED',
          });
        }
        if (Number(batch.error_count) > 0)
          throw new ConflictException({ code: 'PRODUCT_IMPORT_HAS_ERRORS' });
        const rows = await manager.query<Array<Record<string, unknown>>>(
          `SELECT * FROM product_import_rows WHERE import_id = ? AND tenant_id = ? ORDER BY source_row`,
          [input.id, input.tenantId],
        );
        for (const row of rows) await this.apply(manager, input.tenantId, row);
        await manager.query(
          `UPDATE product_imports SET status = 'CONFIRMED', confirmed_by_user_id = ?,
            confirmation_key = ?, confirmed_at = UTC_TIMESTAMP(6) WHERE id = ? AND tenant_id = ?`,
          [input.userId, key, input.id, input.tenantId],
        );
      });
    } catch (error) {
      if (
        error instanceof QueryFailedError &&
        (error.driverError as { errno?: number }).errno === 1062
      ) {
        const sqlMessage = String(
          (error.driverError as { sqlMessage?: string }).sqlMessage ?? '',
        );
        throw new ConflictException({
          code: sqlMessage.includes('uq_product_import_confirmation')
            ? 'IDEMPOTENCY_KEY_REUSED'
            : 'PRODUCT_IMPORT_STALE',
        });
      }
      throw error;
    }
    return this.get(input.tenantId, input.id);
  }

  async result(tenantId: string, id: string): Promise<StreamableFile> {
    const response = await this.get(tenantId, id);
    if (response.data.status !== 'CONFIRMED')
      throw new ConflictException({ code: 'PRODUCT_IMPORT_NOT_CONFIRMED' });
    const header = 'row,action,sku,name,result';
    const lines = response.data.rows.map((row) =>
      [row.rowNumber, row.action, row.sku, row.name, 'APPLIED']
        .map((value) => this.csvCell(value))
        .join(','),
    );
    return new StreamableFile(
      Buffer.from(`\uFEFF${[header, ...lines].join('\r\n')}\r\n`),
      {
        type: 'text/csv; charset=utf-8',
        disposition: `attachment; filename="product-import-${id}.csv"`,
      },
    );
  }

  private async apply(
    manager: EntityManager,
    tenantId: string,
    row: Record<string, unknown>,
  ) {
    if (row.action === 'UNCHANGED') return;
    const categoryName =
      typeof row.category_name === 'string' ? row.category_name : null;
    const brandName =
      typeof row.brand_name === 'string' ? row.brand_name : null;
    const categoryId = categoryName
      ? await this.classification(manager, 'categories', tenantId, categoryName)
      : null;
    const brandId = brandName
      ? await this.classification(manager, 'brands', tenantId, brandName)
      : null;
    if (row.action === 'CREATE') {
      await manager.query(
        `INSERT INTO products
          (id, tenant_id, name, sku, normalized_sku, barcode, track_lots,
           category_id, brand_id, cost, price, active)
         VALUES (?, ?, ?, ?, ?, ?,
           EXISTS(SELECT 1 FROM inventory_valuation_policies
                  WHERE tenant_id = ? AND method = 'SPECIFIC_LOT'),
           ?, ?, ?, ?, ?)`,
        [
          randomUUID(),
          tenantId,
          row.name,
          row.sku,
          this.normalize(String(row.sku)),
          row.barcode,
          tenantId,
          categoryId,
          brandId,
          row.cost,
          row.price,
          row.active,
        ],
      );
    } else {
      const result = await manager.query<ResultSetHeader>(
        `UPDATE products SET name = ?, barcode = ?, category_id = ?, brand_id = ?, cost = ?, price = ?,
          active = ?, version = version + 1 WHERE id = ? AND tenant_id = ? AND version = ?`,
        [
          row.name,
          row.barcode,
          categoryId,
          brandId,
          row.cost,
          row.price,
          row.active,
          row.product_id,
          tenantId,
          row.preview_version,
        ],
      );
      if (result.affectedRows !== 1)
        throw new ConflictException({ code: 'PRODUCT_IMPORT_STALE' });
    }
  }

  private async resolve(
    tenantId: string,
    parsed: ParsedRow[],
  ): Promise<StoredRow[]> {
    const products = await this.dataSource.query<
      Array<Record<string, unknown>>
    >(
      `SELECT p.*, c.name AS category_name, b.name AS brand_name FROM products p
       LEFT JOIN categories c ON c.id = p.category_id AND c.tenant_id = p.tenant_id
       LEFT JOIN brands b ON b.id = p.brand_id AND b.tenant_id = p.tenant_id
       WHERE p.tenant_id = ?`,
      [tenantId],
    );
    const skuSeen = new Set<string>();
    const barcodeSeen = new Set<string>();
    return parsed.map((row) => {
      const normalizedSku = this.normalize(row.sku);
      const current = products.find((p) => p.normalized_sku === normalizedSku);
      if (skuSeen.has(normalizedSku))
        row.errors.push({
          code: 'DUPLICATE_FILE_SKU',
          message: 'SKU duplicado en archivo.',
        });
      skuSeen.add(normalizedSku);
      if (row.barcode) {
        if (barcodeSeen.has(row.barcode))
          row.errors.push({
            code: 'DUPLICATE_FILE_BARCODE',
            message: 'Barcode duplicado en archivo.',
          });
        barcodeSeen.add(row.barcode);
        const owner = products.find(
          (p) => p.barcode === row.barcode && p.id !== current?.id,
        );
        if (owner)
          row.errors.push({
            code: 'BARCODE_IN_USE',
            message: 'Barcode ya pertenece a otro producto.',
          });
      }
      const same =
        current &&
        String(current.name) === row.name &&
        (current.barcode ?? null) === row.barcode &&
        (current.category_name ?? null) === row.category &&
        (current.brand_name ?? null) === row.brand &&
        this.money(String(current.cost)) === row.cost &&
        this.money(String(current.price)) === row.price &&
        Boolean(current.active) === row.active;
      return {
        ...row,
        id: randomUUID(),
        productId: current ? String(current.id) : null,
        previewVersion: current ? Number(current.version) : null,
        action: row.errors.length
          ? 'ERROR'
          : same
            ? 'UNCHANGED'
            : current
              ? 'UPDATE'
              : 'CREATE',
      };
    });
  }

  private csvCell(value: unknown): string {
    const text = String(value);
    const safe = /^[=+\-@]/.test(text) ? `'${text}` : text;
    return `"${safe.replaceAll('"', '""')}"`;
  }

  private parse(matrix: string[][]): ParsedRow[] {
    if (matrix.length < 2)
      throw new BadRequestException({ code: 'EMPTY_PRODUCT_IMPORT' });
    const indexes = new Map<Header, number>();
    matrix[0].forEach((value, index) => {
      const header = value.trim().toLowerCase().replace(/[ _-]/g, '') as Header;
      const aliases: Record<string, Header> = {
        nombre: 'name',
        name: 'name',
        sku: 'sku',
        barcode: 'barcode',
        codigo: 'barcode',
        categoria: 'category',
        category: 'category',
        marca: 'brand',
        brand: 'brand',
        costo: 'cost',
        cost: 'cost',
        precio: 'price',
        price: 'price',
        activo: 'active',
        active: 'active',
      };
      if (aliases[header]) indexes.set(aliases[header], index);
    });
    const missing = HEADERS.filter((header) => !indexes.has(header));
    if (missing.length)
      throw new BadRequestException({
        code: 'INVALID_PRODUCT_IMPORT_HEADERS',
        missing,
      });
    const data = matrix.slice(1).filter((row) => row.some(Boolean));
    if (!data.length || data.length > 1000)
      throw new BadRequestException({
        code: 'INVALID_PRODUCT_IMPORT_ROW_COUNT',
      });
    return data.map((values, index) => {
      const value = (h: Header) => (values[indexes.get(h)!] ?? '').trim();
      const name = value('name'),
        sku = value('sku'),
        barcode = value('barcode') || null;
      const category = value('category') || null,
        brand = value('brand') || null;
      const cost = /^\d{1,12}(\.\d{1,2})?$/.test(value('cost'))
        ? this.money(value('cost'))
        : null;
      const price = /^\d{1,12}(\.\d{1,2})?$/.test(value('price'))
        ? this.money(value('price'))
        : null;
      const activeRaw = value('active').toUpperCase();
      const active = [
        'TRUE',
        '1',
        'SI',
        'SÍ',
        'YES',
        'ACTIVE',
        'ACTIVO',
      ].includes(activeRaw);
      const errors: ParsedRow['errors'] = [];
      if (name.length < 2 || name.length > 160)
        errors.push({
          code: 'INVALID_NAME',
          message: 'Nombre debe tener 2 a 160 caracteres.',
        });
      if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,39}$/.test(sku))
        errors.push({ code: 'INVALID_SKU', message: 'SKU inválido.' });
      if (barcode && !/^[A-Za-z0-9][A-Za-z0-9._-]{3,63}$/.test(barcode))
        errors.push({ code: 'INVALID_BARCODE', message: 'Barcode inválido.' });
      if (category && (category.length < 2 || category.length > 80))
        errors.push({
          code: 'INVALID_CATEGORY',
          message: 'Categoría inválida.',
        });
      if (brand && (brand.length < 2 || brand.length > 120))
        errors.push({ code: 'INVALID_BRAND', message: 'Marca inválida.' });
      if (!cost)
        errors.push({ code: 'INVALID_COST', message: 'Costo inválido.' });
      if (!price)
        errors.push({ code: 'INVALID_PRICE', message: 'Precio inválido.' });
      if (
        ![
          'TRUE',
          'FALSE',
          '1',
          '0',
          'SI',
          'SÍ',
          'NO',
          'YES',
          'ACTIVE',
          'INACTIVE',
          'ACTIVO',
          'INACTIVO',
        ].includes(activeRaw)
      )
        errors.push({
          code: 'INVALID_ACTIVE',
          message: 'Activo debe ser sí/no o true/false.',
        });
      return {
        sourceRow: index + 2,
        name,
        sku,
        barcode,
        category,
        brand,
        cost,
        price,
        active,
        errors,
      };
    });
  }

  private async workbook(buffer: Buffer): Promise<string[][]> {
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(
      buffer as unknown as Parameters<typeof workbook.xlsx.load>[0],
    );
    const sheet = workbook.worksheets[0];
    if (!sheet) return [];
    const rows: string[][] = [];
    sheet.eachRow((row) =>
      rows.push(
        Array.from({ length: row.cellCount }, (_, i) =>
          row.getCell(i + 1).text.trim(),
        ),
      ),
    );
    return rows;
  }

  private csv(buffer: Buffer): string[][] {
    const content = buffer.toString('utf8').replace(/^\uFEFF/, '');
    const rows: string[][] = [];
    let row: string[] = [],
      field = '',
      quoted = false;
    for (let i = 0; i < content.length; i += 1) {
      const char = content[i];
      if (char === '"') {
        if (quoted && content[i + 1] === '"') {
          field += '"';
          i += 1;
        } else quoted = !quoted;
      } else if (char === ',' && !quoted) {
        row.push(field.trim());
        field = '';
      } else if ((char === '\r' || char === '\n') && !quoted) {
        if (char === '\r' && content[i + 1] === '\n') i += 1;
        row.push(field.trim());
        if (row.some(Boolean)) rows.push(row);
        row = [];
        field = '';
      } else field += char;
    }
    if (quoted) throw new Error('UNCLOSED_QUOTE');
    row.push(field.trim());
    if (row.some(Boolean)) rows.push(row);
    return rows;
  }

  private async classification(
    manager: EntityManager,
    table: 'categories' | 'brands',
    tenantId: string,
    name: string,
  ) {
    const normalized = this.normalize(name);
    const id = randomUUID();
    await manager.query(
      `INSERT INTO ${table} (id, tenant_id, name, normalized_name, active) VALUES (?, ?, ?, ?, TRUE)
      ON DUPLICATE KEY UPDATE name = VALUES(name), active = TRUE`,
      [id, tenantId, name, normalized],
    );
    const rows = await manager.query<Array<{ id: string }>>(
      `SELECT id FROM ${table} WHERE tenant_id = ? AND normalized_name = ?`,
      [tenantId, normalized],
    );
    return rows[0].id;
  }

  private counts(rows: StoredRow[]) {
    return rows.reduce(
      (result, row) => ({ ...result, [row.action]: result[row.action] + 1 }),
      { CREATE: 0, UPDATE: 0, UNCHANGED: 0, ERROR: 0 },
    );
  }
  private money(value: string) {
    const [whole, fraction = ''] = value.split('.');
    return `${BigInt(whole)}.${fraction.padEnd(2, '0')}`;
  }
  private normalize(value: string) {
    return value.normalize('NFKC').toUpperCase();
  }
  private json<T>(value: unknown): T | null {
    if (value == null) return null;
    return typeof value === 'string' ? (JSON.parse(value) as T) : (value as T);
  }
}
