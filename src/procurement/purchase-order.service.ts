import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { createHash } from 'node:crypto';
import { ListPurchaseOrdersDto } from './dto/list-purchase-orders.dto';
import { SavePurchaseOrderDto } from './dto/save-purchase-order.dto';
import { UpdatePurchaseOrderDto } from './dto/update-purchase-order.dto';
import { ReceivePurchaseOrderDto } from './dto/receive-purchase-order.dto';
import { ReturnPurchaseReceiptDto } from './dto/return-purchase-receipt.dto';
import {
  InvalidPurchaseReceiptError,
  PurchaseOrderDuplicateLineError,
  PurchaseOrderIdempotencyConflictError,
  PurchaseOrderNotFoundError,
  PurchaseOrderReferenceError,
  PurchaseOrderStateError,
  PurchaseOrderVersionConflictError,
  PurchaseReceiptLocationError,
  PurchaseReceiptOveragePermissionError,
  PurchaseReceiptOverageReasonError,
  InvalidPurchaseReturnError,
  PurchaseReturnQuantityError,
  PurchaseReturnStockError,
} from './purchase-order.errors';
import { PurchaseOrderRepository } from './purchase-order.repository';
import { PurchaseOrderDelivery } from './purchase-order.delivery';
import { PurchaseReceiptRepository } from './purchase-receipt.repository';
import { PurchaseReturnRepository } from './purchase-return.repository';
import {
  PurchaseOrderListResponse,
  PurchaseOrderResponse,
} from './purchase-order.types';
import {
  InsufficientInventoryLotStockError,
  InvalidInventoryLotCodeError,
  InventoryLotCurrencyMismatchError,
  InventoryLotNotFoundError,
  InventoryLotRequiredError,
  InvalidInventoryLotDatesError,
  InventoryLotExpirationRequiredError,
  InventoryFifoCurrencyMismatchError,
  InventoryFifoLayerShortageError,
} from '../inventory/inventory.errors';
import {
  InventorySerialDuplicateError,
  InventorySerialNotFoundError,
  InventorySerialQuantityError,
  InventorySerialRequiredError,
  InventorySerialStateConflictError,
} from '../inventory/inventory-serial-tracking';

@Injectable()
export class PurchaseOrderService {
  constructor(
    private readonly orders: PurchaseOrderRepository,
    private readonly delivery: PurchaseOrderDelivery,
    private readonly receipts: PurchaseReceiptRepository,
    private readonly returns: PurchaseReturnRepository,
  ) {}

  async create(
    tenantId: string,
    actorUserId: string,
    dto: SavePurchaseOrderDto,
  ): Promise<PurchaseOrderResponse> {
    this.validate(dto);
    try {
      return {
        data: await this.orders.create(tenantId, actorUserId, dto),
        meta: { apiVersion: '1' },
      };
    } catch (error) {
      this.rethrow(error);
    }
  }

  async update(
    tenantId: string,
    id: string,
    dto: UpdatePurchaseOrderDto,
  ): Promise<PurchaseOrderResponse> {
    this.validate(dto);
    try {
      const order = await this.orders.update(tenantId, id, dto);
      if (!order) throw new NotFoundException();
      return { data: order, meta: { apiVersion: '1' } };
    } catch (error) {
      this.rethrow(error);
    }
  }

  async list(
    tenantId: string,
    query: ListPurchaseOrdersDto,
  ): Promise<PurchaseOrderListResponse> {
    const { orders, total } = await this.orders.list(tenantId, query);
    return {
      data: orders,
      meta: {
        apiVersion: '1',
        pagination: {
          page: query.page,
          pageSize: query.pageSize,
          total,
          totalPages: Math.ceil(total / query.pageSize),
        },
      },
    };
  }

  async get(tenantId: string, id: string): Promise<PurchaseOrderResponse> {
    const order = await this.orders.findById(tenantId, id);
    if (!order) throw new NotFoundException();
    return { data: order, meta: { apiVersion: '1' } };
  }

  approve(input: {
    tenantId: string;
    orderId: string;
    actorUserId: string;
    version: number;
    reason?: string;
    idempotencyKey: string | undefined;
  }): Promise<PurchaseOrderResponse> {
    return this.changeStatus({ ...input, from: ['DRAFT'], to: 'APPROVED' });
  }

  async send(input: {
    tenantId: string;
    orderId: string;
    actorUserId: string;
    version: number;
    idempotencyKey: string | undefined;
  }): Promise<PurchaseOrderResponse> {
    this.idempotencyKey(input.idempotencyKey);
    const current = await this.get(input.tenantId, input.orderId);
    const recipient = await this.orders.findSupplierEmail(
      input.tenantId,
      input.orderId,
    );
    const delivery = await this.delivery.send({
      folio: current.data.folio,
      recipient,
    });
    return this.changeStatus({
      ...input,
      from: ['APPROVED'],
      to: 'SENT',
      delivery,
    });
  }

  cancel(input: {
    tenantId: string;
    orderId: string;
    actorUserId: string;
    version: number;
    reason: string;
    idempotencyKey: string | undefined;
  }): Promise<PurchaseOrderResponse> {
    return this.changeStatus({
      ...input,
      from: ['DRAFT', 'APPROVED', 'SENT'],
      to: 'CANCELLED',
    });
  }

  async receive(input: {
    tenantId: string;
    orderId: string;
    warehouseId: string;
    actorUserId: string;
    allowOverage: boolean;
    idempotencyKey: string | undefined;
    dto: ReceivePurchaseOrderDto;
  }): Promise<PurchaseOrderResponse> {
    const idempotencyKey = this.idempotencyKey(input.idempotencyKey);
    try {
      const receipt = await this.receipts.receive({ ...input, idempotencyKey });
      const order = await this.orders.findById(input.tenantId, input.orderId);
      if (!order) throw new PurchaseOrderNotFoundError();
      return {
        data: order,
        meta: {
          apiVersion: '1',
          idempotentReplay: receipt.replay,
          receiptId: receipt.receiptId,
        },
      };
    } catch (error) {
      this.rethrow(error);
    }
  }

  async returnToSupplier(input: {
    tenantId: string;
    orderId: string;
    actorUserId: string;
    warehouseId: string;
    idempotencyKey: string | undefined;
    dto: ReturnPurchaseReceiptDto;
  }): Promise<PurchaseOrderResponse> {
    const idempotencyKey = this.idempotencyKey(input.idempotencyKey);
    try {
      const purchaseReturn = await this.returns.create({
        ...input,
        idempotencyKey,
      });
      const order = await this.orders.findById(input.tenantId, input.orderId);
      if (!order) throw new PurchaseOrderNotFoundError();
      return {
        data: order,
        meta: {
          apiVersion: '1',
          idempotentReplay: purchaseReturn.replay,
          returnId: purchaseReturn.returnId,
        },
      };
    } catch (error) {
      this.rethrow(error);
    }
  }

  private async changeStatus(input: {
    tenantId: string;
    orderId: string;
    actorUserId: string;
    version: number;
    from: Array<'DRAFT' | 'APPROVED' | 'SENT'>;
    to: 'APPROVED' | 'SENT' | 'CANCELLED';
    reason?: string;
    delivery?: { mode: 'SIMULATED'; recipient: string | null };
    idempotencyKey: string | undefined;
  }): Promise<PurchaseOrderResponse> {
    const idempotencyKey = this.idempotencyKey(input.idempotencyKey);
    const fingerprint = createHash('sha256')
      .update(
        JSON.stringify({
          orderId: input.orderId,
          to: input.to,
          version: input.version,
          reason: input.reason ?? null,
        }),
      )
      .digest('hex');
    try {
      const result = await this.orders.transition({
        ...input,
        idempotencyKey,
        fingerprint,
      });
      return {
        data: result.order,
        meta: { apiVersion: '1', idempotentReplay: result.replay },
      };
    } catch (error) {
      this.rethrow(error);
    }
  }

  private idempotencyKey(value: string | undefined): string {
    if (!value || !/^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/.test(value)) {
      throw new BadRequestException({
        code: 'INVALID_IDEMPOTENCY_KEY',
        message:
          'Idempotency-Key es obligatorio y debe tener entre 8 y 128 caracteres.',
      });
    }
    return value;
  }

  private validate(dto: SavePurchaseOrderDto): void {
    if (
      new Set(dto.lines.map((line) => line.supplierProductId)).size !==
      dto.lines.length
    ) {
      this.rethrow(new PurchaseOrderDuplicateLineError());
    }
  }

  private rethrow(error: unknown): never {
    if (error instanceof PurchaseOrderReferenceError) {
      const responses = {
        SUPPLIER: {
          code: 'INVALID_PURCHASE_ORDER_SUPPLIER',
          message:
            'El proveedor no existe, está inactivo o pertenece a otra empresa.',
        },
        SUPPLIER_PRODUCT: {
          code: 'INVALID_PURCHASE_ORDER_LINE',
          message:
            'Una línea no corresponde a un producto activo de ese proveedor.',
        },
        CURRENCY: {
          code: 'INVALID_PURCHASE_ORDER_CURRENCY',
          message: 'La moneda no coincide con el precio vigente de una línea.',
        },
      }[error.reference];
      throw new BadRequestException(responses);
    }
    if (error instanceof PurchaseOrderNotFoundError)
      throw new NotFoundException();
    if (error instanceof PurchaseOrderIdempotencyConflictError) {
      throw new ConflictException({
        code: 'IDEMPOTENCY_KEY_REUSED',
        message: 'La clave de idempotencia ya fue usada con otros datos.',
      });
    }
    if (error instanceof PurchaseOrderDuplicateLineError) {
      throw new BadRequestException({
        code: 'DUPLICATE_PURCHASE_ORDER_LINE',
        message: 'Cada producto del proveedor sólo puede aparecer una vez.',
      });
    }
    if (error instanceof InvalidPurchaseReceiptError) {
      throw new BadRequestException({
        code: 'INVALID_PURCHASE_RECEIPT',
        message: 'La recepción contiene líneas o cantidades no válidas.',
      });
    }
    if (error instanceof PurchaseReceiptLocationError) {
      throw new BadRequestException({
        code: 'INVALID_PURCHASE_RECEIPT_LOCATION',
        message:
          'La ubicación no pertenece a la bodega activa o está inactiva.',
      });
    }
    if (error instanceof PurchaseReceiptOveragePermissionError) {
      throw new ForbiddenException({
        code: 'PURCHASE_RECEIPT_OVERAGE_PERMISSION_REQUIRED',
        message:
          'La cantidad excede la orden y requiere permiso para sobrantes.',
      });
    }
    if (error instanceof PurchaseReceiptOverageReasonError) {
      throw new BadRequestException({
        code: 'PURCHASE_RECEIPT_OVERAGE_REASON_REQUIRED',
        message: 'Indica el motivo para recibir cantidades sobrantes.',
      });
    }
    if (error instanceof InvalidPurchaseReturnError) {
      throw new BadRequestException({
        code: 'INVALID_PURCHASE_RETURN',
        message: 'La devolución no corresponde a esta orden o recepción.',
      });
    }
    if (error instanceof PurchaseReturnQuantityError) {
      throw new ConflictException({
        code: 'PURCHASE_RETURN_QUANTITY_EXCEEDED',
        message: 'La cantidad acumulada a devolver supera lo recibido.',
      });
    }
    if (error instanceof PurchaseReturnStockError) {
      throw new ConflictException({
        code: 'INSUFFICIENT_PURCHASE_RETURN_STOCK',
        message:
          'No hay stock disponible suficiente en la ubicación de recepción.',
      });
    }
    if (error instanceof PurchaseOrderVersionConflictError) {
      throw new ConflictException({
        code: 'PURCHASE_ORDER_VERSION_CONFLICT',
        currentVersion: error.currentVersion,
        message:
          'La orden cambió desde que la abriste. Recarga antes de guardar.',
      });
    }
    if (error instanceof PurchaseOrderStateError) {
      throw new ConflictException({
        code: 'PURCHASE_ORDER_STATE_CONFLICT',
        currentStatus: error.status,
        message: 'El estado actual de la orden no permite esta operación.',
      });
    }
    if (error instanceof InventoryFifoLayerShortageError) {
      throw new ConflictException({ code: 'INVENTORY_FIFO_LAYER_SHORTAGE' });
    }
    if (error instanceof InventoryFifoCurrencyMismatchError) {
      throw new ConflictException({
        code: 'INVENTORY_FIFO_CURRENCY_MISMATCH',
      });
    }
    if (error instanceof InventoryLotRequiredError) {
      throw new BadRequestException({
        code: 'INVENTORY_LOT_REQUIRED',
        message: 'Indica el lote de cada producto que controla lotes.',
      });
    }
    if (error instanceof InventoryLotExpirationRequiredError) {
      throw new BadRequestException({
        code: 'INVENTORY_LOT_EXPIRATION_REQUIRED',
        message: 'Indica la fecha de caducidad del lote.',
      });
    }
    if (error instanceof InvalidInventoryLotDatesError) {
      throw new BadRequestException({
        code: 'INVALID_INVENTORY_LOT_DATES',
        message: 'Las fechas del lote no son válidas o no coinciden.',
      });
    }
    if (error instanceof InvalidInventoryLotCodeError) {
      throw new BadRequestException({ code: 'INVALID_INVENTORY_LOT_CODE' });
    }
    if (error instanceof InventoryLotNotFoundError) {
      throw new NotFoundException({ code: 'INVENTORY_LOT_NOT_FOUND' });
    }
    if (error instanceof InsufficientInventoryLotStockError) {
      throw new ConflictException({
        code: 'INSUFFICIENT_INVENTORY_LOT_STOCK',
      });
    }
    if (error instanceof InventoryLotCurrencyMismatchError) {
      throw new ConflictException({
        code: 'INVENTORY_LOT_CURRENCY_MISMATCH',
        message: 'Los lotes de un producto deben usar una sola moneda.',
      });
    }
    if (
      error instanceof InventorySerialRequiredError ||
      error instanceof InventorySerialQuantityError
    ) {
      throw new BadRequestException({ code: 'INVENTORY_SERIALS_REQUIRED' });
    }
    if (error instanceof InventorySerialNotFoundError)
      throw new NotFoundException({ code: 'INVENTORY_SERIAL_NOT_FOUND' });
    if (
      error instanceof InventorySerialDuplicateError ||
      error instanceof InventorySerialStateConflictError
    ) {
      throw new ConflictException({ code: 'INVENTORY_SERIAL_STATE_CONFLICT' });
    }
    throw error;
  }
}
