import { ConflictException } from '@nestjs/common';
import { createHash } from 'node:crypto';
import type { AuditService } from '../audit/audit.service';
import type { CustomerOrderService } from '../orders/customer-order.service';
import type { CustomerOrderData } from '../orders/customer-order.types';
import type { CommerceRepository } from './commerce.repository';
import { CommerceService } from './commerce.service';
import type { CommercePrincipal } from './commerce.types';
import type { CommerceWebhookService } from './commerce-webhook.service';
import type { CreateCommerceOrderDto } from './dto/create-commerce-order.dto';

describe('CommerceService', () => {
  let capturedCreateInput:
    Parameters<CustomerOrderService['create']>[0] | undefined;
  const repository = {
    findExternalOrder: jest.fn<
      ReturnType<CommerceRepository['findExternalOrder']>,
      Parameters<CommerceRepository['findExternalOrder']>
    >(),
    linkExternalOrder: jest.fn<
      ReturnType<CommerceRepository['linkExternalOrder']>,
      Parameters<CommerceRepository['linkExternalOrder']>
    >(),
    catalog: jest.fn<
      ReturnType<CommerceRepository['catalog']>,
      Parameters<CommerceRepository['catalog']>
    >(),
    rotateCredential: jest.fn<
      ReturnType<CommerceRepository['rotateCredential']>,
      Parameters<CommerceRepository['rotateCredential']>
    >(),
  };
  const orders = {
    create: jest.fn<
      ReturnType<CustomerOrderService['create']>,
      Parameters<CustomerOrderService['create']>
    >(),
    confirm: jest.fn<
      ReturnType<CustomerOrderService['confirm']>,
      Parameters<CustomerOrderService['confirm']>
    >(),
    get: jest.fn<
      ReturnType<CustomerOrderService['get']>,
      Parameters<CustomerOrderService['get']>
    >(),
  };
  const audit = { recordRequired: jest.fn().mockResolvedValue(undefined) };
  const webhooks = { publishOrder: jest.fn(), replay: jest.fn() };
  const service = new CommerceService(
    repository as unknown as CommerceRepository,
    orders as unknown as CustomerOrderService,
    audit as unknown as AuditService,
    webhooks as unknown as CommerceWebhookService,
  );
  const principal: CommercePrincipal = {
    credentialId: '10000000-0000-4000-8000-000000000001',
    tenantId: '20000000-0000-4000-8000-000000000001',
    actorUserId: '30000000-0000-4000-8000-000000000001',
    scopes: ['CATALOG_READ', 'STOCK_READ', 'ORDERS_WRITE', 'ORDERS_READ'],
    keyHash: 'a'.repeat(64),
    rateLimitPerMinute: 60,
    context: {
      branchId: '40000000-0000-4000-8000-000000000001',
      warehouseId: '50000000-0000-4000-8000-000000000001',
      cashRegisterId: '60000000-0000-4000-8000-000000000001',
      locationId: '70000000-0000-4000-8000-000000000001',
      customerId: '80000000-0000-4000-8000-000000000001',
    },
  };
  const dto: CreateCommerceOrderDto = {
    externalOrderId: 'market-1001',
    expiresInHours: 24,
    fulfillment: {
      method: 'PICKUP',
      windowStart: '2026-08-30T10:00:00.000Z',
      windowEnd: '2026-08-30T12:00:00.000Z',
      deliveryCost: '0',
    },
    lines: [
      { productId: '90000000-0000-4000-8000-000000000001', quantity: '1' },
    ],
    payment: { method: 'TRANSFER', reference: 'market-payment-1001' },
  };

  beforeEach(() => {
    jest.clearAllMocks();
    capturedCreateInput = undefined;
  });

  it('creates and confirms one tenant-scoped order with a stock reservation', async () => {
    const draft = order('DRAFT', 1);
    const confirmed = order('CONFIRMED', 2);
    repository.findExternalOrder.mockResolvedValue(null);
    orders.create.mockImplementation(
      (input: Parameters<CustomerOrderService['create']>[0]) => {
        capturedCreateInput = input;
        return Promise.resolve({
          data: draft,
          meta: { apiVersion: '1', idempotentReplay: false },
        });
      },
    );
    orders.confirm.mockResolvedValue({
      data: confirmed,
      meta: { apiVersion: '1', idempotentReplay: false },
    });

    const result = await service.createOrder(principal, dto);

    expect(capturedCreateInput).toBeDefined();
    const createInput = capturedCreateInput!;
    expect(createInput.tenantId).toBe(principal.tenantId);
    expect(createInput.branchId).toBe(principal.context.branchId);
    expect(createInput.dto).toMatchObject({
      channel: 'WEB',
      customerId: principal.context.customerId,
      locationId: principal.context.locationId,
    });
    expect(createInput.idempotencyKey?.length).toBeLessThanOrEqual(128);
    expect(orders.confirm).toHaveBeenCalledWith(
      expect.objectContaining({
        orderId: draft.id,
        tenantId: principal.tenantId,
      }),
    );
    expect(repository.linkExternalOrder).toHaveBeenCalledWith(
      expect.objectContaining({
        principal,
        externalOrderId: dto.externalOrderId,
      }),
    );
    expect(webhooks.publishOrder).toHaveBeenCalledWith(
      principal.tenantId,
      confirmed,
    );
    expect(result.data).toMatchObject({
      status: 'CONFIRMED',
      reservationStatus: 'ACTIVE',
    });
  });

  it('replays the mapped order without creating another reservation', async () => {
    repository.findExternalOrder.mockResolvedValue({
      order_id: order().id,
      request_fingerprint: fingerprint(dto),
    });
    orders.get.mockResolvedValue({
      data: order('CONFIRMED', 2),
      meta: { apiVersion: '1' },
    });

    const result = await service.createOrder(principal, dto);

    expect(result.meta.idempotentReplay).toBe(true);
    expect(orders.create).not.toHaveBeenCalled();
    expect(orders.confirm).not.toHaveBeenCalled();
    expect(orders.get).toHaveBeenCalledWith(
      principal.tenantId,
      principal.context.branchId,
      order().id,
    );
  });

  it('rejects reuse of an external id with a different request', async () => {
    repository.findExternalOrder.mockResolvedValue({
      order_id: order().id,
      request_fingerprint: 'different',
    });
    await expect(service.createOrder(principal, dto)).rejects.toBeInstanceOf(
      ConflictException,
    );
  });

  it('returns incremental public catalog fields without cost or customer PII', async () => {
    repository.catalog.mockResolvedValue([
      {
        id: dto.lines[0].productId,
        name: 'Café',
        sku: 'CAFE-1',
        barcode: null,
        base_unit: 'UNIT',
        quantity_precision: 0,
        minimum_quantity: '1.000',
        price: '50.00',
        active: 1,
        stock_behavior: 'TRACKED',
        quantity: '8.000',
        available_quantity: '7.000',
        currency: 'MXN',
        changed_at: '2026-08-30T00:00:00.000Z',
        changed_cursor: '2026-08-30 00:00:00.000000',
      },
    ]);

    const result = await service.catalog(principal, undefined, 100);
    const serialized = JSON.stringify(result);

    expect(serialized).not.toContain('cost');
    expect(serialized).not.toContain('customer');
    expect(result.data[0]).toMatchObject({
      price: '50.00',
      stock: { onHand: '8.000', available: '7.000' },
    });
    expect(repository.catalog).toHaveBeenCalledWith(
      expect.objectContaining({ principal }),
    );
  });

  it('rotates an active credential and exposes the replacement key only once', async () => {
    repository.rotateCredential.mockResolvedValue({
      id: principal.credentialId,
      name: 'Marketplace',
      keyPrefix: 'uic_87654321',
      scopes: ['CATALOG_READ'],
      context: {
        branch: { id: 'b', name: 'Sucursal' },
        warehouse: { id: 'w', name: 'Bodega' },
        cashRegister: { id: 'r', name: 'Caja', code: 'C1' },
        location: { id: 'l', name: 'Ubicación', code: 'L1' },
        customer: { id: 'c', name: 'Cliente' },
      },
      active: true,
      rateLimitPerMinute: 60,
      webhook: { url: null, events: [], enabled: false, mode: 'SIMULATOR' },
      lastUsedAt: null,
      createdAt: '2026-08-30T00:00:00.000Z',
      updatedAt: '2026-08-30T00:00:00.000Z',
    });

    const result = await service.rotateCredential({
      tenantId: principal.tenantId,
      userId: principal.actorUserId,
      credentialId: principal.credentialId,
      correlationId: 'request-rotate',
    });

    expect(result.data.apiKey).toMatch(/^uic_[a-f0-9]{8}_[A-Za-z0-9_-]{43}$/);
    expect(repository.rotateCredential).toHaveBeenCalled();
    const rotated = repository.rotateCredential.mock.calls[0][0];
    expect(rotated).toMatchObject({
      tenantId: principal.tenantId,
      credentialId: principal.credentialId,
    });
    expect(rotated.keyHash).toMatch(/^[a-f0-9]{64}$/);
    expect(JSON.stringify(result.data)).not.toContain('keyHash');
    expect(audit.recordRequired).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'COMMERCE_CREDENTIAL_ROTATED' }),
    );
  });

  it('audits a controlled webhook replay', async () => {
    webhooks.replay.mockResolvedValue({
      id: 'delivery-1',
      status: 'SUCCEEDED',
      attemptCount: 4,
    });

    await expect(
      service.replayDelivery({
        tenantId: principal.tenantId,
        userId: principal.actorUserId,
        deliveryId: 'delivery-1',
        correlationId: 'request-replay',
      }),
    ).resolves.toMatchObject({ data: { status: 'SUCCEEDED' } });
    expect(audit.recordRequired).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'COMMERCE_WEBHOOK_REPLAYED' }),
    );
  });

  it('publishes a secret-free OpenAPI 3.1 contract with scoped operations', () => {
    const contract = service.openapi();

    expect(contract.openapi).toBe('3.1.0');
    expect(contract.paths['/catalog'].get['x-required-scope']).toBe(
      'CATALOG_READ',
    );
    expect(
      contract.paths['/catalog'].get.responses['200'].description.length,
    ).toBeGreaterThan(0);
    expect(JSON.stringify(contract)).not.toMatch(/uic_[a-f0-9]{8}_/);
  });
});

function fingerprint(value: object) {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function order(
  status: CustomerOrderData['status'] = 'CONFIRMED',
  version = 2,
): CustomerOrderData {
  return {
    id: 'a0000000-0000-4000-8000-000000000001',
    orderNumber: 'ORD-1',
    channel: 'WEB',
    priority: 'NORMAL',
    status,
    version,
    customer: { id: 'c', name: 'Cliente', identifier: null },
    context: {
      branch: { id: 'b', name: 'Sucursal' },
      warehouse: { id: 'w', name: 'Bodega' },
      cashRegister: { id: 'r', name: 'Caja', code: 'C1' },
      location: { id: 'l', name: 'Ubicación', code: 'L1' },
    },
    currency: 'MXN',
    totals: { subtotal: '50.00', tax: '0.00', total: '50.00' },
    expiresInHours: 24,
    fulfillment: {
      method: 'PICKUP',
      status: 'READY',
      deliveryCost: '0.00',
      window: { start: '', end: '' },
      address: null,
      carrier: null,
      responsible: { preparation: null, delivery: null },
    },
    reservation: { id: 'res', reservationNumber: 'RES-1', status: 'ACTIVE' },
    sale: null,
    lines: [],
    payments: [
      {
        id: 'pay',
        method: 'TRANSFER',
        amount: '50.00',
        amountReceived: '50.00',
        reference: 'market-payment-1001',
        status: 'PLANNED',
      },
    ],
    transitions: [],
    cancellationReason: null,
    createdAt: '2026-08-30T00:00:00.000Z',
    updatedAt: '2026-08-30T00:00:00.000Z',
  };
}
