import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, Logger } from '@nestjs/common';
import request from 'supertest';
import { App } from 'supertest/types';
import { AppModule } from './../src/app.module';
import { DataSource } from 'typeorm';
import { createHash, randomUUID } from 'node:crypto';
import { SalesRepository } from '../src/pos/sales.repository';
import { InventoryTransferRepository } from '../src/inventory/inventory-transfer.repository';
import { PosCartQuoteResponse } from '../src/pos/pos.types';
import { verify } from 'argon2';
import { configureApp } from '../src/security/configure-app';
import { RegistrationService } from '../src/auth/registration/registration.service';
import { ThrottlerStorage, ThrottlerStorageService } from '@nestjs/throttler';
import * as ExcelJS from 'exceljs';
import { AuditService } from '../src/audit/audit.service';
import { SupplierProductData } from '../src/suppliers/supplier-product.types';

describe('UInventario API (e2e)', () => {
  let app: INestApplication<App>;
  let dataSource: DataSource;

  async function bootApplication(): Promise<void> {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    configureApp(app);
    await app.init();
    dataSource = app.get(DataSource);
  }

  beforeAll(bootApplication);

  async function resetIdentityData(): Promise<void> {
    await dataSource.query('SET FOREIGN_KEY_CHECKS = 0');
    for (const table of [
      'audit_events',
      'audit_chain_heads',
      'password_reset_tokens',
      'sale_payments',
      'sale_lines',
      'sales',
      'cash_register_movements',
      'cash_register_shifts',
      'customers',
      'inventory_movements',
      'inventory_import_rows',
      'inventory_imports',
      'inventory_transfer_receipt_lines',
      'inventory_transfer_receipts',
      'inventory_transfer_lines',
      'inventory_transfers',
      'inventory_balances',
      'purchase_return_lines',
      'purchase_returns',
      'purchase_receipt_lines',
      'purchase_receipts',
      'purchase_order_transitions',
      'purchase_order_lines',
      'purchase_orders',
      'purchase_order_sequences',
      'supplier_product_prices',
      'supplier_products',
      'supplier_contacts',
      'suppliers',
      'products',
      'brands',
      'categories',
      'cash_registers',
      'locations',
      'warehouses',
      'branches',
      'sessions',
      'registration_requests',
      'user_cash_register_access',
      'user_branch_access',
      'user_roles',
      'users',
      'role_permissions',
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

  async function openCurrentCashRegister(
    cookie: string,
    idempotencyKey: string,
    openingAmount = '0.00',
  ): Promise<void> {
    await request(app.getHttpServer())
      .post('/api/v1/pos/register-shifts')
      .set('Cookie', cookie)
      .set('Idempotency-Key', idempotencyKey)
      .send({ openingAmount })
      .expect(201);
  }

  describe('health', () => {
    it('/health/live (GET)', () => {
      return request(app.getHttpServer())
        .get('/health/live')
        .expect(200)
        .expect({ status: 'ok', info: {}, error: {}, details: {} });
    });

    it('/health/ready (GET)', () => {
      return request(app.getHttpServer())
        .get('/health/ready')
        .expect(200)
        .expect({
          status: 'ok',
          info: { database: { status: 'up' } },
          error: {},
          details: { database: { status: 'up' } },
        });
    });
  });

  describe('HTTP security', () => {
    beforeEach(resetIdentityData);

    it('adds defensive headers and a validated correlation id', async () => {
      const requestId = 'security-correlation-2026';
      await request(app.getHttpServer())
        .get('/health/live')
        .set('X-Request-Id', requestId)
        .expect(200)
        .expect('X-Request-Id', requestId)
        .expect('X-Content-Type-Options', 'nosniff')
        .expect('X-Frame-Options', 'SAMEORIGIN')
        .expect('Cross-Origin-Resource-Policy', 'same-origin');

      await request(app.getHttpServer())
        .get('/health/live')
        .set('X-Request-Id', 'invalid id with spaces')
        .expect(200)
        .expect(({ headers }: { headers: Record<string, string> }) => {
          expect(headers['x-request-id']).toMatch(
            /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
          );
        });
    });

    it('rejects cross-origin mutations before credentials or data are processed', async () => {
      await request(app.getHttpServer())
        .post('/api/v1/auth/registrations')
        .set('Origin', 'https://attacker.example')
        .set('Idempotency-Key', 'security-origin-blocked')
        .send(registrationPayload)
        .expect(403)
        .expect({
          code: 'ORIGIN_NOT_ALLOWED',
          message: 'El origen de la solicitud no está autorizado.',
        });

      const [{ total }] = await dataSource.query<
        Array<{ total: number | string }>
      >('SELECT COUNT(*) AS total FROM tenants');
      expect(Number(total)).toBe(0);

      await request(app.getHttpServer())
        .post('/api/v1/auth/registrations')
        .set('Origin', 'http://localhost:4200')
        .set('Idempotency-Key', 'security-origin-allowed')
        .send(registrationPayload)
        .expect(201)
        .expect('Access-Control-Allow-Origin', 'http://localhost:4200');
    });

    it('returns and logs only sanitized metadata for unexpected errors', async () => {
      const registration = app.get(RegistrationService);
      const sensitiveValue = 'mysql://admin:secret@example/database';
      const service = jest
        .spyOn(registration, 'register')
        .mockRejectedValueOnce(new Error(sensitiveValue));
      const logger = jest
        .spyOn(Logger.prototype, 'error')
        .mockImplementation(() => undefined);

      try {
        const response = await request(app.getHttpServer())
          .post('/api/v1/auth/registrations')
          .set('Origin', 'http://localhost:4200')
          .set('Idempotency-Key', 'security-sanitized-error')
          .send(registrationPayload)
          .expect(500)
          .expect({
            statusCode: 500,
            message: 'Internal server error',
          });

        expect(JSON.stringify(response.body)).not.toContain(sensitiveValue);
        expect(JSON.stringify(logger.mock.calls)).not.toContain(sensitiveValue);
        expect(logger).toHaveBeenCalledWith(
          expect.stringContaining('unhandled_request_error'),
        );
      } finally {
        service.mockRestore();
        logger.mockRestore();
      }
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
        .expect(({ body }) => {
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
        .expect(expectedBody as object);

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

  describe('password reset', () => {
    beforeEach(resetIdentityData);

    it('does not enumerate accounts and consumes valid tokens only once', async () => {
      await registerAccount('password-reset-registration');
      const known = await request(app.getHttpServer())
        .post('/api/v1/auth/password-resets')
        .send({ email: registrationPayload.email.toUpperCase() })
        .expect(202);
      const unknown = await request(app.getHttpServer())
        .post('/api/v1/auth/password-resets')
        .send({ email: 'unknown@example.com' })
        .expect(202);
      expect(known.body).toEqual(unknown.body);

      const mailbox = await request(app.getHttpServer())
        .get('/api/v1/auth/password-resets/local-mailbox')
        .query({ email: registrationPayload.email })
        .expect(200);
      const localMessage = mailbox.body as {
        data: { token: string; resetUrl: string };
      };
      const token = localMessage.data.token;
      expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
      expect(localMessage.data.resetUrl).toContain(encodeURIComponent(token));
      const [persisted] = await dataSource.query<Array<{ token_hash: string }>>(
        'SELECT token_hash FROM password_reset_tokens LIMIT 1',
      );
      expect(persisted.token_hash).not.toBe(token);

      const nextPassword = 'Nueva-Correcta-2026!';
      await request(app.getHttpServer())
        .post('/api/v1/auth/password-resets/complete')
        .send({ token, password: nextPassword })
        .expect(200);
      await request(app.getHttpServer())
        .post('/api/v1/auth/password-resets/complete')
        .send({ token, password: nextPassword })
        .expect(400)
        .expect(({ body }: { body: { code?: string } }) => {
          expect(body.code).toBe('INVALID_PASSWORD_RESET_TOKEN');
        });
      const [changedUser] = await dataSource.query<
        Array<{ password_hash: string }>
      >('SELECT password_hash FROM users WHERE normalized_email = ? LIMIT 1', [
        registrationPayload.email,
      ]);
      await expect(
        verify(changedUser.password_hash, registrationPayload.password),
      ).resolves.toBe(false);
      await expect(
        verify(changedUser.password_hash, nextPassword),
      ).resolves.toBe(true);

      await request(app.getHttpServer())
        .post('/api/v1/auth/password-resets')
        .send({ email: registrationPayload.email })
        .expect(202);
      const expiredMailbox = await request(app.getHttpServer())
        .get('/api/v1/auth/password-resets/local-mailbox')
        .query({ email: registrationPayload.email })
        .expect(200);
      const expiredToken = (expiredMailbox.body as { data: { token: string } })
        .data.token;
      await dataSource.query(
        'UPDATE password_reset_tokens SET expires_at = ? WHERE used_at IS NULL',
        [new Date(Date.now() - 60_000)],
      );
      await request(app.getHttpServer())
        .post('/api/v1/auth/password-resets/complete')
        .send({ token: expiredToken, password: 'Otra-Correcta-2026!' })
        .expect(400)
        .expect(({ body }: { body: { code?: string } }) => {
          expect(body.code).toBe('INVALID_PASSWORD_RESET_TOKEN');
        });
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
                  'ACCESS_MANAGE',
                  'AUDIT_EXPORT',
                  'AUDIT_VIEW',
                  'CASH_REGISTER_CLOSE',
                  'CASH_REGISTER_MOVE',
                  'CASH_REGISTER_OPEN',
                  'INVENTORY_ADJUST',
                  'INVENTORY_APPROVE',
                  'INVENTORY_COUNT',
                  'INVENTORY_TRANSFER',
                  'INVENTORY_VIEW',
                  'PRODUCTS_MANAGE',
                  'PURCHASE_ORDERS_APPROVE',
                  'PURCHASE_ORDERS_MANAGE',
                  'PURCHASE_RECEIPTS_OVERAGE',
                  'SALE_REPRINT',
                  'SALES_DISCOUNT',
                  'SALES_MANAGE',
                  'SALES_VOID',
                  'SUPPLIERS_MANAGE',
                  'TENANT_MANAGE',
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

  describe('supplier management', () => {
    beforeEach(resetIdentityData);

    async function completeSupplierOnboarding(
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

    it('creates, searches, updates and deactivates tenant-scoped suppliers', async () => {
      await registerAccount('supplier-primary-registration');
      const cookie = await createPersistedSession(registrationPayload.email);
      const supplier = {
        legalName: 'Café Mayorista, S.A. de C.V.',
        tradeName: 'Café Mayorista',
        taxIdentifier: 'ABC010203AB1',
        contacts: [
          {
            name: 'Ana Compras',
            email: 'ANA.COMPRAS@PROVEEDOR.EXAMPLE',
            phone: '+52 55 1000 2000',
            role: 'Ventas',
            primary: true,
          },
        ],
      };

      await request(app.getHttpServer())
        .post('/api/v1/suppliers')
        .set('Cookie', cookie)
        .send(supplier)
        .expect(403);
      await completeSupplierOnboarding(registrationPayload.email, cookie);

      await request(app.getHttpServer())
        .post('/api/v1/suppliers')
        .set('Cookie', cookie)
        .send({ ...supplier, taxIdentifier: 'INVALID' })
        .expect(400)
        .expect(
          ({ body }: { body: { code?: string; identifierType?: string } }) => {
            expect(body.code).toBe('INVALID_SUPPLIER_TAX_IDENTIFIER');
            expect(body.identifierType).toBe('RFC');
          },
        );

      let created!: { id: string; version: number };
      await request(app.getHttpServer())
        .post('/api/v1/suppliers')
        .set('Cookie', cookie)
        .send(supplier)
        .expect(201)
        .expect(
          ({
            body,
          }: {
            body: { data: typeof created & Record<string, unknown> };
          }) => {
            created = body.data;
            expect(body.data).toMatchObject({
              legalName: supplier.legalName,
              tradeName: supplier.tradeName,
              countryCode: 'MX',
              identifierType: 'RFC',
              taxIdentifier: supplier.taxIdentifier,
              active: true,
              version: 1,
              contacts: [
                {
                  name: 'Ana Compras',
                  email: 'ana.compras@proveedor.example',
                  primary: true,
                },
              ],
            });
          },
        );

      for (const q of ['mayorista', 'ana.compras', 'ABC010203']) {
        await request(app.getHttpServer())
          .get('/api/v1/suppliers')
          .query({ q, page: 1, pageSize: 10 })
          .set('Cookie', cookie)
          .expect(200)
          .expect(
            ({
              body,
            }: {
              body: { data: Array<{ id: string }>; meta: object };
            }) => {
              expect(body.data).toEqual([
                expect.objectContaining({ id: created.id }),
              ]);
              expect(body.meta).toMatchObject({
                pagination: { page: 1, pageSize: 10, total: 1, totalPages: 1 },
              });
            },
          );
      }

      await request(app.getHttpServer())
        .post('/api/v1/suppliers')
        .set('Cookie', cookie)
        .send({
          ...supplier,
          legalName: 'Duplicado',
          taxIdentifier: 'ABC-010203-AB1',
        })
        .expect(409)
        .expect(({ body }: { body: { code?: string } }) => {
          expect(body.code).toBe('SUPPLIER_IDENTIFIER_ALREADY_EXISTS');
        });

      await request(app.getHttpServer())
        .patch(`/api/v1/suppliers/${created.id}`)
        .set('Cookie', cookie)
        .send({
          ...supplier,
          version: created.version,
          contacts: [
            ...supplier.contacts,
            { name: 'Otra persona', email: 'otra@example.com', primary: true },
          ],
        })
        .expect(400)
        .expect(({ body }: { body: { code?: string } }) => {
          expect(body.code).toBe('MULTIPLE_PRIMARY_SUPPLIER_CONTACTS');
        });

      await request(app.getHttpServer())
        .patch(`/api/v1/suppliers/${created.id}`)
        .set('Cookie', cookie)
        .send({
          ...supplier,
          legalName: 'Café Mayorista Actualizado',
          version: created.version,
          contacts: [
            { name: 'Luis Ventas', phone: '+52 55 2000 3000', primary: true },
          ],
        })
        .expect(200)
        .expect(({ body }: { body: unknown }) => {
          expect(body).toMatchObject({
            data: {
              legalName: 'Café Mayorista Actualizado',
              version: 2,
              contacts: [{ name: 'Luis Ventas', email: null, primary: true }],
            },
          });
        });

      await request(app.getHttpServer())
        .patch(`/api/v1/suppliers/${created.id}`)
        .set('Cookie', cookie)
        .send({ ...supplier, version: 1 })
        .expect(409)
        .expect(
          ({ body }: { body: { code?: string; currentVersion?: number } }) => {
            expect(body.code).toBe('SUPPLIER_VERSION_CONFLICT');
            expect(body.currentVersion).toBe(2);
          },
        );

      const secondary = {
        organizationName: 'Otra empresa',
        email: 'other-supplier@example.com',
        password: registrationPayload.password,
      };
      await request(app.getHttpServer())
        .post('/api/v1/auth/registrations')
        .set('Idempotency-Key', 'supplier-secondary-registration')
        .send(secondary)
        .expect(201);
      const secondaryCookie = await createPersistedSession(secondary.email);
      await completeSupplierOnboarding(secondary.email, secondaryCookie);
      await request(app.getHttpServer())
        .post('/api/v1/suppliers')
        .set('Cookie', secondaryCookie)
        .send(supplier)
        .expect(201);
      await request(app.getHttpServer())
        .get(`/api/v1/suppliers/${created.id}`)
        .set('Cookie', secondaryCookie)
        .expect(404);

      await request(app.getHttpServer())
        .delete(`/api/v1/suppliers/${created.id}`)
        .set('Cookie', cookie)
        .expect(200)
        .expect(({ body }: { body: unknown }) => {
          expect(body).toMatchObject({ data: { active: false, version: 3 } });
        });
      await request(app.getHttpServer())
        .get('/api/v1/suppliers')
        .set('Cookie', cookie)
        .expect(200)
        .expect(({ body }: { body: { data: unknown[] } }) => {
          expect(body.data).toHaveLength(0);
        });
      await request(app.getHttpServer())
        .get('/api/v1/suppliers')
        .query({ status: 'ALL' })
        .set('Cookie', cookie)
        .expect(200)
        .expect(({ body }: { body: unknown }) => {
          expect(body).toMatchObject({
            data: [{ id: created.id, active: false }],
          });
        });

      const [audit] = await dataSource.query<
        Array<{ event_count: number | string; pii: number | string }>
      >(
        `SELECT COUNT(*) AS event_count,
                SUM(CASE WHEN after_data LIKE '%ana.compras%' THEN 1 ELSE 0 END) AS pii
         FROM audit_events WHERE entity_type = 'SUPPLIER' AND entity_id = ?`,
        [created.id],
      );
      expect(Number(audit.event_count)).toBe(3);
      expect(Number(audit.pii)).toBe(0);

      const [admin] = await dataSource.query<
        Array<{ role_id: string; tenant_id: string }>
      >(
        `SELECT ur.role_id, u.tenant_id FROM users u
         INNER JOIN user_roles ur ON ur.user_id = u.id AND ur.tenant_id = u.tenant_id
         WHERE u.normalized_email = ? LIMIT 1`,
        [registrationPayload.email],
      );
      await dataSource.query(
        `DELETE FROM role_permissions
         WHERE role_id = ? AND tenant_id = ? AND permission = 'SUPPLIERS_MANAGE'`,
        [admin.role_id, admin.tenant_id],
      );
      await request(app.getHttpServer())
        .post('/api/v1/suppliers')
        .set('Cookie', cookie)
        .send({ legalName: 'Sin permiso', taxIdentifier: 'DEF040506CD2' })
        .expect(403)
        .expect(({ body }: { body: { code?: string } }) => {
          expect(body.code).toBe('PERMISSION_DENIED');
        });
    });

    it('keeps tenant-scoped supplier prices with immutable history without changing catalog costs', async () => {
      await registerAccount('supplier-price-primary-registration');
      const cookie = await createPersistedSession(registrationPayload.email);
      await completeSupplierOnboarding(registrationPayload.email, cookie);

      let product!: { id: string; cost: string; price: string };
      await request(app.getHttpServer())
        .post('/api/v1/products')
        .set('Cookie', cookie)
        .send({
          name: 'Cafe molido 500 g',
          sku: 'CAFE-PROV-500',
          cost: '85.40',
          price: '119.90',
        })
        .expect(201)
        .expect(({ body }: { body: { data: typeof product } }) => {
          product = body.data;
        });

      let supplier!: { id: string };
      await request(app.getHttpServer())
        .post('/api/v1/suppliers')
        .set('Cookie', cookie)
        .send({
          legalName: 'Proveedor Uno, S.A. de C.V.',
          taxIdentifier: 'ABC010203AB1',
        })
        .expect(201)
        .expect(({ body }: { body: { data: typeof supplier } }) => {
          supplier = body.data;
        });

      const initialPrice = {
        supplierId: supplier.id,
        productId: product.id,
        supplierCode: 'PROV-CAFE-500',
        currency: 'MXN',
        unitCost: '80.00',
        minimumQuantity: '12.000',
        validFrom: '2026-08-01',
      };
      await request(app.getHttpServer())
        .post('/api/v1/supplier-products')
        .set('Cookie', cookie)
        .send({ ...initialPrice, currency: 'ZZZ' })
        .expect(400);
      await request(app.getHttpServer())
        .post('/api/v1/supplier-products')
        .set('Cookie', cookie)
        .send({ ...initialPrice, validFrom: '2026-02-31' })
        .expect(400);
      await request(app.getHttpServer())
        .post('/api/v1/supplier-products')
        .set('Cookie', cookie)
        .send({ ...initialPrice, validTo: '2026-07-31' })
        .expect(400)
        .expect(({ body }: { body: { code?: string } }) => {
          expect(body.code).toBe('INVALID_SUPPLIER_PRICE_VALIDITY');
        });

      let link!: SupplierProductData;
      await request(app.getHttpServer())
        .post('/api/v1/supplier-products')
        .set('Cookie', cookie)
        .send(initialPrice)
        .expect(201)
        .expect(({ body }: { body: { data: SupplierProductData } }) => {
          link = body.data;
          expect(body.data).toMatchObject({
            supplierCode: initialPrice.supplierCode,
            minimumQuantity: initialPrice.minimumQuantity,
            version: 1,
            product: {
              id: product.id,
              catalogCost: '85.40',
              catalogPrice: '119.90',
            },
            prices: [
              {
                currency: 'MXN',
                unitCost: '80.00',
                validFrom: '2026-08-01',
                validTo: null,
              },
            ],
          });
        });

      await request(app.getHttpServer())
        .post('/api/v1/supplier-products')
        .set('Cookie', cookie)
        .send(initialPrice)
        .expect(409)
        .expect(({ body }: { body: { code?: string } }) => {
          expect(body.code).toBe('SUPPLIER_PRODUCT_ALREADY_EXISTS');
        });

      let otherProduct!: { id: string };
      await request(app.getHttpServer())
        .post('/api/v1/products')
        .set('Cookie', cookie)
        .send({
          name: 'Cafe soluble',
          sku: 'CAFE-SOLUBLE',
          cost: '70.00',
          price: '100.00',
        })
        .expect(201)
        .expect(({ body }: { body: { data: typeof otherProduct } }) => {
          otherProduct = body.data;
        });
      await request(app.getHttpServer())
        .post('/api/v1/supplier-products')
        .set('Cookie', cookie)
        .send({
          ...initialPrice,
          productId: otherProduct.id,
          supplierCode: ' prov-cafe-500 ',
        })
        .expect(409)
        .expect(({ body }: { body: { code?: string } }) => {
          expect(body.code).toBe('SUPPLIER_CODE_ALREADY_EXISTS');
        });

      await request(app.getHttpServer())
        .patch(`/api/v1/supplier-products/${link.id}`)
        .set('Cookie', cookie)
        .send({
          ...initialPrice,
          version: 1,
          currency: 'USD',
          unitCost: '78.50',
          minimumQuantity: '24.000',
          validFrom: '2026-09-01',
        })
        .expect(200)
        .expect(({ body }: { body: { data: SupplierProductData } }) => {
          expect(body.data).toMatchObject({
            version: 2,
            minimumQuantity: '24.000',
            product: { catalogCost: '85.40', catalogPrice: '119.90' },
            prices: [
              {
                currency: 'USD',
                unitCost: '78.50',
                validFrom: '2026-09-01',
                validTo: null,
              },
              {
                currency: 'MXN',
                unitCost: '80.00',
                validFrom: '2026-08-01',
                validTo: '2026-08-31',
              },
            ],
          });
        });
      await request(app.getHttpServer())
        .patch(`/api/v1/supplier-products/${link.id}`)
        .set('Cookie', cookie)
        .send({ ...initialPrice, version: 1, validFrom: '2026-10-01' })
        .expect(409)
        .expect(
          ({ body }: { body: { code?: string; currentVersion?: number } }) => {
            expect(body.code).toBe('SUPPLIER_PRODUCT_VERSION_CONFLICT');
            expect(body.currentVersion).toBe(2);
          },
        );

      await request(app.getHttpServer())
        .get('/api/v1/supplier-products')
        .query({ q: 'prov-cafe', page: 1, pageSize: 10 })
        .set('Cookie', cookie)
        .expect(200)
        .expect(
          ({
            body,
          }: {
            body: {
              data: SupplierProductData[];
              meta: { pagination: { total: number; totalPages: number } };
            };
          }) => {
            expect(body.data).toHaveLength(1);
            expect(body.data[0].prices).toHaveLength(2);
            expect(body.meta.pagination).toMatchObject({
              total: 1,
              totalPages: 1,
            });
          },
        );

      const [catalogProduct] = await dataSource.query<
        Array<{ cost: string; price: string }>
      >('SELECT cost, price FROM products WHERE id = ?', [product.id]);
      expect(catalogProduct).toMatchObject({ cost: '85.40', price: '119.90' });

      const secondary = {
        organizationName: 'Otra empresa de compras',
        email: 'other-supplier-price@example.com',
        password: registrationPayload.password,
      };
      await request(app.getHttpServer())
        .post('/api/v1/auth/registrations')
        .set('Idempotency-Key', 'supplier-price-secondary-registration')
        .send(secondary)
        .expect(201);
      const secondaryCookie = await createPersistedSession(secondary.email);
      await completeSupplierOnboarding(secondary.email, secondaryCookie);
      await request(app.getHttpServer())
        .get(`/api/v1/supplier-products/${link.id}`)
        .set('Cookie', secondaryCookie)
        .expect(404);
      await request(app.getHttpServer())
        .post('/api/v1/supplier-products')
        .set('Cookie', secondaryCookie)
        .send(initialPrice)
        .expect(400)
        .expect(({ body }: { body: { code?: string } }) => {
          expect(['INVALID_SUPPLIER', 'INVALID_PRODUCT']).toContain(body.code);
        });

      const [audit] = await dataSource.query<
        Array<{ event_count: number | string }>
      >(
        `SELECT COUNT(*) AS event_count FROM audit_events
         WHERE entity_type = 'SUPPLIER_PRODUCT' AND entity_id = ?`,
        [link.id],
      );
      expect(Number(audit.event_count)).toBe(2);
    });
  });

  describe('purchase order drafts', () => {
    beforeEach(resetIdentityData);

    async function setupProcurement(
      email: string,
      cookie: string,
      suffix: string,
    ): Promise<{
      supplierId: string;
      supplierProductId: string;
      productId: string;
      locationId: string;
    }> {
      await request(app.getHttpServer())
        .put('/api/v1/onboarding/company')
        .set('Cookie', cookie)
        .send({
          legalName: `${suffix} Legal`,
          tradeName: suffix,
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

      let supplierId = '';
      await request(app.getHttpServer())
        .post('/api/v1/suppliers')
        .set('Cookie', cookie)
        .send({
          legalName: `${suffix} Proveedor`,
          taxIdentifier: 'ABC010203AB1',
        })
        .expect(201)
        .expect(({ body }: { body: { data: { id: string } } }) => {
          supplierId = body.data.id;
        });
      let productId = '';
      await request(app.getHttpServer())
        .post('/api/v1/products')
        .set('Cookie', cookie)
        .send({
          name: `${suffix} Producto`,
          sku: `${suffix.toUpperCase()}-1`,
          cost: '85.40',
          price: '119.90',
        })
        .expect(201)
        .expect(({ body }: { body: { data: { id: string } } }) => {
          productId = body.data.id;
        });
      let supplierProductId = '';
      await request(app.getHttpServer())
        .post('/api/v1/supplier-products')
        .set('Cookie', cookie)
        .send({
          supplierId,
          productId,
          supplierCode: `${suffix.toUpperCase()}-PROV-1`,
          currency: 'MXN',
          unitCost: '80.00',
          validFrom: '2026-08-01',
        })
        .expect(201)
        .expect(({ body }: { body: { data: { id: string } } }) => {
          supplierProductId = body.data.id;
        });
      const [location] = await dataSource.query<Array<{ id: string }>>(
        `SELECT l.id FROM locations l
         INNER JOIN users u ON u.tenant_id = l.tenant_id
         WHERE u.normalized_email = ? LIMIT 1`,
        [email],
      );
      return {
        supplierId,
        supplierProductId,
        productId,
        locationId: location.id,
      };
    }

    it('calculates, edits and isolates tenant-scoped draft orders with sequential folios', async () => {
      await registerAccount('purchase-order-primary-registration');
      const cookie = await createPersistedSession(registrationPayload.email);
      const first = await setupProcurement(
        registrationPayload.email,
        cookie,
        'Principal',
      );

      let secondProductId = '';
      await request(app.getHttpServer())
        .post('/api/v1/products')
        .set('Cookie', cookie)
        .send({
          name: 'Producto Secundario',
          sku: 'SECOND-1',
          cost: '25.00',
          price: '40.00',
        })
        .expect(201)
        .expect(({ body }: { body: { data: { id: string } } }) => {
          secondProductId = body.data.id;
        });
      let secondSupplierProductId = '';
      await request(app.getHttpServer())
        .post('/api/v1/supplier-products')
        .set('Cookie', cookie)
        .send({
          supplierId: first.supplierId,
          productId: secondProductId,
          supplierCode: 'SECOND-PROV-1',
          currency: 'MXN',
          unitCost: '30.00',
          validFrom: '2026-08-01',
        })
        .expect(201)
        .expect(({ body }: { body: { data: { id: string } } }) => {
          secondSupplierProductId = body.data.id;
        });

      const input = {
        supplierId: first.supplierId,
        currency: 'MXN',
        notes: 'Entregar por la mañana',
        lines: [
          {
            supplierProductId: first.supplierProductId,
            quantity: '2.500',
            unitCost: '80.00',
            notes: 'Empaque sellado',
          },
          {
            supplierProductId: secondSupplierProductId,
            quantity: '0.333',
            unitCost: '30.00',
          },
        ],
      };
      await request(app.getHttpServer())
        .post('/api/v1/purchase-orders')
        .set('Cookie', cookie)
        .send({ ...input, currency: 'USD' })
        .expect(400)
        .expect(({ body }: { body: { code?: string } }) => {
          expect(body.code).toBe('INVALID_PURCHASE_ORDER_CURRENCY');
        });
      await request(app.getHttpServer())
        .post('/api/v1/purchase-orders')
        .set('Cookie', cookie)
        .send({ ...input, lines: [input.lines[0], input.lines[0]] })
        .expect(400)
        .expect(({ body }: { body: { code?: string } }) => {
          expect(body.code).toBe('DUPLICATE_PURCHASE_ORDER_LINE');
        });

      let order!: {
        id: string;
        folio: string;
        version: number;
      };
      await request(app.getHttpServer())
        .post('/api/v1/purchase-orders')
        .set('Cookie', cookie)
        .send(input)
        .expect(201)
        .expect(
          ({
            body,
          }: {
            body: { data: typeof order & Record<string, unknown> };
          }) => {
            order = body.data;
            expect(body.data).toMatchObject({
              folio: 'OC-000001',
              currency: 'MXN',
              status: 'DRAFT',
              subtotal: '209.99',
              total: '209.99',
              version: 1,
              lines: [
                {
                  supplierProductId: first.supplierProductId,
                  quantity: '2.500',
                  unitCost: '80.00',
                  subtotal: '200.00',
                  notes: 'Empaque sellado',
                },
                {
                  supplierProductId: secondSupplierProductId,
                  quantity: '0.333',
                  unitCost: '30.00',
                  subtotal: '9.99',
                },
              ],
            });
          },
        );

      const update = {
        ...input,
        version: 1,
        notes: 'Entrega actualizada',
        lines: [
          {
            supplierProductId: first.supplierProductId,
            quantity: '3.000',
            unitCost: '79.99',
          },
        ],
      };
      await request(app.getHttpServer())
        .patch(`/api/v1/purchase-orders/${order.id}`)
        .set('Cookie', cookie)
        .send(update)
        .expect(200)
        .expect(({ body }: { body: unknown }) => {
          expect(body).toMatchObject({
            data: {
              folio: 'OC-000001',
              subtotal: '239.97',
              total: '239.97',
              version: 2,
              lines: [
                { quantity: '3.000', unitCost: '79.99', subtotal: '239.97' },
              ],
            },
          });
        });
      await request(app.getHttpServer())
        .patch(`/api/v1/purchase-orders/${order.id}`)
        .set('Cookie', cookie)
        .send(update)
        .expect(409)
        .expect(
          ({ body }: { body: { code?: string; currentVersion?: number } }) => {
            expect(body.code).toBe('PURCHASE_ORDER_VERSION_CONFLICT');
            expect(body.currentVersion).toBe(2);
          },
        );

      await request(app.getHttpServer())
        .get('/api/v1/purchase-orders')
        .query({ q: 'OC-000001', page: 1, pageSize: 10 })
        .set('Cookie', cookie)
        .expect(200)
        .expect(({ body }: { body: unknown }) => {
          expect(body).toMatchObject({
            data: [{ id: order.id, folio: 'OC-000001', total: '239.97' }],
            meta: { pagination: { total: 1, totalPages: 1 } },
          });
        });

      const secondary = {
        organizationName: 'Otra empresa de compras',
        email: 'other-purchase-order@example.com',
        password: registrationPayload.password,
      };
      await request(app.getHttpServer())
        .post('/api/v1/auth/registrations')
        .set('Idempotency-Key', 'purchase-order-secondary-registration')
        .send(secondary)
        .expect(201);
      const secondaryCookie = await createPersistedSession(secondary.email);
      const secondarySetup = await setupProcurement(
        secondary.email,
        secondaryCookie,
        'Secundaria',
      );
      await request(app.getHttpServer())
        .post('/api/v1/purchase-orders')
        .set('Cookie', secondaryCookie)
        .send({
          supplierId: secondarySetup.supplierId,
          currency: 'MXN',
          lines: [
            {
              supplierProductId: secondarySetup.supplierProductId,
              quantity: '1.000',
              unitCost: '80.00',
            },
          ],
        })
        .expect(201)
        .expect(({ body }: { body: unknown }) => {
          expect(body).toMatchObject({ data: { folio: 'OC-000001' } });
        });
      await request(app.getHttpServer())
        .get(`/api/v1/purchase-orders/${order.id}`)
        .set('Cookie', secondaryCookie)
        .expect(404);

      await dataSource.query(
        "UPDATE purchase_orders SET status = 'APPROVED' WHERE id = ?",
        [order.id],
      );
      await request(app.getHttpServer())
        .patch(`/api/v1/purchase-orders/${order.id}`)
        .set('Cookie', cookie)
        .send({ ...update, version: 2 })
        .expect(409)
        .expect(
          ({ body }: { body: { code?: string; currentStatus?: string } }) => {
            expect(body.code).toBe('PURCHASE_ORDER_STATE_CONFLICT');
            expect(body.currentStatus).toBe('APPROVED');
          },
        );

      const [audit] = await dataSource.query<Array<{ total: number | string }>>(
        `SELECT COUNT(*) AS total FROM audit_events
         WHERE entity_type = 'PURCHASE_ORDER' AND entity_id = ?`,
        [order.id],
      );
      expect(Number(audit.total)).toBe(2);

      const [admin] = await dataSource.query<
        Array<{ role_id: string; tenant_id: string }>
      >(
        `SELECT ur.role_id, u.tenant_id FROM users u
         INNER JOIN user_roles ur ON ur.user_id = u.id AND ur.tenant_id = u.tenant_id
         WHERE u.normalized_email = ? LIMIT 1`,
        [registrationPayload.email],
      );
      await dataSource.query(
        `DELETE FROM role_permissions
         WHERE role_id = ? AND tenant_id = ? AND permission = 'SUPPLIERS_MANAGE'`,
        [admin.role_id, admin.tenant_id],
      );
      await request(app.getHttpServer())
        .get('/api/v1/suppliers')
        .set('Cookie', cookie)
        .expect(200);
      await request(app.getHttpServer())
        .get('/api/v1/supplier-products')
        .set('Cookie', cookie)
        .expect(200);
      await request(app.getHttpServer())
        .post('/api/v1/suppliers')
        .set('Cookie', cookie)
        .send({
          legalName: 'Proveedor bloqueado',
          taxIdentifier: 'DEF040506CD2',
        })
        .expect(403);
      await dataSource.query(
        `DELETE FROM role_permissions
         WHERE role_id = ? AND tenant_id = ? AND permission = 'PURCHASE_ORDERS_MANAGE'`,
        [admin.role_id, admin.tenant_id],
      );
      await dataSource.query(
        `DELETE FROM role_permissions
         WHERE role_id = ? AND tenant_id = ? AND permission = 'PURCHASE_ORDERS_APPROVE'`,
        [admin.role_id, admin.tenant_id],
      );
      await request(app.getHttpServer())
        .get('/api/v1/purchase-orders')
        .set('Cookie', cookie)
        .expect(403)
        .expect(({ body }: { body: { code?: string } }) => {
          expect(body.code).toBe('PERMISSION_DENIED');
        });
    });

    it('enforces and idempotently records approve, send and cancel transitions', async () => {
      await registerAccount('purchase-order-lifecycle-registration');
      const cookie = await createPersistedSession(registrationPayload.email);
      const setup = await setupProcurement(
        registrationPayload.email,
        cookie,
        'Lifecycle',
      );
      let order!: { id: string; version: number };
      await request(app.getHttpServer())
        .post('/api/v1/purchase-orders')
        .set('Cookie', cookie)
        .send({
          supplierId: setup.supplierId,
          currency: 'MXN',
          lines: [
            {
              supplierProductId: setup.supplierProductId,
              quantity: '1.000',
              unitCost: '80.00',
            },
          ],
        })
        .expect(201)
        .expect(({ body }: { body: { data: typeof order } }) => {
          order = body.data;
        });

      const [admin] = await dataSource.query<
        Array<{ role_id: string; tenant_id: string }>
      >(
        `SELECT ur.role_id, u.tenant_id FROM users u
         INNER JOIN user_roles ur ON ur.user_id = u.id AND ur.tenant_id = u.tenant_id
         WHERE u.normalized_email = ? LIMIT 1`,
        [registrationPayload.email],
      );
      await dataSource.query(
        `DELETE FROM role_permissions
         WHERE role_id = ? AND tenant_id = ? AND permission = 'PURCHASE_ORDERS_APPROVE'`,
        [admin.role_id, admin.tenant_id],
      );
      await request(app.getHttpServer())
        .post(`/api/v1/purchase-orders/${order.id}/approve`)
        .set('Cookie', cookie)
        .set('Idempotency-Key', 'po-approve-denied')
        .send({ version: 1 })
        .expect(403);
      await dataSource.query(
        `INSERT INTO role_permissions (role_id, tenant_id, permission)
         VALUES (?, ?, 'PURCHASE_ORDERS_APPROVE')`,
        [admin.role_id, admin.tenant_id],
      );

      await request(app.getHttpServer())
        .post(`/api/v1/purchase-orders/${order.id}/approve`)
        .set('Cookie', cookie)
        .send({ version: 1 })
        .expect(400)
        .expect(({ body }: { body: { code?: string } }) => {
          expect(body.code).toBe('INVALID_IDEMPOTENCY_KEY');
        });

      const approveKey = 'po-approve-lifecycle-1';
      await request(app.getHttpServer())
        .post(`/api/v1/purchase-orders/${order.id}/approve`)
        .set('Cookie', cookie)
        .set('Idempotency-Key', approveKey)
        .send({ version: 1, reason: 'Presupuesto confirmado' })
        .expect(200)
        .expect(({ body }: { body: { data: { approvedAt: unknown } } }) => {
          expect(typeof body.data.approvedAt).toBe('string');
          expect(body).toMatchObject({
            data: {
              status: 'APPROVED',
              version: 2,
              transitions: [
                {
                  fromStatus: 'DRAFT',
                  toStatus: 'APPROVED',
                  reason: 'Presupuesto confirmado',
                },
              ],
            },
            meta: { idempotentReplay: false },
          });
        });
      await request(app.getHttpServer())
        .post(`/api/v1/purchase-orders/${order.id}/approve`)
        .set('Cookie', cookie)
        .set('Idempotency-Key', approveKey)
        .send({ version: 1, reason: 'Presupuesto confirmado' })
        .expect(200)
        .expect(({ body }: { body: unknown }) => {
          expect(body).toMatchObject({
            data: { status: 'APPROVED', version: 2 },
            meta: { idempotentReplay: true },
          });
        });
      await request(app.getHttpServer())
        .post(`/api/v1/purchase-orders/${order.id}/send`)
        .set('Cookie', cookie)
        .set('Idempotency-Key', approveKey)
        .send({ version: 2 })
        .expect(409)
        .expect(({ body }: { body: { code?: string } }) => {
          expect(body.code).toBe('IDEMPOTENCY_KEY_REUSED');
        });

      await request(app.getHttpServer())
        .post(`/api/v1/purchase-orders/${order.id}/send`)
        .set('Cookie', cookie)
        .set('Idempotency-Key', 'po-send-lifecycle-1')
        .send({ version: 2 })
        .expect(200)
        .expect(({ body }: { body: { data: { sentAt: unknown } } }) => {
          expect(typeof body.data.sentAt).toBe('string');
          expect(body).toMatchObject({
            data: {
              status: 'SENT',
              version: 3,
              transitions: [
                { toStatus: 'APPROVED' },
                {
                  fromStatus: 'APPROVED',
                  toStatus: 'SENT',
                  delivery: { mode: 'SIMULATED', recipient: null },
                },
              ],
            },
          });
        });
      await request(app.getHttpServer())
        .post(`/api/v1/purchase-orders/${order.id}/send`)
        .set('Cookie', cookie)
        .set('Idempotency-Key', 'po-send-invalid-state')
        .send({ version: 3 })
        .expect(409)
        .expect(
          ({ body }: { body: { code?: string; currentStatus?: string } }) => {
            expect(body.code).toBe('PURCHASE_ORDER_STATE_CONFLICT');
            expect(body.currentStatus).toBe('SENT');
          },
        );

      await request(app.getHttpServer())
        .post(`/api/v1/purchase-orders/${order.id}/cancel`)
        .set('Cookie', cookie)
        .set('Idempotency-Key', 'po-cancel-no-reason')
        .send({ version: 3 })
        .expect(400);
      const cancelKey = 'po-cancel-lifecycle-1';
      const cancellation = {
        version: 3,
        reason: 'Proveedor sin disponibilidad',
      };
      await request(app.getHttpServer())
        .post(`/api/v1/purchase-orders/${order.id}/cancel`)
        .set('Cookie', cookie)
        .set('Idempotency-Key', cancelKey)
        .send(cancellation)
        .expect(200)
        .expect(({ body }: { body: { data: { cancelledAt: unknown } } }) => {
          expect(typeof body.data.cancelledAt).toBe('string');
          expect(body).toMatchObject({
            data: {
              status: 'CANCELLED',
              version: 4,
              cancellationReason: cancellation.reason,
            },
            meta: { idempotentReplay: false },
          });
        });
      await request(app.getHttpServer())
        .post(`/api/v1/purchase-orders/${order.id}/cancel`)
        .set('Cookie', cookie)
        .set('Idempotency-Key', cancelKey)
        .send(cancellation)
        .expect(200)
        .expect(({ body }: { body: unknown }) => {
          expect(body).toMatchObject({ meta: { idempotentReplay: true } });
        });

      const [counts] = await dataSource.query<
        Array<{ transitions: number | string; audits: number | string }>
      >(
        `SELECT
           (SELECT COUNT(*) FROM purchase_order_transitions
            WHERE purchase_order_id = ?) AS transitions,
           (SELECT COUNT(*) FROM audit_events
            WHERE entity_id = ? AND action IN (
              'PURCHASE_ORDER_APPROVED', 'PURCHASE_ORDER_SENT', 'PURCHASE_ORDER_CANCELLED'
            )) AS audits`,
        [order.id, order.id],
      );
      expect(Number(counts.transitions)).toBe(3);
      expect(Number(counts.audits)).toBe(3);

      await dataSource.query(
        `DELETE FROM role_permissions
         WHERE role_id = ? AND tenant_id = ? AND permission = 'PURCHASE_ORDERS_MANAGE'`,
        [admin.role_id, admin.tenant_id],
      );
      await request(app.getHttpServer())
        .get('/api/v1/purchase-orders')
        .set('Cookie', cookie)
        .expect(200);
      await request(app.getHttpServer())
        .patch(`/api/v1/purchase-orders/${order.id}`)
        .set('Cookie', cookie)
        .send({
          supplierId: setup.supplierId,
          currency: 'MXN',
          version: 4,
          lines: [
            {
              supplierProductId: setup.supplierProductId,
              quantity: '1.000',
              unitCost: '80.00',
            },
          ],
        })
        .expect(403);
    });

    it('records partial, complete and authorized overage receipts idempotently', async () => {
      await registerAccount('purchase-receipt-registration');
      const cookie = await createPersistedSession(registrationPayload.email);
      const setup = await setupProcurement(
        registrationPayload.email,
        cookie,
        'Receipts',
      );
      let order!: {
        id: string;
        version: number;
        lines: Array<{ id: string; productId: string }>;
      };
      await request(app.getHttpServer())
        .post('/api/v1/purchase-orders')
        .set('Cookie', cookie)
        .send({
          supplierId: setup.supplierId,
          currency: 'MXN',
          lines: [
            {
              supplierProductId: setup.supplierProductId,
              quantity: '5.000',
              unitCost: '80.00',
            },
          ],
        })
        .expect(201)
        .expect(({ body }: { body: { data: typeof order } }) => {
          order = body.data;
        });
      await request(app.getHttpServer())
        .post('/api/v1/inventory/movements')
        .set('Cookie', cookie)
        .set('Idempotency-Key', 'po-receipt-history-initial-stock')
        .send({
          productId: order.lines[0].productId,
          locationId: setup.locationId,
          type: 'INITIAL',
          quantity: '1.000',
          reason: 'Stock previo para validar costo histórico',
        })
        .expect(201);
      await openCurrentCashRegister(cookie, 'po-receipt-history-shift');
      await request(app.getHttpServer())
        .post('/api/v1/pos/sales/cash')
        .set('Cookie', cookie)
        .set('Idempotency-Key', 'po-receipt-history-sale')
        .send({
          lines: [{ productId: order.lines[0].productId, quantity: '1.000' }],
          cashReceived: '120.00',
        })
        .expect(201);
      await request(app.getHttpServer())
        .post(`/api/v1/purchase-orders/${order.id}/approve`)
        .set('Cookie', cookie)
        .set('Idempotency-Key', 'po-receipt-approve-1')
        .send({ version: 1 })
        .expect(200);

      const [admin] = await dataSource.query<
        Array<{ role_id: string; tenant_id: string }>
      >(
        `SELECT ur.role_id, u.tenant_id FROM users u
         INNER JOIN user_roles ur ON ur.user_id = u.id AND ur.tenant_id = u.tenant_id
         WHERE u.normalized_email = ? LIMIT 1`,
        [registrationPayload.email],
      );
      await dataSource.query(
        `DELETE FROM role_permissions
         WHERE role_id = ? AND tenant_id = ?
           AND permission = 'PURCHASE_RECEIPTS_OVERAGE'`,
        [admin.role_id, admin.tenant_id],
      );

      const partial = {
        version: 2,
        locationId: setup.locationId,
        documentReference: 'REM-100-PARCIAL',
        lines: [
          {
            purchaseOrderLineId: order.lines[0].id,
            receivedQuantity: '2.000',
          },
        ],
      };
      const partialKey = 'po-receipt-partial-1';
      await request(app.getHttpServer())
        .post(`/api/v1/purchase-orders/${order.id}/receipts`)
        .set('Cookie', cookie)
        .set('Idempotency-Key', partialKey)
        .send(partial)
        .expect(201)
        .expect(({ body }: { body: unknown }) => {
          expect(body).toMatchObject({
            data: {
              status: 'PARTIALLY_RECEIVED',
              version: 3,
              lines: [
                {
                  receivedQuantity: '2.000',
                  remainingQuantity: '3.000',
                  overageQuantity: '0.000',
                },
              ],
              receipts: [
                {
                  documentReference: partial.documentReference,
                  location: { id: setup.locationId },
                  responsible: { email: registrationPayload.email },
                  lines: [
                    {
                      purchaseOrderLineId: order.lines[0].id,
                      receivedQuantity: '2.000',
                      overageQuantity: '0.000',
                      unitCost: '80.00',
                      totalCost: '160.00',
                      previousCatalogCost: '85.40',
                      resultingCatalogCost: '80.00',
                    },
                  ],
                },
              ],
            },
            meta: { idempotentReplay: false },
          });
        });
      await request(app.getHttpServer())
        .post(`/api/v1/purchase-orders/${order.id}/receipts`)
        .set('Cookie', cookie)
        .set('Idempotency-Key', partialKey)
        .send(partial)
        .expect(201)
        .expect(({ body }: { body: unknown }) => {
          expect(body).toMatchObject({
            data: { version: 3 },
            meta: { idempotentReplay: true },
          });
        });
      await request(app.getHttpServer())
        .post(`/api/v1/purchase-orders/${order.id}/receipts`)
        .set('Cookie', cookie)
        .set('Idempotency-Key', partialKey)
        .send({ ...partial, documentReference: 'REM-ALTERADA' })
        .expect(409)
        .expect(({ body }: { body: { code?: string } }) => {
          expect(body.code).toBe('IDEMPOTENCY_KEY_REUSED');
        });

      const excess = {
        version: 3,
        locationId: setup.locationId,
        documentReference: 'REM-100-EXCESO',
        lines: [
          {
            purchaseOrderLineId: order.lines[0].id,
            receivedQuantity: '4.000',
          },
        ],
      };
      await request(app.getHttpServer())
        .post(`/api/v1/purchase-orders/${order.id}/receipts`)
        .set('Cookie', cookie)
        .set('Idempotency-Key', 'po-receipt-overage-denied')
        .send({
          ...excess,
          overageReason: 'El proveedor envió una unidad adicional',
        })
        .expect(403)
        .expect(({ body }: { body: { code?: string } }) => {
          expect(body.code).toBe(
            'PURCHASE_RECEIPT_OVERAGE_PERMISSION_REQUIRED',
          );
        });
      await dataSource.query(
        `INSERT INTO role_permissions (role_id, tenant_id, permission)
         VALUES (?, ?, 'PURCHASE_RECEIPTS_OVERAGE')`,
        [admin.role_id, admin.tenant_id],
      );
      await request(app.getHttpServer())
        .post(`/api/v1/purchase-orders/${order.id}/receipts`)
        .set('Cookie', cookie)
        .set('Idempotency-Key', 'po-receipt-overage-no-reason')
        .send(excess)
        .expect(400)
        .expect(({ body }: { body: { code?: string } }) => {
          expect(body.code).toBe('PURCHASE_RECEIPT_OVERAGE_REASON_REQUIRED');
        });

      await request(app.getHttpServer())
        .post(`/api/v1/purchase-orders/${order.id}/receipts`)
        .set('Cookie', cookie)
        .set('Idempotency-Key', 'po-receipt-complete-1')
        .send({
          ...partial,
          version: 3,
          documentReference: 'REM-100-COMPLETA',
          lines: [{ ...partial.lines[0], receivedQuantity: '3.000' }],
        })
        .expect(201)
        .expect(({ body }: { body: unknown }) => {
          expect(body).toMatchObject({
            data: {
              status: 'RECEIVED',
              version: 4,
              lines: [
                {
                  receivedQuantity: '5.000',
                  remainingQuantity: '0.000',
                  overageQuantity: '0.000',
                },
              ],
            },
          });
        });

      await request(app.getHttpServer())
        .post(`/api/v1/purchase-orders/${order.id}/receipts`)
        .set('Cookie', cookie)
        .set('Idempotency-Key', 'po-receipt-overage-allowed')
        .send({
          ...excess,
          version: 4,
          overageReason: 'El proveedor envió una unidad adicional',
          lines: [{ ...excess.lines[0], receivedQuantity: '1.000' }],
        })
        .expect(201)
        .expect(({ body }: { body: unknown }) => {
          expect(body).toMatchObject({
            data: {
              status: 'RECEIVED',
              version: 5,
              lines: [
                {
                  receivedQuantity: '6.000',
                  remainingQuantity: '0.000',
                  overageQuantity: '1.000',
                },
              ],
            },
          });
        });

      const [counts] = await dataSource.query<
        Array<{
          receipts: number | string;
          receiptLines: number | string;
          purchaseMovements: number | string;
          balance: string;
          productCost: string;
          historicalSaleCost: string;
          receivedCost: string;
          audits: number | string;
        }>
      >(
        `SELECT
           (SELECT COUNT(*) FROM purchase_receipts WHERE purchase_order_id = ?) AS receipts,
           (SELECT COUNT(*) FROM purchase_receipt_lines prl
            INNER JOIN purchase_receipts pr ON pr.id = prl.receipt_id
            WHERE pr.purchase_order_id = ?) AS receiptLines,
           (SELECT COUNT(*) FROM inventory_movements
            WHERE purchase_receipt_id IN (
              SELECT id FROM purchase_receipts WHERE purchase_order_id = ?
            )) AS purchaseMovements,
           (SELECT quantity FROM inventory_balances
            WHERE product_id = ? AND location_id = ?) AS balance,
           (SELECT cost FROM products WHERE id = ?) AS productCost,
           (SELECT unit_cost FROM sale_lines
            WHERE product_id = ? LIMIT 1) AS historicalSaleCost,
           (SELECT SUM(prl.total_cost) FROM purchase_receipt_lines prl
            INNER JOIN purchase_receipts pr ON pr.id = prl.receipt_id
            WHERE pr.purchase_order_id = ?) AS receivedCost,
           (SELECT COUNT(*) FROM audit_events
            WHERE entity_id = ? AND action = 'PURCHASE_ORDER_RECEIVED') AS audits`,
        [
          order.id,
          order.id,
          order.id,
          order.lines[0].productId,
          setup.locationId,
          order.lines[0].productId,
          order.lines[0].productId,
          order.id,
          order.id,
        ],
      );
      expect(Number(counts.receipts)).toBe(3);
      expect(Number(counts.receiptLines)).toBe(3);
      expect(Number(counts.purchaseMovements)).toBe(3);
      expect(counts.balance).toBe('6.000');
      expect(counts.productCost).toBe('80.00');
      expect(counts.historicalSaleCost).toBe('85.40');
      expect(counts.receivedCost).toBe('480.00');
      expect(Number(counts.audits)).toBe(3);

      await request(app.getHttpServer())
        .get('/api/v1/inventory/movements')
        .query({ type: 'PURCHASE_RECEIPT', document: 'REM-100', pageSize: 10 })
        .set('Cookie', cookie)
        .expect(200)
        .expect(({ body }: { body: { data: unknown[]; meta: unknown } }) => {
          expect(body.data).toHaveLength(3);
          expect(body.data[0]).toMatchObject({
            type: 'PURCHASE_RECEIPT',
            direction: 'IN',
            product: { id: order.lines[0].productId },
            location: { id: setup.locationId },
            document: { type: 'PURCHASE_RECEIPT' },
          });
          expect(body.meta).toMatchObject({ pagination: { total: 3 } });
        });
    });

    it('rolls back receipt, stock, cost and order state when movement persistence fails', async () => {
      await registerAccount('purchase-receipt-rollback-registration');
      const cookie = await createPersistedSession(registrationPayload.email);
      const setup = await setupProcurement(
        registrationPayload.email,
        cookie,
        'ReceiptRollback',
      );
      let order!: {
        id: string;
        lines: Array<{ id: string; productId: string }>;
      };
      await request(app.getHttpServer())
        .post('/api/v1/purchase-orders')
        .set('Cookie', cookie)
        .send({
          supplierId: setup.supplierId,
          currency: 'MXN',
          lines: [
            {
              supplierProductId: setup.supplierProductId,
              quantity: '1.000',
              unitCost: '80.00',
            },
          ],
        })
        .expect(201)
        .expect(({ body }: { body: { data: typeof order } }) => {
          order = body.data;
        });
      await request(app.getHttpServer())
        .post(`/api/v1/purchase-orders/${order.id}/approve`)
        .set('Cookie', cookie)
        .set('Idempotency-Key', 'po-receipt-rollback-approve')
        .send({ version: 1 })
        .expect(200);

      await dataSource.query(`
        ALTER TABLE inventory_movements
        ADD CONSTRAINT ck_test_reject_purchase_receipt
        CHECK (type <> 'PURCHASE_RECEIPT')
      `);
      try {
        await request(app.getHttpServer())
          .post(`/api/v1/purchase-orders/${order.id}/receipts`)
          .set('Cookie', cookie)
          .set('Idempotency-Key', 'po-receipt-forced-rollback')
          .send({
            version: 2,
            locationId: setup.locationId,
            documentReference: 'REM-ROLLBACK',
            lines: [
              {
                purchaseOrderLineId: order.lines[0].id,
                receivedQuantity: '1.000',
              },
            ],
          })
          .expect(500);
      } finally {
        await dataSource.query(`
          ALTER TABLE inventory_movements
          DROP CHECK ck_test_reject_purchase_receipt
        `);
      }

      const [state] = await dataSource.query<
        Array<{
          status: string;
          version: number | string;
          receivedQuantity: string;
          receipts: number | string;
          movements: number | string;
          balances: number | string;
          productCost: string;
        }>
      >(
        `SELECT po.status, po.version, pol.received_quantity AS receivedQuantity,
           (SELECT COUNT(*) FROM purchase_receipts WHERE purchase_order_id = po.id) AS receipts,
           (SELECT COUNT(*) FROM inventory_movements
            WHERE purchase_receipt_id IS NOT NULL) AS movements,
           (SELECT COUNT(*) FROM inventory_balances
            WHERE product_id = pol.product_id AND location_id = ?) AS balances,
           (SELECT cost FROM products WHERE id = pol.product_id) AS productCost
         FROM purchase_orders po
         INNER JOIN purchase_order_lines pol ON pol.purchase_order_id = po.id
         WHERE po.id = ?`,
        [setup.locationId, order.id],
      );
      expect({
        status: state.status,
        version: Number(state.version),
        receivedQuantity: state.receivedQuantity,
        receipts: Number(state.receipts),
        movements: Number(state.movements),
        balances: Number(state.balances),
        productCost: state.productCost,
      }).toEqual({
        status: 'APPROVED',
        version: 2,
        receivedQuantity: '0.000',
        receipts: 0,
        movements: 0,
        balances: 0,
        productCost: '85.40',
      });
    });

    it('returns received products atomically with accumulated limits, permissions and traceability', async () => {
      await registerAccount('purchase-return-registration');
      const cookie = await createPersistedSession(registrationPayload.email);
      const setup = await setupProcurement(
        registrationPayload.email,
        cookie,
        'SupplierReturn',
      );
      let order!: {
        id: string;
        lines: Array<{ id: string; productId: string }>;
      };
      await request(app.getHttpServer())
        .post('/api/v1/purchase-orders')
        .set('Cookie', cookie)
        .send({
          supplierId: setup.supplierId,
          currency: 'MXN',
          lines: [
            {
              supplierProductId: setup.supplierProductId,
              quantity: '5.000',
              unitCost: '80.00',
            },
          ],
        })
        .expect(201)
        .expect(({ body }: { body: { data: typeof order } }) => {
          order = body.data;
        });
      await request(app.getHttpServer())
        .post(`/api/v1/purchase-orders/${order.id}/approve`)
        .set('Cookie', cookie)
        .set('Idempotency-Key', 'supplier-return-approve')
        .send({ version: 1 })
        .expect(200);

      let receipt!: { id: string; lines: Array<{ id: string }> };
      await request(app.getHttpServer())
        .post(`/api/v1/purchase-orders/${order.id}/receipts`)
        .set('Cookie', cookie)
        .set('Idempotency-Key', 'supplier-return-receipt')
        .send({
          version: 2,
          locationId: setup.locationId,
          documentReference: 'REM-DEV-100',
          lines: [
            {
              purchaseOrderLineId: order.lines[0].id,
              receivedQuantity: '5.000',
            },
          ],
        })
        .expect(201)
        .expect(
          ({
            body,
          }: {
            body: { data: { receipts: Array<typeof receipt> } };
          }) => {
            receipt = body.data.receipts[0];
          },
        );

      const [admin] = await dataSource.query<
        Array<{ role_id: string; tenant_id: string }>
      >(
        `SELECT ur.role_id, u.tenant_id FROM users u
         INNER JOIN user_roles ur ON ur.user_id = u.id AND ur.tenant_id = u.tenant_id
         WHERE u.normalized_email = ? LIMIT 1`,
        [registrationPayload.email],
      );
      await dataSource.query(
        `DELETE FROM role_permissions
         WHERE role_id = ? AND tenant_id = ? AND permission = 'PURCHASE_ORDERS_MANAGE'`,
        [admin.role_id, admin.tenant_id],
      );
      const partialReturn = {
        purchaseReceiptId: receipt.id,
        documentReference: 'DEV-PROV-100',
        reason: 'Empaque dañado por proveedor',
        lines: [
          {
            purchaseReceiptLineId: receipt.lines[0].id,
            returnedQuantity: '2.000',
          },
        ],
      };
      await request(app.getHttpServer())
        .post(`/api/v1/purchase-orders/${order.id}/returns`)
        .set('Cookie', cookie)
        .set('Idempotency-Key', 'supplier-return-forbidden')
        .send(partialReturn)
        .expect(403);
      await dataSource.query(
        `INSERT INTO role_permissions (role_id, tenant_id, permission)
         VALUES (?, ?, 'PURCHASE_ORDERS_MANAGE')`,
        [admin.role_id, admin.tenant_id],
      );

      const partialKey = 'supplier-return-partial';
      await request(app.getHttpServer())
        .post(`/api/v1/purchase-orders/${order.id}/returns`)
        .set('Cookie', cookie)
        .set('Idempotency-Key', partialKey)
        .send(partialReturn)
        .expect(201)
        .expect(({ body }: { body: unknown }) => {
          expect(body).toMatchObject({
            data: {
              returns: [
                {
                  purchaseReceiptId: receipt.id,
                  documentReference: partialReturn.documentReference,
                  reason: partialReturn.reason,
                  status: 'CREDIT_PENDING',
                  expectedCreditTotal: '160.00',
                  creditDocumentReference: null,
                  location: { id: setup.locationId },
                  lines: [
                    {
                      purchaseReceiptLineId: receipt.lines[0].id,
                      productId: setup.productId,
                      returnedQuantity: '2.000',
                      unitCost: '80.00',
                      totalCost: '160.00',
                    },
                  ],
                },
              ],
              receipts: [
                {
                  lines: [
                    { returnedQuantity: '2.000', returnableQuantity: '3.000' },
                  ],
                },
              ],
            },
            meta: { idempotentReplay: false },
          });
        });
      await request(app.getHttpServer())
        .post(`/api/v1/purchase-orders/${order.id}/returns`)
        .set('Cookie', cookie)
        .set('Idempotency-Key', partialKey)
        .send(partialReturn)
        .expect(201)
        .expect(({ body }: { body: unknown }) => {
          expect(body).toMatchObject({ meta: { idempotentReplay: true } });
        });
      await request(app.getHttpServer())
        .post(`/api/v1/purchase-orders/${order.id}/returns`)
        .set('Cookie', cookie)
        .set('Idempotency-Key', partialKey)
        .send({ ...partialReturn, reason: 'Otra causa' })
        .expect(409)
        .expect(({ body }: { body: { code?: string } }) => {
          expect(body.code).toBe('IDEMPOTENCY_KEY_REUSED');
        });

      await request(app.getHttpServer())
        .post(`/api/v1/purchase-orders/${order.id}/returns`)
        .set('Cookie', cookie)
        .set('Idempotency-Key', 'supplier-return-complete')
        .send({
          ...partialReturn,
          documentReference: 'DEV-PROV-101',
          lines: [
            {
              purchaseReceiptLineId: receipt.lines[0].id,
              returnedQuantity: '3.000',
            },
          ],
        })
        .expect(201)
        .expect(({ body }: { body: unknown }) => {
          expect(body).toMatchObject({
            data: {
              receipts: [
                {
                  lines: [
                    { returnedQuantity: '5.000', returnableQuantity: '0.000' },
                  ],
                },
              ],
            },
          });
        });
      await request(app.getHttpServer())
        .post(`/api/v1/purchase-orders/${order.id}/returns`)
        .set('Cookie', cookie)
        .set('Idempotency-Key', 'supplier-return-over-limit')
        .send({
          ...partialReturn,
          documentReference: 'DEV-PROV-102',
          lines: [
            {
              purchaseReceiptLineId: receipt.lines[0].id,
              returnedQuantity: '1.000',
            },
          ],
        })
        .expect(409)
        .expect(({ body }: { body: { code?: string } }) => {
          expect(body.code).toBe('PURCHASE_RETURN_QUANTITY_EXCEEDED');
        });

      const [counts] = await dataSource.query<
        Array<{
          returns: number | string;
          returnLines: number | string;
          movements: number | string;
          balance: string;
          expectedCredit: string;
          audits: number | string;
        }>
      >(
        `SELECT
           (SELECT COUNT(*) FROM purchase_returns WHERE purchase_order_id = ?) AS returns,
           (SELECT COUNT(*) FROM purchase_return_lines prl
            INNER JOIN purchase_returns pr ON pr.id = prl.purchase_return_id
            WHERE pr.purchase_order_id = ?) AS returnLines,
           (SELECT COUNT(*) FROM inventory_movements
            WHERE purchase_return_id IS NOT NULL) AS movements,
           (SELECT quantity FROM inventory_balances
            WHERE product_id = ? AND location_id = ?) AS balance,
           (SELECT SUM(expected_credit_total) FROM purchase_returns
            WHERE purchase_order_id = ?) AS expectedCredit,
           (SELECT COUNT(*) FROM audit_events
            WHERE action = 'PURCHASE_RETURN_CREATED' AND after_data LIKE ?) AS audits`,
        [
          order.id,
          order.id,
          setup.productId,
          setup.locationId,
          order.id,
          `%${order.id}%`,
        ],
      );
      expect({
        returns: Number(counts.returns),
        returnLines: Number(counts.returnLines),
        movements: Number(counts.movements),
        balance: counts.balance,
        expectedCredit: counts.expectedCredit,
        audits: Number(counts.audits),
      }).toEqual({
        returns: 2,
        returnLines: 2,
        movements: 2,
        balance: '0.000',
        expectedCredit: '400.00',
        audits: 2,
      });
      await request(app.getHttpServer())
        .get('/api/v1/inventory/movements')
        .query({ type: 'SUPPLIER_RETURN', document: 'DEV-PROV', pageSize: 10 })
        .set('Cookie', cookie)
        .expect(200)
        .expect(({ body }: { body: { data: unknown[]; meta: unknown } }) => {
          expect(body.data).toHaveLength(2);
          expect(body.data[0]).toMatchObject({
            type: 'SUPPLIER_RETURN',
            direction: 'OUT',
            product: { id: setup.productId },
            location: { id: setup.locationId },
            document: { type: 'SUPPLIER_RETURN' },
          });
          expect(body.meta).toMatchObject({ pagination: { total: 2 } });
        });
    });

    it('rolls back supplier return, stock and credit state when movement persistence fails', async () => {
      await registerAccount('supplier-return-rollback-registration');
      const cookie = await createPersistedSession(registrationPayload.email);
      const setup = await setupProcurement(
        registrationPayload.email,
        cookie,
        'ReturnRollback',
      );
      let order!: { id: string; lines: Array<{ id: string }> };
      await request(app.getHttpServer())
        .post('/api/v1/purchase-orders')
        .set('Cookie', cookie)
        .send({
          supplierId: setup.supplierId,
          currency: 'MXN',
          lines: [
            {
              supplierProductId: setup.supplierProductId,
              quantity: '1.000',
              unitCost: '80.00',
            },
          ],
        })
        .expect(201)
        .expect(({ body }: { body: { data: typeof order } }) => {
          order = body.data;
        });
      await request(app.getHttpServer())
        .post(`/api/v1/purchase-orders/${order.id}/approve`)
        .set('Cookie', cookie)
        .set('Idempotency-Key', 'return-rollback-approve')
        .send({ version: 1 })
        .expect(200);
      let receipt!: { id: string; lines: Array<{ id: string }> };
      await request(app.getHttpServer())
        .post(`/api/v1/purchase-orders/${order.id}/receipts`)
        .set('Cookie', cookie)
        .set('Idempotency-Key', 'return-rollback-receipt')
        .send({
          version: 2,
          locationId: setup.locationId,
          documentReference: 'REM-RETURN-ROLLBACK',
          lines: [
            {
              purchaseOrderLineId: order.lines[0].id,
              receivedQuantity: '1.000',
            },
          ],
        })
        .expect(201)
        .expect(
          ({
            body,
          }: {
            body: { data: { receipts: Array<typeof receipt> } };
          }) => {
            receipt = body.data.receipts[0];
          },
        );

      await dataSource.query(`
        ALTER TABLE inventory_movements
        ADD CONSTRAINT ck_test_reject_supplier_return
        CHECK (type <> 'SUPPLIER_RETURN')
      `);
      try {
        await request(app.getHttpServer())
          .post(`/api/v1/purchase-orders/${order.id}/returns`)
          .set('Cookie', cookie)
          .set('Idempotency-Key', 'supplier-return-forced-rollback')
          .send({
            purchaseReceiptId: receipt.id,
            documentReference: 'DEV-ROLLBACK',
            reason: 'Prueba de rollback',
            lines: [
              {
                purchaseReceiptLineId: receipt.lines[0].id,
                returnedQuantity: '1.000',
              },
            ],
          })
          .expect(500);
      } finally {
        await dataSource.query(`
          ALTER TABLE inventory_movements
          DROP CHECK ck_test_reject_supplier_return
        `);
      }
      const [state] = await dataSource.query<
        Array<{
          returns: number | string;
          movements: number | string;
          balance: string;
          returned: string;
        }>
      >(
        `SELECT
           (SELECT COUNT(*) FROM purchase_returns WHERE purchase_order_id = ?) AS returns,
           (SELECT COUNT(*) FROM inventory_movements
            WHERE purchase_return_id IS NOT NULL) AS movements,
           (SELECT quantity FROM inventory_balances
            WHERE product_id = ? AND location_id = ?) AS balance,
           (SELECT COALESCE(SUM(returned_quantity), 0) FROM purchase_return_lines
            WHERE purchase_receipt_line_id = ?) AS returned`,
        [order.id, setup.productId, setup.locationId, receipt.lines[0].id],
      );
      expect({
        returns: Number(state.returns),
        movements: Number(state.movements),
        balance: state.balance,
        returned: state.returned,
      }).toEqual({
        returns: 0,
        movements: 0,
        balance: '1.000',
        returned: '0.000',
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
      await request(app.getHttpServer())
        .patch(`/api/v1/products/${randomUUID()}`)
        .set('Cookie', primaryCookie)
        .send({
          name: 'Café',
          sku: 'CAFE-1',
          cost: '10.00',
          price: '15.00',
          version: 1,
        })
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

      const [primaryProduct] = await dataSource.query<Array<{ id: string }>>(
        'SELECT id FROM products WHERE normalized_sku = ? LIMIT 1',
        [product.sku],
      );
      await request(app.getHttpServer())
        .post('/api/v1/products')
        .set('Cookie', primaryCookie)
        .send({ name: 'Té verde', sku: 'TE-1', cost: '20.00', price: '30.00' })
        .expect(201);

      for (const search of ['cafe-500', '345678', 'molido']) {
        await request(app.getHttpServer())
          .get('/api/v1/products')
          .query({ q: ` ${search} `, page: 1, pageSize: 1 })
          .set('Cookie', primaryCookie)
          .expect(200)
          .expect(({ body }: { body: unknown }) => {
            expect(body).toMatchObject({
              data: [{ id: primaryProduct.id, sku: product.sku }],
              meta: {
                pagination: { page: 1, pageSize: 1, total: 1, totalPages: 1 },
              },
            });
          });
      }
      await request(app.getHttpServer())
        .get('/api/v1/products')
        .query({ page: 2, pageSize: 1 })
        .set('Cookie', primaryCookie)
        .expect(200)
        .expect(({ body }: { body: unknown }) => {
          expect(body).toMatchObject({
            meta: {
              pagination: { page: 2, pageSize: 1, total: 2, totalPages: 2 },
            },
          });
          expect((body as { data: unknown[] }).data).toHaveLength(1);
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

      const [secondaryProduct] = await dataSource.query<Array<{ id: string }>>(
        `SELECT p.id FROM products p
         INNER JOIN users u ON u.tenant_id = p.tenant_id
         WHERE u.normalized_email = ? AND p.normalized_sku = ? LIMIT 1`,
        [secondary.email, product.sku],
      );
      await request(app.getHttpServer())
        .get(`/api/v1/products/${primaryProduct.id}`)
        .set('Cookie', primaryCookie)
        .expect(200);
      await request(app.getHttpServer())
        .get(`/api/v1/products/${secondaryProduct.id}`)
        .set('Cookie', primaryCookie)
        .expect(404);

      const [counts] = await dataSource.query<
        Array<{
          products: number | string;
          categories: number | string;
          brands: number | string;
        }>
      >(`SELECT (SELECT COUNT(*) FROM products) AS products,
                (SELECT COUNT(*) FROM categories) AS categories,
                (SELECT COUNT(*) FROM brands) AS brands`);
      expect(Number(counts.products)).toBe(3);
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

      const current = await request(app.getHttpServer())
        .get(`/api/v1/products/${primaryProduct.id}`)
        .set('Cookie', primaryCookie)
        .expect(200);
      const currentVersion = (current.body as { data: { version: number } })
        .data.version;
      const update = {
        ...product,
        name: 'Café molido premium 500 g',
        sku: 'CAFE-PREMIUM-500',
        barcode: '7501234567899',
        cost: '90.00',
        price: '129.90',
        version: currentVersion,
      };
      await request(app.getHttpServer())
        .patch(`/api/v1/products/${primaryProduct.id}`)
        .set('Cookie', primaryCookie)
        .send(update)
        .expect(200)
        .expect(({ body }: { body: unknown }) => {
          expect(body).toMatchObject({
            data: {
              id: primaryProduct.id,
              name: update.name,
              sku: update.sku,
              cost: update.cost,
              price: update.price,
              version: currentVersion + 1,
            },
          });
        });
      await request(app.getHttpServer())
        .patch(`/api/v1/products/${primaryProduct.id}`)
        .set('Cookie', primaryCookie)
        .send({ ...update, name: 'Edición obsoleta' })
        .expect(409)
        .expect(
          ({ body }: { body: { code?: string; currentVersion?: number } }) => {
            expect(body).toMatchObject({
              code: 'PRODUCT_VERSION_CONFLICT',
              currentVersion: currentVersion + 1,
            });
          },
        );
      await request(app.getHttpServer())
        .patch(`/api/v1/products/${primaryProduct.id}`)
        .set('Cookie', primaryCookie)
        .send({ ...update, sku: 'TE-1', version: currentVersion + 1 })
        .expect(409)
        .expect(({ body }: { body: { code?: string } }) => {
          expect(body.code).toBe('SKU_ALREADY_EXISTS');
        });
      await request(app.getHttpServer())
        .patch(`/api/v1/products/${secondaryProduct.id}`)
        .set('Cookie', primaryCookie)
        .send({ ...update, version: 1 })
        .expect(404);
    });

    it('deletes unreferenced products and deactivates products with inventory history', async () => {
      await request(app.getHttpServer())
        .delete(`/api/v1/products/${randomUUID()}`)
        .expect(401);

      await registerAccount('product-retirement-registration');
      const cookie = await createPersistedSession(registrationPayload.email);
      await completeOnboarding(registrationPayload.email, cookie);

      const disposableResponse = await request(app.getHttpServer())
        .post('/api/v1/products')
        .set('Cookie', cookie)
        .send({
          name: 'Producto temporal',
          sku: 'TEMP-DELETE',
          cost: '1.00',
          price: '2.00',
        })
        .expect(201);
      const disposableId = (disposableResponse.body as { data: { id: string } })
        .data.id;
      await request(app.getHttpServer())
        .delete(`/api/v1/products/${disposableId}`)
        .set('Cookie', cookie)
        .expect(200)
        .expect(({ body }: { body: unknown }) => {
          expect(body).toMatchObject({
            data: { outcome: 'DELETED', product: null },
          });
        });
      await request(app.getHttpServer())
        .get(`/api/v1/products/${disposableId}`)
        .set('Cookie', cookie)
        .expect(404);

      const retainedResponse = await request(app.getHttpServer())
        .post('/api/v1/products')
        .set('Cookie', cookie)
        .send({
          name: 'Producto con historial',
          sku: 'KEEP-HISTORY',
          cost: '10.00',
          price: '15.00',
        })
        .expect(201);
      const retainedId = (retainedResponse.body as { data: { id: string } })
        .data.id;
      const [location] = await dataSource.query<Array<{ id: string }>>(
        `SELECT l.id FROM locations l
         INNER JOIN users u ON u.tenant_id = l.tenant_id
         WHERE u.normalized_email = ? LIMIT 1`,
        [registrationPayload.email],
      );
      await request(app.getHttpServer())
        .post('/api/v1/inventory/movements')
        .set('Cookie', cookie)
        .set('Idempotency-Key', 'product-retirement-stock')
        .send({
          productId: retainedId,
          locationId: location.id,
          type: 'INITIAL',
          quantity: '3',
          reason: 'Stock para conservar historial',
        })
        .expect(201);

      await request(app.getHttpServer())
        .delete(`/api/v1/products/${retainedId}`)
        .set('Cookie', cookie)
        .expect(200)
        .expect(({ body }: { body: unknown }) => {
          expect(body).toMatchObject({
            data: {
              outcome: 'DEACTIVATED',
              product: { id: retainedId, active: false },
            },
          });
        });
      await request(app.getHttpServer())
        .delete(`/api/v1/products/${retainedId}`)
        .set('Cookie', cookie)
        .expect(200)
        .expect(({ body }: { body: unknown }) => {
          expect(body).toMatchObject({
            data: {
              outcome: 'DEACTIVATED',
              product: { id: retainedId, active: false, version: 2 },
            },
          });
        });
      await request(app.getHttpServer())
        .get(`/api/v1/products/${retainedId}`)
        .set('Cookie', cookie)
        .expect(200)
        .expect(({ body }: { body: unknown }) => {
          expect(body).toMatchObject({
            data: { id: retainedId, active: false },
          });
        });

      await request(app.getHttpServer())
        .get('/api/v1/products')
        .query({ q: 'KEEP-HISTORY' })
        .set('Cookie', cookie)
        .expect(200)
        .expect(({ body }: { body: unknown }) => {
          expect(body).toMatchObject({
            data: [],
            meta: { pagination: { total: 0 } },
          });
        });
      for (const status of ['INACTIVE', 'ALL']) {
        await request(app.getHttpServer())
          .get('/api/v1/products')
          .query({ q: 'KEEP-HISTORY', status })
          .set('Cookie', cookie)
          .expect(200)
          .expect(({ body }: { body: unknown }) => {
            expect(body).toMatchObject({
              data: [{ id: retainedId, active: false }],
              meta: { pagination: { total: 1 } },
            });
          });
      }
      await request(app.getHttpServer())
        .get('/api/v1/products')
        .query({ status: 'UNKNOWN' })
        .set('Cookie', cookie)
        .expect(400);

      const [history] = await dataSource.query<
        Array<{ total: number | string }>
      >(
        'SELECT COUNT(*) AS total FROM inventory_movements WHERE product_id = ?',
        [retainedId],
      );
      expect(Number(history.total)).toBe(1);
    });
  });

  describe('inventory stock', () => {
    beforeEach(resetIdentityData);

    async function completeInventoryOnboarding(
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

    it('updates balance atomically and makes retries idempotent', async () => {
      await registerAccount('inventory-primary-registration');
      const cookie = await createPersistedSession(registrationPayload.email);
      await request(app.getHttpServer())
        .get('/api/v1/inventory/movements')
        .set('Cookie', cookie)
        .expect(403);
      await completeInventoryOnboarding(registrationPayload.email, cookie);
      const productResponse = await request(app.getHttpServer())
        .post('/api/v1/products')
        .set('Cookie', cookie)
        .send({
          name: 'Café',
          sku: 'CAFE-STOCK',
          cost: '10.00',
          price: '15.00',
        })
        .expect(201);
      const productId = (productResponse.body as { data: { id: string } }).data
        .id;
      const [location] = await dataSource.query<
        Array<{
          id: string;
          name: string;
          warehouse_id: string;
          branch_id: string;
          user_id: string;
        }>
      >(
        `SELECT l.id, l.name, l.warehouse_id, w.branch_id, u.id AS user_id FROM locations l
         INNER JOIN warehouses w ON w.id = l.warehouse_id AND w.tenant_id = l.tenant_id
         INNER JOIN users u ON u.tenant_id = l.tenant_id
         WHERE u.normalized_email = ? LIMIT 1`,
        [registrationPayload.email],
      );

      await request(app.getHttpServer())
        .post('/api/v1/inventory/movements')
        .set('Cookie', cookie)
        .send({
          productId,
          locationId: location.id,
          type: 'INITIAL',
          quantity: '10',
          reason: 'Apertura de inventario',
        })
        .expect(400);

      const initial = {
        productId,
        locationId: location.id,
        type: 'INITIAL',
        quantity: '10',
        reason: 'Apertura de inventario',
        reference: 'CONTEO-001',
      };
      await request(app.getHttpServer())
        .post('/api/v1/inventory/movements')
        .set('Cookie', cookie)
        .set('Idempotency-Key', 'inventory-initial-001')
        .send(initial)
        .expect(201)
        .expect(({ body }: { body: unknown }) => {
          expect(body).toMatchObject({
            data: { quantityChange: '10.000', quantity: '10.000' },
            meta: { idempotentReplay: false },
          });
        });
      await dataSource.query(
        'UPDATE products SET active = FALSE WHERE id = ?',
        [productId],
      );
      await request(app.getHttpServer())
        .post('/api/v1/inventory/movements')
        .set('Cookie', cookie)
        .set('Idempotency-Key', 'inventory-initial-001')
        .send(initial)
        .expect(201)
        .expect(({ body }: { body: unknown }) => {
          expect(body).toMatchObject({
            data: { quantity: '10.000' },
            meta: { idempotentReplay: true },
          });
        });
      await request(app.getHttpServer())
        .post('/api/v1/inventory/movements')
        .set('Cookie', cookie)
        .set('Idempotency-Key', 'inventory-initial-001')
        .send({ ...initial, quantity: '11' })
        .expect(409)
        .expect(({ body }: { body: { code?: string } }) => {
          expect(body.code).toBe('IDEMPOTENCY_KEY_REUSED');
        });
      await dataSource.query('UPDATE products SET active = TRUE WHERE id = ?', [
        productId,
      ]);
      await request(app.getHttpServer())
        .post('/api/v1/inventory/movements')
        .set('Cookie', cookie)
        .set('Idempotency-Key', 'inventory-initial-002')
        .send(initial)
        .expect(409)
        .expect(({ body }: { body: { code?: string } }) => {
          expect(body.code).toBe('INITIAL_STOCK_ALREADY_EXISTS');
        });

      await request(app.getHttpServer())
        .post('/api/v1/inventory/movements')
        .set('Cookie', cookie)
        .set('Idempotency-Key', 'inventory-entry-001')
        .send({
          ...initial,
          type: 'ENTRY',
          quantity: '2.5',
          reason: 'Recepción manual',
        })
        .expect(201);
      const concurrent = await Promise.all(
        ['inventory-entry-002', 'inventory-entry-003'].map((key) =>
          request(app.getHttpServer())
            .post('/api/v1/inventory/movements')
            .set('Cookie', cookie)
            .set('Idempotency-Key', key)
            .send({
              ...initial,
              type: 'ENTRY',
              quantity: '1',
              reason: 'Entrada concurrente',
            }),
        ),
      );
      expect(concurrent.map(({ status }) => status)).toEqual([201, 201]);
      await request(app.getHttpServer())
        .post('/api/v1/inventory/movements')
        .set('Cookie', cookie)
        .set('Idempotency-Key', 'inventory-adjustment-001')
        .send({
          ...initial,
          type: 'ADJUSTMENT',
          quantity: '-20',
          reason: 'Conteo físico',
        })
        .expect(409)
        .expect(({ body }: { body: { code?: string } }) => {
          expect(body.code).toBe('INVALID_STOCK_QUANTITY');
        });
      await request(app.getHttpServer())
        .post('/api/v1/inventory/movements')
        .set('Cookie', cookie)
        .set('Idempotency-Key', 'inventory-adjustment-002')
        .send({
          ...initial,
          type: 'ADJUSTMENT',
          quantity: '-0.5',
          reason: 'Conteo físico',
          reference: 'CONTEO-002',
        })
        .expect(201);

      await request(app.getHttpServer())
        .get(`/api/v1/inventory/products/${productId}/balance`)
        .query({ locationId: location.id })
        .set('Cookie', cookie)
        .expect(200)
        .expect(({ body }: { body: unknown }) => {
          expect(body).toMatchObject({
            data: {
              product: { id: productId, sku: 'CAFE-STOCK' },
              location: { id: location.id },
              quantity: '14.000',
            },
            meta: { policy: { negativeStock: 'DENY' } },
          });
        });
      await request(app.getHttpServer())
        .get('/api/v1/inventory/stock')
        .query({
          branchId: location.branch_id,
          warehouseId: location.warehouse_id,
          productId,
          q: ' cafe-stock ',
          page: 1,
          pageSize: 1,
        })
        .set('Cookie', cookie)
        .expect(200)
        .expect(({ body }: { body: unknown }) => {
          expect(body).toMatchObject({
            data: [
              {
                product: { id: productId, sku: 'CAFE-STOCK', active: true },
                availableQuantity: '14.000',
                totalQuantity: '14.000',
                states: [
                  { code: 'AVAILABLE', quantity: '14.000' },
                  { code: 'RESERVED', quantity: '0.000' },
                  { code: 'DAMAGED', quantity: '0.000' },
                  { code: 'IN_TRANSIT', quantity: '0.000' },
                ],
              },
            ],
            meta: {
              policy: { negativeStock: 'DENY' },
              scope: {
                branch: { id: location.branch_id },
                warehouse: { id: location.warehouse_id },
              },
              pagination: { page: 1, pageSize: 1, total: 1, totalPages: 1 },
            },
          });
        });
      await request(app.getHttpServer())
        .get('/api/v1/inventory/stock')
        .query({ q: 'sin-resultados' })
        .set('Cookie', cookie)
        .expect(200)
        .expect(({ body }: { body: { data: unknown[] } }) => {
          expect(body.data).toEqual([]);
        });
      await request(app.getHttpServer())
        .get('/api/v1/inventory/movements')
        .query({ q: ' cafe-stock ', type: 'ENTRY', page: 1, pageSize: 2 })
        .set('Cookie', cookie)
        .expect(200)
        .expect(({ body }: { body: unknown }) => {
          expect(body).toMatchObject({
            data: [
              {
                type: 'ENTRY',
                direction: 'IN',
                product: { id: productId, sku: 'CAFE-STOCK' },
                location: {
                  id: location.id,
                  warehouse: { id: location.warehouse_id },
                },
                responsible: { email: registrationPayload.email },
              },
              { type: 'ENTRY', direction: 'IN' },
            ],
            meta: {
              scope: { branch: { id: location.branch_id } },
              pagination: { page: 1, pageSize: 2, total: 3, totalPages: 2 },
            },
          });
        });
      const adjustmentHistory = await request(app.getHttpServer())
        .get('/api/v1/inventory/movements')
        .query({ productId, type: 'ADJUSTMENT' })
        .set('Cookie', cookie)
        .expect(200);
      const adjustment = (
        adjustmentHistory.body as {
          data: Array<{
            id: string;
            previousQuantity: string;
            resultingQuantity: string;
            correlationId: string;
            idempotencyKey: string;
            document: { type: string; id: string; reference: string | null };
          }>;
        }
      ).data[0];
      expect(adjustmentHistory.body).toMatchObject({
        data: [
          {
            direction: 'OUT',
            quantityChange: '-0.500',
            previousQuantity: '14.500',
            resultingQuantity: '14.000',
            reason: 'Conteo físico',
            reference: 'CONTEO-002',
            idempotencyKey: 'inventory-adjustment-002',
            document: { type: 'MOVEMENT', reference: 'CONTEO-002' },
          },
        ],
      });
      expect(adjustment.correlationId).toBe(adjustment.id);
      expect(adjustment.document.id).toBe(adjustment.id);
      await request(app.getHttpServer())
        .get('/api/v1/inventory/movements')
        .query({
          locationId: location.id,
          userId: location.user_id,
          location: location.name,
          responsible: registrationPayload.email,
          document: 'inventory-adjustment-002',
        })
        .set('Cookie', cookie)
        .expect(200)
        .expect(({ body }: { body: { data: Array<{ id: string }> } }) => {
          expect(body.data.map(({ id }) => id)).toEqual([adjustment.id]);
        });
      const firstMovementPage = await request(app.getHttpServer())
        .get('/api/v1/inventory/movements')
        .query({ page: 1, pageSize: 2 })
        .set('Cookie', cookie)
        .expect(200);
      const repeatedMovementPage = await request(app.getHttpServer())
        .get('/api/v1/inventory/movements')
        .query({ page: 1, pageSize: 2 })
        .set('Cookie', cookie)
        .expect(200);
      expect(repeatedMovementPage.body).toEqual(firstMovementPage.body);
      await request(app.getHttpServer())
        .patch(`/api/v1/inventory/movements/${adjustment.id}`)
        .set('Cookie', cookie)
        .send({ reason: 'Intento de mutación' })
        .expect(404);
      await request(app.getHttpServer())
        .delete(`/api/v1/inventory/movements/${adjustment.id}`)
        .set('Cookie', cookie)
        .expect(404);
      const [persistedMovement] = await dataSource.query<
        Array<{ reason: string; idempotency_key: string }>
      >(
        'SELECT reason, idempotency_key FROM inventory_movements WHERE id = ?',
        [adjustment.id],
      );
      expect(persistedMovement).toEqual({
        reason: 'Conteo físico',
        idempotency_key: 'inventory-adjustment-002',
      });
      await request(app.getHttpServer())
        .get('/api/v1/inventory/movements')
        .query({ dateFrom: '2099-01-01' })
        .set('Cookie', cookie)
        .expect(200)
        .expect(({ body }: { body: { data: unknown[] } }) => {
          expect(body.data).toEqual([]);
        });
      await request(app.getHttpServer())
        .get('/api/v1/inventory/movements')
        .query({ dateFrom: '2026-02-01', dateTo: '2026-01-01' })
        .set('Cookie', cookie)
        .expect(400);
      const [counts] = await dataSource.query<
        Array<{ movements: number | string }>
      >('SELECT COUNT(*) AS movements FROM inventory_movements');
      expect(Number(counts.movements)).toBe(5);
    });

    it('applies operational movement directions and rolls back invalid exits', async () => {
      await registerAccount('inventory-operational-registration');
      const cookie = await createPersistedSession(registrationPayload.email);
      await completeInventoryOnboarding(registrationPayload.email, cookie);
      const productResponse = await request(app.getHttpServer())
        .post('/api/v1/products')
        .set('Cookie', cookie)
        .send({
          name: 'Producto operativo',
          sku: 'OPS-1',
          cost: '5.00',
          price: '9.00',
        })
        .expect(201);
      const productId = (productResponse.body as { data: { id: string } }).data
        .id;
      const [location] = await dataSource.query<Array<{ id: string }>>(
        `SELECT l.id FROM locations l
         INNER JOIN users u ON u.tenant_id = l.tenant_id
         WHERE u.normalized_email = ? LIMIT 1`,
        [registrationPayload.email],
      );
      const base = { productId, locationId: location.id };
      const operations = [
        {
          type: 'INITIAL',
          quantity: '10',
          reason: 'Conteo inicial',
          expectedChange: '10.000',
          expectedBalance: '10.000',
        },
        {
          type: 'ENTRY',
          quantity: '2',
          reason: 'Entrada manual',
          reference: 'ENT-001',
          expectedChange: '2.000',
          expectedBalance: '12.000',
        },
        {
          type: 'RETURN',
          quantity: '1',
          reason: 'Devolución de cliente',
          reference: 'DEV-001',
          expectedChange: '1.000',
          expectedBalance: '13.000',
        },
        {
          type: 'EXIT',
          quantity: '3',
          reason: 'Salida operativa',
          reference: 'SAL-001',
          expectedChange: '-3.000',
          expectedBalance: '10.000',
        },
        {
          type: 'LOSS',
          quantity: '1',
          reason: 'Pérdida documentada',
          reference: 'INC-LOSS-001',
          expectedChange: '-1.000',
          expectedBalance: '9.000',
        },
        {
          type: 'DAMAGE',
          quantity: '1',
          reason: 'Daño documentado',
          reference: 'INC-DAMAGE-001',
          expectedChange: '-1.000',
          expectedBalance: '8.000',
        },
        {
          type: 'ADJUSTMENT',
          quantity: '-2',
          reason: 'Ajuste autorizado',
          reference: 'ADJ-001',
          expectedChange: '-2.000',
          expectedBalance: '6.000',
        },
      ];

      for (const [index, operation] of operations.entries()) {
        const { expectedChange, expectedBalance, ...payload } = operation;
        await request(app.getHttpServer())
          .post('/api/v1/inventory/movements')
          .set('Cookie', cookie)
          .set('Idempotency-Key', `operational-movement-${index}`)
          .send({ ...base, ...payload })
          .expect(201)
          .expect(({ body }: { body: unknown }) => {
            expect(body).toMatchObject({
              data: {
                type: operation.type,
                quantityChange: expectedChange,
                quantity: expectedBalance,
                reason: operation.reason,
                reference: operation.reference ?? null,
              },
            });
          });
      }

      await request(app.getHttpServer())
        .post('/api/v1/inventory/movements')
        .set('Cookie', cookie)
        .set('Idempotency-Key', 'operational-missing-reference')
        .send({ ...base, type: 'LOSS', quantity: '1', reason: 'Sin evidencia' })
        .expect(400)
        .expect(({ body }: { body: { code?: string } }) => {
          expect(body.code).toBe('MOVEMENT_REFERENCE_REQUIRED');
        });
      for (const [key, quantity] of [
        ['operational-negative-exit', '-1'],
        ['operational-insufficient-exit', '99'],
      ]) {
        await request(app.getHttpServer())
          .post('/api/v1/inventory/movements')
          .set('Cookie', cookie)
          .set('Idempotency-Key', key)
          .send({
            ...base,
            type: 'EXIT',
            quantity,
            reason: 'Salida inválida',
            reference: 'SAL-INVALID',
          })
          .expect(409)
          .expect(({ body }: { body: { code?: string } }) => {
            expect(body.code).toBe('INVALID_STOCK_QUANTITY');
          });
      }

      const balance = await request(app.getHttpServer())
        .get(`/api/v1/inventory/products/${productId}/balance`)
        .query({ locationId: location.id })
        .set('Cookie', cookie)
        .expect(200);
      expect(balance.body).toMatchObject({ data: { quantity: '6.000' } });
      const history = await request(app.getHttpServer())
        .get('/api/v1/inventory/movements')
        .query({ productId, pageSize: 20 })
        .set('Cookie', cookie)
        .expect(200);
      const historyData = history.body as {
        data: Array<{
          type: string;
          direction: string;
          responsible: { email: string };
        }>;
      };
      expect(historyData.data).toHaveLength(7);
      expect(historyData.data).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ type: 'RETURN', direction: 'IN' }),
          expect.objectContaining({ type: 'EXIT', direction: 'OUT' }),
          expect.objectContaining({ type: 'LOSS', direction: 'OUT' }),
          expect.objectContaining({ type: 'DAMAGE', direction: 'OUT' }),
        ]),
      );
      expect(
        historyData.data.every(
          ({ responsible }) => responsible.email === registrationPayload.email,
        ),
      ).toBe(true);
    });

    it('reconciles stock states atomically and limits POS to available stock', async () => {
      await registerAccount('inventory-states-registration');
      const cookie = await createPersistedSession(registrationPayload.email);
      await completeInventoryOnboarding(registrationPayload.email, cookie);
      const productResponse = await request(app.getHttpServer())
        .post('/api/v1/products')
        .set('Cookie', cookie)
        .send({
          name: 'Producto por estado',
          sku: 'STATE-1',
          cost: '5.00',
          price: '9.00',
        })
        .expect(201);
      const productId = (productResponse.body as { data: { id: string } }).data
        .id;
      const [location] = await dataSource.query<Array<{ id: string }>>(
        `SELECT l.id FROM locations l
         INNER JOIN users u ON u.tenant_id = l.tenant_id
         WHERE u.normalized_email = ? LIMIT 1`,
        [registrationPayload.email],
      );
      await request(app.getHttpServer())
        .post('/api/v1/inventory/movements')
        .set('Cookie', cookie)
        .set('Idempotency-Key', 'state-initial-stock')
        .send({
          productId,
          locationId: location.id,
          type: 'INITIAL',
          quantity: '10',
          reason: 'Conteo inicial',
        })
        .expect(201);

      const transitions = [
        ['RESERVED', '3', 'Reserva operativa', 'STATE-RES-1'],
        ['DAMAGED', '2', 'Cuarentena por daño', 'STATE-DMG-1'],
        ['IN_TRANSIT', '1', 'Preparación de traslado', 'STATE-TRN-1'],
      ] as const;
      for (const [
        index,
        [toState, quantity, reason, reference],
      ] of transitions.entries()) {
        await request(app.getHttpServer())
          .post('/api/v1/inventory/state-transitions')
          .set('Cookie', cookie)
          .set('Idempotency-Key', `state-transition-${index}`)
          .send({
            productId,
            locationId: location.id,
            fromState: 'AVAILABLE',
            toState,
            quantity,
            reason,
            reference,
          })
          .expect(201)
          .expect(({ body }: { body: unknown }) => {
            expect(body).toMatchObject({
              data: {
                type: 'STATE_TRANSITION',
                quantityChange: '0.000',
                quantity: '10.000',
                stateTransition: {
                  from: 'AVAILABLE',
                  to: toState,
                  quantity: `${quantity}.000`,
                },
              },
            });
          });
      }

      await request(app.getHttpServer())
        .post('/api/v1/inventory/state-transitions')
        .set('Cookie', cookie)
        .set('Idempotency-Key', 'state-transition-0')
        .send({
          productId,
          locationId: location.id,
          fromState: 'AVAILABLE',
          toState: 'RESERVED',
          quantity: '3',
          reason: 'Reserva operativa',
          reference: 'STATE-RES-1',
        })
        .expect(201)
        .expect(({ body }: { body: unknown }) => {
          expect(body).toMatchObject({
            meta: { idempotentReplay: true },
            data: {
              type: 'STATE_TRANSITION',
              stateTransition: {
                from: 'AVAILABLE',
                to: 'RESERVED',
                quantity: '3.000',
              },
            },
          });
        });

      await request(app.getHttpServer())
        .post('/api/v1/inventory/state-transitions')
        .set('Cookie', cookie)
        .set('Idempotency-Key', 'state-invalid-route')
        .send({
          productId,
          locationId: location.id,
          fromState: 'RESERVED',
          toState: 'DAMAGED',
          quantity: '1',
          reason: 'Ruta inválida',
          reference: 'STATE-INVALID',
        })
        .expect(400)
        .expect(({ body }: { body: { code?: string } }) => {
          expect(body.code).toBe('INVALID_STOCK_STATE_TRANSITION');
        });

      const concurrent = await Promise.all(
        ['state-concurrent-a', 'state-concurrent-b'].map((key) =>
          request(app.getHttpServer())
            .post('/api/v1/inventory/state-transitions')
            .set('Cookie', cookie)
            .set('Idempotency-Key', key)
            .send({
              productId,
              locationId: location.id,
              fromState: 'AVAILABLE',
              toState: 'RESERVED',
              quantity: '3',
              reason: 'Reserva concurrente',
              reference: key,
            }),
        ),
      );
      expect(concurrent.map(({ status }) => status).sort()).toEqual([201, 409]);

      const balance = await request(app.getHttpServer())
        .get(`/api/v1/inventory/products/${productId}/balance`)
        .query({ locationId: location.id })
        .set('Cookie', cookie)
        .expect(200);
      expect(balance.body).toMatchObject({
        data: {
          quantity: '10.000',
          totalQuantity: '10.000',
          availableQuantity: '1.000',
          states: [
            { code: 'AVAILABLE', quantity: '1.000' },
            { code: 'RESERVED', quantity: '6.000' },
            { code: 'DAMAGED', quantity: '2.000' },
            { code: 'IN_TRANSIT', quantity: '1.000' },
          ],
        },
      });
      await openCurrentCashRegister(cookie, 'state-pos-shift');
      await request(app.getHttpServer())
        .post('/api/v1/pos/cart/quote')
        .set('Cookie', cookie)
        .send({ lines: [{ productId, quantity: '2' }] })
        .expect(409)
        .expect(({ body }: { body: { code?: string } }) => {
          expect(body.code).toBe('INSUFFICIENT_STOCK');
        });
      await request(app.getHttpServer())
        .post('/api/v1/pos/sales/cash')
        .set('Cookie', cookie)
        .set('Idempotency-Key', 'state-sale-over-available')
        .send({ lines: [{ productId, quantity: '2' }], cashReceived: '18.00' })
        .expect(409)
        .expect(({ body }: { body: { code?: string } }) => {
          expect(body.code).toBe('INSUFFICIENT_STOCK');
        });
      await request(app.getHttpServer())
        .get('/api/v1/inventory/movements')
        .query({ productId, type: 'STATE_TRANSITION' })
        .set('Cookie', cookie)
        .expect(200)
        .expect(({ body }: { body: unknown }) => {
          const history = (
            body as {
              data: Array<{
                reason: string;
                direction: string;
                responsible: { email: string };
                stateTransition: unknown;
              }>;
            }
          ).data;
          const reservation = history.find(
            ({ reason }) => reason === 'Reserva concurrente',
          );
          expect(reservation).toMatchObject({
            direction: 'TRANSFER',
            responsible: { email: registrationPayload.email },
            stateTransition: {
              from: 'AVAILABLE',
              to: 'RESERVED',
              quantity: '3.000',
            },
          });
        });
      const [invariant] = await dataSource.query<
        Array<{
          total: string;
          available: string;
          reserved: string;
          damaged: string;
          in_transit: string;
          movements: number | string;
        }>
      >(
        `SELECT quantity AS total, available_quantity AS available,
                reserved_quantity AS reserved, damaged_quantity AS damaged,
                in_transit_quantity AS in_transit,
                (SELECT COUNT(*) FROM inventory_movements
                 WHERE product_id = ? AND type = 'STATE_TRANSITION') AS movements
         FROM inventory_balances WHERE product_id = ? AND location_id = ?`,
        [productId, productId, location.id],
      );
      expect(Number(invariant.total)).toBe(
        Number(invariant.available) +
          Number(invariant.reserved) +
          Number(invariant.damaged) +
          Number(invariant.in_transit),
      );
      expect(Number(invariant.movements)).toBe(4);
    });

    it('keeps stock independent while switching between tenant branches and warehouses', async () => {
      await registerAccount('multi-location-registration');
      const cookie = await createPersistedSession(registrationPayload.email);
      await completeInventoryOnboarding(registrationPayload.email, cookie);
      const initialOrganization = await request(app.getHttpServer())
        .get('/api/v1/organization/branches')
        .set('Cookie', cookie)
        .expect(200);
      const initialBranch = (
        initialOrganization.body as {
          data: Array<{
            id: string;
            warehouses: Array<{
              id: string;
              locations: Array<{ id: string }>;
            }>;
          }>;
        }
      ).data[0];
      const initialWarehouse = initialBranch.warehouses[0];
      const product = await request(app.getHttpServer())
        .post('/api/v1/products')
        .set('Cookie', cookie)
        .send({
          name: 'Producto multisucursal',
          sku: 'MULTI-1',
          cost: '3.00',
          price: '5.00',
        })
        .expect(201);
      const productId = (product.body as { data: { id: string } }).data.id;

      const createdBranch = await request(app.getHttpServer())
        .post('/api/v1/organization/branches')
        .set('Cookie', cookie)
        .send({
          name: 'Sucursal Norte',
          timezone: 'America/Mexico_City',
          warehouseName: 'Bodega Norte',
          locationName: 'Piso Norte',
          locationCode: 'NORTE',
        })
        .expect(201);
      const secondary = (
        createdBranch.body as {
          data: {
            id: string;
            warehouses: Array<{
              id: string;
              locations: Array<{ id: string }>;
            }>;
          };
        }
      ).data;
      const secondaryWarehouse = secondary.warehouses[0];
      const extraWarehouse = await request(app.getHttpServer())
        .post(`/api/v1/organization/branches/${secondary.id}/warehouses`)
        .set('Cookie', cookie)
        .send({
          name: 'Bodega Temporal',
          locationName: 'Temporal',
          locationCode: 'TEMP',
        })
        .expect(201);
      const extraWarehouseId = (extraWarehouse.body as { data: { id: string } })
        .data.id;
      await request(app.getHttpServer())
        .patch(`/api/v1/organization/branches/${secondary.id}`)
        .set('Cookie', cookie)
        .send({
          name: 'Sucursal Norte Actualizada',
          timezone: 'America/Monterrey',
        })
        .expect(200);
      await request(app.getHttpServer())
        .patch(`/api/v1/organization/warehouses/${secondaryWarehouse.id}`)
        .set('Cookie', cookie)
        .send({ name: 'Bodega Norte Actualizada' })
        .expect(200);
      await request(app.getHttpServer())
        .delete(`/api/v1/organization/warehouses/${extraWarehouseId}`)
        .set('Cookie', cookie)
        .expect(200)
        .expect(({ body }: { body: unknown }) => {
          expect(body).toMatchObject({
            data: { id: extraWarehouseId, active: false },
          });
        });

      const temporaryBranch = await request(app.getHttpServer())
        .post('/api/v1/organization/branches')
        .set('Cookie', cookie)
        .send({
          name: 'Sucursal Temporal',
          timezone: 'America/Mexico_City',
          warehouseName: 'Bodega Temporal Independiente',
          locationName: 'General Temporal',
          locationCode: 'BRANCH-TEMP',
        })
        .expect(201);
      const temporaryBranchId = (
        temporaryBranch.body as { data: { id: string } }
      ).data.id;
      await request(app.getHttpServer())
        .delete(`/api/v1/organization/branches/${temporaryBranchId}`)
        .set('Cookie', cookie)
        .expect(200)
        .expect(({ body }: { body: unknown }) => {
          expect(body).toMatchObject({
            data: { id: temporaryBranchId, active: false },
          });
        });

      await request(app.getHttpServer())
        .patch('/api/v1/auth/sessions/current/context')
        .set('Cookie', cookie)
        .send({ branchId: secondary.id, warehouseId: secondaryWarehouse.id })
        .expect(200)
        .expect(({ body }: { body: unknown }) => {
          expect(body).toMatchObject({
            data: {
              context: {
                branch: {
                  id: secondary.id,
                  name: 'Sucursal Norte Actualizada',
                },
                warehouse: {
                  id: secondaryWarehouse.id,
                  name: 'Bodega Norte Actualizada',
                },
                cashRegister: null,
              },
            },
          });
        });
      await request(app.getHttpServer())
        .post('/api/v1/inventory/movements')
        .set('Cookie', cookie)
        .set('Idempotency-Key', 'multi-location-north-stock')
        .send({
          productId,
          locationId: secondaryWarehouse.locations[0].id,
          type: 'INITIAL',
          quantity: '7',
          reason: 'Stock sucursal norte',
        })
        .expect(201);
      await request(app.getHttpServer())
        .get('/api/v1/inventory/stock')
        .set('Cookie', cookie)
        .expect(200)
        .expect(({ body }: { body: unknown }) => {
          expect(body).toMatchObject({
            data: [{ product: { id: productId }, totalQuantity: '7.000' }],
            meta: { scope: { branch: { id: secondary.id } } },
          });
        });

      await request(app.getHttpServer())
        .patch('/api/v1/auth/sessions/current/context')
        .set('Cookie', cookie)
        .send({ branchId: initialBranch.id, warehouseId: initialWarehouse.id })
        .expect(200);
      await request(app.getHttpServer())
        .post('/api/v1/inventory/movements')
        .set('Cookie', cookie)
        .set('Idempotency-Key', 'multi-location-primary-stock')
        .send({
          productId,
          locationId: initialWarehouse.locations[0].id,
          type: 'INITIAL',
          quantity: '3',
          reason: 'Stock sucursal principal',
        })
        .expect(201);
      await request(app.getHttpServer())
        .get('/api/v1/inventory/stock')
        .set('Cookie', cookie)
        .expect(200)
        .expect(({ body }: { body: unknown }) => {
          expect(body).toMatchObject({
            data: [{ product: { id: productId }, totalQuantity: '3.000' }],
            meta: { scope: { branch: { id: initialBranch.id } } },
          });
        });

      const balances = await dataSource.query<
        Array<{ location_id: string; quantity: string }>
      >(
        `SELECT location_id, quantity FROM inventory_balances
         WHERE product_id = ? ORDER BY quantity`,
        [productId],
      );
      expect(balances.map(({ quantity }) => Number(quantity))).toEqual([3, 7]);
      await request(app.getHttpServer())
        .delete(`/api/v1/organization/branches/${secondary.id}`)
        .set('Cookie', cookie)
        .expect(409)
        .expect(({ body }: { body: { code?: string } }) => {
          expect(body.code).toBe('ORGANIZATION_IN_USE');
        });
      await request(app.getHttpServer())
        .delete(`/api/v1/organization/branches/${initialBranch.id}`)
        .set('Cookie', cookie)
        .expect(409)
        .expect(({ body }: { body: { code?: string } }) => {
          expect(body.code).toBe('INITIAL_ORGANIZATION_TARGET');
        });
    });

    it('dispatches transfers atomically, idempotently and only from available stock', async () => {
      await registerAccount('transfer-registration');
      const cookie = await createPersistedSession(registrationPayload.email);
      await completeInventoryOnboarding(registrationPayload.email, cookie);
      const organization = await request(app.getHttpServer())
        .get('/api/v1/organization/branches')
        .set('Cookie', cookie)
        .expect(200);
      const origin = (
        organization.body as {
          data: Array<{
            id: string;
            warehouses: Array<{ id: string; locations: Array<{ id: string }> }>;
          }>;
        }
      ).data[0];
      const destinationResponse = await request(app.getHttpServer())
        .post('/api/v1/organization/branches')
        .set('Cookie', cookie)
        .send({
          name: 'Sucursal Destino',
          timezone: 'America/Mexico_City',
          warehouseName: 'Bodega Destino',
          locationName: 'Recepción',
          locationCode: 'DEST',
        })
        .expect(201);
      const destination = (
        destinationResponse.body as {
          data: {
            id: string;
            warehouses: Array<{ id: string; locations: Array<{ id: string }> }>;
          };
        }
      ).data;
      const originWarehouse = origin.warehouses[0];
      const destinationWarehouse = destination.warehouses[0];
      const productResponse = await request(app.getHttpServer())
        .post('/api/v1/products')
        .set('Cookie', cookie)
        .send({
          name: 'Producto transferible',
          sku: 'TRANSFER-1',
          cost: '4.00',
          price: '8.00',
        })
        .expect(201);
      const productId = (productResponse.body as { data: { id: string } }).data
        .id;
      await request(app.getHttpServer())
        .post('/api/v1/inventory/movements')
        .set('Cookie', cookie)
        .set('Idempotency-Key', 'transfer-initial-stock')
        .send({
          productId,
          locationId: originWarehouse.locations[0].id,
          type: 'INITIAL',
          quantity: '10',
          reason: 'Stock para transferir',
        })
        .expect(201);

      const transferInput = (quantity: string, reference: string) => ({
        destinationWarehouseId: destinationWarehouse.id,
        reference,
        reason: 'Reabasto entre sucursales',
        lines: [
          {
            productId,
            sourceLocationId: originWarehouse.locations[0].id,
            destinationLocationId: destinationWarehouse.locations[0].id,
            quantity,
          },
        ],
      });
      const created = await request(app.getHttpServer())
        .post('/api/v1/inventory/transfers')
        .set('Cookie', cookie)
        .set('Idempotency-Key', 'transfer-create-main')
        .send(transferInput('6', 'TR-001'))
        .expect(201);
      const mainTransfer = created.body as {
        data: { id: string; lines: Array<{ id: string }> };
      };
      const transferId = mainTransfer.data.id;
      const transferLineId = mainTransfer.data.lines[0].id;
      await request(app.getHttpServer())
        .post('/api/v1/inventory/transfers')
        .set('Cookie', cookie)
        .set('Idempotency-Key', 'transfer-create-main')
        .send(transferInput('6', 'TR-001'))
        .expect(201)
        .expect(({ body }: { body: unknown }) => {
          expect(body).toMatchObject({
            data: { id: transferId, status: 'DRAFT' },
            meta: { idempotentReplay: true },
          });
        });

      const cancellable = await request(app.getHttpServer())
        .post('/api/v1/inventory/transfers')
        .set('Cookie', cookie)
        .set('Idempotency-Key', 'transfer-create-cancel')
        .send(transferInput('1', 'TR-CANCEL'))
        .expect(201);
      const cancellableId = (cancellable.body as { data: { id: string } }).data
        .id;
      await request(app.getHttpServer())
        .post(`/api/v1/inventory/transfers/${cancellableId}/cancel`)
        .set('Cookie', cookie)
        .expect(200)
        .expect(({ body }: { body: unknown }) => {
          expect(body).toMatchObject({
            data: {
              id: cancellableId,
              status: 'CANCELLED',
              cancelledBy: { email: registrationPayload.email },
            },
          });
        });
      await request(app.getHttpServer())
        .post(`/api/v1/inventory/transfers/${cancellableId}/dispatch`)
        .set('Cookie', cookie)
        .set('Idempotency-Key', 'transfer-dispatch-cancelled')
        .expect(409);

      const simultaneousReplay = await Promise.all(
        ['first', 'second'].map(() =>
          request(app.getHttpServer())
            .post(`/api/v1/inventory/transfers/${transferId}/dispatch`)
            .set('Cookie', cookie)
            .set('Idempotency-Key', 'transfer-dispatch-main'),
        ),
      );
      expect(simultaneousReplay.map(({ status }) => status)).toEqual([
        200, 200,
      ]);
      expect(
        simultaneousReplay.map(
          ({ body }) =>
            (body as { meta: { idempotentReplay: boolean } }).meta
              .idempotentReplay,
        ),
      ).toContain(true);
      await request(app.getHttpServer())
        .post(`/api/v1/inventory/transfers/${transferId}/dispatch`)
        .set('Cookie', cookie)
        .set('Idempotency-Key', 'transfer-dispatch-other')
        .expect(409)
        .expect(({ body }: { body: { code?: string } }) => {
          expect(body.code).toBe('TRANSFER_STATUS_CONFLICT');
        });

      const competingTransfers = await Promise.all(
        ['A', 'B'].map(async (suffix) => {
          const response = await request(app.getHttpServer())
            .post('/api/v1/inventory/transfers')
            .set('Cookie', cookie)
            .set('Idempotency-Key', `transfer-create-competing-${suffix}`)
            .send(transferInput('3', `TR-COMPETE-${suffix}`))
            .expect(201);
          return (response.body as { data: { id: string } }).data.id;
        }),
      );
      const competingDispatches = await Promise.all(
        competingTransfers.map((id, index) =>
          request(app.getHttpServer())
            .post(`/api/v1/inventory/transfers/${id}/dispatch`)
            .set('Cookie', cookie)
            .set('Idempotency-Key', `transfer-dispatch-competing-${index}`),
        ),
      );
      expect(competingDispatches.map(({ status }) => status).sort()).toEqual([
        200, 409,
      ]);
      expect(
        competingDispatches.find(({ status }) => status === 409)?.body,
      ).toMatchObject({ code: 'INSUFFICIENT_AVAILABLE_STOCK' });

      const rollbackTransferResponse = await request(app.getHttpServer())
        .post('/api/v1/inventory/transfers')
        .set('Cookie', cookie)
        .set('Idempotency-Key', 'transfer-create-rollback')
        .send(transferInput('1', 'TR-ROLLBACK'))
        .expect(201);
      const rollbackTransferId = (
        rollbackTransferResponse.body as { data: { id: string } }
      ).data.id;
      const [principal] = await dataSource.query<Array<{ tenant_id: string }>>(
        'SELECT tenant_id FROM users WHERE normalized_email = ? LIMIT 1',
        [registrationPayload.email],
      );
      await expect(
        app.get(InventoryTransferRepository).dispatch({
          tenantId: principal.tenant_id,
          transferId: rollbackTransferId,
          originWarehouseId: originWarehouse.id,
          userId: randomUUID(),
          idempotencyKey: 'transfer-dispatch-rollback',
        }),
      ).rejects.toThrow();
      await request(app.getHttpServer())
        .get(`/api/v1/inventory/transfers/${rollbackTransferId}`)
        .set('Cookie', cookie)
        .expect(200)
        .expect(({ body }: { body: unknown }) => {
          expect(body).toMatchObject({
            data: { id: rollbackTransferId, status: 'DRAFT' },
          });
        });

      await request(app.getHttpServer())
        .post(`/api/v1/inventory/transfers/${transferId}/receipts`)
        .set('Cookie', cookie)
        .set('Idempotency-Key', 'transfer-receive-wrong-context')
        .send({
          lines: [
            {
              transferLineId,
              receivedQuantity: '1',
              discrepancyQuantity: '0',
            },
          ],
        })
        .expect(400)
        .expect(({ body }: { body: { code?: string } }) => {
          expect(body.code).toBe('INVALID_TRANSFER_TARGET');
        });

      await request(app.getHttpServer())
        .patch('/api/v1/auth/sessions/current/context')
        .set('Cookie', cookie)
        .send({
          branchId: destination.id,
          warehouseId: destinationWarehouse.id,
        })
        .expect(200);
      const partialReceipt = {
        lines: [
          {
            transferLineId,
            receivedQuantity: '2',
            discrepancyQuantity: '0',
          },
        ],
      };
      const concurrentReceiptReplay = await Promise.all(
        ['first', 'second'].map(() =>
          request(app.getHttpServer())
            .post(`/api/v1/inventory/transfers/${transferId}/receipts`)
            .set('Cookie', cookie)
            .set('Idempotency-Key', 'transfer-receive-partial')
            .send(partialReceipt),
        ),
      );
      expect(concurrentReceiptReplay.map(({ status }) => status)).toEqual([
        200, 200,
      ]);
      expect(
        concurrentReceiptReplay.map(
          ({ body }) =>
            (body as { meta: { idempotentReplay: boolean } }).meta
              .idempotentReplay,
        ),
      ).toContain(true);
      expect(concurrentReceiptReplay[0].body).toMatchObject({
        data: {
          status: 'PARTIALLY_RECEIVED',
          lines: [
            {
              id: transferLineId,
              receivedQuantity: '2.000',
              discrepancyQuantity: '0.000',
              pendingQuantity: '4.000',
            },
          ],
        },
      });
      await request(app.getHttpServer())
        .post(`/api/v1/inventory/transfers/${transferId}/receipts`)
        .set('Cookie', cookie)
        .set('Idempotency-Key', 'transfer-receive-excess')
        .send({
          lines: [
            {
              transferLineId,
              receivedQuantity: '5',
              discrepancyQuantity: '0',
            },
          ],
        })
        .expect(409)
        .expect(({ body }: { body: { code?: string } }) => {
          expect(body.code).toBe('TRANSFER_RECEIPT_EXCEEDS_PENDING');
        });
      await request(app.getHttpServer())
        .post(`/api/v1/inventory/transfers/${transferId}/receipts`)
        .set('Cookie', cookie)
        .set('Idempotency-Key', 'transfer-receive-missing-reason')
        .send({
          lines: [
            {
              transferLineId,
              receivedQuantity: '3',
              discrepancyQuantity: '1',
            },
          ],
        })
        .expect(400)
        .expect(({ body }: { body: { code?: string } }) => {
          expect(body.code).toBe('TRANSFER_DISCREPANCY_REASON_REQUIRED');
        });
      await request(app.getHttpServer())
        .post(`/api/v1/inventory/transfers/${transferId}/receipts`)
        .set('Cookie', cookie)
        .set('Idempotency-Key', 'transfer-receive-final')
        .send({
          discrepancyReason: 'Faltante confirmado al abrir el embarque',
          lines: [
            {
              transferLineId,
              receivedQuantity: '3',
              discrepancyQuantity: '1',
            },
          ],
        })
        .expect(200)
        .expect(({ body }: { body: unknown }) => {
          expect(body).toMatchObject({
            data: {
              status: 'RECEIVED',
              lines: [
                {
                  id: transferLineId,
                  receivedQuantity: '5.000',
                  discrepancyQuantity: '1.000',
                  pendingQuantity: '0.000',
                },
              ],
              receipts: [
                {
                  receivedBy: { email: registrationPayload.email },
                  lines: [
                    {
                      transferLineId,
                      receivedQuantity: '2.000',
                      discrepancyQuantity: '0.000',
                    },
                  ],
                },
                {
                  discrepancyReason: 'Faltante confirmado al abrir el embarque',
                  receivedBy: { email: registrationPayload.email },
                  lines: [
                    {
                      transferLineId,
                      receivedQuantity: '3.000',
                      discrepancyQuantity: '1.000',
                    },
                  ],
                },
              ],
            },
          });
        });

      const successfulCompetingId =
        competingTransfers[
          competingDispatches.findIndex(({ status }) => status === 200)
        ];
      const successfulCompeting = await request(app.getHttpServer())
        .get(`/api/v1/inventory/transfers/${successfulCompetingId}`)
        .set('Cookie', cookie)
        .expect(200);
      const successfulCompetingLineId = (
        successfulCompeting.body as { data: { lines: Array<{ id: string }> } }
      ).data.lines[0].id;
      await request(app.getHttpServer())
        .post(`/api/v1/inventory/transfers/${successfulCompetingId}/receipts`)
        .set('Cookie', cookie)
        .set('Idempotency-Key', 'transfer-receive-complete')
        .send({
          lines: [
            {
              transferLineId: successfulCompetingLineId,
              receivedQuantity: '3',
              discrepancyQuantity: '0',
            },
          ],
        })
        .expect(200)
        .expect(({ body }: { body: unknown }) => {
          expect(body).toMatchObject({ data: { status: 'RECEIVED' } });
        });

      const balances = await dataSource.query<
        Array<{
          location_id: string;
          quantity: string;
          available_quantity: string;
          in_transit_quantity: string;
        }>
      >(
        `SELECT location_id, quantity, available_quantity, in_transit_quantity
         FROM inventory_balances WHERE product_id = ? ORDER BY location_id`,
        [productId],
      );
      const source = balances.find(
        ({ location_id }) => location_id === originWarehouse.locations[0].id,
      )!;
      const target = balances.find(
        ({ location_id }) =>
          location_id === destinationWarehouse.locations[0].id,
      )!;
      expect(source).toMatchObject({
        quantity: '1.000',
        available_quantity: '1.000',
        in_transit_quantity: '0.000',
      });
      expect(target).toMatchObject({
        quantity: '8.000',
        available_quantity: '8.000',
        in_transit_quantity: '0.000',
      });
      expect(Number(source.quantity) + Number(target.quantity)).toBe(9);

      await request(app.getHttpServer())
        .get(`/api/v1/inventory/transfers/${transferId}`)
        .set('Cookie', cookie)
        .expect(200)
        .expect(({ body }: { body: unknown }) => {
          expect(body).toMatchObject({
            data: {
              id: transferId,
              status: 'RECEIVED',
              reference: 'TR-001',
              reason: 'Reabasto entre sucursales',
              originWarehouse: { id: originWarehouse.id },
              destinationWarehouse: { id: destinationWarehouse.id },
              lines: [
                {
                  product: { id: productId, sku: 'TRANSFER-1' },
                  quantity: '6.000',
                },
              ],
              createdBy: { email: registrationPayload.email },
              dispatchedBy: { email: registrationPayload.email },
            },
          });
        });
      const [movementSummary] = await dataSource.query<
        Array<{ transfers: number | string; movement_total: string }>
      >(
        `SELECT COUNT(*) AS transfers, SUM(quantity_change) AS movement_total
         FROM inventory_movements
         WHERE transfer_id IS NOT NULL AND product_id = ?`,
        [productId],
      );
      expect(Number(movementSummary.transfers)).toBe(8);
      expect(Number(movementSummary.movement_total)).toBe(-1);
      await request(app.getHttpServer())
        .get('/api/v1/inventory/movements')
        .query({ document: 'TR-001', pageSize: 10 })
        .set('Cookie', cookie)
        .expect(200)
        .expect(
          ({
            body,
          }: {
            body: {
              data: Array<{
                type: string;
                correlationId: string;
                document: { type: string; id: string };
              }>;
            };
          }) => {
            expect(body.data).toHaveLength(4);
            expect(body.data.map(({ type }) => type).sort()).toEqual([
              'TRANSFER_DISCREPANCY',
              'TRANSFER_IN',
              'TRANSFER_RECEIPT',
              'TRANSFER_RECEIPT',
            ]);
            expect(
              body.data.every(
                ({ correlationId }) => correlationId === transferId,
              ),
            ).toBe(true);
            expect(body.data.map(({ document }) => document.type)).toContain(
              'RECEIPT',
            );
            expect(
              body.data
                .filter(({ document }) => document.type === 'RECEIPT')
                .every(({ document }) => document.id !== transferId),
            ).toBe(true);
          },
        );
    });

    it('rejects products and locations outside the active tenant', async () => {
      await registerAccount('inventory-isolation-primary');
      const primaryCookie = await createPersistedSession(
        registrationPayload.email,
      );
      await completeInventoryOnboarding(
        registrationPayload.email,
        primaryCookie,
      );
      const productResponse = await request(app.getHttpServer())
        .post('/api/v1/products')
        .set('Cookie', primaryCookie)
        .send({ name: 'Café', sku: 'ISOLATED-1', cost: '1.00', price: '2.00' })
        .expect(201);
      const productId = (productResponse.body as { data: { id: string } }).data
        .id;

      const primaryOrganization = await request(app.getHttpServer())
        .get('/api/v1/organization/branches')
        .set('Cookie', primaryCookie)
        .expect(200);
      const primaryLocationId = (
        primaryOrganization.body as {
          data: Array<{
            warehouses: Array<{ locations: Array<{ id: string }> }>;
          }>;
        }
      ).data[0].warehouses[0].locations[0].id;

      const secondary = {
        organizationName: 'Otra Tienda',
        email: 'other-inventory@example.com',
        password: registrationPayload.password,
      };
      await request(app.getHttpServer())
        .post('/api/v1/auth/registrations')
        .set('Idempotency-Key', 'inventory-isolation-secondary')
        .send(secondary)
        .expect(201);
      const secondaryCookie = await createPersistedSession(secondary.email);
      await completeInventoryOnboarding(secondary.email, secondaryCookie);
      const [foreignLocation] = await dataSource.query<
        Array<{ id: string; warehouse_id: string; branch_id: string }>
      >(
        `SELECT l.id, l.warehouse_id, w.branch_id FROM locations l
         INNER JOIN warehouses w ON w.id = l.warehouse_id AND w.tenant_id = l.tenant_id
         INNER JOIN users u ON u.tenant_id = l.tenant_id
         WHERE u.normalized_email = ? LIMIT 1`,
        [secondary.email],
      );
      const foreignDestinationResponse = await request(app.getHttpServer())
        .post('/api/v1/organization/branches')
        .set('Cookie', secondaryCookie)
        .send({
          name: 'Destino aislado',
          timezone: 'America/Mexico_City',
          warehouseName: 'Bodega destino aislada',
          locationName: 'Recepcion aislada',
          locationCode: 'ISO-DEST',
        })
        .expect(201);
      const foreignDestination = (
        foreignDestinationResponse.body as {
          data: {
            warehouses: Array<{ id: string; locations: Array<{ id: string }> }>;
          };
        }
      ).data.warehouses[0];
      const foreignProductResponse = await request(app.getHttpServer())
        .post('/api/v1/products')
        .set('Cookie', secondaryCookie)
        .send({
          name: 'Producto de otro tenant',
          sku: 'FOREIGN-TRANSFER',
          cost: '1.00',
          price: '2.00',
        })
        .expect(201);
      const foreignProductId = (
        foreignProductResponse.body as { data: { id: string } }
      ).data.id;
      const foreignTransferResponse = await request(app.getHttpServer())
        .post('/api/v1/inventory/transfers')
        .set('Cookie', secondaryCookie)
        .set('Idempotency-Key', 'foreign-transfer-create')
        .send({
          destinationWarehouseId: foreignDestination.id,
          reference: 'FOREIGN-001',
          reason: 'Transferencia de otro tenant',
          lines: [
            {
              productId: foreignProductId,
              sourceLocationId: foreignLocation.id,
              destinationLocationId: foreignDestination.locations[0].id,
              quantity: '1',
            },
          ],
        })
        .expect(201);
      const foreignTransferData = foreignTransferResponse.body as {
        data: { id: string; lines: Array<{ id: string }> };
      };
      const foreignTransferId = foreignTransferData.data.id;
      const foreignTransferLineId = foreignTransferData.data.lines[0].id;

      const foreignContext = await request(app.getHttpServer())
        .patch('/api/v1/auth/sessions/current/context')
        .set('Cookie', primaryCookie)
        .send({
          branchId: foreignLocation.branch_id,
          warehouseId: foreignLocation.warehouse_id,
        })
        .expect(404);
      const missingContext = await request(app.getHttpServer())
        .patch('/api/v1/auth/sessions/current/context')
        .set('Cookie', primaryCookie)
        .send({ branchId: randomUUID(), warehouseId: randomUUID() })
        .expect(404);
      expect(foreignContext.body).toEqual(missingContext.body);

      const foreignTransfer = await request(app.getHttpServer())
        .get(`/api/v1/inventory/transfers/${foreignTransferId}`)
        .set('Cookie', primaryCookie)
        .expect(404);
      const missingTransfer = await request(app.getHttpServer())
        .get(`/api/v1/inventory/transfers/${randomUUID()}`)
        .set('Cookie', primaryCookie)
        .expect(404);
      expect(foreignTransfer.body).toEqual(missingTransfer.body);

      const foreignReceipt = await request(app.getHttpServer())
        .post(`/api/v1/inventory/transfers/${foreignTransferId}/receipts`)
        .set('Cookie', primaryCookie)
        .set('Idempotency-Key', 'inventory-foreign-receipt')
        .send({
          lines: [
            {
              transferLineId: foreignTransferLineId,
              receivedQuantity: '1',
              discrepancyQuantity: '0',
            },
          ],
        })
        .expect(404);
      const missingReceipt = await request(app.getHttpServer())
        .post(`/api/v1/inventory/transfers/${randomUUID()}/receipts`)
        .set('Cookie', primaryCookie)
        .set('Idempotency-Key', 'inventory-missing-receipt')
        .send({
          lines: [
            {
              transferLineId: randomUUID(),
              receivedQuantity: '1',
              discrepancyQuantity: '0',
            },
          ],
        })
        .expect(404);
      expect(foreignReceipt.body).toEqual(missingReceipt.body);

      const invalidTransferInput = (destinationWarehouseId: string) => ({
        destinationWarehouseId,
        reference: 'ISOLATION-001',
        reason: 'No debe revelar recursos externos',
        lines: [
          {
            productId,
            sourceLocationId: primaryLocationId,
            destinationLocationId: foreignDestination.locations[0].id,
            quantity: '1',
          },
        ],
      });
      const foreignTransferAttempt = await request(app.getHttpServer())
        .post('/api/v1/inventory/transfers')
        .set('Cookie', primaryCookie)
        .set('Idempotency-Key', 'inventory-foreign-transfer')
        .send(invalidTransferInput(foreignDestination.id))
        .expect(400);
      const missingTransferAttempt = await request(app.getHttpServer())
        .post('/api/v1/inventory/transfers')
        .set('Cookie', primaryCookie)
        .set('Idempotency-Key', 'inventory-missing-transfer')
        .send(invalidTransferInput(randomUUID()))
        .expect(400);
      expect(foreignTransferAttempt.body).toEqual(missingTransferAttempt.body);

      const organizations = await request(app.getHttpServer())
        .get('/api/v1/organization/branches')
        .set('Cookie', primaryCookie)
        .expect(200);
      expect(
        (organizations.body as { data: Array<{ id: string }> }).data.map(
          ({ id }) => id,
        ),
      ).not.toContain(foreignLocation.branch_id);

      await request(app.getHttpServer())
        .post('/api/v1/inventory/movements')
        .set('Cookie', primaryCookie)
        .set('Idempotency-Key', 'inventory-foreign-location')
        .send({
          productId,
          locationId: foreignLocation.id,
          type: 'INITIAL',
          quantity: '1',
          reason: 'No autorizado',
        })
        .expect(404);
      await request(app.getHttpServer())
        .get('/api/v1/inventory/stock')
        .query({
          branchId: foreignLocation.branch_id,
          warehouseId: foreignLocation.warehouse_id,
        })
        .set('Cookie', primaryCookie)
        .expect(404);
      await request(app.getHttpServer())
        .get('/api/v1/inventory/movements')
        .set('Cookie', primaryCookie)
        .expect(200)
        .expect(({ body }: { body: { data: unknown[] } }) => {
          expect(body.data).toEqual([]);
        });
    });

    it('previews CSV/XLSX and confirms an atomic, tenant-scoped, retryable stock import', async () => {
      await registerAccount('inventory-import-registration');
      const cookie = await createPersistedSession(registrationPayload.email);
      await completeInventoryOnboarding(registrationPayload.email, cookie);
      await request(app.getHttpServer())
        .post('/api/v1/products')
        .set('Cookie', cookie)
        .send({
          name: 'Café importado',
          sku: 'IMPORT-CAFE',
          cost: '10.00',
          price: '15.00',
        })
        .expect(201);
      const [scope] = await dataSource.query<
        Array<{
          product_id: string;
          location_id: string;
          location_code: string;
        }>
      >(
        `SELECT p.id AS product_id, l.id AS location_id, l.code AS location_code
         FROM products p
         INNER JOIN locations l ON l.tenant_id = p.tenant_id
         INNER JOIN users u ON u.tenant_id = p.tenant_id
         WHERE u.normalized_email = ? AND p.normalized_sku = 'IMPORT-CAFE' LIMIT 1`,
        [registrationPayload.email],
      );
      const csv = [
        'sku,location,quantity,state,reason',
        `IMPORT-CAFE,${scope.location_code},10,AVAILABLE,Conteo inicial`,
        `IMPORT-CAFE,${scope.location_code},2,DAMAGED,Producto dañado`,
      ].join('\n');
      const preview = await request(app.getHttpServer())
        .post('/api/v1/inventory/imports/preview')
        .set('Cookie', cookie)
        .field('mode', 'INITIAL')
        .attach('file', Buffer.from(csv), {
          filename: 'stock-inicial.csv',
          contentType: 'text/csv',
        })
        .expect(201);
      expect(preview.body).toMatchObject({
        data: {
          mode: 'INITIAL',
          status: 'PREVIEWED',
          policy: 'ATOMIC',
          canConfirm: true,
          summary: { rows: 2, validRows: 2, errorRows: 0, movements: null },
          rows: [
            {
              state: 'AVAILABLE',
              targetQuantity: '10.000',
              currentQuantity: '0.000',
              difference: '10.000',
              errors: [],
            },
            {
              state: 'DAMAGED',
              targetQuantity: '2.000',
              currentQuantity: '0.000',
              difference: '2.000',
              errors: [],
            },
          ],
        },
      });
      const importId = (preview.body as { data: { id: string } }).data.id;

      const confirmed = await request(app.getHttpServer())
        .post(`/api/v1/inventory/imports/${importId}/confirm`)
        .set('Cookie', cookie)
        .set('Idempotency-Key', 'inventory-import-confirm-001')
        .expect(201);
      expect(confirmed.body).toMatchObject({
        data: {
          id: importId,
          status: 'CONFIRMED',
          canConfirm: false,
          summary: { rows: 2, movements: 2 },
        },
        meta: { idempotentReplay: false },
      });
      await request(app.getHttpServer())
        .post(`/api/v1/inventory/imports/${importId}/confirm`)
        .set('Cookie', cookie)
        .set('Idempotency-Key', 'inventory-import-confirm-retry')
        .expect(201)
        .expect(({ body }: { body: unknown }) => {
          expect(body).toMatchObject({
            data: {
              id: importId,
              status: 'CONFIRMED',
              summary: { movements: 2 },
            },
            meta: { idempotentReplay: true },
          });
        });
      await request(app.getHttpServer())
        .get(`/api/v1/inventory/products/${scope.product_id}/balance`)
        .query({ locationId: scope.location_id })
        .set('Cookie', cookie)
        .expect(200)
        .expect(({ body }: { body: unknown }) => {
          expect(body).toMatchObject({
            data: {
              quantity: '12.000',
              states: [
                { code: 'AVAILABLE', quantity: '10.000' },
                { code: 'RESERVED', quantity: '0.000' },
                { code: 'DAMAGED', quantity: '2.000' },
                { code: 'IN_TRANSIT', quantity: '0.000' },
              ],
            },
          });
        });
      await request(app.getHttpServer())
        .get('/api/v1/inventory/movements')
        .set('Cookie', cookie)
        .expect(200)
        .expect(
          ({
            body,
          }: {
            body: {
              data: Array<{
                type: string;
                correlationId: string;
                document: { type: string; id: string };
              }>;
            };
          }) => {
            expect(
              body.data.some(
                (movement) =>
                  movement.type === 'IMPORT' &&
                  movement.correlationId === importId &&
                  movement.document.type === 'IMPORT' &&
                  movement.document.id === importId,
              ),
            ).toBe(true);
          },
        );

      const invalidCsv = [
        'sku;ubicacion;cantidad;estado;motivo',
        `IMPORT-CAFE;${scope.location_code};20;AVAILABLE;Conteo válido`,
        `NO-EXISTE;${scope.location_code};5;AVAILABLE;Fila inválida`,
      ].join('\n');
      const invalidPreview = await request(app.getHttpServer())
        .post('/api/v1/inventory/imports/preview')
        .set('Cookie', cookie)
        .field('mode', 'COUNT')
        .attach('file', Buffer.from(invalidCsv), 'conteo.csv')
        .expect(201);
      expect(invalidPreview.body).toMatchObject({
        data: {
          policy: 'ATOMIC',
          canConfirm: false,
          summary: { rows: 2, validRows: 1, errorRows: 1 },
        },
      });
      const invalidImportId = (invalidPreview.body as { data: { id: string } })
        .data.id;
      await request(app.getHttpServer())
        .post(`/api/v1/inventory/imports/${invalidImportId}/confirm`)
        .set('Cookie', cookie)
        .set('Idempotency-Key', 'inventory-import-invalid')
        .expect(409)
        .expect(({ body }: { body: { code?: string } }) => {
          expect(body.code).toBe('INVENTORY_IMPORT_HAS_ERRORS');
        });

      const staleCsv = [
        'sku,location,quantity,state,reason',
        `IMPORT-CAFE,${scope.location_code},15,AVAILABLE,Conteo físico`,
      ].join('\n');
      const stalePreview = await request(app.getHttpServer())
        .post('/api/v1/inventory/imports/preview')
        .set('Cookie', cookie)
        .field('mode', 'COUNT')
        .attach('file', Buffer.from(staleCsv), 'conteo-stale.csv')
        .expect(201);
      const staleImportId = (stalePreview.body as { data: { id: string } }).data
        .id;
      await request(app.getHttpServer())
        .post('/api/v1/inventory/movements')
        .set('Cookie', cookie)
        .set('Idempotency-Key', 'inventory-import-concurrent-entry')
        .send({
          productId: scope.product_id,
          locationId: scope.location_id,
          type: 'ENTRY',
          quantity: '1',
          reason: 'Entrada concurrente',
          reference: 'RECEPCION-CONCURRENTE',
        })
        .expect(201);
      await request(app.getHttpServer())
        .post(`/api/v1/inventory/imports/${staleImportId}/confirm`)
        .set('Cookie', cookie)
        .set('Idempotency-Key', 'inventory-import-stale')
        .expect(409)
        .expect(({ body }: { body: { code?: string } }) => {
          expect(body.code).toBe('INVENTORY_IMPORT_STALE');
        });

      const workbook = new ExcelJS.Workbook();
      const sheet = workbook.addWorksheet('Conteo');
      sheet.addRow(['sku', 'location', 'quantity', 'state', 'reason']);
      sheet.addRow([
        'IMPORT-CAFE',
        scope.location_code,
        '11',
        'AVAILABLE',
        'Vista previa Excel',
      ]);
      const xlsx = await workbook.xlsx.writeBuffer();
      await request(app.getHttpServer())
        .post('/api/v1/inventory/imports/preview')
        .set('Cookie', cookie)
        .field('mode', 'COUNT')
        .attach('file', Buffer.from(xlsx), 'conteo.xlsx')
        .expect(201)
        .expect(({ body }: { body: unknown }) => {
          expect(body).toMatchObject({
            data: {
              canConfirm: true,
              summary: { rows: 1, errorRows: 0 },
              rows: [{ currentQuantity: '11.000', difference: '0.000' }],
            },
          });
        });

      const otherEmail = 'otro-importador@example.com';
      await request(app.getHttpServer())
        .post('/api/v1/auth/registrations')
        .set('Idempotency-Key', 'inventory-import-other-registration')
        .send({
          organizationName: 'Otra tienda',
          email: otherEmail,
          password: registrationPayload.password,
        })
        .expect(201);
      const otherCookie = await createPersistedSession(otherEmail);
      await completeInventoryOnboarding(otherEmail, otherCookie);
      await request(app.getHttpServer())
        .get(`/api/v1/inventory/imports/${importId}`)
        .set('Cookie', otherCookie)
        .expect(404);

      const [{ total: importMovements }] = await dataSource.query<
        Array<{ total: number | string }>
      >(
        `SELECT COUNT(*) AS total FROM inventory_movements
         WHERE tenant_id = (SELECT tenant_id FROM users WHERE normalized_email = ?)
           AND inventory_import_id = ?`,
        [registrationPayload.email, importId],
      );
      expect(Number(importMovements)).toBe(2);
    });
  });

  describe('POS cart quote', () => {
    beforeEach(resetIdentityData);

    async function preparePos(openShift = true): Promise<{
      cookie: string;
      productId: string;
      locationId: string;
    }> {
      await registerAccount('pos-cart-registration');
      const cookie = await createPersistedSession(registrationPayload.email);
      await request(app.getHttpServer())
        .put('/api/v1/onboarding/company')
        .set('Cookie', cookie)
        .send({
          legalName: 'Tienda POS Legal',
          tradeName: 'Tienda POS',
          countryCode: 'MX',
        })
        .expect(200);
      await request(app.getHttpServer())
        .put('/api/v1/onboarding/initial-location')
        .set('Cookie', cookie)
        .send({
          branchName: 'Sucursal POS',
          timezone: 'America/Mexico_City',
          warehouseName: 'Bodega POS',
          locationName: 'General POS',
        })
        .expect(200);
      await request(app.getHttpServer())
        .put('/api/v1/onboarding/initial-cash-register')
        .set('Cookie', cookie)
        .send({ name: 'Caja POS' })
        .expect(200);
      const productResponse = await request(app.getHttpServer())
        .post('/api/v1/products')
        .set('Cookie', cookie)
        .send({
          name: 'Café POS',
          sku: 'CAFE-POS',
          barcode: '7501234500000',
          cost: '80.00',
          price: '119.90',
        })
        .expect(201);
      const productId = (productResponse.body as { data: { id: string } }).data
        .id;
      const [location] = await dataSource.query<Array<{ id: string }>>(
        `SELECT l.id FROM locations l
         INNER JOIN users u ON u.tenant_id = l.tenant_id
         WHERE u.normalized_email = ? LIMIT 1`,
        [registrationPayload.email],
      );
      await request(app.getHttpServer())
        .post('/api/v1/inventory/movements')
        .set('Cookie', cookie)
        .set('Idempotency-Key', 'pos-initial-stock')
        .send({
          productId,
          locationId: location.id,
          type: 'INITIAL',
          quantity: '5',
          reason: 'Stock para POS',
        })
        .expect(201);
      if (openShift) {
        await openCurrentCashRegister(cookie, 'pos-open-shift', '250.00');
      }
      return { cookie, productId, locationId: location.id };
    }

    it('manages tenant customers and associates an optional active customer to sales', async () => {
      const { cookie, productId } = await preparePos();
      await request(app.getHttpServer())
        .post('/api/v1/customers')
        .set('Cookie', cookie)
        .send({
          name: 'Sin consentimiento',
          email: 'private@example.com',
          dataProcessingConsent: false,
        })
        .expect(400)
        .expect(({ body }: { body: { code?: string } }) => {
          expect(body.code).toBe('CUSTOMER_CONSENT_REQUIRED');
        });

      let customer!: { id: string; version: number };
      await request(app.getHttpServer())
        .post('/api/v1/customers')
        .set('Cookie', cookie)
        .send({
          name: 'Ana Pérez',
          identifier: 'CLI-001',
          email: 'Ana@example.com',
          phone: '+52 55 1234 5678',
          dataProcessingConsent: true,
        })
        .expect(201)
        .expect(({ body }: { body: { data: typeof customer } }) => {
          customer = body.data;
        });
      await request(app.getHttpServer())
        .post('/api/v1/customers')
        .set('Cookie', cookie)
        .send({
          name: 'Duplicada',
          email: 'ana@example.com',
          dataProcessingConsent: true,
        })
        .expect(409)
        .expect(({ body }: { body: { code?: string } }) => {
          expect(body.code).toBe('CUSTOMER_DUPLICATE');
        });
      await request(app.getHttpServer())
        .get('/api/v1/customers')
        .query({ q: '55 1234', status: 'ACTIVE', page: 1, pageSize: 10 })
        .set('Cookie', cookie)
        .expect(200)
        .expect(({ body }: { body: unknown }) => {
          expect(body).toMatchObject({
            data: [
              { id: customer.id, name: 'Ana Pérez', email: 'ana@example.com' },
            ],
            meta: { pagination: { total: 1 } },
          });
        });
      await request(app.getHttpServer())
        .patch(`/api/v1/customers/${customer.id}`)
        .set('Cookie', cookie)
        .send({
          version: customer.version,
          name: 'Ana Pérez López',
          identifier: 'CLI-001',
          email: 'ana@example.com',
          phone: '+52 55 1234 5678',
          dataProcessingConsent: true,
          active: true,
        })
        .expect(200)
        .expect(({ body }: { body: unknown }) => {
          expect(body).toMatchObject({
            data: { version: 2, name: 'Ana Pérez López' },
          });
        });

      const anonymousSale = await request(app.getHttpServer())
        .post('/api/v1/pos/sales/cash')
        .set('Cookie', cookie)
        .set('Idempotency-Key', 'customer-anonymous-sale')
        .send({ lines: [{ productId, quantity: '1' }], cashReceived: '120.00' })
        .expect(201);
      expect(anonymousSale.body).toMatchObject({ data: { customer: null } });
      const customerSale = await request(app.getHttpServer())
        .post('/api/v1/pos/sales/cash')
        .set('Cookie', cookie)
        .set('Idempotency-Key', 'customer-linked-sale')
        .send({
          customerId: customer.id,
          lines: [{ productId, quantity: '1' }],
          cashReceived: '120.00',
        })
        .expect(201);
      expect(customerSale.body).toMatchObject({
        data: {
          customer: {
            id: customer.id,
            name: 'Ana Pérez López',
            identifier: 'CLI-001',
          },
        },
      });
      const customerSaleId = (customerSale.body as { data: { id: string } })
        .data.id;

      await request(app.getHttpServer())
        .delete(`/api/v1/customers/${customer.id}`)
        .set('Cookie', cookie)
        .expect(200)
        .expect(({ body }: { body: unknown }) => {
          expect(body).toMatchObject({ data: { active: false, version: 3 } });
        });
      await request(app.getHttpServer())
        .post('/api/v1/pos/sales/cash')
        .set('Cookie', cookie)
        .set('Idempotency-Key', 'inactive-customer-sale')
        .send({
          customerId: customer.id,
          lines: [{ productId, quantity: '1' }],
          cashReceived: '120.00',
        })
        .expect(400)
        .expect(({ body }: { body: { code?: string } }) => {
          expect(body.code).toBe('POS_CUSTOMER_NOT_AVAILABLE');
        });
      await request(app.getHttpServer())
        .get(`/api/v1/pos/sales/${customerSaleId}`)
        .set('Cookie', cookie)
        .expect(200)
        .expect(({ body }: { body: unknown }) => {
          expect(body).toMatchObject({
            data: { customer: { id: customer.id, name: 'Ana Pérez López' } },
          });
        });
      await request(app.getHttpServer())
        .get('/api/v1/audit-events')
        .query({ entityType: 'CUSTOMER', page: 1, pageSize: 10 })
        .set('Cookie', cookie)
        .expect(200)
        .expect(({ body }: { body: { data: Array<{ action: string }> } }) => {
          expect(body.data.map(({ action }) => action)).toEqual(
            expect.arrayContaining([
              'CUSTOMER_CREATED',
              'CUSTOMER_UPDATED',
              'CUSTOMER_DEACTIVATED',
            ]),
          );
          expect(JSON.stringify(body.data)).not.toContain('ana@example.com');
          expect(JSON.stringify(body.data)).not.toContain('+52 55 1234 5678');
        });

      const other = {
        organizationName: 'Otra empresa clientes',
        email: 'other-customers@example.com',
        password: registrationPayload.password,
      };
      await request(app.getHttpServer())
        .post('/api/v1/auth/registrations')
        .set('Idempotency-Key', 'other-customers-registration')
        .send(other)
        .expect(201);
      const otherCookie = await createPersistedSession(other.email);
      await request(app.getHttpServer())
        .put('/api/v1/onboarding/company')
        .set('Cookie', otherCookie)
        .send({
          legalName: 'Otra empresa clientes Legal',
          tradeName: 'Otra empresa clientes',
          countryCode: 'MX',
        })
        .expect(200);
      await request(app.getHttpServer())
        .put('/api/v1/onboarding/initial-location')
        .set('Cookie', otherCookie)
        .send({
          branchName: 'Sucursal clientes',
          timezone: 'America/Mexico_City',
          warehouseName: 'Bodega clientes',
          locationName: 'General clientes',
        })
        .expect(200);
      await request(app.getHttpServer())
        .put('/api/v1/onboarding/initial-cash-register')
        .set('Cookie', otherCookie)
        .send({ name: 'Caja clientes' })
        .expect(200);
      await request(app.getHttpServer())
        .get('/api/v1/customers')
        .query({ q: 'Ana', status: 'ALL', page: 1, pageSize: 10 })
        .set('Cookie', otherCookie)
        .expect(200)
        .expect(({ body }: { body: { data: unknown[] } }) => {
          expect(body.data).toEqual([]);
        });
    });

    it('opens one auditable register shift idempotently and requires it for POS operations', async () => {
      const { cookie, productId } = await preparePos(false);
      await request(app.getHttpServer())
        .get('/api/v1/pos/register-shifts/current')
        .set('Cookie', cookie)
        .expect(200)
        .expect(({ body }: { body: { data: unknown } }) => {
          expect(body.data).toBeNull();
        });
      await request(app.getHttpServer())
        .post('/api/v1/pos/cart/quote')
        .set('Cookie', cookie)
        .send({ lines: [{ productId, quantity: '1' }] })
        .expect(409)
        .expect(({ body }: { body: { code?: string } }) => {
          expect(body.code).toBe('CASH_REGISTER_SHIFT_REQUIRED');
        });

      const keys = ['pos-shift-concurrent-a', 'pos-shift-concurrent-b'];
      const openings = await Promise.all(
        keys.map((key) =>
          request(app.getHttpServer())
            .post('/api/v1/pos/register-shifts')
            .set('Cookie', cookie)
            .set('Idempotency-Key', key)
            .send({ openingAmount: '250.00' }),
        ),
      );
      expect(openings.map(({ status }) => status).sort()).toEqual([201, 409]);
      expect(openings.find(({ status }) => status === 409)?.body).toMatchObject(
        { code: 'CASH_REGISTER_ALREADY_OPEN' },
      );
      const successfulIndex = openings.findIndex(
        ({ status }) => status === 201,
      );
      const successful = openings[successfulIndex];
      const successfulBody = successful.body as {
        data: { id: string; openedAt: string };
      };
      expect(successfulBody).toMatchObject({
        data: {
          status: 'OPEN',
          openingAmount: '250.00',
          currency: 'MXN',
          openedBy: { email: registrationPayload.email },
          branch: { name: 'Sucursal POS' },
          cashRegister: { name: 'Caja POS', code: 'MAIN' },
        },
        meta: { apiVersion: '1', idempotentReplay: false },
      });
      expect(successfulBody.data.openedAt).toEqual(expect.any(String));

      await request(app.getHttpServer())
        .post('/api/v1/pos/register-shifts')
        .set('Cookie', cookie)
        .set('Idempotency-Key', keys[successfulIndex])
        .send({ openingAmount: '250.0' })
        .expect(201)
        .expect(({ body }: { body: unknown }) => {
          expect(body).toMatchObject({
            data: { id: successfulBody.data.id },
            meta: { idempotentReplay: true },
          });
        });
      await request(app.getHttpServer())
        .post('/api/v1/pos/register-shifts')
        .set('Cookie', cookie)
        .set('Idempotency-Key', keys[successfulIndex])
        .send({ openingAmount: '251.00' })
        .expect(409)
        .expect(({ body }: { body: { code?: string } }) => {
          expect(body.code).toBe('IDEMPOTENCY_KEY_REUSED');
        });
      await request(app.getHttpServer())
        .get('/api/v1/pos/register-shifts/current')
        .set('Cookie', cookie)
        .expect(200)
        .expect(({ body }: { body: unknown }) => {
          expect(body).toMatchObject({ data: { id: successfulBody.data.id } });
        });
      const [audit] = await dataSource.query<Array<{ total: number | string }>>(
        `SELECT COUNT(*) AS total FROM audit_events
         WHERE action = 'CASH_REGISTER_SHIFT_OPENED' AND entity_id = ?`,
        [successfulBody.data.id],
      );
      expect(Number(audit.total)).toBe(1);
    });

    it('tracks immutable cash movements, expected balance and explicit reversals', async () => {
      const { cookie, productId } = await preparePos();
      await request(app.getHttpServer())
        .post('/api/v1/pos/sales/cash')
        .set('Cookie', cookie)
        .set('Idempotency-Key', 'cash-movement-sale')
        .send({
          lines: [{ productId, quantity: '1' }],
          cashReceived: '120.00',
        })
        .expect(201);

      await request(app.getHttpServer())
        .get('/api/v1/pos/register-shifts/current/movements')
        .set('Cookie', cookie)
        .expect(200)
        .expect(({ body }: { body: unknown }) => {
          expect(body).toMatchObject({
            data: [],
            meta: { currency: 'MXN', expectedCash: '369.90' },
          });
        });

      const income = await request(app.getHttpServer())
        .post('/api/v1/pos/register-shifts/current/movements')
        .set('Cookie', cookie)
        .set('Idempotency-Key', 'cash-income-supplies')
        .send({ type: 'INCOME', amount: '50', reason: 'Fondo adicional' })
        .expect(201);
      const incomeId = (income.body as { data: { id: string } }).data.id;
      expect(income.body).toMatchObject({
        data: {
          type: 'INCOME',
          amount: '50.00',
          reason: 'Fondo adicional',
          responsible: { email: registrationPayload.email },
          reversalOf: null,
          reversed: false,
        },
        meta: { expectedCash: '419.90', idempotentReplay: false },
      });
      await request(app.getHttpServer())
        .post('/api/v1/pos/register-shifts/current/movements')
        .set('Cookie', cookie)
        .set('Idempotency-Key', 'cash-income-supplies')
        .send({ type: 'INCOME', amount: '50.00', reason: 'Fondo adicional' })
        .expect(201)
        .expect(({ body }: { body: unknown }) => {
          expect(body).toMatchObject({
            data: { id: incomeId },
            meta: { expectedCash: '419.90', idempotentReplay: true },
          });
        });
      await request(app.getHttpServer())
        .post('/api/v1/pos/register-shifts/current/movements')
        .set('Cookie', cookie)
        .set('Idempotency-Key', 'cash-income-supplies')
        .send({ type: 'INCOME', amount: '51.00', reason: 'Fondo adicional' })
        .expect(409)
        .expect(({ body }: { body: { code?: string } }) => {
          expect(body.code).toBe('IDEMPOTENCY_KEY_REUSED');
        });

      const withdrawal = await request(app.getHttpServer())
        .post('/api/v1/pos/register-shifts/current/movements')
        .set('Cookie', cookie)
        .set('Idempotency-Key', 'cash-withdrawal-supplier')
        .send({
          type: 'WITHDRAWAL',
          amount: '80.00',
          reason: 'Pago de insumos',
        })
        .expect(201);
      const withdrawalId = (withdrawal.body as { data: { id: string } }).data
        .id;
      expect(withdrawal.body).toMatchObject({
        meta: { expectedCash: '339.90' },
      });

      const incomeReversal = await request(app.getHttpServer())
        .post(
          `/api/v1/pos/register-shifts/current/movements/${incomeId}/reversals`,
        )
        .set('Cookie', cookie)
        .set('Idempotency-Key', 'cash-reverse-income')
        .send({ reason: 'Ingreso capturado por error' })
        .expect(201);
      expect(incomeReversal.body).toMatchObject({
        data: {
          type: 'REVERSAL',
          amount: '50.00',
          reversalOf: {
            id: incomeId,
            type: 'INCOME',
            reason: 'Fondo adicional',
          },
        },
        meta: { expectedCash: '289.90', idempotentReplay: false },
      });
      await request(app.getHttpServer())
        .post(
          `/api/v1/pos/register-shifts/current/movements/${incomeId}/reversals`,
        )
        .set('Cookie', cookie)
        .set('Idempotency-Key', 'cash-reverse-income')
        .send({ reason: 'Ingreso capturado por error' })
        .expect(201)
        .expect(({ body }: { body: unknown }) => {
          expect(body).toMatchObject({ meta: { idempotentReplay: true } });
        });
      await request(app.getHttpServer())
        .post(
          `/api/v1/pos/register-shifts/current/movements/${incomeId}/reversals`,
        )
        .set('Cookie', cookie)
        .set('Idempotency-Key', 'cash-reverse-income-again')
        .send({ reason: 'Segundo intento' })
        .expect(409)
        .expect(({ body }: { body: { code?: string } }) => {
          expect(body.code).toBe('CASH_REGISTER_MOVEMENT_ALREADY_REVERSED');
        });
      await request(app.getHttpServer())
        .post(
          `/api/v1/pos/register-shifts/current/movements/${withdrawalId}/reversals`,
        )
        .set('Cookie', cookie)
        .set('Idempotency-Key', 'cash-reverse-withdrawal')
        .send({ reason: 'Pago cancelado' })
        .expect(201)
        .expect(({ body }: { body: unknown }) => {
          expect(body).toMatchObject({ meta: { expectedCash: '369.90' } });
        });

      const concurrent = await Promise.all(
        ['cash-limit-a', 'cash-limit-b'].map((key) =>
          request(app.getHttpServer())
            .post('/api/v1/pos/register-shifts/current/movements')
            .set('Cookie', cookie)
            .set('Idempotency-Key', key)
            .send({
              type: 'WITHDRAWAL',
              amount: '300.00',
              reason: 'Retiro concurrente',
            }),
        ),
      );
      expect(concurrent.map(({ status }) => status).sort()).toEqual([201, 409]);
      expect(
        concurrent.find(({ status }) => status === 409)?.body,
      ).toMatchObject({
        code: 'INSUFFICIENT_EXPECTED_CASH',
      });

      const history = await request(app.getHttpServer())
        .get('/api/v1/pos/register-shifts/current/movements')
        .set('Cookie', cookie)
        .expect(200);
      expect(history.body).toMatchObject({ meta: { expectedCash: '69.90' } });
      const movements = (
        history.body as {
          data: Array<{ id: string; type: string; reversed: boolean }>;
        }
      ).data;
      expect(movements).toHaveLength(5);
      expect(movements.find(({ id }) => id === incomeId)).toMatchObject({
        reversed: true,
      });
      expect(movements.find(({ id }) => id === withdrawalId)).toMatchObject({
        reversed: true,
      });

      await request(app.getHttpServer())
        .patch(`/api/v1/pos/register-shifts/current/movements/${withdrawalId}`)
        .set('Cookie', cookie)
        .send({ amount: '1.00' })
        .expect(404);
      await request(app.getHttpServer())
        .delete(`/api/v1/pos/register-shifts/current/movements/${withdrawalId}`)
        .set('Cookie', cookie)
        .expect(404);
      const [state] = await dataSource.query<
        Array<{
          sales: number | string;
          movements: number | string;
          audit_events: number | string;
        }>
      >(
        `SELECT (SELECT COUNT(*) FROM sales) AS sales,
                (SELECT COUNT(*) FROM cash_register_movements) AS movements,
                (SELECT COUNT(*) FROM audit_events
                  WHERE action IN ('CASH_REGISTER_MOVEMENT_CREATED',
                    'CASH_REGISTER_MOVEMENT_REVERSED')) AS audit_events`,
      );
      expect({
        sales: Number(state.sales),
        movements: Number(state.movements),
        auditEvents: Number(state.audit_events),
      }).toEqual({ sales: 1, movements: 5, auditEvents: 5 });
    });

    it('closes and audits cash shifts with exact, surplus and shortage counts', async () => {
      const { cookie, productId } = await preparePos();
      await request(app.getHttpServer())
        .post('/api/v1/pos/sales/cash')
        .set('Cookie', cookie)
        .set('Idempotency-Key', 'closure-sale')
        .send({ lines: [{ productId, quantity: '1' }], cashReceived: '120.00' })
        .expect(201);
      await request(app.getHttpServer())
        .post('/api/v1/pos/register-shifts/current/movements')
        .set('Cookie', cookie)
        .set('Idempotency-Key', 'closure-income')
        .send({ type: 'INCOME', amount: '50.00', reason: 'Cambio adicional' })
        .expect(201);
      await request(app.getHttpServer())
        .post('/api/v1/pos/register-shifts/current/movements')
        .set('Cookie', cookie)
        .set('Idempotency-Key', 'closure-withdrawal')
        .send({ type: 'WITHDRAWAL', amount: '20.00', reason: 'Retiro parcial' })
        .expect(201);

      await request(app.getHttpServer())
        .post('/api/v1/pos/register-shifts/current/closure')
        .set('Cookie', cookie)
        .set('Idempotency-Key', 'closure-invalid-denominations')
        .send({
          countedAmount: '399.90',
          denominations: [{ denomination: '200.00', quantity: 2 }],
        })
        .expect(400)
        .expect(({ body }: { body: { code?: string } }) => {
          expect(body.code).toBe('DENOMINATION_TOTAL_MISMATCH');
        });
      await request(app.getHttpServer())
        .post('/api/v1/pos/register-shifts/current/closure')
        .set('Cookie', cookie)
        .set('Idempotency-Key', 'closure-reason-required')
        .send({
          countedAmount: '400.00',
          denominations: [{ denomination: '200.00', quantity: 2 }],
        })
        .expect(400)
        .expect(({ body }: { body: { code?: string } }) => {
          expect(body.code).toBe('CASH_DIFFERENCE_REASON_REQUIRED');
        });

      const keys = ['closure-concurrent-a', 'closure-concurrent-b'];
      const closures = await Promise.all(
        keys.map((key) =>
          request(app.getHttpServer())
            .post('/api/v1/pos/register-shifts/current/closure')
            .set('Cookie', cookie)
            .set('Idempotency-Key', key)
            .send({
              countedAmount: '400.00',
              differenceReason: 'Sobrante de diez centavos',
              denominations: [{ denomination: '200.00', quantity: 2 }],
            }),
        ),
      );
      expect(closures.map(({ status }) => status).sort()).toEqual([201, 409]);
      expect(closures.find(({ status }) => status === 409)?.body).toMatchObject(
        {
          code: 'CASH_REGISTER_ALREADY_CLOSED',
        },
      );
      const successfulIndex = closures.findIndex(
        ({ status }) => status === 201,
      );
      const closureBody = closures[successfulIndex].body as {
        data: { id: string; openedAt: string; closedAt: string };
      };
      expect(closureBody).toMatchObject({
        data: {
          status: 'CLOSED',
          currency: 'MXN',
          openingAmount: '250.00',
          salesCount: 1,
          cashSales: '119.90',
          movementsCount: 2,
          movementsNet: '30.00',
          expectedCash: '399.90',
          countedCash: '400.00',
          difference: '0.10',
          differenceReason: 'Sobrante de diez centavos',
          denominations: [{ denomination: '200.00', quantity: 2 }],
          openedBy: { email: registrationPayload.email },
          closedBy: { email: registrationPayload.email },
        },
      });
      expect(Date.parse(closureBody.data.closedAt)).toBeGreaterThanOrEqual(
        Date.parse(closureBody.data.openedAt),
      );
      await request(app.getHttpServer())
        .post('/api/v1/pos/register-shifts/current/closure')
        .set('Cookie', cookie)
        .set('Idempotency-Key', keys[successfulIndex])
        .send({
          countedAmount: '400.0',
          differenceReason: 'Sobrante de diez centavos',
          denominations: [{ denomination: '200', quantity: 2 }],
        })
        .expect(201)
        .expect(({ body }: { body: unknown }) => {
          expect(body).toMatchObject({
            data: { id: closureBody.data.id },
            meta: { idempotentReplay: true },
          });
        });

      await openCurrentCashRegister(cookie, 'closure-exact-opening', '0.00');
      await request(app.getHttpServer())
        .post('/api/v1/pos/register-shifts/current/closure')
        .set('Cookie', cookie)
        .set('Idempotency-Key', 'closure-exact')
        .send({ countedAmount: '0.00' })
        .expect(201)
        .expect(({ body }: { body: unknown }) => {
          expect(body).toMatchObject({
            data: {
              expectedCash: '0.00',
              countedCash: '0.00',
              difference: '0.00',
              differenceReason: null,
            },
          });
        });

      await openCurrentCashRegister(
        cookie,
        'closure-shortage-opening',
        '10.00',
      );
      const shortage = await request(app.getHttpServer())
        .post('/api/v1/pos/register-shifts/current/closure')
        .set('Cookie', cookie)
        .set('Idempotency-Key', 'closure-shortage')
        .send({
          countedAmount: '5.00',
          differenceReason: 'Faltante verificado',
        })
        .expect(201);
      const shortageId = (shortage.body as { data: { id: string } }).data.id;
      expect(shortage.body).toMatchObject({
        data: {
          expectedCash: '10.00',
          countedCash: '5.00',
          difference: '-5.00',
          differenceReason: 'Faltante verificado',
        },
      });
      await request(app.getHttpServer())
        .get('/api/v1/pos/register-shifts/current')
        .set('Cookie', cookie)
        .expect(200)
        .expect(({ body }: { body: { data: unknown } }) => {
          expect(body.data).toBeNull();
        });
      await request(app.getHttpServer())
        .get('/api/v1/pos/register-shifts/latest-closed')
        .set('Cookie', cookie)
        .expect(200)
        .expect(({ body }: { body: unknown }) => {
          expect(body).toMatchObject({ data: { id: shortageId } });
        });
      await request(app.getHttpServer())
        .post('/api/v1/pos/cart/quote')
        .set('Cookie', cookie)
        .send({ lines: [{ productId, quantity: '1' }] })
        .expect(409)
        .expect(({ body }: { body: { code?: string } }) => {
          expect(body.code).toBe('CASH_REGISTER_SHIFT_REQUIRED');
        });
      await request(app.getHttpServer())
        .post('/api/v1/pos/register-shifts/current/movements')
        .set('Cookie', cookie)
        .set('Idempotency-Key', 'closure-blocked-movement')
        .send({ type: 'INCOME', amount: '1.00', reason: 'No permitido' })
        .expect(409)
        .expect(({ body }: { body: { code?: string } }) => {
          expect(body.code).toBe('CASH_REGISTER_SHIFT_REQUIRED');
        });
      const [audit] = await dataSource.query<Array<{ total: number | string }>>(
        `SELECT COUNT(*) AS total FROM audit_events
         WHERE action = 'CASH_REGISTER_SHIFT_CLOSED'`,
      );
      expect(Number(audit.total)).toBe(3);
    });

    it('recalculates prices, included tax and totals from server data', async () => {
      const { cookie, productId, locationId } = await preparePos();
      await request(app.getHttpServer())
        .post('/api/v1/pos/cart/quote')
        .set('Cookie', cookie)
        .send({
          lines: [{ productId, quantity: '1', total: '0.01' }],
        })
        .expect(400);

      await request(app.getHttpServer())
        .post('/api/v1/pos/cart/quote')
        .set('Cookie', cookie)
        .send({
          lines: [
            { productId, quantity: '1' },
            { productId, quantity: '1.5' },
          ],
        })
        .expect(200)
        .expect(({ body }: { body: unknown }) => {
          expect(body).toMatchObject({
            data: {
              context: {
                branch: { name: 'Sucursal POS' },
                warehouse: { name: 'Bodega POS' },
                cashRegister: { name: 'Caja POS', code: 'MAIN' },
              },
              currency: 'MXN',
              taxRate: '0.1600',
              lines: [
                {
                  product: { id: productId, name: 'Café POS', sku: 'CAFE-POS' },
                  quantity: '2.500',
                  availableQuantity: '5.000',
                  unitPrice: '119.90',
                  subtotal: '258.41',
                  tax: '41.34',
                  total: '299.75',
                },
              ],
              totals: { subtotal: '258.41', tax: '41.34', total: '299.75' },
            },
          });
        });

      const salePayload = {
        lines: [
          { productId, quantity: '1' },
          { productId, quantity: '1.5' },
        ],
        cashReceived: '300.00',
      };
      await request(app.getHttpServer())
        .post('/api/v1/pos/sales/cash')
        .set('Cookie', cookie)
        .send(salePayload)
        .expect(400);
      await request(app.getHttpServer())
        .post('/api/v1/pos/sales/cash')
        .set('Cookie', cookie)
        .set('Idempotency-Key', 'pos-cash-insufficient')
        .send({ ...salePayload, cashReceived: '299.74' })
        .expect(400)
        .expect(({ body }: { body: { code?: string } }) => {
          expect(body.code).toBe('INSUFFICIENT_CASH_RECEIVED');
        });
      const beforeSale = await dataSource.query<
        Array<{ total: number | string }>
      >('SELECT COUNT(*) AS total FROM sales');
      expect(Number(beforeSale[0].total)).toBe(0);

      const completed = await Promise.all(
        [1, 2].map(() =>
          request(app.getHttpServer())
            .post('/api/v1/pos/sales/cash')
            .set('Cookie', cookie)
            .set('Idempotency-Key', 'pos-cash-double-submit')
            .send(salePayload),
        ),
      );
      expect(completed.map(({ status }) => status)).toEqual([201, 201]);
      const saleBodies = completed.map(
        ({ body }) =>
          body as {
            data: { id: string; receiptNumber: string };
            meta: { idempotentReplay: boolean };
          },
      );
      expect(saleBodies[0].data.id).toBe(saleBodies[1].data.id);
      expect(
        saleBodies.map(({ meta }) => meta.idempotentReplay).sort(),
      ).toEqual([false, true]);
      expect(saleBodies[0].data.receiptNumber).toMatch(/^V-[A-F0-9]{12}$/);
      expect(completed[0].body).toMatchObject({
        data: {
          status: 'COMPLETED',
          currency: 'MXN',
          totals: { total: '299.75' },
          payment: {
            method: 'CASH',
            amountReceived: '300.00',
            amountApplied: '299.75',
            change: '0.25',
          },
          context: { cashRegister: { name: 'Caja POS' } },
        },
      });
      await request(app.getHttpServer())
        .post('/api/v1/pos/sales/cash')
        .set('Cookie', cookie)
        .set('Idempotency-Key', 'pos-cash-double-submit')
        .send({ ...salePayload, cashReceived: '301.00' })
        .expect(409)
        .expect(({ body }: { body: { code?: string } }) => {
          expect(body.code).toBe('IDEMPOTENCY_KEY_REUSED');
        });
      const [saleCounts] = await dataSource.query<
        Array<{
          sales: number | string;
          line_count: number | string;
          payments: number | string;
          sale_movements: number | string;
          sales_linked_to_open_shift: number | string;
          balance: string;
        }>
      >(
        `SELECT (SELECT COUNT(*) FROM sales) AS sales,
                (SELECT COUNT(*) FROM sale_lines) AS line_count,
                (SELECT COUNT(*) FROM sale_payments) AS payments,
                (SELECT COUNT(*) FROM inventory_movements WHERE type = 'SALE') AS sale_movements,
                (SELECT COUNT(*) FROM sales s
                  INNER JOIN cash_register_shifts crs
                    ON crs.id = s.cash_register_shift_id AND crs.tenant_id = s.tenant_id
                  WHERE crs.status = 'OPEN') AS sales_linked_to_open_shift,
                (SELECT quantity FROM inventory_balances
                  WHERE product_id = ? AND location_id = ?) AS balance`,
        [productId, locationId],
      );
      expect({
        sales: Number(saleCounts.sales),
        lines: Number(saleCounts.line_count),
        payments: Number(saleCounts.payments),
        saleMovements: Number(saleCounts.sale_movements),
        salesLinkedToOpenShift: Number(saleCounts.sales_linked_to_open_shift),
        balance: saleCounts.balance,
      }).toEqual({
        sales: 1,
        lines: 1,
        payments: 1,
        saleMovements: 1,
        salesLinkedToOpenShift: 1,
        balance: '2.500',
      });
      const [trace] = await dataSource.query<
        Array<{
          sale_id: string;
          sale_line_id: string;
          location_id: string;
          quantity_change: string;
          resulting_quantity: string;
        }>
      >(`SELECT sale_id, sale_line_id, location_id, quantity_change, resulting_quantity
         FROM inventory_movements WHERE type = 'SALE'`);
      expect(trace).toMatchObject({
        sale_id: saleBodies[0].data.id,
        location_id: locationId,
        quantity_change: '-2.500',
        resulting_quantity: '2.500',
      });
      expect(trace.sale_line_id).toBeTruthy();

      await request(app.getHttpServer())
        .get('/api/v1/inventory/movements')
        .query({ productId, type: 'SALE' })
        .set('Cookie', cookie)
        .expect(200)
        .expect(({ body }: { body: unknown }) => {
          expect(body).toMatchObject({
            data: [
              {
                type: 'SALE',
                direction: 'OUT',
                quantityChange: '-2.500',
                resultingQuantity: '2.500',
                reference: saleBodies[0].data.receiptNumber,
                responsible: { email: registrationPayload.email },
              },
            ],
          });
        });

      const history = await request(app.getHttpServer())
        .get('/api/v1/pos/sales')
        .query({
          dateFrom: '2000-01-01',
          dateTo: '2099-12-31',
          page: 1,
          pageSize: 1,
        })
        .set('Cookie', cookie)
        .expect(200);
      const historyBody = history.body as {
        data: Array<{
          id: string;
          receiptNumber: string;
          status: string;
          user: { id: string; email: string };
          cashRegister: { id: string; name: string };
          total: string;
        }>;
        meta: { pagination: { total: number; totalPages: number } };
      };
      expect(historyBody.data).toHaveLength(1);
      expect(historyBody.data[0]).toMatchObject({
        id: saleBodies[0].data.id,
        receiptNumber: saleBodies[0].data.receiptNumber,
        status: 'COMPLETED',
        total: '299.75',
        user: { email: registrationPayload.email },
        cashRegister: { name: 'Caja POS' },
      });
      expect(historyBody.meta.pagination).toMatchObject({
        total: 1,
        totalPages: 1,
      });
      for (const filter of [
        { dateFrom: '2099-01-01' },
        { cashRegisterId: randomUUID() },
        { userId: randomUUID() },
      ]) {
        await request(app.getHttpServer())
          .get('/api/v1/pos/sales')
          .query(filter)
          .set('Cookie', cookie)
          .expect(200)
          .expect(({ body }: { body: { data: unknown[] } }) => {
            expect(body.data).toEqual([]);
          });
      }
      await request(app.getHttpServer())
        .get(`/api/v1/pos/sales/${saleBodies[0].data.id}`)
        .set('Cookie', cookie)
        .expect(200)
        .expect(({ body }: { body: unknown }) => {
          expect(body).toMatchObject({
            data: {
              id: saleBodies[0].data.id,
              lines: [{ product: { id: productId }, quantity: '2.500' }],
              payment: { method: 'CASH', change: '0.25' },
              user: { email: registrationPayload.email },
              context: { cashRegister: { name: 'Caja POS' } },
              movements: [
                {
                  product: { id: productId },
                  location: { id: locationId },
                  quantityChange: '-2.500',
                  resultingQuantity: '2.500',
                  reference: saleBodies[0].data.receiptNumber,
                },
              ],
            },
          });
        });

      await request(app.getHttpServer())
        .patch(`/api/v1/products/${productId}`)
        .set('Cookie', cookie)
        .send({
          name: 'Café POS actualizado',
          sku: 'CAFE-POS-NUEVO',
          barcode: '7501234500001',
          cost: '90.00',
          price: '140.00',
          version: 1,
        })
        .expect(200);
      await request(app.getHttpServer())
        .get(`/api/v1/pos/sales/${saleBodies[0].data.id}`)
        .set('Cookie', cookie)
        .expect(200)
        .expect(({ body }: { body: unknown }) => {
          expect(body).toMatchObject({
            data: {
              lines: [
                {
                  product: { name: 'Café POS', sku: 'CAFE-POS' },
                  unitPrice: '119.90',
                },
              ],
              totals: { total: '299.75' },
            },
          });
        });
    });

    it('voids a sale once with payment, stock, cash and audit compensation', async () => {
      const { cookie, productId, locationId } = await preparePos();
      const sale = await request(app.getHttpServer())
        .post('/api/v1/pos/sales/cash')
        .set('Cookie', cookie)
        .set('Idempotency-Key', 'sale-to-void')
        .send({
          lines: [{ productId, quantity: '2' }],
          cashReceived: '240.00',
        })
        .expect(201);
      const saleId = (sale.body as { data: { id: string } }).data.id;
      const [principal] = await dataSource.query<
        Array<{ id: string; tenant_id: string; role_id: string }>
      >(
        `SELECT u.id, u.tenant_id, ur.role_id FROM users u
         INNER JOIN user_roles ur ON ur.user_id = u.id AND ur.tenant_id = u.tenant_id
         WHERE u.normalized_email = ? LIMIT 1`,
        [registrationPayload.email],
      );

      await dataSource.query(
        `DELETE FROM role_permissions
         WHERE role_id = ? AND tenant_id = ? AND permission = 'SALES_VOID'`,
        [principal.role_id, principal.tenant_id],
      );
      await request(app.getHttpServer())
        .post(`/api/v1/pos/sales/${saleId}/void`)
        .set('Cookie', cookie)
        .set('Idempotency-Key', 'sale-void-without-permission')
        .send({ reason: 'Error de captura' })
        .expect(403)
        .expect(({ body }: { body: { code?: string } }) => {
          expect(body.code).toBe('PERMISSION_DENIED');
        });
      await dataSource.query(
        `INSERT INTO role_permissions (role_id, tenant_id, permission)
         VALUES (?, ?, 'SALES_VOID')`,
        [principal.role_id, principal.tenant_id],
      );
      await request(app.getHttpServer())
        .post(`/api/v1/pos/sales/${saleId}/void`)
        .set('Cookie', cookie)
        .set('Idempotency-Key', 'sale-void-invalid-reason')
        .send({ reason: ' ' })
        .expect(400);

      const voided = await Promise.all(
        [1, 2].map(() =>
          request(app.getHttpServer())
            .post(`/api/v1/pos/sales/${saleId}/void`)
            .set('Cookie', cookie)
            .set('X-Request-Id', 'sale-void-audit')
            .set('Idempotency-Key', 'sale-void-double-submit')
            .send({ reason: 'Error de captura confirmado' }),
        ),
      );
      expect(voided.map(({ status }) => status)).toEqual([201, 201]);
      expect(
        voided
          .map(
            ({ body }) =>
              (body as { meta: { idempotentReplay: boolean } }).meta
                .idempotentReplay,
          )
          .sort(),
      ).toEqual([false, true]);
      expect(voided[0].body).toMatchObject({
        data: {
          id: saleId,
          status: 'VOIDED',
          payment: { status: 'REVERSED', amountApplied: '239.80' },
          void: {
            reason: 'Error de captura confirmado',
            user: { id: principal.id, email: registrationPayload.email },
          },
          movements: [
            { type: 'SALE', quantityChange: '-2.000' },
            { type: 'SALE_VOID', quantityChange: '2.000' },
          ],
        },
      });
      await request(app.getHttpServer())
        .post(`/api/v1/pos/sales/${saleId}/void`)
        .set('Cookie', cookie)
        .set('Idempotency-Key', 'sale-void-double-submit')
        .send({ reason: 'Motivo distinto' })
        .expect(409)
        .expect(({ body }: { body: { code?: string } }) => {
          expect(body.code).toBe('IDEMPOTENCY_KEY_REUSED');
        });
      await request(app.getHttpServer())
        .post(`/api/v1/pos/sales/${saleId}/void`)
        .set('Cookie', cookie)
        .set('Idempotency-Key', 'sale-void-second-key')
        .send({ reason: 'Segundo intento' })
        .expect(409)
        .expect(({ body }: { body: { code?: string } }) => {
          expect(body.code).toBe('SALE_ALREADY_VOIDED');
        });

      const [state] = await dataSource.query<
        Array<{
          sales: number | string;
          reversed_payments: number | string;
          sale_void_movements: number | string;
          balance: string;
          audit_events: number | string;
          before_data: string | { status: string };
          after_data: string | { status: string; reason: string };
        }>
      >(
        `SELECT (SELECT COUNT(*) FROM sales) AS sales,
                (SELECT COUNT(*) FROM sale_payments WHERE status = 'REVERSED') AS reversed_payments,
                (SELECT COUNT(*) FROM inventory_movements WHERE type = 'SALE_VOID') AS sale_void_movements,
                (SELECT quantity FROM inventory_balances
                  WHERE product_id = ? AND location_id = ?) AS balance,
                (SELECT COUNT(*) FROM audit_events WHERE action = 'SALE_VOIDED') AS audit_events,
                (SELECT before_data FROM audit_events WHERE action = 'SALE_VOIDED' LIMIT 1) AS before_data,
                (SELECT after_data FROM audit_events WHERE action = 'SALE_VOIDED' LIMIT 1) AS after_data`,
        [productId, locationId],
      );
      const before =
        typeof state.before_data === 'string'
          ? (JSON.parse(state.before_data) as { status: string })
          : state.before_data;
      const after =
        typeof state.after_data === 'string'
          ? (JSON.parse(state.after_data) as { status: string; reason: string })
          : state.after_data;
      expect({
        sales: Number(state.sales),
        reversedPayments: Number(state.reversed_payments),
        saleVoidMovements: Number(state.sale_void_movements),
        balance: state.balance,
        auditEvents: Number(state.audit_events),
        before,
        after,
      }).toEqual({
        sales: 1,
        reversedPayments: 1,
        saleVoidMovements: 1,
        balance: '5.000',
        auditEvents: 1,
        before: { status: 'COMPLETED', paymentStatus: 'COMPLETED' },
        after: {
          status: 'VOIDED',
          paymentStatus: 'REVERSED',
          reason: 'Error de captura confirmado',
          restoredMovementCount: 1,
        },
      });
      await request(app.getHttpServer())
        .get('/api/v1/pos/register-shifts/current/movements')
        .set('Cookie', cookie)
        .expect(200)
        .expect(({ body }: { body: unknown }) => {
          expect(body).toMatchObject({ meta: { expectedCash: '250.00' } });
        });
      await request(app.getHttpServer())
        .get('/api/v1/inventory/movements')
        .query({ productId, type: 'SALE_VOID' })
        .set('Cookie', cookie)
        .expect(200)
        .expect(({ body }: { body: unknown }) => {
          expect(body).toMatchObject({
            data: [
              {
                type: 'SALE_VOID',
                direction: 'IN',
                quantityChange: '2.000',
                responsible: { email: registrationPayload.email },
                document: { type: 'SALE', id: saleId },
              },
            ],
          });
        });

      const laterSale = await request(app.getHttpServer())
        .post('/api/v1/pos/sales/cash')
        .set('Cookie', cookie)
        .set('Idempotency-Key', 'sale-after-void')
        .send({
          lines: [{ productId, quantity: '1' }],
          cashReceived: '120.00',
        })
        .expect(201);
      const laterSaleId = (laterSale.body as { data: { id: string } }).data.id;
      await request(app.getHttpServer())
        .post('/api/v1/pos/register-shifts/current/closure')
        .set('Cookie', cookie)
        .set('Idempotency-Key', 'sale-void-close-shift')
        .send({ countedAmount: '369.90' })
        .expect(201);
      await request(app.getHttpServer())
        .post(`/api/v1/pos/sales/${laterSaleId}/void`)
        .set('Cookie', cookie)
        .set('Idempotency-Key', 'sale-void-after-close')
        .send({ reason: 'Turno ya cerrado' })
        .expect(409)
        .expect(({ body }: { body: { code?: string } }) => {
          expect(body.code).toBe('SALE_VOID_NOT_ALLOWED');
        });
      const [laterState] = await dataSource.query<
        Array<{ status: string; balance: string }>
      >(
        `SELECT s.status,
                (SELECT quantity FROM inventory_balances
                  WHERE product_id = ? AND location_id = ?) AS balance
         FROM sales s WHERE s.id = ?`,
        [productId, locationId, laterSaleId],
      );
      expect(laterState).toEqual({ status: 'COMPLETED', balance: '4.000' });
    });

    it('does not expose a sale outside the active branch', async () => {
      const { cookie, productId } = await preparePos();
      const sale = await request(app.getHttpServer())
        .post('/api/v1/pos/sales/cash')
        .set('Cookie', cookie)
        .set('Idempotency-Key', 'pos-history-branch-scope')
        .send({
          lines: [{ productId, quantity: '1' }],
          cashReceived: '120.00',
        })
        .expect(201);
      const saleId = (sale.body as { data: { id: string } }).data.id;
      const [principal] = await dataSource.query<Array<{ tenant_id: string }>>(
        'SELECT tenant_id FROM users WHERE normalized_email = ? LIMIT 1',
        [registrationPayload.email],
      );
      const branchId = randomUUID();
      const warehouseId = randomUUID();
      const cashRegisterId = randomUUID();
      await dataSource.query(
        `INSERT INTO branches (id, tenant_id, name, timezone)
         VALUES (?, ?, 'Sucursal Alterna', 'America/Mexico_City')`,
        [branchId, principal.tenant_id],
      );
      await dataSource.query(
        `INSERT INTO warehouses (id, tenant_id, branch_id, name)
         VALUES (?, ?, ?, 'Bodega Alterna')`,
        [warehouseId, principal.tenant_id, branchId],
      );
      await dataSource.query(
        `INSERT INTO cash_registers (id, tenant_id, branch_id, name, code)
         VALUES (?, ?, ?, 'Caja Alterna', 'ALT')`,
        [cashRegisterId, principal.tenant_id, branchId],
      );
      await dataSource.query(
        `UPDATE sessions SET active_branch_id = ?, active_warehouse_id = ?,
          active_cash_register_id = ? WHERE tenant_id = ?`,
        [branchId, warehouseId, cashRegisterId, principal.tenant_id],
      );

      await request(app.getHttpServer())
        .get('/api/v1/pos/sales')
        .set('Cookie', cookie)
        .expect(200)
        .expect(({ body }: { body: { data: unknown[] } }) => {
          expect(body.data).toEqual([]);
        });
      await request(app.getHttpServer())
        .get(`/api/v1/pos/sales/${saleId}`)
        .set('Cookie', cookie)
        .expect(404);
      await request(app.getHttpServer())
        .post(`/api/v1/pos/sales/${saleId}/void`)
        .set('Cookie', cookie)
        .set('Idempotency-Key', 'pos-void-branch-scope')
        .send({ reason: 'No debe revelar la venta' })
        .expect(404);
    });

    it('prevents concurrent sales from overselling stock', async () => {
      const { cookie, productId, locationId } = await preparePos();
      const payload = {
        lines: [{ productId, quantity: '3' }],
        cashReceived: '400.00',
      };

      const responses = await Promise.all(
        ['pos-concurrent-a', 'pos-concurrent-b'].map((key) =>
          request(app.getHttpServer())
            .post('/api/v1/pos/sales/cash')
            .set('Cookie', cookie)
            .set('Idempotency-Key', key)
            .send(payload),
        ),
      );

      expect(responses.map(({ status }) => status).sort()).toEqual([201, 409]);
      expect(
        responses.find(({ status }) => status === 409)?.body,
      ).toMatchObject({ code: 'INSUFFICIENT_STOCK', productId });
      const [state] = await dataSource.query<
        Array<{
          sales: number | string;
          sale_movements: number | string;
          balance: string;
        }>
      >(
        `SELECT (SELECT COUNT(*) FROM sales) AS sales,
                (SELECT COUNT(*) FROM inventory_movements WHERE type = 'SALE') AS sale_movements,
                (SELECT quantity FROM inventory_balances
                  WHERE product_id = ? AND location_id = ?) AS balance`,
        [productId, locationId],
      );
      expect({
        sales: Number(state.sales),
        saleMovements: Number(state.sale_movements),
        balance: state.balance,
      }).toEqual({ sales: 1, saleMovements: 1, balance: '2.000' });
    });

    it('rolls back the stock decrement when payment persistence fails', async () => {
      const { cookie, productId, locationId } = await preparePos();
      const quoteResponse = await request(app.getHttpServer())
        .post('/api/v1/pos/cart/quote')
        .set('Cookie', cookie)
        .send({ lines: [{ productId, quantity: '2' }] })
        .expect(200);
      const quote = (quoteResponse.body as PosCartQuoteResponse).data;
      const [principal] = await dataSource.query<
        Array<{ id: string; tenant_id: string }>
      >('SELECT id, tenant_id FROM users WHERE normalized_email = ? LIMIT 1', [
        registrationPayload.email,
      ]);
      const [shift] = await dataSource.query<Array<{ id: string }>>(
        `SELECT id FROM cash_register_shifts
         WHERE tenant_id = ? AND opened_by_user_id = ? AND status = 'OPEN'`,
        [principal.tenant_id, principal.id],
      );

      await expect(
        app.get(SalesRepository).persistCashSale({
          tenantId: principal.tenant_id,
          userId: principal.id,
          idempotencyKey: 'pos-payment-rollback',
          fingerprint: 'f'.repeat(64),
          cashRegisterShiftId: shift.id,
          quote,
          amountReceived: '10000000000000.00',
          change: '0.00',
        }),
      ).rejects.toThrow();
      const [state] = await dataSource.query<
        Array<{
          sales: number | string;
          sale_movements: number | string;
          balance: string;
        }>
      >(
        `SELECT (SELECT COUNT(*) FROM sales) AS sales,
                (SELECT COUNT(*) FROM inventory_movements WHERE type = 'SALE') AS sale_movements,
                (SELECT quantity FROM inventory_balances
                  WHERE product_id = ? AND location_id = ?) AS balance`,
        [productId, locationId],
      );
      expect({
        sales: Number(state.sales),
        saleMovements: Number(state.sale_movements),
        balance: state.balance,
      }).toEqual({ sales: 0, saleMovements: 0, balance: '5.000' });
    });

    it('rejects insufficient stock, inactive and nonexistent products', async () => {
      const { cookie, productId } = await preparePos();
      await request(app.getHttpServer())
        .post('/api/v1/pos/cart/quote')
        .set('Cookie', cookie)
        .send({ lines: [{ productId, quantity: '6' }] })
        .expect(409)
        .expect(({ body }: { body: { code?: string } }) => {
          expect(body.code).toBe('INSUFFICIENT_STOCK');
        });

      await dataSource.query(
        'UPDATE products SET active = FALSE WHERE id = ?',
        [productId],
      );
      await request(app.getHttpServer())
        .post('/api/v1/pos/cart/quote')
        .set('Cookie', cookie)
        .send({ lines: [{ productId, quantity: '1' }] })
        .expect(409)
        .expect(({ body }: { body: { code?: string } }) => {
          expect(body.code).toBe('PRODUCT_NOT_AVAILABLE');
        });
      await request(app.getHttpServer())
        .post('/api/v1/pos/cart/quote')
        .set('Cookie', cookie)
        .send({ lines: [{ productId: randomUUID(), quantity: '1' }] })
        .expect(404);
    });
  });

  describe('core tenant isolation matrix', () => {
    beforeEach(resetIdentityData);

    interface TenantFixture {
      cookie: string;
      tenantId: string;
      userId: string;
      branchId: string;
      warehouseId: string;
      locationId: string;
      cashRegisterId: string;
      productId: string;
      saleId: string;
      email: string;
      organizationName: string;
    }

    async function provisionTenant(
      suffix: string,
      organizationName: string,
      email: string,
    ): Promise<TenantFixture> {
      const registration = await request(app.getHttpServer())
        .post('/api/v1/auth/registrations')
        .set('Idempotency-Key', `tenant-matrix-registration-${suffix}`)
        .send({
          organizationName,
          email,
          password: registrationPayload.password,
        })
        .expect(201);
      const tenantId = (
        registration.body as { data: { tenant: { id: string } } }
      ).data.tenant.id;
      const cookie = await createPersistedSession(email);

      await request(app.getHttpServer())
        .put('/api/v1/onboarding/company')
        .set('Cookie', cookie)
        .send({
          legalName: `${organizationName}, S.A. de C.V.`,
          tradeName: organizationName,
          countryCode: 'MX',
        })
        .expect(200);
      const locationResponse = await request(app.getHttpServer())
        .put('/api/v1/onboarding/initial-location')
        .set('Cookie', cookie)
        .send({
          branchName: `Sucursal ${suffix}`,
          timezone: 'America/Mexico_City',
          warehouseName: `Bodega ${suffix}`,
          locationName: `General ${suffix}`,
        })
        .expect(200);
      const locationContext = (
        locationResponse.body as {
          data: {
            branch: { id: string };
            warehouse: { id: string };
            location: { id: string };
          };
        }
      ).data;
      const registerResponse = await request(app.getHttpServer())
        .put('/api/v1/onboarding/initial-cash-register')
        .set('Cookie', cookie)
        .send({ name: `Caja ${suffix}` })
        .expect(200);
      const cashRegisterId = (
        registerResponse.body as { data: { cashRegister: { id: string } } }
      ).data.cashRegister.id;
      const productResponse = await request(app.getHttpServer())
        .post('/api/v1/products')
        .set('Cookie', cookie)
        .send({
          name: `Producto ${suffix}`,
          sku: 'TENANT-MATRIX',
          cost: '5.00',
          price: '10.00',
        })
        .expect(201);
      const productId = (productResponse.body as { data: { id: string } }).data
        .id;
      await request(app.getHttpServer())
        .post('/api/v1/inventory/movements')
        .set('Cookie', cookie)
        .set('Idempotency-Key', `tenant-matrix-stock-${suffix}`)
        .send({
          productId,
          locationId: locationContext.location.id,
          type: 'INITIAL',
          quantity: '5',
          reason: 'Prueba de aislamiento',
          reference: `MATRIX-${suffix}`,
        })
        .expect(201);
      await openCurrentCashRegister(cookie, `tenant-matrix-shift-${suffix}`);
      const saleResponse = await request(app.getHttpServer())
        .post('/api/v1/pos/sales/cash')
        .set('Cookie', cookie)
        .set('Idempotency-Key', `tenant-matrix-sale-${suffix}`)
        .send({
          lines: [{ productId, quantity: '1' }],
          cashReceived: '10.00',
        })
        .expect(201);
      const saleId = (saleResponse.body as { data: { id: string } }).data.id;
      const [user] = await dataSource.query<Array<{ id: string }>>(
        'SELECT id FROM users WHERE normalized_email = ? LIMIT 1',
        [email],
      );

      return {
        cookie,
        tenantId,
        userId: user.id,
        branchId: locationContext.branch.id,
        warehouseId: locationContext.warehouse.id,
        locationId: locationContext.location.id,
        cashRegisterId,
        productId,
        saleId,
        email,
        organizationName,
      };
    }

    it('keeps company, operational context, catalog, stock and sales opaque across tenants', async () => {
      const primary = await provisionTenant(
        'A',
        'Empresa Matriz A',
        'matrix-a@example.com',
      );
      const foreign = await provisionTenant(
        'B',
        'Empresa Matriz B',
        'matrix-b@example.com',
      );

      await request(app.getHttpServer())
        .get('/api/v1/onboarding/company')
        .set('Cookie', primary.cookie)
        .set('X-Tenant-Id', foreign.tenantId)
        .expect(200)
        .expect(({ body }: { body: unknown }) => {
          expect(body).toMatchObject({
            data: { company: { tradeName: primary.organizationName } },
          });
        });
      await request(app.getHttpServer())
        .get('/api/v1/auth/sessions/current')
        .set('Cookie', primary.cookie)
        .expect(200)
        .expect(({ body }: { body: unknown }) => {
          expect(body).toMatchObject({
            data: {
              user: { email: primary.email },
              tenant: { id: primary.tenantId },
              context: {
                branch: { id: primary.branchId },
                warehouse: { id: primary.warehouseId },
                cashRegister: { id: primary.cashRegisterId },
              },
            },
          });
        });

      const missingProductId = randomUUID();
      const foreignProduct = await request(app.getHttpServer())
        .get(`/api/v1/products/${foreign.productId}`)
        .set('Cookie', primary.cookie)
        .expect(404);
      const missingProduct = await request(app.getHttpServer())
        .get(`/api/v1/products/${missingProductId}`)
        .set('Cookie', primary.cookie)
        .expect(404);
      expect(foreignProduct.body).toEqual(missingProduct.body);

      const productUpdate = {
        name: 'Intento ajeno',
        sku: 'FOREIGN-UPDATE',
        cost: '1.00',
        price: '2.00',
        version: 1,
      };
      const foreignUpdate = await request(app.getHttpServer())
        .patch(`/api/v1/products/${foreign.productId}`)
        .set('Cookie', primary.cookie)
        .send(productUpdate)
        .expect(404);
      const missingUpdate = await request(app.getHttpServer())
        .patch(`/api/v1/products/${missingProductId}`)
        .set('Cookie', primary.cookie)
        .send(productUpdate)
        .expect(404);
      expect(foreignUpdate.body).toEqual(missingUpdate.body);

      const products = await request(app.getHttpServer())
        .get('/api/v1/products')
        .set('Cookie', primary.cookie)
        .expect(200);
      expect(
        (products.body as { data: Array<{ id: string }> }).data.map(
          ({ id }) => id,
        ),
      ).toEqual([primary.productId]);

      for (const [productId, locationId, missingProduct, missingLocation] of [
        [
          foreign.productId,
          primary.locationId,
          randomUUID(),
          primary.locationId,
        ],
        [
          primary.productId,
          foreign.locationId,
          primary.productId,
          randomUUID(),
        ],
      ]) {
        const foreignMovement = await request(app.getHttpServer())
          .post('/api/v1/inventory/movements')
          .set('Cookie', primary.cookie)
          .set('Idempotency-Key', `tenant-matrix-rejected-${locationId}`)
          .send({
            productId,
            locationId,
            type: 'ENTRY',
            quantity: '1',
            reason: 'Intento ajeno',
            reference: 'TENANT-ATTEMPT',
          })
          .expect(404);
        const missingMovement = await request(app.getHttpServer())
          .post('/api/v1/inventory/movements')
          .set('Cookie', primary.cookie)
          .set('Idempotency-Key', `tenant-matrix-missing-${locationId}`)
          .send({
            productId: missingProduct,
            locationId: missingLocation,
            type: 'ENTRY',
            quantity: '1',
            reason: 'Intento inexistente',
            reference: 'TENANT-MISSING',
          })
          .expect(404);
        expect(foreignMovement.body).toEqual(missingMovement.body);

        const foreignTransition = await request(app.getHttpServer())
          .post('/api/v1/inventory/state-transitions')
          .set('Cookie', primary.cookie)
          .set('Idempotency-Key', `tenant-state-rejected-${locationId}`)
          .send({
            productId,
            locationId,
            fromState: 'AVAILABLE',
            toState: 'RESERVED',
            quantity: '1',
            reason: 'Intento ajeno',
            reference: 'TENANT-STATE-ATTEMPT',
          })
          .expect(404);
        const missingTransition = await request(app.getHttpServer())
          .post('/api/v1/inventory/state-transitions')
          .set('Cookie', primary.cookie)
          .set('Idempotency-Key', `tenant-state-missing-${locationId}`)
          .send({
            productId: missingProduct,
            locationId: missingLocation,
            fromState: 'AVAILABLE',
            toState: 'RESERVED',
            quantity: '1',
            reason: 'Intento inexistente',
            reference: 'TENANT-STATE-MISSING',
          })
          .expect(404);
        expect(foreignTransition.body).toEqual(missingTransition.body);
      }
      const foreignBalance = await request(app.getHttpServer())
        .get(`/api/v1/inventory/products/${foreign.productId}/balance`)
        .query({ locationId: primary.locationId })
        .set('Cookie', primary.cookie)
        .expect(404);
      const missingBalance = await request(app.getHttpServer())
        .get(`/api/v1/inventory/products/${randomUUID()}/balance`)
        .query({ locationId: primary.locationId })
        .set('Cookie', primary.cookie)
        .expect(404);
      expect(foreignBalance.body).toEqual(missingBalance.body);
      const foreignStockScope = await request(app.getHttpServer())
        .get('/api/v1/inventory/stock')
        .query({
          branchId: foreign.branchId,
          warehouseId: foreign.warehouseId,
        })
        .set('Cookie', primary.cookie)
        .expect(404);
      const missingStockScope = await request(app.getHttpServer())
        .get('/api/v1/inventory/stock')
        .query({ branchId: randomUUID(), warehouseId: randomUUID() })
        .set('Cookie', primary.cookie)
        .expect(404);
      expect(foreignStockScope.body).toEqual(missingStockScope.body);

      const movements = await request(app.getHttpServer())
        .get('/api/v1/inventory/movements')
        .set('Cookie', primary.cookie)
        .expect(200);
      const movementProducts = (
        movements.body as { data: Array<{ product: { id: string } }> }
      ).data.map(({ product }) => product.id);
      expect(new Set(movementProducts)).toEqual(new Set([primary.productId]));
      expect(movementProducts).not.toContain(foreign.productId);
      await request(app.getHttpServer())
        .get('/api/v1/inventory/movements')
        .query({ productId: foreign.productId })
        .set('Cookie', primary.cookie)
        .expect(200)
        .expect(({ body }: { body: { data: unknown[] } }) => {
          expect(body.data).toEqual([]);
        });

      const missingSaleId = randomUUID();
      const foreignSale = await request(app.getHttpServer())
        .get(`/api/v1/pos/sales/${foreign.saleId}`)
        .set('Cookie', primary.cookie)
        .expect(404);
      const missingSale = await request(app.getHttpServer())
        .get(`/api/v1/pos/sales/${missingSaleId}`)
        .set('Cookie', primary.cookie)
        .expect(404);
      expect(foreignSale.body).toEqual(missingSale.body);

      const sales = await request(app.getHttpServer())
        .get('/api/v1/pos/sales')
        .set('Cookie', primary.cookie)
        .expect(200);
      expect(
        (sales.body as { data: Array<{ id: string }> }).data.map(
          ({ id }) => id,
        ),
      ).toEqual([primary.saleId]);
      for (const query of [
        { cashRegisterId: foreign.cashRegisterId },
        { userId: foreign.userId },
      ]) {
        const foreignFilteredSales = await request(app.getHttpServer())
          .get('/api/v1/pos/sales')
          .query(query)
          .set('Cookie', primary.cookie)
          .expect(200);
        const filterName = Object.keys(query)[0];
        const missingFilteredSales = await request(app.getHttpServer())
          .get('/api/v1/pos/sales')
          .query({ [filterName]: randomUUID() })
          .set('Cookie', primary.cookie)
          .expect(200);
        expect(foreignFilteredSales.body).toEqual(missingFilteredSales.body);
        expect((foreignFilteredSales.body as { data: unknown[] }).data).toEqual(
          [],
        );
      }

      const foreignQuote = await request(app.getHttpServer())
        .post('/api/v1/pos/cart/quote')
        .set('Cookie', primary.cookie)
        .send({ lines: [{ productId: foreign.productId, quantity: '1' }] })
        .expect(404);
      const missingQuote = await request(app.getHttpServer())
        .post('/api/v1/pos/cart/quote')
        .set('Cookie', primary.cookie)
        .send({ lines: [{ productId: randomUUID(), quantity: '1' }] })
        .expect(404);
      expect(foreignQuote.body).toEqual(missingQuote.body);

      const foreignSaleAttempt = await request(app.getHttpServer())
        .post('/api/v1/pos/sales/cash')
        .set('Cookie', primary.cookie)
        .set('Idempotency-Key', 'tenant-matrix-foreign-sale')
        .send({
          lines: [{ productId: foreign.productId, quantity: '1' }],
          cashReceived: '10.00',
        })
        .expect(404);
      const missingSaleAttempt = await request(app.getHttpServer())
        .post('/api/v1/pos/sales/cash')
        .set('Cookie', primary.cookie)
        .set('Idempotency-Key', 'tenant-matrix-missing-sale')
        .send({
          lines: [{ productId: randomUUID(), quantity: '1' }],
          cashReceived: '10.00',
        })
        .expect(404);
      expect(foreignSaleAttempt.body).toEqual(missingSaleAttempt.body);
    });
  });

  describe('Inventory access delegation', () => {
    beforeEach(resetIdentityData);

    it('delegates granular tenant roles and enforces branch scope', async () => {
      await registerAccount('access-primary-registration');
      const adminCookie = await createPersistedSession(
        registrationPayload.email,
      );
      await request(app.getHttpServer())
        .put('/api/v1/onboarding/company')
        .set('Cookie', adminCookie)
        .send({
          legalName: 'Accesos, S.A.',
          tradeName: 'Accesos',
          countryCode: 'MX',
        })
        .expect(200);
      const initial = await request(app.getHttpServer())
        .put('/api/v1/onboarding/initial-location')
        .set('Cookie', adminCookie)
        .send({
          branchName: 'Sucursal Centro',
          timezone: 'America/Mexico_City',
          warehouseName: 'Bodega Centro',
          locationName: 'General Centro',
        })
        .expect(200);
      await request(app.getHttpServer())
        .put('/api/v1/onboarding/initial-cash-register')
        .set('Cookie', adminCookie)
        .send({ name: 'Caja Centro' })
        .expect(200);
      const initialData = (
        initial.body as {
          data: {
            branch: { id: string };
            warehouse: { id: string };
            location: { id: string };
          };
        }
      ).data;
      const initialBranchId = initialData.branch.id;
      const second = await request(app.getHttpServer())
        .post('/api/v1/organization/branches')
        .set('Cookie', adminCookie)
        .send({
          name: 'Sucursal Norte',
          timezone: 'America/Mexico_City',
          warehouseName: 'Bodega Norte',
          locationName: 'General Norte',
          locationCode: 'NORTE',
        })
        .expect(201);
      const secondBranchId = (second.body as { data: { id: string } }).data.id;
      const secondWarehouse = (
        second.body as {
          data: {
            warehouses: Array<{ id: string; locations: Array<{ id: string }> }>;
          };
        }
      ).data.warehouses[0];
      const third = await request(app.getHttpServer())
        .post('/api/v1/organization/branches')
        .set('Cookie', adminCookie)
        .send({
          name: 'Sucursal Sur',
          timezone: 'America/Mexico_City',
          warehouseName: 'Bodega Sur',
          locationName: 'General Sur',
          locationCode: 'SUR',
        })
        .expect(201);
      const thirdWarehouse = (
        third.body as {
          data: {
            warehouses: Array<{ id: string; locations: Array<{ id: string }> }>;
          };
        }
      ).data.warehouses[0];
      const product = await request(app.getHttpServer())
        .post('/api/v1/products')
        .set('Cookie', adminCookie)
        .send({
          name: 'Producto de acceso',
          sku: 'ACCESS-1',
          cost: '5.00',
          price: '10.00',
        })
        .expect(201);
      const productId = (product.body as { data: { id: string } }).data.id;
      const hiddenTransfer = await request(app.getHttpServer())
        .post('/api/v1/inventory/transfers')
        .set('Cookie', adminCookie)
        .set('Idempotency-Key', 'access-hidden-transfer')
        .send({
          destinationWarehouseId: thirdWarehouse.id,
          reference: 'ACCESS-HIDDEN',
          reason: 'Transferencia fuera del alcance del operador',
          lines: [
            {
              productId,
              sourceLocationId: initialData.location.id,
              destinationLocationId: thirdWarehouse.locations[0].id,
              quantity: '1',
            },
          ],
        })
        .expect(201);
      const hiddenTransferId = (hiddenTransfer.body as { data: { id: string } })
        .data.id;

      const viewer = await request(app.getHttpServer())
        .post('/api/v1/access/roles')
        .set('Cookie', adminCookie)
        .send({
          name: 'Consulta de inventario',
          permissions: ['INVENTORY_VIEW'],
        })
        .expect(201);
      const operator = await request(app.getHttpServer())
        .post('/api/v1/access/roles')
        .set('Cookie', adminCookie)
        .send({
          name: 'Operación de inventario',
          permissions: [
            'INVENTORY_VIEW',
            'INVENTORY_ADJUST',
            'INVENTORY_TRANSFER',
          ],
        })
        .expect(201);
      const approver = await request(app.getHttpServer())
        .post('/api/v1/access/roles')
        .set('Cookie', adminCookie)
        .send({
          name: 'Aprobación de inventario',
          permissions: [
            'INVENTORY_VIEW',
            'INVENTORY_COUNT',
            'INVENTORY_APPROVE',
          ],
        })
        .expect(201);
      const viewerRoleId = (viewer.body as { data: { id: string } }).data.id;
      const operatorRoleId = (operator.body as { data: { id: string } }).data
        .id;
      const approverRoleId = (approver.body as { data: { id: string } }).data
        .id;
      const staffPassword = 'Personal-2026!';
      const staff = await request(app.getHttpServer())
        .post('/api/v1/access/users')
        .set('Cookie', adminCookie)
        .send({
          email: 'inventario@example.com',
          password: staffPassword,
          roleIds: [viewerRoleId],
          branchIds: [initialBranchId],
        })
        .expect(201);
      const staffId = (staff.body as { data: { id: string } }).data.id;
      const viewerLogin = await request(app.getHttpServer())
        .post('/api/v1/auth/sessions')
        .send({ email: 'inventario@example.com', password: staffPassword })
        .expect(200);
      const viewerCookie = (
        viewerLogin.headers['set-cookie'] as unknown as string[]
      )[0].split(';')[0];
      expect(viewerLogin.body).toMatchObject({
        data: {
          user: { permissions: ['INVENTORY_VIEW'] },
          context: { branch: { id: initialBranchId } },
        },
      });
      await request(app.getHttpServer())
        .get('/api/v1/products')
        .set('Cookie', viewerCookie)
        .expect(200);
      await request(app.getHttpServer())
        .get('/api/v1/inventory/stock')
        .set('Cookie', viewerCookie)
        .expect(200);
      for (const path of [
        '/api/v1/inventory/movements',
        '/api/v1/inventory/transfers',
      ]) {
        await request(app.getHttpServer())
          .post(path)
          .set('Cookie', viewerCookie)
          .send({})
          .expect(403)
          .expect(({ body }: { body: { code?: string } }) => {
            expect(body.code).toBe('INVENTORY_ACCESS_DENIED');
          });
      }
      await request(app.getHttpServer())
        .get('/api/v1/access/roles')
        .set('Cookie', viewerCookie)
        .expect(403);
      await request(app.getHttpServer())
        .get('/api/v1/organization/branches')
        .set('Cookie', viewerCookie)
        .expect(200)
        .expect(({ body }: { body: { data: Array<{ id: string }> } }) => {
          expect(body.data.map(({ id }) => id)).toEqual([initialBranchId]);
        });

      await request(app.getHttpServer())
        .patch(`/api/v1/access/users/${staffId}`)
        .set('Cookie', adminCookie)
        .send({ roleIds: [operatorRoleId], branchIds: [secondBranchId] })
        .expect(200);
      await request(app.getHttpServer())
        .get('/api/v1/auth/sessions/current')
        .set('Cookie', viewerCookie)
        .expect(401);
      const operatorLogin = await request(app.getHttpServer())
        .post('/api/v1/auth/sessions')
        .send({ email: 'inventario@example.com', password: staffPassword })
        .expect(200);
      const operatorCookie = (
        operatorLogin.headers['set-cookie'] as unknown as string[]
      )[0].split(';')[0];
      expect(operatorLogin.body).toMatchObject({
        data: {
          user: {
            permissions: [
              'INVENTORY_ADJUST',
              'INVENTORY_TRANSFER',
              'INVENTORY_VIEW',
            ],
          },
          context: { branch: { id: secondBranchId } },
        },
      });
      await request(app.getHttpServer())
        .patch('/api/v1/auth/sessions/current/context')
        .set('Cookie', operatorCookie)
        .send({
          branchId: initialBranchId,
          warehouseId: (initial.body as { data: { warehouse: { id: string } } })
            .data.warehouse.id,
        })
        .expect(404);
      await request(app.getHttpServer())
        .post('/api/v1/inventory/movements')
        .set('Cookie', operatorCookie)
        .send({})
        .expect(400);
      await request(app.getHttpServer())
        .post('/api/v1/inventory/transfers')
        .set('Cookie', operatorCookie)
        .set('Idempotency-Key', 'operator-unassigned-destination')
        .send({
          destinationWarehouseId: initialData.warehouse.id,
          reference: 'ACCESS-DENIED',
          reason: 'Destino fuera de sucursales asignadas',
          lines: [
            {
              productId,
              sourceLocationId: secondWarehouse.locations[0].id,
              destinationLocationId: initialData.location.id,
              quantity: '1',
            },
          ],
        })
        .expect(400);
      await request(app.getHttpServer())
        .get(`/api/v1/inventory/transfers/${hiddenTransferId}`)
        .set('Cookie', operatorCookie)
        .expect(404);
      await request(app.getHttpServer())
        .get('/api/v1/inventory/transfers')
        .set('Cookie', operatorCookie)
        .expect(200)
        .expect(({ body }: { body: { data: Array<{ id: string }> } }) => {
          expect(body.data.map(({ id }) => id)).not.toContain(hiddenTransferId);
        });
      await request(app.getHttpServer())
        .post(`/api/v1/inventory/transfers/${randomUUID()}/dispatch`)
        .set('Cookie', operatorCookie)
        .set('Idempotency-Key', 'operator-cannot-approve')
        .expect(403);

      const approvalUser = await request(app.getHttpServer())
        .post('/api/v1/access/users')
        .set('Cookie', adminCookie)
        .send({
          email: 'aprobador@example.com',
          password: 'Aprobador-2026!',
          roleIds: [approverRoleId],
          branchIds: [initialBranchId],
        })
        .expect(201);
      expect(approvalUser.body).toMatchObject({
        data: {
          roles: [
            {
              permissions: [
                'INVENTORY_APPROVE',
                'INVENTORY_COUNT',
                'INVENTORY_VIEW',
              ],
            },
          ],
        },
      });
      const approvalLogin = await request(app.getHttpServer())
        .post('/api/v1/auth/sessions')
        .send({ email: 'aprobador@example.com', password: 'Aprobador-2026!' })
        .expect(200);
      const approvalCookie = (
        approvalLogin.headers['set-cookie'] as unknown as string[]
      )[0].split(';')[0];
      await request(app.getHttpServer())
        .post('/api/v1/inventory/transfers')
        .set('Cookie', approvalCookie)
        .send({})
        .expect(403);
      await request(app.getHttpServer())
        .post(`/api/v1/inventory/transfers/${randomUUID()}/dispatch`)
        .set('Cookie', approvalCookie)
        .set('Idempotency-Key', 'approver-can-approve')
        .expect(404);

      const [adminRole] = await dataSource.query<Array<{ id: string }>>(
        `SELECT r.id FROM roles r
         INNER JOIN users u ON u.tenant_id = r.tenant_id
         WHERE u.normalized_email = ? AND r.code = 'ADMIN'`,
        [registrationPayload.email],
      );
      await request(app.getHttpServer())
        .post('/api/v1/access/users')
        .set('Cookie', adminCookie)
        .send({
          email: 'admin-no-delegable@example.com',
          password: 'Delegacion-2026!',
          roleIds: [adminRole.id],
          branchIds: [initialBranchId],
        })
        .expect(400);
      await request(app.getHttpServer())
        .get('/api/v1/audit-events')
        .query({ pageSize: 50 })
        .set('Cookie', adminCookie)
        .expect(200)
        .expect(({ body }: { body: { data: Array<{ action: string }> } }) => {
          const actions = body.data.map(({ action }) => action);
          expect(actions).toContain('ACCESS_ROLE_CREATED');
          expect(actions).toContain('ACCESS_USER_CREATED');
          expect(actions).toContain('ACCESS_USER_UPDATED');
        });

      const otherPayload = {
        organizationName: 'Otra empresa',
        email: 'otra-admin@example.com',
        password: 'Correcta-2026!',
      };
      await request(app.getHttpServer())
        .post('/api/v1/auth/registrations')
        .set('Idempotency-Key', 'access-other-registration')
        .send(otherPayload)
        .expect(201);
      const otherCookie = await createPersistedSession(otherPayload.email);
      await request(app.getHttpServer())
        .put('/api/v1/onboarding/company')
        .set('Cookie', otherCookie)
        .send({
          legalName: 'Otra Empresa, S.A.',
          tradeName: 'Otra',
          countryCode: 'MX',
        })
        .expect(200);
      const otherLocation = await request(app.getHttpServer())
        .put('/api/v1/onboarding/initial-location')
        .set('Cookie', otherCookie)
        .send({
          branchName: 'Sucursal Ajena',
          timezone: 'America/Mexico_City',
          warehouseName: 'Bodega Ajena',
          locationName: 'General Ajena',
        })
        .expect(200);
      await request(app.getHttpServer())
        .put('/api/v1/onboarding/initial-cash-register')
        .set('Cookie', otherCookie)
        .send({ name: 'Caja Ajena' })
        .expect(200);
      const otherRole = await request(app.getHttpServer())
        .post('/api/v1/access/roles')
        .set('Cookie', otherCookie)
        .send({ name: 'Rol ajeno', permissions: ['INVENTORY_VIEW'] })
        .expect(201);
      await request(app.getHttpServer())
        .patch(`/api/v1/access/users/${staffId}`)
        .set('Cookie', otherCookie)
        .send({
          roleIds: [(otherRole.body as { data: { id: string } }).data.id],
          branchIds: [
            (otherLocation.body as { data: { branch: { id: string } } }).data
              .branch.id,
          ],
        })
        .expect(404);
    });
  });

  describe('Cashier branch and register delegation', () => {
    beforeEach(resetIdentityData);

    it('enforces exact register scope and granular POS permissions', async () => {
      await registerAccount('cashier-scope-registration');
      const adminCookie = await createPersistedSession(
        registrationPayload.email,
      );
      await request(app.getHttpServer())
        .put('/api/v1/onboarding/company')
        .set('Cookie', adminCookie)
        .send({
          legalName: 'Cajas Seguras, S.A.',
          tradeName: 'Cajas Seguras',
          countryCode: 'MX',
        })
        .expect(200);
      const initialLocation = await request(app.getHttpServer())
        .put('/api/v1/onboarding/initial-location')
        .set('Cookie', adminCookie)
        .send({
          branchName: 'Sucursal Centro',
          timezone: 'America/Mexico_City',
          warehouseName: 'Bodega Centro',
          locationName: 'General Centro',
        })
        .expect(200);
      const initialRegister = await request(app.getHttpServer())
        .put('/api/v1/onboarding/initial-cash-register')
        .set('Cookie', adminCookie)
        .send({ name: 'Caja Centro 1' })
        .expect(200);
      const initial = initialLocation.body as {
        data: { branch: { id: string }; warehouse: { id: string } };
      };
      const initialRegisterId = (
        initialRegister.body as { data: { cashRegister: { id: string } } }
      ).data.cashRegister.id;
      const unassignedRegister = await request(app.getHttpServer())
        .post(
          `/api/v1/organization/branches/${initial.data.branch.id}/cash-registers`,
        )
        .set('Cookie', adminCookie)
        .send({ name: 'Caja Centro 2', code: 'CENTER-2' })
        .expect(201);
      const unassignedRegisterId = (
        unassignedRegister.body as { data: { id: string } }
      ).data.id;

      const northBranch = await request(app.getHttpServer())
        .post('/api/v1/organization/branches')
        .set('Cookie', adminCookie)
        .send({
          name: 'Sucursal Norte',
          timezone: 'America/Mexico_City',
          warehouseName: 'Bodega Norte',
          locationName: 'General Norte',
          locationCode: 'NORTH',
        })
        .expect(201);
      const north = northBranch.body as {
        data: { id: string; warehouses: Array<{ id: string }> };
      };
      const northRegister = await request(app.getHttpServer())
        .post(`/api/v1/organization/branches/${north.data.id}/cash-registers`)
        .set('Cookie', adminCookie)
        .send({ name: 'Caja Norte', code: 'NORTH-1' })
        .expect(201);
      const northRegisterId = (northRegister.body as { data: { id: string } })
        .data.id;

      const cashierRole = await request(app.getHttpServer())
        .post('/api/v1/access/roles')
        .set('Cookie', adminCookie)
        .send({
          name: 'Cajero de apertura',
          permissions: [
            'SALES_MANAGE',
            'SALES_DISCOUNT',
            'SALE_REPRINT',
            'CASH_REGISTER_OPEN',
          ],
        })
        .expect(201);
      const cashierRoleId = (cashierRole.body as { data: { id: string } }).data
        .id;
      const cashier = await request(app.getHttpServer())
        .post('/api/v1/access/users')
        .set('Cookie', adminCookie)
        .send({
          email: 'cashier@example.com',
          password: 'Cashier-2026!',
          roleIds: [cashierRoleId],
          branchIds: [initial.data.branch.id, north.data.id],
          cashRegisterIds: [initialRegisterId, northRegisterId],
        })
        .expect(201);
      const cashierData = (
        cashier.body as {
          data: {
            id: string;
            cashRegisters: Array<{
              id: string;
              name: string;
              code: string;
              branchId: string;
            }>;
          };
        }
      ).data;
      const cashierId = cashierData.id;
      expect(cashierData.cashRegisters).toEqual([
        {
          id: initialRegisterId,
          name: 'Caja Centro 1',
          code: 'MAIN',
          branchId: initial.data.branch.id,
        },
        {
          id: northRegisterId,
          name: 'Caja Norte',
          code: 'NORTH-1',
          branchId: north.data.id,
        },
      ]);

      const cashierLogin = await request(app.getHttpServer())
        .post('/api/v1/auth/sessions')
        .send({ email: 'cashier@example.com', password: 'Cashier-2026!' })
        .expect(200);
      const cashierCookie = (
        cashierLogin.headers['set-cookie'] as unknown as string[]
      )[0].split(';')[0];
      expect(cashierLogin.body).toMatchObject({
        data: {
          context: {
            branch: { id: initial.data.branch.id },
            cashRegister: { id: initialRegisterId },
          },
        },
      });
      await request(app.getHttpServer())
        .get('/api/v1/organization/branches')
        .set('Cookie', cashierCookie)
        .expect(200)
        .expect(
          ({
            body,
          }: {
            body: {
              data: Array<{
                id: string;
                cashRegisters: Array<{ id: string }>;
              }>;
            };
          }) => {
            expect(
              body.data.find(({ id }) => id === initial.data.branch.id)
                ?.cashRegisters,
            ).toEqual([
              { id: initialRegisterId, name: 'Caja Centro 1', code: 'MAIN' },
            ]);
            expect(
              body.data.find(({ id }) => id === north.data.id)?.cashRegisters,
            ).toEqual([
              { id: northRegisterId, name: 'Caja Norte', code: 'NORTH-1' },
            ]);
          },
        );

      await request(app.getHttpServer())
        .patch('/api/v1/auth/sessions/current/context')
        .set('Cookie', cashierCookie)
        .send({
          branchId: initial.data.branch.id,
          warehouseId: initial.data.warehouse.id,
          cashRegisterId: unassignedRegisterId,
        })
        .expect(404);
      await request(app.getHttpServer())
        .patch('/api/v1/auth/sessions/current/context')
        .set('Cookie', cashierCookie)
        .send({
          branchId: north.data.id,
          warehouseId: north.data.warehouses[0].id,
          cashRegisterId: northRegisterId,
        })
        .expect(200)
        .expect(({ body }: { body: unknown }) => {
          expect(body).toMatchObject({
            data: {
              context: {
                branch: { id: north.data.id },
                cashRegister: { id: northRegisterId },
              },
            },
          });
        });

      await request(app.getHttpServer())
        .post('/api/v1/pos/register-shifts')
        .set('Cookie', cashierCookie)
        .set('Idempotency-Key', 'cashier-open-north')
        .send({ openingAmount: '100.00' })
        .expect(201);
      await request(app.getHttpServer())
        .post('/api/v1/pos/register-shifts/current/movements')
        .set('Cookie', cashierCookie)
        .set('Idempotency-Key', 'cashier-movement-denied')
        .send({ type: 'INCOME', amount: '10.00', reason: 'Cambio' })
        .expect(403);
      await request(app.getHttpServer())
        .post('/api/v1/pos/register-shifts/current/closure')
        .set('Cookie', cashierCookie)
        .set('Idempotency-Key', 'cashier-close-denied')
        .send({ countedAmount: '100.00' })
        .expect(403);
      await request(app.getHttpServer())
        .post(`/api/v1/pos/sales/${randomUUID()}/void`)
        .set('Cookie', cashierCookie)
        .set('Idempotency-Key', 'cashier-void-denied')
        .send({ reason: 'Sin permiso' })
        .expect(403);

      await request(app.getHttpServer())
        .patch(`/api/v1/access/users/${cashierId}`)
        .set('Cookie', adminCookie)
        .send({
          roleIds: [cashierRoleId],
          branchIds: [initial.data.branch.id],
          cashRegisterIds: [initialRegisterId],
        })
        .expect(200);
      await request(app.getHttpServer())
        .get('/api/v1/auth/sessions/current')
        .set('Cookie', cashierCookie)
        .expect(401);
      const reassignedLogin = await request(app.getHttpServer())
        .post('/api/v1/auth/sessions')
        .send({ email: 'cashier@example.com', password: 'Cashier-2026!' })
        .expect(200);
      expect(reassignedLogin.body).toMatchObject({
        data: {
          context: {
            branch: { id: initial.data.branch.id },
            cashRegister: { id: initialRegisterId },
          },
        },
      });

      await request(app.getHttpServer())
        .get('/api/v1/audit-events')
        .query({ pageSize: 50 })
        .set('Cookie', adminCookie)
        .expect(200)
        .expect(
          ({ body }: { body: { data: Array<Record<string, unknown>> } }) => {
            expect(body.data).toEqual(
              expect.arrayContaining([
                expect.objectContaining({
                  action: 'ACCESS_USER_UPDATED',
                  entityId: cashierId,
                  after: {
                    roleIds: [cashierRoleId],
                    branchIds: [initial.data.branch.id],
                    cashRegisterIds: [initialRegisterId],
                  },
                }),
              ]),
            );
          },
        );
    });
  });

  describe('Core role authorization matrix', () => {
    beforeEach(resetIdentityData);

    it('rejects anonymous access and a role without Core permissions', async () => {
      for (const path of [
        '/api/v1/onboarding/company',
        '/api/v1/products',
        '/api/v1/inventory/stock',
        '/api/v1/inventory/transfers',
        '/api/v1/pos/register-shifts/current',
        '/api/v1/pos/register-shifts/current/movements',
        '/api/v1/pos/register-shifts/latest-closed',
        '/api/v1/pos/sales',
      ]) {
        await request(app.getHttpServer()).get(path).expect(401);
      }

      await registerAccount('role-authorization-registration');
      const cookie = await createPersistedSession(registrationPayload.email);
      const [principal] = await dataSource.query<
        Array<{ id: string; tenant_id: string }>
      >('SELECT id, tenant_id FROM users WHERE normalized_email = ? LIMIT 1', [
        registrationPayload.email,
      ]);
      const staffRoleId = randomUUID();
      await dataSource.query(
        `INSERT INTO roles (id, tenant_id, code, name) VALUES (?, ?, 'STAFF', 'Personal')`,
        [staffRoleId, principal.tenant_id],
      );
      await dataSource.query('DELETE FROM user_roles WHERE user_id = ?', [
        principal.id,
      ]);
      await dataSource.query(
        'INSERT INTO user_roles (user_id, role_id, tenant_id) VALUES (?, ?, ?)',
        [principal.id, staffRoleId, principal.tenant_id],
      );

      for (const [path, code] of [
        ['/api/v1/onboarding/company', 'ONBOARDING_ACCESS_DENIED'],
        ['/api/v1/products', 'PRODUCT_ACCESS_DENIED'],
        ['/api/v1/inventory/stock', 'INVENTORY_ACCESS_DENIED'],
        ['/api/v1/inventory/transfers', 'INVENTORY_ACCESS_DENIED'],
        ['/api/v1/pos/register-shifts/current', 'POS_ACCESS_DENIED'],
        ['/api/v1/pos/register-shifts/current/movements', 'POS_ACCESS_DENIED'],
        ['/api/v1/pos/register-shifts/latest-closed', 'POS_ACCESS_DENIED'],
        ['/api/v1/pos/sales', 'POS_ACCESS_DENIED'],
        ['/api/v1/audit-events', 'AUDIT_ACCESS_DENIED'],
      ]) {
        await request(app.getHttpServer())
          .get(path)
          .set('Cookie', cookie)
          .expect(403)
          .expect(({ body }: { body: { code?: string } }) => {
            expect(body.code).toBe(code);
          });
      }

      await request(app.getHttpServer())
        .delete(`/api/v1/products/${randomUUID()}`)
        .set('Cookie', cookie)
        .expect(403)
        .expect(({ body }: { body: { code?: string } }) => {
          expect(body.code).toBe('PRODUCT_ACCESS_DENIED');
        });

      await request(app.getHttpServer())
        .post('/api/v1/pos/register-shifts/current/closure')
        .set('Cookie', cookie)
        .set('Idempotency-Key', 'staff-closure-denied')
        .send({ countedAmount: '0.00' })
        .expect(403)
        .expect(({ body }: { body: { code?: string } }) => {
          expect(body.code).toBe('POS_ACCESS_DENIED');
        });

      await request(app.getHttpServer())
        .post('/api/v1/inventory/movements')
        .set('Cookie', cookie)
        .set('Idempotency-Key', 'staff-inventory-denied')
        .send({
          productId: randomUUID(),
          locationId: randomUUID(),
          type: 'EXIT',
          quantity: '1',
          reason: 'Intento sin permiso',
          reference: 'DENIED-001',
        })
        .expect(403)
        .expect(({ body }: { body: { code?: string } }) => {
          expect(body.code).toBe('INVENTORY_ACCESS_DENIED');
        });

      await request(app.getHttpServer())
        .post('/api/v1/inventory/transfers')
        .set('Cookie', cookie)
        .set('Idempotency-Key', 'staff-transfer-denied')
        .send({
          destinationWarehouseId: randomUUID(),
          reference: 'DENIED-TRANSFER',
          reason: 'Intento sin permiso',
          lines: [
            {
              productId: randomUUID(),
              sourceLocationId: randomUUID(),
              destinationLocationId: randomUUID(),
              quantity: '1',
            },
          ],
        })
        .expect(403)
        .expect(({ body }: { body: { code?: string } }) => {
          expect(body.code).toBe('INVENTORY_ACCESS_DENIED');
        });

      await request(app.getHttpServer())
        .post('/api/v1/organization/branches')
        .set('Cookie', cookie)
        .send({
          name: 'Sucursal no autorizada',
          timezone: 'America/Mexico_City',
          warehouseName: 'Bodega no autorizada',
          locationName: 'General',
          locationCode: 'DENIED',
        })
        .expect(403)
        .expect(({ body }: { body: { code?: string } }) => {
          expect(body.code).toBe('ORGANIZATION_ACCESS_DENIED');
        });

      await request(app.getHttpServer())
        .post('/api/v1/inventory/state-transitions')
        .set('Cookie', cookie)
        .set('Idempotency-Key', 'staff-state-transition-denied')
        .send({
          productId: randomUUID(),
          locationId: randomUUID(),
          fromState: 'AVAILABLE',
          toState: 'RESERVED',
          quantity: '1',
          reason: 'Intento sin permiso',
          reference: 'DENIED-STATE-001',
        })
        .expect(403)
        .expect(({ body }: { body: { code?: string } }) => {
          expect(body.code).toBe('INVENTORY_ACCESS_DENIED');
        });

      await request(app.getHttpServer())
        .put('/api/v1/onboarding/company')
        .set('Cookie', cookie)
        .send({ legalName: 'Cambio no autorizado', countryCode: 'MX' })
        .expect(403)
        .expect(({ body }: { body: { code?: string } }) => {
          expect(body.code).toBe('ONBOARDING_ACCESS_DENIED');
        });
    });
  });

  describe('Core audit trail', () => {
    beforeEach(async () => {
      await resetIdentityData();
      const throttlerStorage =
        app.get<ThrottlerStorageService>(ThrottlerStorage);
      throttlerStorage.onApplicationShutdown();
      throttlerStorage.storage.clear();
    });

    it('records critical actions without secrets and exposes an admin-only append-only view', async () => {
      await request(app.getHttpServer())
        .post('/api/v1/auth/registrations')
        .set('X-Request-Id', 'audit-registration')
        .set('Idempotency-Key', 'audit-registration-key')
        .send(registrationPayload)
        .expect(201);
      const login = await request(app.getHttpServer())
        .post('/api/v1/auth/sessions')
        .set('X-Request-Id', 'audit-login-success')
        .send({
          email: registrationPayload.email,
          password: registrationPayload.password,
        })
        .expect(200);
      const cookie = (
        login.headers['set-cookie'] as unknown as string[]
      )[0].split(';')[0];

      await request(app.getHttpServer())
        .put('/api/v1/onboarding/company')
        .set('Cookie', cookie)
        .set('X-Request-Id', 'audit-company-update')
        .send({
          legalName: 'Tienda Auditada, S.A. de C.V.',
          tradeName: 'Tienda Auditada',
          countryCode: 'MX',
        })
        .expect(200);
      const location = await request(app.getHttpServer())
        .put('/api/v1/onboarding/initial-location')
        .set('Cookie', cookie)
        .send({
          branchName: 'Sucursal Auditada',
          timezone: 'America/Mexico_City',
          warehouseName: 'Bodega Auditada',
          locationName: 'General Auditada',
        })
        .expect(200);
      await request(app.getHttpServer())
        .put('/api/v1/onboarding/initial-cash-register')
        .set('Cookie', cookie)
        .send({ name: 'Caja Auditada' })
        .expect(200);

      const product = await request(app.getHttpServer())
        .post('/api/v1/products')
        .set('Cookie', cookie)
        .set('X-Request-Id', 'audit-product-create')
        .send({
          name: 'Producto Auditado',
          sku: 'AUDIT-1',
          cost: '5.00',
          price: '10.00',
        })
        .expect(201);
      const productId = (product.body as { data: { id: string } }).data.id;
      await request(app.getHttpServer())
        .patch(`/api/v1/products/${productId}`)
        .set('Cookie', cookie)
        .set('X-Request-Id', 'audit-product-update')
        .send({
          name: 'Producto Auditado Actualizado',
          sku: 'AUDIT-1',
          cost: '6.00',
          price: '11.00',
          version: 1,
        })
        .expect(200);
      const locationId = (
        location.body as { data: { location: { id: string } } }
      ).data.location.id;
      await request(app.getHttpServer())
        .post('/api/v1/inventory/movements')
        .set('Cookie', cookie)
        .set('X-Request-Id', 'audit-stock-create')
        .set('Idempotency-Key', 'audit-stock-key')
        .send({
          productId,
          locationId,
          type: 'INITIAL',
          quantity: '5',
          reason: 'Stock auditado',
        })
        .expect(201);
      await openCurrentCashRegister(cookie, 'audit-open-shift');
      const sale = await request(app.getHttpServer())
        .post('/api/v1/pos/sales/cash')
        .set('Cookie', cookie)
        .set('X-Request-Id', 'audit-sale-complete')
        .set('Idempotency-Key', 'audit-sale-key')
        .send({ lines: [{ productId, quantity: '1' }], cashReceived: '11.00' })
        .expect(201);
      const saleId = (sale.body as { data: { id: string } }).data.id;

      await request(app.getHttpServer())
        .post('/api/v1/auth/registrations')
        .set('Idempotency-Key', 'audit-foreign-registration')
        .send({
          organizationName: 'Empresa Auditada Ajena',
          email: 'foreign-audit@example.com',
          password: registrationPayload.password,
        })
        .expect(201);

      const response = await request(app.getHttpServer())
        .get('/api/v1/audit-events')
        .query({ pageSize: 50 })
        .set('Cookie', cookie)
        .expect(200);
      const body = response.body as {
        data: Array<{
          id: string;
          action: string;
          entityType: string;
          entityId: string;
          correlationId: string;
          createdAt: string;
          actor: { email: string };
        }>;
        meta: { pagination: { total: number } };
      };
      expect(body.meta.pagination.total).toBe(8);
      expect(new Set(body.data.map(({ action }) => action))).toEqual(
        new Set([
          'REGISTRATION_CREATED',
          'AUTH_LOGIN_SUCCEEDED',
          'COMPANY_UPDATED',
          'PRODUCT_CREATED',
          'PRODUCT_UPDATED',
          'INVENTORY_MOVEMENT_CREATED',
          'CASH_REGISTER_SHIFT_OPENED',
          'SALE_COMPLETED',
        ]),
      );
      expect(
        body.data.find(({ action }) => action === 'SALE_COMPLETED'),
      ).toMatchObject({
        entityType: 'SALE',
        entityId: saleId,
        correlationId: 'audit-sale-complete',
        actor: { email: registrationPayload.email },
      });
      expect(
        body.data.every(
          ({ createdAt }) => !Number.isNaN(Date.parse(createdAt)),
        ),
      ).toBe(true);
      expect(JSON.stringify(body)).not.toContain(registrationPayload.password);
      expect(JSON.stringify(body)).not.toContain('password');

      const eventId = body.data[0].id;
      await request(app.getHttpServer())
        .patch(`/api/v1/audit-events/${eventId}`)
        .set('Cookie', cookie)
        .send({ action: 'ALTERED' })
        .expect(404);
      await request(app.getHttpServer())
        .delete(`/api/v1/audit-events/${eventId}`)
        .set('Cookie', cookie)
        .expect(404);

      const [principal] = await dataSource.query<
        Array<{ id: string; tenant_id: string }>
      >('SELECT id, tenant_id FROM users WHERE normalized_email = ? LIMIT 1', [
        registrationPayload.email,
      ]);
      const staffRoleId = randomUUID();
      await dataSource.query(
        `INSERT INTO roles (id, tenant_id, code, name) VALUES (?, ?, 'STAFF', 'Personal')`,
        [staffRoleId, principal.tenant_id],
      );
      await dataSource.query('DELETE FROM user_roles WHERE user_id = ?', [
        principal.id,
      ]);
      await dataSource.query(
        'INSERT INTO user_roles (user_id, role_id, tenant_id) VALUES (?, ?, ?)',
        [principal.id, staffRoleId, principal.tenant_id],
      );
      await request(app.getHttpServer())
        .get('/api/v1/audit-events')
        .set('Cookie', cookie)
        .expect(403)
        .expect(({ body }: { body: { code?: string } }) => {
          expect(body.code).toBe('AUDIT_ACCESS_DENIED');
        });
    });

    it('redacts, chains, filters and exports audit events with delegated permissions', async () => {
      await registerAccount('audit-integrity-registration');
      const cookie = await createPersistedSession(registrationPayload.email);
      await request(app.getHttpServer())
        .put('/api/v1/onboarding/company')
        .set('Cookie', cookie)
        .send({
          legalName: 'Tienda Íntegra, S.A. de C.V.',
          tradeName: 'Tienda Íntegra',
          countryCode: 'MX',
        })
        .expect(200);
      await request(app.getHttpServer())
        .put('/api/v1/onboarding/initial-location')
        .set('Cookie', cookie)
        .send({
          branchName: 'Sucursal Íntegra',
          timezone: 'America/Mexico_City',
          warehouseName: 'Bodega Íntegra',
          locationName: 'General Íntegra',
        })
        .expect(200);
      await request(app.getHttpServer())
        .put('/api/v1/onboarding/initial-cash-register')
        .set('Cookie', cookie)
        .send({ name: 'Caja Íntegra' })
        .expect(200);
      const [principal] = await dataSource.query<
        Array<{ id: string; tenant_id: string }>
      >('SELECT id, tenant_id FROM users WHERE normalized_email = ? LIMIT 1', [
        registrationPayload.email,
      ]);
      const audit = app.get(AuditService);
      await Promise.all(
        Array.from({ length: 25 }, (_, index) =>
          audit.recordRequired({
            tenantId: principal.tenant_id,
            actorUserId: principal.id,
            action: 'VOLUME_EVENT',
            entityType: 'AUDIT_TEST',
            entityId: randomUUID(),
            correlationId: `audit-volume-${index}`,
            origin: 'SYSTEM',
            after: {
              index,
              password: `password-${index}`,
              nested: {
                apiKey: `key-${index}`,
                note: `Bearer token-${index}`,
              },
            },
          }),
        ),
      );

      const response = await request(app.getHttpServer())
        .get('/api/v1/audit-events')
        .query({
          action: 'VOLUME_EVENT',
          q: 'audit-volume',
          page: 2,
          pageSize: 10,
        })
        .set('Cookie', cookie)
        .expect(200);
      const body = response.body as {
        data: Array<{
          id: string;
          tenantId: string;
          sequence: number;
          origin: string;
          retentionUntil: string;
          impersonator: null;
          after: Record<string, unknown>;
          integrity: { valid: boolean; hash: string; previousHash: string };
        }>;
        meta: {
          retention: { minimumDays: number; policy: string };
          integrity: { valid: boolean };
          pagination: { total: number; page: number; totalPages: number };
        };
      };
      expect(body.meta).toMatchObject({
        retention: { minimumDays: 365, policy: 'APPEND_ONLY' },
        integrity: { valid: true },
        pagination: { total: 25, page: 2, totalPages: 3 },
      });
      expect(body.data).toHaveLength(10);
      expect(
        body.data.every(
          (event) =>
            event.tenantId === principal.tenant_id &&
            event.origin === 'SYSTEM' &&
            event.impersonator === null &&
            event.integrity.valid &&
            event.integrity.hash.length === 64 &&
            event.integrity.previousHash.length === 64 &&
            Date.parse(event.retentionUntil) > Date.now(),
        ),
      ).toBe(true);
      expect(JSON.stringify(body.data)).not.toContain('password-');
      expect(JSON.stringify(body.data)).not.toContain('key-');
      expect(JSON.stringify(body.data)).not.toContain('token-');
      expect(JSON.stringify(body.data)).toContain('[REDACTED]');

      const exported = await request(app.getHttpServer())
        .get('/api/v1/audit-events/export')
        .query({ action: 'VOLUME_EVENT' })
        .set('Cookie', cookie)
        .expect(200)
        .expect('Content-Type', /text\/csv/)
        .expect('Content-Disposition', /audit-\d{4}-\d{2}-\d{2}\.csv/);
      expect(exported.text.split('\r\n').filter(Boolean)).toHaveLength(26);
      expect(exported.text).not.toContain('password-');
      expect(exported.text).toContain('[REDACTED]');

      await request(app.getHttpServer())
        .get('/api/v1/audit-events')
        .query({ action: 'AUDIT_EXPORT_CREATED' })
        .set('Cookie', cookie)
        .expect(200)
        .expect(
          ({
            body,
          }: {
            body: {
              data: Array<{
                origin: string;
                after: { filters: { action?: string }; results: number };
                integrity: { valid: boolean };
              }>;
            };
          }) => {
            expect(body.data[0]).toMatchObject({
              origin: 'ADMIN_CONSOLE',
              after: { results: 25 },
              integrity: { valid: true },
            });
            expect(body.data[0].after.filters.action).toBe('VOLUME_EVENT');
          },
        );

      const viewerRoleId = randomUUID();
      await dataSource.query(
        `INSERT INTO roles (id, tenant_id, code, name)
         VALUES (?, ?, 'AUDITOR', 'Auditor de solo lectura')`,
        [viewerRoleId, principal.tenant_id],
      );
      await dataSource.query(
        `INSERT INTO role_permissions (role_id, tenant_id, permission)
         VALUES (?, ?, 'AUDIT_VIEW')`,
        [viewerRoleId, principal.tenant_id],
      );
      await dataSource.query('DELETE FROM user_roles WHERE user_id = ?', [
        principal.id,
      ]);
      await dataSource.query(
        'INSERT INTO user_roles (user_id, role_id, tenant_id) VALUES (?, ?, ?)',
        [principal.id, viewerRoleId, principal.tenant_id],
      );
      const viewerCookie = await createPersistedSession(
        registrationPayload.email,
      );
      await request(app.getHttpServer())
        .get('/api/v1/audit-events')
        .query({ action: 'VOLUME_EVENT', pageSize: 1 })
        .set('Cookie', viewerCookie)
        .expect(200);
      await request(app.getHttpServer())
        .get('/api/v1/audit-events/export')
        .set('Cookie', viewerCookie)
        .expect(403)
        .expect(({ body }: { body: { code?: string } }) => {
          expect(body.code).toBe('AUDIT_ACCESS_DENIED');
        });

      const eventId = body.data[0].id;
      await dataSource.query(
        `UPDATE audit_events SET after_data = JSON_OBJECT('tampered', TRUE)
         WHERE id = ?`,
        [eventId],
      );
      await request(app.getHttpServer())
        .get('/api/v1/audit-events')
        .query({ action: 'VOLUME_EVENT', q: eventId })
        .set('Cookie', viewerCookie)
        .expect(200)
        .expect(({ body }: { body: unknown }) => {
          expect(body).toMatchObject({
            data: [{ id: eventId, integrity: { valid: false } }],
            meta: { integrity: { valid: false } },
          });
        });
    });
  });

  describe('Core release persistence', () => {
    beforeEach(async () => {
      await resetIdentityData();
      const throttlerStorage =
        app.get<ThrottlerStorageService>(ThrottlerStorage);
      throttlerStorage.onApplicationShutdown();
      throttlerStorage.storage.clear();
    });

    it('keeps the completed Core journey available after an application restart', async () => {
      await request(app.getHttpServer())
        .post('/api/v1/auth/registrations')
        .set('Idempotency-Key', 'release-registration')
        .send(registrationPayload)
        .expect(201);
      const login = await request(app.getHttpServer())
        .post('/api/v1/auth/sessions')
        .send({
          email: registrationPayload.email,
          password: registrationPayload.password,
        })
        .expect(200);
      const cookie = (
        login.headers['set-cookie'] as unknown as string[]
      )[0].split(';')[0];

      await request(app.getHttpServer())
        .put('/api/v1/onboarding/company')
        .set('Cookie', cookie)
        .send({
          legalName: 'Tienda Persistente, S.A. de C.V.',
          tradeName: 'Tienda Persistente',
          countryCode: 'MX',
        })
        .expect(200);
      const location = await request(app.getHttpServer())
        .put('/api/v1/onboarding/initial-location')
        .set('Cookie', cookie)
        .send({
          branchName: 'Sucursal Persistente',
          timezone: 'America/Mexico_City',
          warehouseName: 'Bodega Persistente',
          locationName: 'General Persistente',
        })
        .expect(200);
      await request(app.getHttpServer())
        .put('/api/v1/onboarding/initial-cash-register')
        .set('Cookie', cookie)
        .send({ name: 'Caja Persistente' })
        .expect(200);

      const product = await request(app.getHttpServer())
        .post('/api/v1/products')
        .set('Cookie', cookie)
        .send({
          name: 'Producto Persistente',
          sku: 'RELEASE-CORE-1',
          cost: '5.00',
          price: '10.00',
        })
        .expect(201);
      const productId = (product.body as { data: { id: string } }).data.id;
      const locationId = (
        location.body as { data: { location: { id: string } } }
      ).data.location.id;
      await request(app.getHttpServer())
        .post('/api/v1/inventory/movements')
        .set('Cookie', cookie)
        .set('Idempotency-Key', 'release-stock')
        .send({
          productId,
          locationId,
          type: 'INITIAL',
          quantity: '10',
          reason: 'Stock de release',
        })
        .expect(201);
      await openCurrentCashRegister(cookie, 'release-open-shift');
      await request(app.getHttpServer())
        .post('/api/v1/pos/sales/cash')
        .set('Cookie', cookie)
        .set('Idempotency-Key', 'release-sale')
        .send({ lines: [{ productId, quantity: '2' }], cashReceived: '20.00' })
        .expect(201);

      await app.close();
      await bootApplication();

      await request(app.getHttpServer())
        .get('/api/v1/auth/sessions/current')
        .set('Cookie', cookie)
        .expect(200)
        .expect(({ body }: { body: unknown }) => {
          expect(body).toMatchObject({
            data: {
              tenant: { name: 'Tienda Persistente' },
              context: {
                branch: { name: 'Sucursal Persistente' },
                warehouse: { name: 'Bodega Persistente' },
                cashRegister: { name: 'Caja Persistente' },
              },
            },
          });
        });
      await request(app.getHttpServer())
        .get(`/api/v1/inventory/products/${productId}/balance`)
        .query({ locationId })
        .set('Cookie', cookie)
        .expect(200)
        .expect(({ body }: { body: unknown }) => {
          expect(body).toMatchObject({
            data: {
              product: { id: productId, sku: 'RELEASE-CORE-1' },
              quantity: '8.000',
            },
          });
        });
      await request(app.getHttpServer())
        .get('/api/v1/pos/sales')
        .set('Cookie', cookie)
        .expect(200)
        .expect(({ body }: { body: unknown }) => {
          expect(body).toMatchObject({
            data: [{ status: 'COMPLETED', total: '20.00' }],
            meta: { pagination: { total: 1 } },
          });
        });
    });
  });

  afterAll(async () => {
    await app.close();
  });
});
