import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { createHash } from 'node:crypto';
import { ListPurchaseOrdersDto } from './dto/list-purchase-orders.dto';
import { SavePurchaseOrderDto } from './dto/save-purchase-order.dto';
import { UpdatePurchaseOrderDto } from './dto/update-purchase-order.dto';
import {
  PurchaseOrderDuplicateLineError,
  PurchaseOrderIdempotencyConflictError,
  PurchaseOrderNotFoundError,
  PurchaseOrderReferenceError,
  PurchaseOrderStateError,
  PurchaseOrderVersionConflictError,
} from './purchase-order.errors';
import { PurchaseOrderRepository } from './purchase-order.repository';
import { PurchaseOrderDelivery } from './purchase-order.delivery';
import {
  PurchaseOrderListResponse,
  PurchaseOrderResponse,
} from './purchase-order.types';

@Injectable()
export class PurchaseOrderService {
  constructor(
    private readonly orders: PurchaseOrderRepository,
    private readonly delivery: PurchaseOrderDelivery,
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
        message: 'Sólo las órdenes en borrador pueden editarse.',
      });
    }
    throw error;
  }
}
