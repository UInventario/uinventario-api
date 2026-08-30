import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { createHash, randomBytes } from 'node:crypto';
import { QueryFailedError } from 'typeorm';
import { AuditService } from '../audit/audit.service';
import { CustomerOrderService } from '../orders/customer-order.service';
import type { CustomerOrderData } from '../orders/customer-order.types';
import type { CreateCommerceCredentialDto } from './dto/create-commerce-credential.dto';
import type { CreateCommerceOrderDto } from './dto/create-commerce-order.dto';
import { CommerceRepository } from './commerce.repository';
import type { CommercePrincipal } from './commerce.types';
import { CommerceWebhookService } from './commerce-webhook.service';

@Injectable()
export class CommerceService {
  constructor(
    private readonly repository: CommerceRepository,
    private readonly orders: CustomerOrderService,
    private readonly audit: AuditService,
    private readonly webhooks: CommerceWebhookService,
  ) {}

  async createCredential(input: {
    tenantId: string;
    userId: string;
    correlationId: string;
    dto: CreateCommerceCredentialDto;
  }) {
    this.assertWebhook(input.dto);
    if (
      input.dto.scopes.includes('STOCK_READ') &&
      !input.dto.scopes.includes('CATALOG_READ')
    )
      throw new BadRequestException('STOCK_SCOPE_REQUIRES_CATALOG_READ');
    const { rawKey, keyPrefix, keyHash } = this.key();
    let credential;
    try {
      credential = await this.repository.createCredential({
        ...input.dto,
        tenantId: input.tenantId,
        userId: input.userId,
        keyPrefix,
        keyHash,
        webhookUrl: input.dto.webhookUrl ?? null,
      });
    } catch (error) {
      if (
        error instanceof QueryFailedError &&
        (error.driverError as { code?: string }).code === 'ER_DUP_ENTRY'
      )
        throw new ConflictException('COMMERCE_CREDENTIAL_NAME_CONFLICT');
      throw error;
    }
    if (!credential)
      throw new BadRequestException({
        code: 'COMMERCE_CONTEXT_INVALID',
        message:
          'La sucursal, bodega, ubicación, caja y cliente deben pertenecer a la empresa y formar un contexto operativo válido.',
      });
    await this.audit.recordRequired({
      tenantId: input.tenantId,
      actorUserId: input.userId,
      action: 'COMMERCE_CREDENTIAL_CREATED',
      entityType: 'COMMERCE_API_CREDENTIAL',
      entityId: credential.id,
      correlationId: input.correlationId,
      after: {
        name: credential.name,
        keyPrefix: credential.keyPrefix,
        scopes: credential.scopes,
        webhookEnabled: credential.webhook.enabled,
      },
    });
    return {
      data: { ...credential, apiKey: rawKey },
      meta: {
        apiVersion: '1',
        warning: 'La clave sólo se muestra una vez.',
      },
    };
  }

  async credentials(tenantId: string) {
    return {
      data: await this.repository.listCredentials(tenantId),
      meta: { apiVersion: '1' },
    };
  }

  openapi() {
    return {
      openapi: '3.1.0',
      info: {
        title: 'UInventario External Commerce API',
        version: '1.0.0',
      },
      servers: [{ url: '/external/v1' }],
      components: {
        securitySchemes: {
          bearerApiKey: { type: 'http', scheme: 'bearer' },
        },
      },
      security: [{ bearerApiKey: [] }],
      paths: {
        '/catalog': {
          get: {
            summary: 'Catálogo incremental',
            'x-required-scope': 'CATALOG_READ',
            'x-limits': { default: 100, maximum: 200 },
            responses: {
              '200': { description: 'Página incremental de catálogo' },
            },
          },
        },
        '/orders': {
          post: {
            summary: 'Crear pedido idempotente',
            'x-required-scope': 'ORDERS_WRITE',
            responses: {
              '201': { description: 'Pedido creado o reproducido' },
            },
          },
        },
        '/orders/{externalOrderId}': {
          get: {
            summary: 'Consultar pedido externo',
            'x-required-scope': 'ORDERS_READ',
            responses: { '200': { description: 'Estado actual del pedido' } },
          },
        },
      },
      'x-webhook-contract': {
        version: '1',
        signatureHeader: 'X-UInventario-Signature',
        signature: 'HMAC-SHA256(JSON, SHA256(apiKey))',
        attempts: { automatic: 3, controlledMaximumTotal: 5 },
        simulatorUrls: {
          success: 'https://success.example.test/webhook',
          retryThenSuccess: 'https://retry.example.test/webhook',
          recoverWithReplay: 'https://recover.example.test/webhook',
          reject: 'https://reject.example.test/webhook',
        },
        example: {
          apiVersion: '1',
          eventId: '00000000-0000-4000-8000-000000000000:ORDER_CONFIRMED:1',
          type: 'ORDER_CONFIRMED',
          occurredAt: '2026-01-01T00:00:00.000Z',
        },
      },
    };
  }

  async rotateCredential(input: {
    tenantId: string;
    userId: string;
    credentialId: string;
    correlationId: string;
  }) {
    const { rawKey, keyPrefix, keyHash } = this.key();
    const credential = await this.repository.rotateCredential({
      tenantId: input.tenantId,
      credentialId: input.credentialId,
      keyPrefix,
      keyHash,
    });
    if (!credential) throw new NotFoundException();
    await this.audit.recordRequired({
      tenantId: input.tenantId,
      actorUserId: input.userId,
      action: 'COMMERCE_CREDENTIAL_ROTATED',
      entityType: 'COMMERCE_API_CREDENTIAL',
      entityId: input.credentialId,
      correlationId: input.correlationId,
      after: { keyPrefix: credential.keyPrefix, scopes: credential.scopes },
    });
    return {
      data: { ...credential, apiKey: rawKey },
      meta: { apiVersion: '1', warning: 'La clave sólo se muestra una vez.' },
    };
  }

  async revokeCredential(input: {
    tenantId: string;
    userId: string;
    credentialId: string;
    correlationId: string;
  }) {
    const revoked = await this.repository.revokeCredential(
      input.tenantId,
      input.credentialId,
    );
    if (!revoked) throw new NotFoundException();
    await this.audit.recordRequired({
      tenantId: input.tenantId,
      actorUserId: input.userId,
      action: 'COMMERCE_CREDENTIAL_REVOKED',
      entityType: 'COMMERCE_API_CREDENTIAL',
      entityId: input.credentialId,
      correlationId: input.correlationId,
    });
    return { data: { revoked: true }, meta: { apiVersion: '1' } };
  }

  async catalog(
    principal: CommercePrincipal,
    cursorValue: string | undefined,
    limit: number,
  ) {
    const cursor = this.decodeCursor(cursorValue);
    const rows = await this.repository.catalog({ principal, cursor, limit });
    const hasMore = rows.length > limit;
    const page = rows.slice(0, limit);
    const items = page.map((row) => ({
      id: String(row.id),
      name: String(row.name),
      sku: String(row.sku),
      barcode: row.barcode ? String(row.barcode) : null,
      unit: String(row.base_unit),
      quantityPrecision: Number(row.quantity_precision),
      minimumQuantity: String(row.minimum_quantity),
      price: String(row.price),
      currency: String(row.currency),
      active: Boolean(row.active),
      stock: principal.scopes.includes('STOCK_READ')
        ? {
            behavior: String(row.stock_behavior),
            onHand: String(row.quantity),
            available: String(row.available_quantity),
          }
        : undefined,
      changedAt: new Date(row.changed_at).toISOString(),
    }));
    const last = page.at(-1);
    return {
      data: items,
      meta: {
        apiVersion: '1',
        hasMore,
        nextCursor:
          hasMore && last
            ? this.encodeCursor(last.changed_cursor, String(last.id))
            : null,
      },
    };
  }

  async createOrder(principal: CommercePrincipal, dto: CreateCommerceOrderDto) {
    const fingerprint = createHash('sha256')
      .update(JSON.stringify(dto))
      .digest('hex');
    const existing = await this.repository.findExternalOrder(
      principal,
      dto.externalOrderId,
    );
    if (existing) {
      if (existing.request_fingerprint !== fingerprint)
        throw new ConflictException('EXTERNAL_ORDER_IDEMPOTENCY_CONFLICT');
      return this.externalOrder(principal, dto.externalOrderId, true);
    }
    const externalIdHash = createHash('sha256')
      .update(dto.externalOrderId)
      .digest('hex')
      .slice(0, 32);
    const key = `commerce:${principal.credentialId}:${externalIdHash}`;
    const created = await this.orders.create({
      tenantId: principal.tenantId,
      branchId: principal.context.branchId,
      warehouseId: principal.context.warehouseId,
      cashRegisterId: principal.context.cashRegisterId,
      userId: principal.actorUserId,
      idempotencyKey: `${key}:create`,
      dto: {
        channel: 'WEB',
        customerId: principal.context.customerId,
        locationId: principal.context.locationId,
        priority: dto.priority,
        expiresInHours: dto.expiresInHours,
        fulfillment: dto.fulfillment,
        lines: dto.lines,
        payments: [{ ...dto.payment }],
      },
    });
    const confirmed = await this.orders.confirm({
      tenantId: principal.tenantId,
      branchId: principal.context.branchId,
      warehouseId: principal.context.warehouseId,
      cashRegisterId: principal.context.cashRegisterId,
      userId: principal.actorUserId,
      orderId: created.data.id,
      idempotencyKey: `${key}:confirm`,
      dto: { version: created.data.version },
    });
    await this.repository.linkExternalOrder({
      principal,
      externalOrderId: dto.externalOrderId,
      orderId: confirmed.data.id,
      fingerprint,
    });
    await this.webhooks.publishOrder(principal.tenantId, confirmed.data);
    return {
      data: this.mapOrder(dto.externalOrderId, confirmed.data),
      meta: { apiVersion: '1', idempotentReplay: false },
    };
  }

  async externalOrder(
    principal: CommercePrincipal,
    externalOrderId: string,
    replay = false,
  ) {
    const mapping = await this.repository.findExternalOrder(
      principal,
      externalOrderId,
    );
    if (!mapping) throw new NotFoundException();
    const result = await this.orders.get(
      principal.tenantId,
      principal.context.branchId,
      mapping.order_id,
    );
    return {
      data: this.mapOrder(externalOrderId, result.data),
      meta: { apiVersion: '1', idempotentReplay: replay },
    };
  }

  async deliveries(tenantId: string) {
    return {
      data: await this.repository.deliveries(tenantId),
      meta: { apiVersion: '1' },
    };
  }

  async replayDelivery(input: {
    tenantId: string;
    userId: string;
    deliveryId: string;
    correlationId: string;
  }) {
    const delivery = await this.webhooks.replay(
      input.tenantId,
      input.deliveryId,
    );
    if (!delivery) throw new ConflictException('WEBHOOK_REPLAY_NOT_ALLOWED');
    await this.audit.recordRequired({
      tenantId: input.tenantId,
      actorUserId: input.userId,
      action: 'COMMERCE_WEBHOOK_REPLAYED',
      entityType: 'COMMERCE_WEBHOOK_DELIVERY',
      entityId: input.deliveryId,
      correlationId: input.correlationId,
      after: { status: delivery.status, attemptCount: delivery.attemptCount },
    });
    return { data: delivery, meta: { apiVersion: '1' } };
  }

  private key() {
    const prefix = randomBytes(6).toString('hex').slice(0, 8);
    const rawKey = `uic_${prefix}_${randomBytes(32).toString('base64url')}`;
    return {
      rawKey,
      keyPrefix: `uic_${prefix}`,
      keyHash: createHash('sha256').update(rawKey).digest('hex'),
    };
  }

  private mapOrder(externalOrderId: string, order: CustomerOrderData) {
    return {
      externalOrderId,
      orderId: order.id,
      orderNumber: order.orderNumber,
      status: order.status,
      fulfillmentStatus: order.fulfillment.status,
      reservationStatus: order.reservation?.status ?? null,
      paymentStatus: order.payments[0]?.status ?? null,
      currency: order.currency,
      total: order.totals.total,
      version: order.version,
      errors: order.fulfillment.carrier?.lastErrorCode
        ? [order.fulfillment.carrier.lastErrorCode]
        : [],
      updatedAt: order.updatedAt,
    };
  }

  private assertWebhook(dto: CreateCommerceCredentialDto) {
    if (dto.webhookEnabled && !dto.webhookUrl)
      throw new BadRequestException('WEBHOOK_URL_REQUIRED');
    if (!dto.webhookUrl) return;
    const url = new URL(dto.webhookUrl);
    if (
      url.protocol !== 'https:' ||
      ['localhost', '127.0.0.1', '::1'].includes(url.hostname) ||
      /^(10\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.)/.test(
        url.hostname,
      )
    )
      throw new BadRequestException('WEBHOOK_URL_NOT_ALLOWED');
  }

  private encodeCursor(updatedAt: string, id: string) {
    return Buffer.from(JSON.stringify({ updatedAt, id })).toString('base64url');
  }

  private decodeCursor(value: string | undefined) {
    if (!value) return null;
    try {
      const cursor = JSON.parse(Buffer.from(value, 'base64url').toString()) as {
        updatedAt?: unknown;
        id?: unknown;
      };
      if (
        typeof cursor.updatedAt !== 'string' ||
        !/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{6}$/.test(
          cursor.updatedAt,
        ) ||
        typeof cursor.id !== 'string' ||
        !/^[0-9a-f-]{36}$/i.test(cursor.id)
      )
        throw new Error();
      return { updatedAt: cursor.updatedAt, id: cursor.id };
    } catch {
      throw new BadRequestException('INVALID_CATALOG_CURSOR');
    }
  }
}
