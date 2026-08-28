import { INestApplication } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import request from 'supertest';
import { App } from 'supertest/types';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/security/configure-app';

jest.setTimeout(90_000);

type TestAgent = ReturnType<typeof request.agent>;

interface TenantFixture {
  agent: TestAgent;
  ownSku: string;
  productId: string;
  locationId: string;
}

const budgets = {
  login: 3_000,
  productSearch: 1_500,
  posQuote: 1_500,
  stock: 1_500,
  syncBootstrap: 2_500,
  salesReport: 2_500,
} as const;

describe('Critical flow performance and concurrency (e2e)', () => {
  let app: INestApplication<App>;
  let tenants: TenantFixture[];
  const loginDurations: number[] = [];
  const runId = randomUUID().slice(0, 8);

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = moduleFixture.createNestApplication();
    configureApp(app);
    await app.init();
    tenants = [await prepareTenant(1), await prepareTenant(2)];
  });

  afterAll(async () => {
    await app.close();
  });

  function p95(durations: number[]): number {
    const ordered = [...durations].sort((left, right) => left - right);
    return ordered[Math.ceil(ordered.length * 0.95) - 1];
  }

  async function timed(action: () => Promise<unknown>): Promise<number> {
    const startedAt = performance.now();
    await action();
    return performance.now() - startedAt;
  }

  async function expectBudget(
    label: keyof typeof budgets,
    action: (sample: number) => Promise<unknown>,
    samples = 6,
  ): Promise<void> {
    const durations: number[] = [];
    for (let sample = 0; sample < samples; sample += 1) {
      durations.push(await timed(() => action(sample)));
    }
    const actualP95 = Math.round(p95(durations));
    process.stdout.write(
      `${JSON.stringify({ check: label, p95Ms: actualP95, budgetMs: budgets[label] })}\n`,
    );
    expect(actualP95).toBeLessThanOrEqual(budgets[label]);
  }

  async function prepareTenant(index: number): Promise<TenantFixture> {
    const email = `performance-${runId}-${index}@example.com`;
    const password = 'Correcta-2026!';
    const ownSku = `PERF-${runId}-${index}`.toUpperCase();
    await request(app.getHttpServer())
      .post('/api/v1/auth/registrations')
      .set('Idempotency-Key', `perf-registration-${runId}-${index}`)
      .send({
        organizationName: `Empresa Rendimiento ${index}`,
        email,
        password,
      })
      .expect(201);

    const agent = request.agent(app.getHttpServer());
    for (let sample = 0; sample < 5; sample += 1) {
      loginDurations.push(
        await timed(() =>
          agent
            .post('/api/v1/auth/sessions')
            .send({ email, password })
            .expect(200),
        ),
      );
    }
    await agent
      .put('/api/v1/onboarding/company')
      .send({
        legalName: `Empresa Rendimiento ${index}, S.A.`,
        tradeName: `Rendimiento ${index}`,
        countryCode: 'MX',
      })
      .expect(200);
    const locationResponse = await agent
      .put('/api/v1/onboarding/initial-location')
      .send({
        branchName: `Sucursal ${index}`,
        timezone: 'America/Mexico_City',
        warehouseName: `Bodega ${index}`,
        locationName: `General ${index}`,
      })
      .expect(200);
    await agent
      .put('/api/v1/onboarding/initial-cash-register')
      .send({ name: `Caja ${index}` })
      .expect(200);
    const productResponse = await agent
      .post('/api/v1/products')
      .send({
        name: `Producto Rendimiento ${index}`,
        sku: ownSku,
        cost: '5.00',
        price: '10.00',
      })
      .expect(201);
    const productId = (productResponse.body as { data: { id: string } }).data
      .id;
    const locationId = (
      locationResponse.body as { data: { location: { id: string } } }
    ).data.location.id;
    await agent
      .post('/api/v1/inventory/movements')
      .set('Idempotency-Key', `perf-stock-${runId}-${index}`)
      .send({
        productId,
        locationId,
        type: 'INITIAL',
        quantity: '10',
        reason: 'Prueba de rendimiento',
      })
      .expect(201);
    await agent
      .post('/api/v1/pos/register-shifts')
      .set('Idempotency-Key', `perf-shift-${runId}-${index}`)
      .send({ openingAmount: '100.00' })
      .expect(201);

    return { agent, ownSku, productId, locationId };
  }

  it('keeps login within its p95 budget', () => {
    expect(loginDurations).toHaveLength(10);
    const actualP95 = Math.round(p95(loginDurations));
    process.stdout.write(
      `${JSON.stringify({ check: 'login', p95Ms: actualP95, budgetMs: budgets.login })}\n`,
    );
    expect(actualP95).toBeLessThanOrEqual(budgets.login);
  });

  it('keeps tenant-scoped search, POS, stock, sync and reports within budget', async () => {
    await expectBudget('productSearch', async (sample) => {
      const tenant = tenants[sample % tenants.length];
      const other = tenants[(sample + 1) % tenants.length];
      const response = await tenant.agent
        .get('/api/v1/products')
        .query({ q: tenant.ownSku, pageSize: 20 })
        .expect(200);
      expect(JSON.stringify(response.body)).toContain(tenant.ownSku);
      expect(JSON.stringify(response.body)).not.toContain(other.ownSku);
    });
    await expectBudget('posQuote', async (sample) => {
      const tenant = tenants[sample % tenants.length];
      await tenant.agent
        .post('/api/v1/pos/cart/quote')
        .send({ lines: [{ productId: tenant.productId, quantity: '1' }] })
        .expect(200);
    });
    await expectBudget('stock', async (sample) => {
      const tenant = tenants[sample % tenants.length];
      await tenant.agent
        .get('/api/v1/inventory/stock')
        .query({ q: tenant.ownSku, pageSize: 20 })
        .expect(200);
    });
    const deviceIds = tenants.map(() => randomUUID());
    await expectBudget(
      'syncBootstrap',
      async (sample) => {
        const tenantIndex = sample % tenants.length;
        await tenants[tenantIndex].agent
          .get('/api/v1/offline/bootstrap')
          .query({ deviceId: deviceIds[tenantIndex], pageSize: 100 })
          .expect(200);
      },
      4,
    );
    await expectBudget(
      'salesReport',
      async (sample) => {
        await tenants[sample % tenants.length].agent
          .get('/api/v1/pos/reports/sales-cash')
          .query({ pageSize: 20 })
          .expect(200);
      },
      4,
    );
  });

  it('serializes stock contention across simultaneous sales and recovers', async () => {
    const tenant = tenants[0];
    const productResponse = await tenant.agent
      .post('/api/v1/products')
      .send({
        name: 'Última unidad concurrente',
        sku: `LAST-${runId}`.toUpperCase(),
        cost: '4.00',
        price: '10.00',
      })
      .expect(201);
    const productId = (productResponse.body as { data: { id: string } }).data
      .id;
    await tenant.agent
      .post('/api/v1/inventory/movements')
      .set('Idempotency-Key', `perf-last-stock-${runId}`)
      .send({
        productId,
        locationId: tenant.locationId,
        type: 'INITIAL',
        quantity: '1',
        reason: 'Contención de última unidad',
      })
      .expect(201);

    const sales = await Promise.all(
      ['a', 'b'].map((suffix) =>
        tenant.agent
          .post('/api/v1/pos/sales/cash')
          .set('Idempotency-Key', `perf-sale-${runId}-${suffix}`)
          .send({
            lines: [{ productId, quantity: '1' }],
            cashReceived: '10.00',
          }),
      ),
    );
    expect(sales.map(({ status }) => status).sort()).toEqual([201, 409]);

    await tenant.agent
      .get(`/api/v1/inventory/products/${productId}/balance`)
      .query({ locationId: tenant.locationId })
      .expect(200)
      .expect(({ body }: { body: unknown }) => {
        expect(body).toMatchObject({
          data: { quantity: '0.000', availableQuantity: '0.000' },
        });
      });
    await tenant.agent.get('/health/ready').expect(200);
  });
});
