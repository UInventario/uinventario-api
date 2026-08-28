import {
  BadRequestException,
  ForbiddenException,
  GoneException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { Workbook } from 'exceljs';
import { DataSource } from 'typeorm';
import type { AppPermission } from '../auth/authorization/authorization.types';
import type {
  CreateDataExportDto,
  DataExportDataset,
  DataExportFormat,
} from './dto/create-data-export.dto';

type ExportStatus =
  'PENDING' | 'PROCESSING' | 'COMPLETED' | 'FAILED' | 'EXPIRED';
type CellType = 'text' | 'number' | 'date' | 'boolean';
interface ExportColumn {
  key: string;
  label: string;
  type: CellType;
}
interface ExportTable {
  columns: ExportColumn[];
  rows: Array<Record<string, unknown>>;
}
interface StoredContext extends CreateDataExportDto {
  branchId: string | null;
  warehouseId: string | null;
  timezone: string;
  includeCosts: boolean;
}
interface ExportRow {
  id: string;
  tenant_id: string;
  requested_by_user_id: string;
  dataset: DataExportDataset;
  format: DataExportFormat;
  status: ExportStatus;
  filters: string | StoredContext;
  excluded_columns: string | string[];
  row_count: number | string | null;
  file_content?: Buffer | null;
  content_type: string | null;
  filename: string | null;
  error_code: string | null;
  expires_at: Date | string;
  created_at: Date | string;
  updated_at: Date | string;
  completed_at: Date | string | null;
}

const MAX_ROWS = 100_000;
const COST_PERMISSIONS: AppPermission[] = ['TENANT_MANAGE', 'PRODUCTS_MANAGE'];

@Injectable()
export class DataExportService {
  private readonly logger = new Logger(DataExportService.name);

  constructor(private readonly dataSource: DataSource) {}

  async create(input: {
    tenantId: string;
    userId: string;
    permissions: AppPermission[];
    branchId: string | null;
    warehouseId: string | null;
    dto: CreateDataExportDto;
  }) {
    this.assertPermission(input.dto.dataset, input.permissions);
    if (
      input.dto.dateFrom &&
      input.dto.dateTo &&
      input.dto.dateFrom > input.dto.dateTo
    ) {
      throw new BadRequestException({ code: 'INVALID_EXPORT_DATE_RANGE' });
    }
    if (
      input.dto.includeSensitive &&
      !input.permissions.includes('TENANT_MANAGE')
    ) {
      throw new ForbiddenException({ code: 'SENSITIVE_EXPORT_FORBIDDEN' });
    }
    if (input.dto.dataset !== 'PRODUCTS' && !input.branchId) {
      throw new BadRequestException({ code: 'EXPORT_CONTEXT_REQUIRED' });
    }
    const timezone = input.branchId
      ? await this.branchTimezone(input.tenantId, input.branchId)
      : 'UTC';
    const includeCosts = COST_PERMISSIONS.some((permission) =>
      input.permissions.includes(permission),
    );
    const excluded = [
      ...(!includeCosts
        ? ['cost', 'inventoryValue', 'historicalCost', 'margin']
        : []),
      ...(!input.dto.includeSensitive
        ? ['customer', 'customerContact', 'responsible']
        : []),
    ];
    const id = randomUUID();
    const context: StoredContext = {
      ...input.dto,
      branchId: input.branchId,
      warehouseId: input.warehouseId,
      timezone,
      includeCosts,
    };
    await this.dataSource.query(
      `UPDATE data_exports SET status = 'EXPIRED', file_content = NULL
       WHERE expires_at <= UTC_TIMESTAMP(6) AND status <> 'EXPIRED'`,
    );
    await this.dataSource.query(
      `INSERT INTO data_exports
       (id, tenant_id, requested_by_user_id, dataset, format, status, filters,
        excluded_columns, expires_at)
       VALUES (?, ?, ?, ?, ?, 'PENDING', ?, ?, DATE_ADD(UTC_TIMESTAMP(6), INTERVAL 24 HOUR))`,
      [
        id,
        input.tenantId,
        input.userId,
        input.dto.dataset,
        input.dto.format,
        JSON.stringify(context),
        JSON.stringify([...new Set(excluded)]),
      ],
    );
    this.schedule(id, input.tenantId, input.userId);
    return this.get(input.tenantId, input.userId, id);
  }

  async get(tenantId: string, userId: string, id: string) {
    const row = await this.find(tenantId, userId, id);
    if (
      new Date(row.expires_at).getTime() <= Date.now() &&
      row.status !== 'EXPIRED'
    ) {
      await this.dataSource.query(
        `UPDATE data_exports SET status = 'EXPIRED', file_content = NULL
         WHERE id = ? AND tenant_id = ?`,
        [id, tenantId],
      );
      row.status = 'EXPIRED';
    }
    if (row.status === 'PENDING') this.schedule(id, tenantId, userId);
    if (
      row.status === 'PROCESSING' &&
      Date.now() - new Date(row.updated_at).getTime() > 5 * 60_000
    ) {
      await this.dataSource.query(
        `UPDATE data_exports SET status = 'PENDING' WHERE id = ? AND tenant_id = ?`,
        [id, tenantId],
      );
      row.status = 'PENDING';
      this.schedule(id, tenantId, userId);
    }
    return { data: this.toData(row), meta: { apiVersion: '1' as const } };
  }

  async retry(tenantId: string, userId: string, id: string) {
    const row = await this.find(tenantId, userId, id);
    if (row.status !== 'FAILED') {
      throw new BadRequestException({ code: 'EXPORT_NOT_RETRYABLE' });
    }
    await this.dataSource.query(
      `UPDATE data_exports SET status = 'PENDING', error_code = NULL
       WHERE id = ? AND tenant_id = ? AND requested_by_user_id = ?`,
      [id, tenantId, userId],
    );
    this.schedule(id, tenantId, userId);
    return this.get(tenantId, userId, id);
  }

  async download(tenantId: string, userId: string, id: string) {
    const row = await this.find(tenantId, userId, id, true);
    if (new Date(row.expires_at).getTime() <= Date.now())
      throw new GoneException();
    if (
      row.status !== 'COMPLETED' ||
      !row.file_content ||
      !row.filename ||
      !row.content_type
    ) {
      throw new BadRequestException({ code: 'EXPORT_NOT_READY' });
    }
    return {
      content: row.file_content,
      filename: row.filename,
      contentType: row.content_type,
    };
  }

  private schedule(id: string, tenantId: string, userId: string): void {
    setImmediate(() => void this.process(id, tenantId, userId));
  }

  private async process(
    id: string,
    tenantId: string,
    userId: string,
  ): Promise<void> {
    try {
      const result = await this.dataSource.query<{ affectedRows?: number }>(
        `UPDATE data_exports SET status = 'PROCESSING'
         WHERE id = ? AND tenant_id = ? AND requested_by_user_id = ? AND status = 'PENDING'`,
        [id, tenantId, userId],
      );
      if (Number(result.affectedRows ?? 0) !== 1) return;
      const row = await this.find(tenantId, userId, id);
      const context = this.json<StoredContext>(row.filters);
      const table = await this.table(tenantId, row.dataset, context);
      if (table.rows.length > MAX_ROWS)
        throw new Error('EXPORT_ROW_LIMIT_EXCEEDED');
      const file =
        row.format === 'CSV'
          ? Buffer.from(this.csv(table), 'utf8')
          : await this.xlsx(table, row.dataset);
      const date = new Date().toISOString().slice(0, 10);
      const extension = row.format.toLowerCase();
      await this.dataSource.query(
        `UPDATE data_exports SET status = 'COMPLETED', row_count = ?, file_content = ?,
           content_type = ?, filename = ?, completed_at = UTC_TIMESTAMP(6), error_code = NULL
         WHERE id = ? AND tenant_id = ?`,
        [
          table.rows.length,
          file,
          row.format === 'CSV'
            ? 'text/csv; charset=utf-8'
            : 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
          `${row.dataset.toLowerCase()}-${date}.${extension}`,
          id,
          tenantId,
        ],
      );
    } catch (error) {
      const code =
        error instanceof Error && error.message === 'EXPORT_ROW_LIMIT_EXCEEDED'
          ? error.message
          : 'EXPORT_GENERATION_FAILED';
      this.logger.error(
        JSON.stringify({
          event: 'data_export_failed',
          exportId: id,
          tenantId,
          errorType: error instanceof Error ? error.name : 'UnknownError',
        }),
      );
      try {
        await this.dataSource.query(
          `UPDATE data_exports SET status = 'FAILED', error_code = ?, file_content = NULL
           WHERE id = ? AND tenant_id = ? AND status = 'PROCESSING'`,
          [code, id, tenantId],
        );
      } catch {
        this.logger.error(
          JSON.stringify({
            event: 'data_export_failure_state_write_failed',
            exportId: id,
            tenantId,
          }),
        );
      }
    }
  }

  private table(
    tenantId: string,
    dataset: DataExportDataset,
    context: StoredContext,
  ) {
    switch (dataset) {
      case 'PRODUCTS':
        return this.products(tenantId, context);
      case 'STOCK':
        return this.stock(tenantId, context);
      case 'SALES':
        return this.sales(tenantId, context);
      case 'MOVEMENTS':
        return this.movements(tenantId, context);
    }
  }

  private async products(
    tenantId: string,
    c: StoredContext,
  ): Promise<ExportTable> {
    const where = ['p.tenant_id = ?'];
    const parameters: unknown[] = [tenantId];
    if (c.q) {
      where.push('(p.name LIKE ? OR p.sku LIKE ? OR p.barcode LIKE ?)');
      parameters.push(`%${c.q}%`, `%${c.q}%`, `%${c.q}%`);
    }
    if (c.productStatus && c.productStatus !== 'ALL') {
      where.push('p.active = ?');
      parameters.push(c.productStatus === 'ACTIVE');
    }
    if (c.categoryId) {
      where.push('p.category_id = ?');
      parameters.push(c.categoryId);
    }
    if (c.brandId) {
      where.push('p.brand_id = ?');
      parameters.push(c.brandId);
    }
    const columns: ExportColumn[] = [
      { key: 'name', label: 'Nombre', type: 'text' },
      { key: 'sku', label: 'SKU', type: 'text' },
      { key: 'barcode', label: 'Código de barras', type: 'text' },
      { key: 'category', label: 'Categoría', type: 'text' },
      { key: 'brand', label: 'Marca', type: 'text' },
      ...(c.includeCosts
        ? [{ key: 'cost', label: 'Costo', type: 'number' as const }]
        : []),
      { key: 'price', label: 'Precio', type: 'number' },
      { key: 'active', label: 'Activo', type: 'boolean' },
      { key: 'createdAt', label: 'Creado', type: 'date' },
      { key: 'updatedAt', label: 'Actualizado', type: 'date' },
    ];
    const rows = await this.dataSource.query<Array<Record<string, unknown>>>(
      `SELECT p.name, p.sku, p.barcode, c.name AS category, b.name AS brand,
        ${c.includeCosts ? 'p.cost,' : ''} p.price, p.active, p.created_at AS createdAt, p.updated_at AS updatedAt
       FROM products p LEFT JOIN categories c ON c.id = p.category_id AND c.tenant_id = p.tenant_id
       LEFT JOIN brands b ON b.id = p.brand_id AND b.tenant_id = p.tenant_id
       WHERE ${where.join(' AND ')} ORDER BY p.name, p.id LIMIT ${MAX_ROWS + 1}`,
      parameters,
    );
    return { columns, rows };
  }

  private async stock(
    tenantId: string,
    c: StoredContext,
  ): Promise<ExportTable> {
    const where = ['ib.tenant_id = ?', 'w.branch_id = ?', 'w.id = ?'];
    const p: unknown[] = [tenantId, c.branchId, c.warehouseId];
    if (c.q) {
      where.push('(pr.name LIKE ? OR pr.sku LIKE ? OR pr.barcode LIKE ?)');
      p.push(`%${c.q}%`, `%${c.q}%`, `%${c.q}%`);
    }
    if (c.productId) {
      where.push('pr.id = ?');
      p.push(c.productId);
    }
    if (c.locationId) {
      where.push('l.id = ?');
      p.push(c.locationId);
    }
    const columns: ExportColumn[] = [
      { key: 'product', label: 'Producto', type: 'text' },
      { key: 'sku', label: 'SKU', type: 'text' },
      { key: 'location', label: 'Ubicación', type: 'text' },
      { key: 'quantity', label: 'Total', type: 'number' },
      { key: 'available', label: 'Disponible', type: 'number' },
      { key: 'reserved', label: 'Reservado', type: 'number' },
      { key: 'damaged', label: 'Dañado', type: 'number' },
      { key: 'inTransit', label: 'En tránsito', type: 'number' },
      ...(c.includeCosts
        ? [
            {
              key: 'inventoryValue',
              label: 'Valor inventario',
              type: 'number' as const,
            },
          ]
        : []),
      { key: 'updatedAt', label: 'Actualizado', type: 'date' },
    ];
    const rows = await this.dataSource.query<Array<Record<string, unknown>>>(
      `SELECT pr.name AS product, pr.sku, l.name AS location, ib.quantity,
        ib.available_quantity AS available, ib.reserved_quantity AS reserved,
        ib.damaged_quantity AS damaged, ib.in_transit_quantity AS inTransit,
        ${c.includeCosts ? 'ROUND(ib.quantity * pr.cost, 2) AS inventoryValue,' : ''}
        ib.updated_at AS updatedAt
       FROM inventory_balances ib INNER JOIN products pr ON pr.id = ib.product_id AND pr.tenant_id = ib.tenant_id
       INNER JOIN locations l ON l.id = ib.location_id AND l.tenant_id = ib.tenant_id
       INNER JOIN warehouses w ON w.id = l.warehouse_id AND w.tenant_id = l.tenant_id
       WHERE ${where.join(' AND ')} ORDER BY pr.name, l.name LIMIT ${MAX_ROWS + 1}`,
      p,
    );
    return { columns, rows };
  }

  private async sales(
    tenantId: string,
    c: StoredContext,
  ): Promise<ExportTable> {
    const where = ['s.tenant_id = ?', 's.branch_id = ?'];
    const p: unknown[] = [tenantId, c.branchId];
    this.dateFilters(where, p, 's.created_at', c);
    if (c.cashRegisterId) {
      where.push('s.cash_register_id = ?');
      p.push(c.cashRegisterId);
    }
    if (c.userId) {
      where.push('s.created_by_user_id = ?');
      p.push(c.userId);
    }
    if (c.saleStatus && c.saleStatus !== 'ALL') {
      where.push('s.status = ?');
      p.push(c.saleStatus);
    }
    if (c.q) {
      where.push(`(s.receipt_number LIKE ? OR cr.name LIKE ? OR cr.code LIKE ?
        OR EXISTS (SELECT 1 FROM sale_lines search_line
          WHERE search_line.sale_id = s.id AND search_line.tenant_id = s.tenant_id
            AND (search_line.product_name LIKE ? OR search_line.product_sku LIKE ?)))`);
      p.push(`%${c.q}%`, `%${c.q}%`, `%${c.q}%`, `%${c.q}%`, `%${c.q}%`);
    }
    const columns: ExportColumn[] = [
      { key: 'receipt', label: 'Folio', type: 'text' },
      { key: 'status', label: 'Estado', type: 'text' },
      { key: 'register', label: 'Caja', type: 'text' },
      { key: 'currency', label: 'Moneda', type: 'text' },
      { key: 'subtotal', label: 'Subtotal', type: 'number' },
      { key: 'tax', label: 'Impuesto', type: 'number' },
      { key: 'total', label: 'Total', type: 'number' },
      ...(c.includeCosts
        ? [
            {
              key: 'historicalCost',
              label: 'Costo histórico',
              type: 'number' as const,
            },
            { key: 'margin', label: 'Margen', type: 'number' as const },
          ]
        : []),
      { key: 'payments', label: 'Pagos', type: 'text' },
      ...(c.includeSensitive
        ? [
            { key: 'responsible', label: 'Responsable', type: 'text' as const },
            { key: 'customer', label: 'Cliente', type: 'text' as const },
            {
              key: 'customerContact',
              label: 'Contacto cliente',
              type: 'text' as const,
            },
          ]
        : []),
      { key: 'createdAt', label: 'Fecha', type: 'date' },
      { key: 'voidedAt', label: 'Anulada', type: 'date' },
    ];
    const rows = await this.dataSource.query<Array<Record<string, unknown>>>(
      `SELECT s.receipt_number AS receipt, s.status, CONCAT(cr.name, ' (', cr.code, ')') AS register,
        s.currency, s.subtotal, s.tax_total AS tax, s.total,
        ${c.includeCosts ? 'COALESCE((SELECT SUM(sl.quantity * sl.unit_cost) FROM sale_lines sl WHERE sl.sale_id = s.id AND sl.tenant_id = s.tenant_id), 0) AS historicalCost, s.total - s.tax_total - COALESCE((SELECT SUM(sl.quantity * sl.unit_cost) FROM sale_lines sl WHERE sl.sale_id = s.id AND sl.tenant_id = s.tenant_id), 0) AS margin,' : ''}
        (SELECT GROUP_CONCAT(CONCAT(sp.method, ':', sp.amount_applied, ':', sp.status) ORDER BY sp.id SEPARATOR ' | ')
          FROM sale_payments sp WHERE sp.sale_id = s.id AND sp.tenant_id = s.tenant_id) AS payments,
        ${c.includeSensitive ? "u.email AS responsible, cu.name AS customer, CONCAT_WS(' | ', cu.email, cu.phone) AS customerContact," : ''}
        s.created_at AS createdAt, s.voided_at AS voidedAt
       FROM sales s INNER JOIN cash_registers cr ON cr.id = s.cash_register_id AND cr.tenant_id = s.tenant_id
       ${c.includeSensitive ? 'INNER JOIN users u ON u.id = s.created_by_user_id AND u.tenant_id = s.tenant_id LEFT JOIN customers cu ON cu.id = s.customer_id AND cu.tenant_id = s.tenant_id' : ''}
       WHERE ${where.join(' AND ')} ORDER BY s.created_at DESC, s.id DESC LIMIT ${MAX_ROWS + 1}`,
      p,
    );
    return { columns, rows };
  }

  private async movements(
    tenantId: string,
    c: StoredContext,
  ): Promise<ExportTable> {
    const where = ['im.tenant_id = ?', 'w.branch_id = ?'];
    const p: unknown[] = [tenantId, c.branchId];
    this.dateFilters(where, p, 'im.created_at', c);
    if (c.productId) {
      where.push('im.product_id = ?');
      p.push(c.productId);
    }
    if (c.locationId) {
      where.push('im.location_id = ?');
      p.push(c.locationId);
    }
    if (c.userId) {
      where.push('im.created_by_user_id = ?');
      p.push(c.userId);
    }
    if (c.movementType) {
      where.push('im.type = ?');
      p.push(c.movementType);
    }
    if (c.q) {
      where.push('(pr.name LIKE ? OR pr.sku LIKE ? OR im.reference LIKE ?)');
      p.push(`%${c.q}%`, `%${c.q}%`, `%${c.q}%`);
    }
    const columns: ExportColumn[] = [
      { key: 'product', label: 'Producto', type: 'text' },
      { key: 'sku', label: 'SKU', type: 'text' },
      { key: 'location', label: 'Ubicación', type: 'text' },
      { key: 'type', label: 'Tipo', type: 'text' },
      { key: 'quantityChange', label: 'Cambio', type: 'number' },
      {
        key: 'resultingQuantity',
        label: 'Existencia resultante',
        type: 'number',
      },
      { key: 'fromState', label: 'Estado origen', type: 'text' },
      { key: 'toState', label: 'Estado destino', type: 'text' },
      { key: 'stateQuantity', label: 'Cantidad por estado', type: 'number' },
      { key: 'reason', label: 'Motivo', type: 'text' },
      { key: 'reference', label: 'Documento', type: 'text' },
      ...(c.includeSensitive
        ? [{ key: 'responsible', label: 'Responsable', type: 'text' as const }]
        : []),
      { key: 'createdAt', label: 'Fecha', type: 'date' },
    ];
    const rows = await this.dataSource.query<Array<Record<string, unknown>>>(
      `SELECT pr.name AS product, pr.sku, l.name AS location, im.type,
        im.quantity_change AS quantityChange, im.resulting_quantity AS resultingQuantity,
        im.from_state AS fromState, im.to_state AS toState, im.state_quantity AS stateQuantity,
        im.reason, im.reference, ${c.includeSensitive ? 'u.email AS responsible,' : ''} im.created_at AS createdAt
       FROM inventory_movements im INNER JOIN products pr ON pr.id = im.product_id AND pr.tenant_id = im.tenant_id
       INNER JOIN locations l ON l.id = im.location_id AND l.tenant_id = im.tenant_id
       INNER JOIN warehouses w ON w.id = l.warehouse_id AND w.tenant_id = l.tenant_id
       ${c.includeSensitive ? 'INNER JOIN users u ON u.id = im.created_by_user_id AND u.tenant_id = im.tenant_id' : ''}
       WHERE ${where.join(' AND ')} ORDER BY im.created_at DESC, im.id DESC LIMIT ${MAX_ROWS + 1}`,
      p,
    );
    return { columns, rows };
  }

  private dateFilters(
    where: string[],
    p: unknown[],
    field: string,
    c: StoredContext,
  ): void {
    if (c.dateFrom) {
      where.push(`${field} >= ?`);
      p.push(this.localBoundary(c.dateFrom, c.timezone, 0));
    }
    if (c.dateTo) {
      where.push(`${field} < ?`);
      p.push(this.localBoundary(c.dateTo, c.timezone, 1));
    }
  }

  private localBoundary(
    date: string,
    timezone: string,
    addDays: number,
  ): string {
    const [year, month, day] = date.split('-').map(Number);
    const target = Date.UTC(year, month - 1, day + addDays);
    let instant = target;
    const formatter = new Intl.DateTimeFormat('en-CA', {
      timeZone: timezone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hourCycle: 'h23',
    });
    for (let i = 0; i < 2; i += 1) {
      const parts = Object.fromEntries(
        formatter
          .formatToParts(new Date(instant))
          .map((x) => [x.type, x.value]),
      );
      instant +=
        target -
        Date.UTC(
          Number(parts.year),
          Number(parts.month) - 1,
          Number(parts.day),
          Number(parts.hour),
          Number(parts.minute),
          Number(parts.second),
        );
    }
    return new Date(instant).toISOString().slice(0, 23).replace('T', ' ');
  }

  private csv(table: ExportTable): string {
    const lines = table.rows.map((row) =>
      table.columns
        .map((column) =>
          this.csvCell(this.render(row[column.key], column.type)),
        )
        .join(','),
    );
    return `\uFEFF${[table.columns.map((column) => this.csvCell(column.label)).join(','), ...lines].join('\r\n')}\r\n`;
  }

  private async xlsx(table: ExportTable, dataset: string): Promise<Buffer> {
    const workbook = new Workbook();
    const sheet = workbook.addWorksheet(dataset.slice(0, 31));
    sheet.columns = table.columns.map((column) => ({
      header: column.label,
      key: column.key,
      width: 20,
    }));
    for (const source of table.rows) {
      const row: Record<string, unknown> = {};
      for (const column of table.columns) {
        const value = source[column.key];
        row[column.key] =
          value == null
            ? null
            : column.type === 'number'
              ? this.excelNumber(value)
              : column.type === 'date'
                ? new Date(value as string | Date)
                : column.type === 'boolean'
                  ? Boolean(value)
                  : this.safeText(this.scalar(value));
      }
      sheet.addRow(row);
    }
    sheet.getRow(1).font = { bold: true };
    sheet.views = [{ state: 'frozen', ySplit: 1 }];
    const buffer = await workbook.xlsx.writeBuffer();
    return Buffer.from(buffer);
  }

  private render(value: unknown, type: CellType): string {
    if (value == null) return '';
    if (type === 'date') return new Date(value as string | Date).toISOString();
    if (type === 'boolean') return value ? 'true' : 'false';
    return type === 'text'
      ? this.safeText(this.scalar(value))
      : this.scalar(value);
  }

  private scalar(value: unknown): string {
    if (typeof value === 'string') return value;
    if (
      typeof value === 'number' ||
      typeof value === 'bigint' ||
      typeof value === 'boolean'
    )
      return `${value}`;
    if (value instanceof Date) return value.toISOString();
    return '';
  }

  private excelNumber(value: unknown): number | string {
    const exact = this.scalar(value);
    const significantDigits = exact
      .replace(/[-.]/g, '')
      .replace(/^0+/, '').length;
    return significantDigits > 15 ? exact : Number(exact);
  }

  private safeText(value: string): string {
    return /^[=+\-@\t\r]/.test(value) ? `'${value}` : value;
  }

  private csvCell(value: string): string {
    return `"${value.replaceAll('"', '""')}"`;
  }

  private assertPermission(
    dataset: DataExportDataset,
    permissions: AppPermission[],
  ): void {
    const required: AppPermission =
      dataset === 'PRODUCTS'
        ? 'PRODUCTS_MANAGE'
        : dataset === 'SALES'
          ? 'SALES_MANAGE'
          : 'INVENTORY_VIEW';
    if (
      !permissions.includes(required) &&
      !permissions.includes('TENANT_MANAGE')
    ) {
      throw new ForbiddenException({ code: 'EXPORT_DATASET_FORBIDDEN' });
    }
  }

  private async branchTimezone(
    tenantId: string,
    branchId: string,
  ): Promise<string> {
    const rows = await this.dataSource.query<Array<{ timezone: string }>>(
      'SELECT timezone FROM branches WHERE id = ? AND tenant_id = ? AND active = TRUE',
      [branchId, tenantId],
    );
    if (!rows[0]) throw new NotFoundException();
    return rows[0].timezone;
  }

  private async find(
    tenantId: string,
    userId: string,
    id: string,
    withContent = false,
  ): Promise<ExportRow> {
    const rows = await this.dataSource.query<ExportRow[]>(
      `SELECT id, tenant_id, requested_by_user_id, dataset, format, status, filters,
        excluded_columns, row_count, content_type, filename, error_code, expires_at,
        created_at, updated_at, completed_at${withContent ? ', file_content' : ''}
       FROM data_exports WHERE id = ? AND tenant_id = ? AND requested_by_user_id = ?`,
      [id, tenantId, userId],
    );
    if (!rows[0]) throw new NotFoundException();
    return rows[0];
  }

  private toData(row: ExportRow) {
    return {
      id: row.id,
      dataset: row.dataset,
      format: row.format,
      status: row.status,
      rowCount: row.row_count == null ? null : Number(row.row_count),
      excludedColumns: this.json<string[]>(row.excluded_columns),
      errorCode: row.error_code,
      expiresAt: new Date(row.expires_at).toISOString(),
      createdAt: new Date(row.created_at).toISOString(),
      completedAt: row.completed_at
        ? new Date(row.completed_at).toISOString()
        : null,
      downloadReady: row.status === 'COMPLETED',
    };
  }

  private json<T>(value: string | T): T {
    return typeof value === 'string' ? (JSON.parse(value) as T) : value;
  }
}
