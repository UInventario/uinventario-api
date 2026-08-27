import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import request from 'supertest';
import { App } from 'supertest/types';
import { AppModule } from './../src/app.module';
import { DataSource } from 'typeorm';
import { createHash, randomUUID } from 'node:crypto';

describe('UInventario API (e2e)', () => {
  let app: INestApplication<App>;
  let dataSource: DataSource;

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    app.setGlobalPrefix('api/v1');
    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
      }),
    );
    await app.init();
    dataSource = app.get(DataSource);
  });

  async function resetIdentityData(): Promise<void> {
    await dataSource.query('SET FOREIGN_KEY_CHECKS = 0');
    for (const table of [
      'products',
      'brands',
      'categories',
      'cash_registers',
      'locations',
      'warehouses',
      'branches',
      'sessions',
      'registration_requests',
      'user_roles',
      'users',
      'roles',
      'tenants',
    ]) {
      await dataSource.query(`TRUNCATE TABLE ${table}`);
    }
    await dataSource.query('SET FOREIGN_KEY_CHECKS = 1');
  }

  const registrationPayload = {
    organizationName: 'Tienda Central',
    email: 'admin@example.com',
    password: 'Correcta-2026!',
  };

  async function registerAccount(idempotencyKey: string): Promise<void> {
    await request(app.getHttpServer())
      .post('/api/v1/auth/registrations')
      .set('Idempotency-Key', idempotencyKey)
      .send(registrationPayload)
      .expect(201);
  }

  async function createPersistedSession(email: string): Promise<string> {
    const [identity] = await dataSource.query<
      Array<{ user_id: string; tenant_id: string }>
    >('SELECT id AS user_id, tenant_id FROM users WHERE normalized_email = ?', [
      email.toLowerCase(),
    ]);
    const token =
      randomUUID().replaceAll('-', '') + randomUUID().replaceAll('-', '');
    await dataSource.query(
      `INSERT INTO sessions
        (id, token_hash, user_id, tenant_id, expires_at, revoked_at)
       VALUES (?, ?, ?, ?, ?, NULL)`,
      [
        randomUUID(),
        createHash('sha256').update(token).digest('hex'),
        identity.user_id,
        identity.tenant_id,
        new Date(Date.now() + 60 * 60_000),
      ],
    );
    return `uinventario_session=${token}`;
  }

  describe('health', () => {
    it('/api/v1/health/live (GET)', () => {
      return request(app.getHttpServer())
        .get('/api/v1/health/live')
        .expect(200)
        .expect({ status: 'ok', info: {}, error: {}, details: {} });
    });

    it('/api/v1/health/ready (GET)', () => {
      return request(app.getHttpServer())
        .get('/api/v1/health/ready')
        .expect(200)
        .expect({
          status: 'ok',
          info: { database: { status: 'up' } },
          error: {},
          details: { database: { status: 'up' } },
        });
    });
  });

  describe('registration', () => {
    beforeEach(resetIdentityData);

    const payload = registrationPayload;

    it('creates a tenant, administrator and protected credential', async () => {
      await request(app.getHttpServer())
        .post('/api/v1/auth/registrations')
        .set('Idempotency-Key', 'registration-success-1')
        .send(payload)
        .expect(201)
        .expect(({ body }: { body: unknown }) => {
          expect(body).toMatchObject({
            data: {
              tenant: { name: payload.organizationName },
              user: { email: payload.email },
              nextStep: 'LOGIN',
            },
            meta: { apiVersion: '1' },
          });
        });

      const [user] = await dataSource.query<Array<{ password_hash: string }>>(
        'SELECT password_hash FROM users WHERE normalized_email = ?',
        [payload.email],
      );
      const [role] = await dataSource.query<Array<{ code: string }>>(
        'SELECT code FROM roles',
      );

      expect(user.password_hash).not.toBe(payload.password);
      expect(user.password_hash.startsWith('$argon2id$')).toBe(true);
      expect(role.code).toBe('ADMIN');
    });

    it('returns the same result when an idempotent request is retried', async () => {
      const first = await request(app.getHttpServer())
        .post('/api/v1/auth/registrations')
        .set('Idempotency-Key', 'registration-retry-1')
        .send(payload)
        .expect(201);
      const expectedBody: unknown = first.body;

      await request(app.getHttpServer())
        .post('/api/v1/auth/registrations')
        .set('Idempotency-Key', 'registration-retry-1')
        .send(payload)
        .expect(201)
        .expect(expectedBody);

      const [{ total }] = await dataSource.query<
        Array<{ total: string | number }>
      >('SELECT COUNT(*) AS total FROM tenants');
      expect(Number(total)).toBe(1);
    });

    it('rejects duplicates without exposing which field conflicted', async () => {
      await request(app.getHttpServer())
        .post('/api/v1/auth/registrations')
        .set('Idempotency-Key', 'registration-duplicate-1')
        .send(payload)
        .expect(201);

      await request(app.getHttpServer())
        .post('/api/v1/auth/registrations')
        .set('Idempotency-Key', 'registration-duplicate-2')
        .send(payload)
        .expect(409)
        .expect(({ body }: { body: unknown }) => {
          expect(body).toEqual({
            code: 'REGISTRATION_NOT_AVAILABLE',
            message:
              'No fue posible crear la cuenta con los datos proporcionados.',
          });
        });
    });

    it('rolls back the losing transaction during a duplicate race', async () => {
      const attempts = await Promise.all([
        request(app.getHttpServer())
          .post('/api/v1/auth/registrations')
          .set('Idempotency-Key', 'registration-race-1')
          .send(payload),
        request(app.getHttpServer())
          .post('/api/v1/auth/registrations')
          .set('Idempotency-Key', 'registration-race-2')
          .send(payload),
      ]);

      expect(attempts.map(({ status }) => status).sort()).toEqual([201, 409]);

      const [counts] = await dataSource.query<
        Array<{
          tenants: string | number;
          users: string | number;
          roles: string | number;
          requests: string | number;
        }>
      >(`
        SELECT
          (SELECT COUNT(*) FROM tenants) AS tenants,
          (SELECT COUNT(*) FROM users) AS users,
          (SELECT COUNT(*) FROM roles) AS roles,
          (SELECT COUNT(*) FROM registration_requests) AS requests
      `);
      expect(
        Object.fromEntries(
          Object.entries(counts).map(([key, value]) => [key, Number(value)]),
        ),
      ).toEqual({
        tenants: 1,
        users: 1,
        roles: 1,
        requests: 1,
      });
    });

    it('rejects weak input before writing data', async () => {
      await request(app.getHttpServer())
        .post('/api/v1/auth/registrations')
        .set('Idempotency-Key', 'registration-invalid-1')
        .send({ ...payload, password: 'weak' })
        .expect(400);

      const [{ total }] = await dataSource.query<
        Array<{ total: string | number }>
      >('SELECT COUNT(*) AS total FROM tenants');
      expect(Number(total)).toBe(0);
    });
  });

  describe('session', () => {
    beforeEach(resetIdentityData);

    it('authenticates, rotates once under refresh races and revokes on logout', async () => {
      await registerAccount('session-success-registration');

      const login = await request(app.getHttpServer())
        .post('/api/v1/auth/sessions')
        .send({
          email: registrationPayload.email.toUpperCase(),
          password: registrationPayload.password,
        })
        .expect(200)
        .expect(({ body }: { body: unknown }) => {
          expect(body).toMatchObject({
            data: {
              user: {
                email: registrationPayload.email,
                roles: ['ADMIN'],
              },
              tenant: { name: registrationPayload.organizationName },
              nextStep: 'ONBOARDING',
            },
            meta: { apiVersion: '1' },
          });
          expect(body).not.toHaveProperty('data.sessionId');
          expect(body).not.toHaveProperty('data.token');
        });

      const setCookie = login.headers['set-cookie'] as unknown as string[];
      expect(setCookie).toHaveLength(1);
      expect(setCookie[0]).toContain('uinventario_session=');
      expect(setCookie[0]).toContain('HttpOnly');
      expect(setCookie[0]).toContain('SameSite=Lax');
      expect(setCookie[0]).toContain('Path=/');
      expect(setCookie[0]).toContain('Max-Age=');

      const rawToken = setCookie[0].split(';', 1)[0].split('=', 2)[1];
      const [stored] = await dataSource.query<Array<{ token_hash: string }>>(
        'SELECT token_hash FROM sessions',
      );
      expect(stored.token_hash).toHaveLength(64);
      expect(stored.token_hash).not.toBe(rawToken);

      const oldCookie = setCookie[0].split(';', 1)[0];
      const refreshAttempts = await Promise.all([
        request(app.getHttpServer())
          .post('/api/v1/auth/sessions/refresh')
          .set('Cookie', oldCookie),
        request(app.getHttpServer())
          .post('/api/v1/auth/sessions/refresh')
          .set('Cookie', oldCookie),
      ]);
      expect(refreshAttempts.map(({ status }) => status).sort()).toEqual([
        200, 401,
      ]);

      const refresh = refreshAttempts.find(({ status }) => status === 200)!;
      const refreshedCookie = (
        refresh.headers['set-cookie'] as unknown as string[]
      )[0].split(';', 1)[0];
      expect(refreshedCookie).not.toBe(oldCookie);

      const [rotated] = await dataSource.query<
        Array<{ token_hash: string; revoked_at: Date | null }>
      >('SELECT token_hash, revoked_at FROM sessions');
      expect(rotated.token_hash).not.toBe(stored.token_hash);
      expect(rotated.revoked_at).toBeNull();

      await request(app.getHttpServer())
        .get('/api/v1/auth/sessions/current')
        .set('Cookie', oldCookie)
        .expect(401);
      await request(app.getHttpServer())
        .get('/api/v1/auth/sessions/current')
        .set('Cookie', refreshedCookie)
        .expect(200);

      const logout = await request(app.getHttpServer())
        .delete('/api/v1/auth/sessions/current')
        .set('Cookie', refreshedCookie)
        .expect(204);
      const clearedCookie = logout.headers['set-cookie'] as unknown as string[];
      expect(clearedCookie[0]).toContain('uinventario_session=;');
      expect(clearedCookie[0]).toContain('Expires=Thu, 01 Jan 1970');

      await request(app.getHttpServer())
        .get('/api/v1/auth/sessions/current')
        .set('Cookie', refreshedCookie)
        .expect(401);
    });

    it('returns the same non-sensitive error for a wrong password or email', async () => {
      await registerAccount('session-invalid-registration');
      const expected = {
        code: 'INVALID_CREDENTIALS',
        message: 'Las credenciales no son válidas.',
      };

      await request(app.getHttpServer())
        .post('/api/v1/auth/sessions')
        .send({ email: registrationPayload.email, password: 'Incorrecta!' })
        .expect(401)
        .expect(expected);
      await request(app.getHttpServer())
        .post('/api/v1/auth/sessions')
        .send({ email: 'otra@example.com', password: 'Incorrecta!' })
        .expect(401)
        .expect(expected);
    });

    it('derives tenant and identity from the persisted session cookie', async () => {
      await registerAccount('session-persistence-registration');
      const login = await request(app.getHttpServer())
        .post('/api/v1/auth/sessions')
        .send({
          email: registrationPayload.email,
          password: registrationPayload.password,
        })
        .expect(200);
      const cookie = (
        login.headers['set-cookie'] as unknown as string[]
      )[0].split(';', 1)[0];

      const [{ tenant_id: tenantId }] = await dataSource.query<
        Array<{ tenant_id: string }>
      >('SELECT tenant_id FROM users WHERE normalized_email = ?', [
        registrationPayload.email,
      ]);

      await request(app.getHttpServer())
        .get('/api/v1/auth/sessions/current')
        .set('Cookie', cookie)
        .set('X-Tenant-Id', '00000000-0000-0000-0000-000000000000')
        .expect(200)
        .expect(({ body }: { body: { data: { tenant: { id: string } } } }) => {
          expect(body.data.tenant.id).toBe(tenantId);
        });

      await request(app.getHttpServer())
        .get('/api/v1/auth/sessions/current')
        .set('Cookie', cookie)
        .expect(200);
    });

    it('rejects missing and expired sessions', async () => {
      await request(app.getHttpServer())
        .get('/api/v1/auth/sessions/current')
        .expect(401)
        .expect({
          code: 'INVALID_SESSION',
          message: 'La sesión no es válida.',
        });

      await registerAccount('session-expiry-registration');
      const login = await request(app.getHttpServer())
        .post('/api/v1/auth/sessions')
        .send({
          email: registrationPayload.email,
          password: registrationPayload.password,
        })
        .expect(200);
      const cookie = (
        login.headers['set-cookie'] as unknown as string[]
      )[0].split(';', 1)[0];
      await dataSource.query('UPDATE sessions SET expires_at = ?', [
        new Date('2000-01-01T00:00:00.000Z'),
      ]);

      await request(app.getHttpServer())
        .get('/api/v1/auth/sessions/current')
        .set('Cookie', cookie)
        .expect(401);
    });
  });

  describe('company onboarding', () => {
    beforeEach(resetIdentityData);

    it('persists and resumes progress only for the session tenant', async () => {
      await registerAccount('onboarding-primary-registration');
      await request(app.getHttpServer())
        .post('/api/v1/auth/registrations')
        .set('Idempotency-Key', 'onboarding-secondary-registration')
        .send({
          organizationName: 'Empresa Ajena',
          email: 'other@example.com',
          password: registrationPayload.password,
        })
        .expect(201);

      const primaryCookie = await createPersistedSession(
        registrationPayload.email,
      );
      const [{ id: otherTenantId }] = await dataSource.query<
        Array<{ id: string }>
      >('SELECT id FROM tenants WHERE name = ?', ['Empresa Ajena']);

      await request(app.getHttpServer())
        .get('/api/v1/onboarding/company')
        .set('Cookie', primaryCookie)
        .expect(200)
        .expect(({ body }: { body: unknown }) => {
          expect(body).toMatchObject({
            data: {
              company: {
                legalName: null,
                tradeName: registrationPayload.organizationName,
                countryCode: null,
              },
              progress: { currentStep: 'COMPANY', completedSteps: [] },
            },
          });
        });

      const company = {
        legalName: 'Tienda Central, S.A. de C.V.',
        tradeName: 'Tienda Central MX',
        countryCode: 'mx',
      };
      await request(app.getHttpServer())
        .put('/api/v1/onboarding/company')
        .set('Cookie', primaryCookie)
        .set('X-Tenant-Id', otherTenantId)
        .send(company)
        .expect(200)
        .expect(({ body }: { body: unknown }) => {
          expect(body).toMatchObject({
            data: {
              company: { ...company, countryCode: 'MX' },
              progress: {
                currentStep: 'BRANCH',
                completedSteps: ['COMPANY'],
              },
            },
          });
        });

      await request(app.getHttpServer())
        .put('/api/v1/onboarding/company')
        .set('Cookie', primaryCookie)
        .send({ ...company, tradeName: 'Tienda Central Actualizada' })
        .expect(200);

      await request(app.getHttpServer())
        .get('/api/v1/onboarding/company')
        .set('Cookie', primaryCookie)
        .expect(200)
        .expect(({ body }: { body: unknown }) => {
          expect(body).toMatchObject({
            data: {
              company: { tradeName: 'Tienda Central Actualizada' },
              progress: { currentStep: 'BRANCH' },
            },
          });
        });

      const [otherTenant] = await dataSource.query<
        Array<{ legal_name: string | null; country_code: string | null }>
      >('SELECT legal_name, country_code FROM tenants WHERE id = ?', [
        otherTenantId,
      ]);
      const [{ total }] = await dataSource.query<
        Array<{ total: number | string }>
      >('SELECT COUNT(*) AS total FROM tenants');
      expect(otherTenant).toEqual({ legal_name: null, country_code: null });
      expect(Number(total)).toBe(2);

      await request(app.getHttpServer())
        .put('/api/v1/onboarding/company')
        .set('Cookie', primaryCookie)
        .send({ ...company, countryCode: 'MEX', tenantId: otherTenantId })
        .expect(400);
    });
  });

  describe('initial branch onboarding', () => {
    beforeEach(resetIdentityData);

    it('creates one consistent branch hierarchy and activates it on retries', async () => {
      await registerAccount('initial-branch-registration');
      const cookie = await createPersistedSession(registrationPayload.email);
      await request(app.getHttpServer())
        .put('/api/v1/onboarding/company')
        .set('Cookie', cookie)
        .send({
          legalName: 'Tienda Central, S.A. de C.V.',
          tradeName: 'Tienda Central',
          countryCode: 'MX',
        })
        .expect(200);

      await request(app.getHttpServer())
        .put('/api/v1/onboarding/initial-location')
        .set('Cookie', cookie)
        .send({
          branchName: 'Sucursal Principal',
          timezone: 'Zona/Inexistente',
          warehouseName: 'Bodega Principal',
          locationName: 'Ubicación General',
        })
        .expect(400);

      const payload = {
        branchName: 'Sucursal Principal',
        timezone: 'America/Mexico_City',
        warehouseName: 'Bodega Principal',
        locationName: 'Ubicación General',
      };
      const attempts = await Promise.all([
        request(app.getHttpServer())
          .put('/api/v1/onboarding/initial-location')
          .set('Cookie', cookie)
          .send(payload),
        request(app.getHttpServer())
          .put('/api/v1/onboarding/initial-location')
          .set('Cookie', cookie)
          .send(payload),
      ]);
      expect(attempts.map(({ status }) => status)).toEqual([200, 200]);
      expect(attempts[0].body).toEqual(attempts[1].body);
      expect(attempts[0].body).toMatchObject({
        data: {
          branch: { name: payload.branchName, timezone: payload.timezone },
          warehouse: { name: payload.warehouseName },
          location: { name: payload.locationName, code: 'GENERAL' },
          progress: {
            currentStep: 'REGISTER',
            completedSteps: ['COMPANY', 'BRANCH'],
          },
        },
      });

      const [counts] = await dataSource.query<
        Array<{
          branches: number | string;
          warehouses: number | string;
          locations: number | string;
        }>
      >(`SELECT (SELECT COUNT(*) FROM branches) AS branches,
                (SELECT COUNT(*) FROM warehouses) AS warehouses,
                (SELECT COUNT(*) FROM locations) AS locations`);
      expect(
        Object.fromEntries(
          Object.entries(counts).map(([key, value]) => [key, Number(value)]),
        ),
      ).toEqual({ branches: 1, warehouses: 1, locations: 1 });

      await request(app.getHttpServer())
        .get('/api/v1/auth/sessions/current')
        .set('Cookie', cookie)
        .expect(200)
        .expect(({ body }: { body: unknown }) => {
          expect(body).toMatchObject({
            data: {
              context: {
                branch: { name: payload.branchName },
                warehouse: { name: payload.warehouseName },
              },
            },
          });
        });
    });
  });

  describe('initial cash register onboarding', () => {
    beforeEach(resetIdentityData);

    it('finishes onboarding once with a tenant-scoped operational context', async () => {
      await registerAccount('initial-register-registration');
      const cookie = await createPersistedSession(registrationPayload.email);
      const existingDeviceCookie = await createPersistedSession(
        registrationPayload.email,
      );
      await request(app.getHttpServer())
        .put('/api/v1/onboarding/company')
        .set('Cookie', cookie)
        .send({
          legalName: 'Tienda Central, S.A. de C.V.',
          tradeName: 'Tienda Central',
          countryCode: 'MX',
        })
        .expect(200);

      await request(app.getHttpServer())
        .put('/api/v1/onboarding/initial-cash-register')
        .set('Cookie', cookie)
        .send({ name: 'Caja Principal' })
        .expect(409)
        .expect(({ body }: { body: { code?: string } }) => {
          expect(body.code).toBe('INITIAL_LOCATION_NOT_CONFIGURED');
        });

      await request(app.getHttpServer())
        .put('/api/v1/onboarding/initial-location')
        .set('Cookie', cookie)
        .send({
          branchName: 'Sucursal Principal',
          timezone: 'America/Mexico_City',
          warehouseName: 'Bodega Principal',
          locationName: 'UbicaciÃ³n General',
        })
        .expect(200);

      const attempts = await Promise.all([
        request(app.getHttpServer())
          .put('/api/v1/onboarding/initial-cash-register')
          .set('Cookie', cookie)
          .send({ name: 'Caja Principal' }),
        request(app.getHttpServer())
          .put('/api/v1/onboarding/initial-cash-register')
          .set('Cookie', cookie)
          .send({ name: 'Caja Principal' }),
      ]);
      expect(attempts.map(({ status }) => status)).toEqual([200, 200]);
      expect(attempts[0].body).toEqual(attempts[1].body);
      expect(attempts[0].body).toMatchObject({
        data: {
          cashRegister: { name: 'Caja Principal', code: 'MAIN' },
          branch: { name: 'Sucursal Principal' },
          progress: {
            currentStep: 'COMPLETE',
            completedSteps: ['COMPANY', 'BRANCH', 'REGISTER'],
          },
        },
      });

      const [state] = await dataSource.query<
        Array<{ cash_registers: number | string; completed: number | string }>
      >(`SELECT (SELECT COUNT(*) FROM cash_registers) AS cash_registers,
                (SELECT COUNT(*) FROM tenants WHERE onboarding_completed_at IS NOT NULL) AS completed`);
      expect(Number(state.cash_registers)).toBe(1);
      expect(Number(state.completed)).toBe(1);

      await request(app.getHttpServer())
        .get('/api/v1/auth/sessions/current')
        .set('Cookie', cookie)
        .expect(200)
        .expect(({ body }: { body: unknown }) => {
          expect(body).toMatchObject({
            data: {
              user: {
                roles: ['ADMIN'],
                permissions: [
                  'TENANT_MANAGE',
                  'PRODUCTS_MANAGE',
                  'STOCK_MANAGE',
                  'SALES_MANAGE',
                ],
              },
              context: {
                branch: { name: 'Sucursal Principal' },
                warehouse: { name: 'Bodega Principal' },
                cashRegister: { name: 'Caja Principal', code: 'MAIN' },
              },
              nextStep: 'APPLICATION',
            },
          });
        });

      await request(app.getHttpServer())
        .get('/api/v1/auth/sessions/current')
        .set('Cookie', existingDeviceCookie)
        .expect(200)
        .expect(({ body }: { body: unknown }) => {
          expect(body).toMatchObject({
            data: {
              context: {
                branch: { name: 'Sucursal Principal' },
                warehouse: { name: 'Bodega Principal' },
                cashRegister: { name: 'Caja Principal' },
              },
              nextStep: 'APPLICATION',
            },
          });
        });
    });
  });

  describe('product creation', () => {
    beforeEach(resetIdentityData);

    async function completeOnboarding(
      email: string,
      cookie: string,
    ): Promise<void> {
      await request(app.getHttpServer())
        .put('/api/v1/onboarding/company')
        .set('Cookie', cookie)
        .send({
          legalName: `${email} Legal`,
          tradeName: email,
          countryCode: 'MX',
        })
        .expect(200);
      await request(app.getHttpServer())
        .put('/api/v1/onboarding/initial-location')
        .set('Cookie', cookie)
        .send({
          branchName: 'Sucursal Principal',
          timezone: 'America/Mexico_City',
          warehouseName: 'Bodega Principal',
          locationName: 'Ubicación General',
        })
        .expect(200);
      await request(app.getHttpServer())
        .put('/api/v1/onboarding/initial-cash-register')
        .set('Cookie', cookie)
        .send({ name: 'Caja Principal' })
        .expect(200);
    }

    it('persists commercial data and scopes SKU and barcode uniqueness by tenant', async () => {
      await registerAccount('product-primary-registration');
      const primaryCookie = await createPersistedSession(
        registrationPayload.email,
      );

      await request(app.getHttpServer())
        .post('/api/v1/products')
        .set('Cookie', primaryCookie)
        .send({ name: 'Café', sku: 'CAFE-1', cost: '10.00', price: '15.00' })
        .expect(403);
      await completeOnboarding(registrationPayload.email, primaryCookie);

      const product = {
        name: 'Café molido 500 g',
        sku: 'CAFE-500',
        barcode: '7501234567890',
        categoryName: 'Abarrotes',
        brandName: 'Casa',
        cost: '85.40',
        price: '119.90',
      };
      await request(app.getHttpServer())
        .post('/api/v1/products')
        .set('Cookie', primaryCookie)
        .send({ ...product, cost: '-1' })
        .expect(400);
      await request(app.getHttpServer())
        .post('/api/v1/products')
        .set('Cookie', primaryCookie)
        .send(product)
        .expect(201)
        .expect(({ body }: { body: unknown }) => {
          expect(body).toMatchObject({
            data: {
              name: product.name,
              sku: product.sku,
              barcode: product.barcode,
              category: { name: product.categoryName },
              brand: { name: product.brandName },
              cost: product.cost,
              price: product.price,
              active: true,
            },
          });
        });

      await request(app.getHttpServer())
        .post('/api/v1/products')
        .set('Cookie', primaryCookie)
        .send({
          ...product,
          sku: product.sku.toLowerCase(),
          barcode: '7500000000001',
        })
        .expect(409)
        .expect(({ body }: { body: { code?: string } }) => {
          expect(body.code).toBe('SKU_ALREADY_EXISTS');
        });
      await request(app.getHttpServer())
        .post('/api/v1/products')
        .set('Cookie', primaryCookie)
        .send({ ...product, sku: 'OTHER-1' })
        .expect(409)
        .expect(({ body }: { body: { code?: string } }) => {
          expect(body.code).toBe('BARCODE_ALREADY_EXISTS');
        });

      const secondary = {
        organizationName: 'Otra Tienda',
        email: 'other-product@example.com',
        password: registrationPayload.password,
      };
      await request(app.getHttpServer())
        .post('/api/v1/auth/registrations')
        .set('Idempotency-Key', 'product-secondary-registration')
        .send(secondary)
        .expect(201);
      const secondaryCookie = await createPersistedSession(secondary.email);
      await completeOnboarding(secondary.email, secondaryCookie);
      await request(app.getHttpServer())
        .post('/api/v1/products')
        .set('Cookie', secondaryCookie)
        .send(product)
        .expect(201);

      const [counts] = await dataSource.query<
        Array<{
          products: number | string;
          categories: number | string;
          brands: number | string;
        }>
      >(`SELECT (SELECT COUNT(*) FROM products) AS products,
                (SELECT COUNT(*) FROM categories) AS categories,
                (SELECT COUNT(*) FROM brands) AS brands`);
      expect(Number(counts.products)).toBe(2);
      expect(Number(counts.categories)).toBe(2);
      expect(Number(counts.brands)).toBe(2);

      await request(app.getHttpServer())
        .get('/api/v1/products/options')
        .set('Cookie', primaryCookie)
        .expect(200)
        .expect(({ body }: { body: unknown }) => {
          expect(body).toMatchObject({
            data: {
              categories: [{ name: product.categoryName }],
              brands: [{ name: product.brandName }],
            },
          });
        });
    });
  });

  afterAll(async () => {
    await app.close();
  });
});
