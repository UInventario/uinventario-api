import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { ListPurchaseOrdersDto } from './dto/list-purchase-orders.dto';
import { SavePurchaseOrderDto } from './dto/save-purchase-order.dto';
import { UpdatePurchaseOrderDto } from './dto/update-purchase-order.dto';
import {
  PurchaseOrderDuplicateLineError,
  PurchaseOrderReferenceError,
  PurchaseOrderStateError,
  PurchaseOrderVersionConflictError,
} from './purchase-order.errors';
import { PurchaseOrderRepository } from './purchase-order.repository';
import {
  PurchaseOrderListResponse,
  PurchaseOrderResponse,
} from './purchase-order.types';

@Injectable()
export class PurchaseOrderService {
  constructor(private readonly orders: PurchaseOrderRepository) {}

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
