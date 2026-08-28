import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { createHash } from 'node:crypto';
import * as ExcelJS from 'exceljs';
import type { InventoryImportMode } from './dto/preview-inventory-import.dto';
import {
  InventoryImportHasErrorsError,
  InventoryImportIdempotencyConflictError,
  InventoryImportNotFoundError,
  InventoryImportStaleError,
} from './inventory-import.errors';
import {
  InventoryImportRepository,
  type ParsedInventoryImportRow,
} from './inventory-import.repository';
import type {
  InventoryImportFile,
  InventoryImportResponse,
  InventoryImportRowError,
} from './inventory-import.types';
import type { InventoryStockState } from './inventory.types';
import {
  InventorySerialQuantityError,
  InventorySerialRequiredError,
} from './inventory-serial-tracking';

const REQUIRED_HEADERS = [
  'sku',
  'location',
  'quantity',
  'state',
  'reason',
] as const;
type RequiredHeader = (typeof REQUIRED_HEADERS)[number];

@Injectable()
export class InventoryImportService {
  constructor(private readonly imports: InventoryImportRepository) {}

  async preview(input: {
    tenantId: string;
    warehouseId: string;
    userId: string;
    correlationId: string;
    mode: InventoryImportMode;
    file: InventoryImportFile | undefined;
  }): Promise<InventoryImportResponse> {
    if (!input.file) {
      throw new BadRequestException({
        code: 'INVENTORY_IMPORT_FILE_REQUIRED',
        message: 'Selecciona un archivo CSV o Excel.',
      });
    }
    if (input.file.size === 0 || input.file.size > 2 * 1024 * 1024) {
      throw new BadRequestException({
        code: 'INVALID_INVENTORY_IMPORT_FILE_SIZE',
        message: 'El archivo debe pesar entre 1 byte y 2 MB.',
      });
    }
    const filename = this.safeFilename(input.file.originalname);
    const extension = filename.split('.').pop()?.toLowerCase();
    if (extension !== 'csv' && extension !== 'xlsx') {
      throw new BadRequestException({
        code: 'INVALID_INVENTORY_IMPORT_FILE_TYPE',
        message: 'El formato debe ser .csv o .xlsx.',
      });
    }
    let matrix: string[][];
    try {
      matrix =
        extension === 'xlsx'
          ? await this.readWorkbook(input.file.buffer)
          : this.readCsv(input.file.buffer);
    } catch {
      throw new BadRequestException({
        code: 'INVALID_INVENTORY_IMPORT_FILE',
        message: 'No fue posible leer el archivo. Verifica que no esté dañado.',
      });
    }
    const rows = this.parseRows(matrix);
    return this.imports.createPreview({
      tenantId: input.tenantId,
      warehouseId: input.warehouseId,
      userId: input.userId,
      correlationId: input.correlationId,
      mode: input.mode,
      sourceFilename: filename,
      sourceHash: createHash('sha256').update(input.file.buffer).digest('hex'),
      rows,
    });
  }

  async get(
    tenantId: string,
    warehouseId: string,
    importId: string,
  ): Promise<InventoryImportResponse> {
    try {
      return await this.imports.get(tenantId, warehouseId, importId);
    } catch (error) {
      if (error instanceof InventoryImportNotFoundError)
        throw new NotFoundException();
      throw error;
    }
  }

  async confirm(input: {
    tenantId: string;
    warehouseId: string;
    userId: string;
    importId: string;
    idempotencyKey: string | undefined;
    correlationId: string;
  }): Promise<InventoryImportResponse> {
    if (
      !input.idempotencyKey ||
      !/^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/.test(input.idempotencyKey)
    ) {
      throw new BadRequestException({
        code: 'INVALID_IDEMPOTENCY_KEY',
        message:
          'Idempotency-Key es obligatorio y debe tener entre 8 y 128 caracteres.',
      });
    }
    try {
      return await this.imports.confirm({
        ...input,
        idempotencyKey: input.idempotencyKey,
      });
    } catch (error) {
      if (error instanceof InventoryImportNotFoundError)
        throw new NotFoundException();
      if (error instanceof InventoryImportHasErrorsError) {
        throw new ConflictException({
          code: 'INVENTORY_IMPORT_HAS_ERRORS',
          message:
            'La política es atómica: corrige todas las filas antes de confirmar.',
        });
      }
      if (error instanceof InventoryImportStaleError) {
        throw new ConflictException({
          code: 'INVENTORY_IMPORT_STALE',
          message:
            'El stock cambió después de la vista previa. Genera una nueva vista previa.',
        });
      }
      if (error instanceof InventoryImportIdempotencyConflictError) {
        throw new ConflictException({
          code: 'IDEMPOTENCY_KEY_REUSED',
          message: 'La clave de idempotencia ya fue usada por otro lote.',
        });
      }
      if (
        error instanceof InventorySerialRequiredError ||
        error instanceof InventorySerialQuantityError
      ) {
        throw new BadRequestException({
          code: 'INVENTORY_SERIALS_REQUIRED',
          message:
            'La importaciÃ³n no puede ajustar productos serializados sin identificar sus unidades.',
        });
      }
      throw error;
    }
  }

  private async readWorkbook(buffer: Buffer): Promise<string[][]> {
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(
      buffer as unknown as Parameters<typeof workbook.xlsx.load>[0],
    );
    const worksheet = workbook.worksheets[0];
    if (!worksheet) return [];
    const matrix: string[][] = [];
    worksheet.eachRow({ includeEmpty: false }, (row) => {
      const values: string[] = [];
      for (let column = 1; column <= row.cellCount; column += 1) {
        values.push(row.getCell(column).text.trim());
      }
      matrix.push(values);
    });
    return matrix;
  }

  private readCsv(buffer: Buffer): string[][] {
    const content = buffer.toString('utf8').replace(/^\uFEFF/, '');
    const firstLine = content.split(/\r?\n/, 1)[0] ?? '';
    const delimiter = this.pickDelimiter(firstLine);
    const rows: string[][] = [];
    let row: string[] = [];
    let field = '';
    let quoted = false;
    for (let index = 0; index < content.length; index += 1) {
      const character = content[index];
      if (character === '"') {
        if (quoted && content[index + 1] === '"') {
          field += '"';
          index += 1;
        } else {
          quoted = !quoted;
        }
      } else if (character === delimiter && !quoted) {
        row.push(field.trim());
        field = '';
      } else if ((character === '\n' || character === '\r') && !quoted) {
        if (character === '\r' && content[index + 1] === '\n') index += 1;
        row.push(field.trim());
        if (row.some((value) => value !== '')) rows.push(row);
        row = [];
        field = '';
      } else {
        field += character;
      }
    }
    if (quoted) throw new Error('UNCLOSED_CSV_QUOTE');
    row.push(field.trim());
    if (row.some((value) => value !== '')) rows.push(row);
    return rows;
  }

  private pickDelimiter(line: string): string {
    const candidates = [',', ';', '\t'];
    return candidates.reduce((selected, candidate) =>
      line.split(candidate).length > line.split(selected).length
        ? candidate
        : selected,
    );
  }

  private parseRows(matrix: string[][]): ParsedInventoryImportRow[] {
    if (matrix.length < 2) {
      throw new BadRequestException({
        code: 'EMPTY_INVENTORY_IMPORT',
        message: 'El archivo debe incluir encabezados y al menos una fila.',
      });
    }
    const headerIndexes = new Map<RequiredHeader, number>();
    matrix[0].forEach((header, index) => {
      const normalized = this.headerName(header);
      if (normalized) headerIndexes.set(normalized, index);
    });
    const missing = REQUIRED_HEADERS.filter(
      (header) => !headerIndexes.has(header),
    );
    if (missing.length > 0) {
      throw new BadRequestException({
        code: 'INVALID_INVENTORY_IMPORT_HEADERS',
        message: `Faltan columnas requeridas: ${missing.join(', ')}.`,
      });
    }
    const data = matrix
      .slice(1)
      .filter((row) => row.some((value) => value.trim() !== ''));
    if (data.length === 0 || data.length > 1000) {
      throw new BadRequestException({
        code: 'INVALID_INVENTORY_IMPORT_ROW_COUNT',
        message: 'El archivo debe contener entre 1 y 1000 filas de datos.',
      });
    }
    return data.map((values, index) => {
      const value = (header: RequiredHeader) =>
        (values[headerIndexes.get(header)!] ?? '').trim();
      const productSku = value('sku');
      const locationCode = value('location');
      const quantity = value('quantity');
      const rawState = value('state');
      const reason = value('reason');
      const errors: InventoryImportRowError[] = [];
      if (!productSku || productSku.length > 40)
        errors.push({
          code: 'INVALID_SKU',
          message: 'SKU es obligatorio y admite hasta 40 caracteres.',
        });
      if (!locationCode || locationCode.length > 40)
        errors.push({
          code: 'INVALID_LOCATION_CODE',
          message: 'Ubicación es obligatoria y admite hasta 40 caracteres.',
        });
      const targetQuantity = /^(0|[1-9]\d{0,11})(\.\d{1,3})?$/.test(quantity)
        ? this.normalizeDecimal(quantity)
        : null;
      if (targetQuantity === null)
        errors.push({
          code: 'INVALID_QUANTITY',
          message:
            'Cantidad debe ser un número no negativo con hasta 3 decimales.',
        });
      const state = this.stockState(rawState);
      if (!state)
        errors.push({
          code: 'INVALID_STOCK_STATE',
          message: 'Estado debe ser AVAILABLE, RESERVED, DAMAGED o IN_TRANSIT.',
        });
      if (reason.length < 2 || reason.length > 160)
        errors.push({
          code: 'INVALID_REASON',
          message: 'Motivo debe contener entre 2 y 160 caracteres.',
        });
      return {
        rowNumber: index + 2,
        productSku,
        locationCode,
        state,
        targetQuantity,
        reason,
        errors,
      };
    });
  }

  private headerName(value: string): RequiredHeader | null {
    const normalized = value
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .trim()
      .toLowerCase()
      .replace(/[ _-]+/g, '');
    return (
      (
        {
          sku: 'sku',
          producto: 'sku',
          productsku: 'sku',
          ubicacion: 'location',
          location: 'location',
          locationcode: 'location',
          cantidad: 'quantity',
          quantity: 'quantity',
          estado: 'state',
          state: 'state',
          motivo: 'reason',
          reason: 'reason',
        } as Record<string, RequiredHeader | undefined>
      )[normalized] ?? null
    );
  }

  private stockState(value: string): InventoryStockState | null {
    const normalized = value
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .trim()
      .toUpperCase()
      .replace(/[ -]+/g, '_');
    return (
      (
        {
          AVAILABLE: 'AVAILABLE',
          DISPONIBLE: 'AVAILABLE',
          RESERVED: 'RESERVED',
          RESERVADO: 'RESERVED',
          DAMAGED: 'DAMAGED',
          DANADO: 'DAMAGED',
          IN_TRANSIT: 'IN_TRANSIT',
          EN_TRANSITO: 'IN_TRANSIT',
        } as Record<string, InventoryStockState | undefined>
      )[normalized] ?? null
    );
  }

  private normalizeDecimal(value: string): string {
    const [whole, fraction = ''] = value.split('.');
    return `${BigInt(whole)}.${fraction.padEnd(3, '0')}`;
  }

  private safeFilename(filename: string): string {
    return (filename.split(/[\\/]/).pop() || 'inventario').slice(0, 160);
  }
}
