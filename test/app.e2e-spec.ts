import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
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
import type { OfflineBootstrapResponseV1 } from '../src/offline-sync/offline-sync-v1.contract';
import type { OfflineChangesResponseV1 } from '../src/offline-sync/offline-sync-v1.contract';
import { StructuredTelemetryService } from '../src/observability/structured-telemetry.service';

jest.setTimeout(15_000);

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
      'privacy_requests',
      'privacy_legal_holds',
      'privacy_policies',
      'inventory_reconciliation_guards',
      'inventory_reconciliation_findings',
      'inventory_reconciliation_runs',
      'inventory_stock_alert_states',
      'inventory_stock_thresholds',
      'inventory_valuation_policy_history',
      'inventory_valuation_policies',
      'offline_commands',
      'offline_device_sequences',
      'offline_devices',
      'offline_sync_tombstones',
      'password_reset_tokens',
      'pos_peripheral_operations',
      'pos_peripheral_profiles',
      'price_list_items',
      'sale_receipt_snapshots',
      'customer_credit_ledger',
      'customer_credit_payment_allocations',
      'customer_debt_ledger',
      'customer_credit_payments',
      'customer_credit_installments',
      'customer_credit_accounts',
      'customer_credit_profiles',
      'sale_return_settlements',
      'sale_return_lines',
      'sale_returns',
      'suspended_sale_lines',
      'suspended_sales',
      'customer_order_transitions',
      'customer_order_payments',
      'customer_order_lines',
      'customer_orders',
      'sale_payments',
      'sale_lines',
      'sales',
      'price_lists',
      'cash_register_movements',
      'cash_register_shifts',
      'product_reservation_lines',
      'product_reservations',
      'customers',
      'inventory_count_attempts',
      'inventory_count_session_lines',
      'inventory_count_sessions',
      'inventory_counts',
      'inventory_movement_fifo_layers',
      'inventory_fifo_layers',
      'inventory_fifo_cutovers',
      'inventory_movement_lots',
      'inventory_serial_events',
      'inventory_serials',
      'inventory_lot_origins',
      'inventory_lot_balances',
      'inventory_lots',
      'inventory_valuations',
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
      const telemetry = jest
        .spyOn(app.get(StructuredTelemetryService), 'emit')
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
        expect(JSON.stringify(telemetry.mock.calls)).not.toContain(
          sensitiveValue,
        );
        expect(telemetry).toHaveBeenCalledWith(
          expect.objectContaining({ event: 'unhandled_request_error' }),
        );
      } finally {
        service.mockRestore();
        telemetry.mockRestore();
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

    it('supports a rotating bearer session and tenant-bound bootstrap for Mobile', async () => {
      await registerAccount('mobile-session-registration');

      const login = await request(app.getHttpServer())
        .post('/api/v1/auth/mobile/sessions')
        .send({
          email: registrationPayload.email,
          password: registrationPayload.password,
        })
        .expect(200);
      expect(login.headers['set-cookie']).toBeUndefined();
      expect(login.headers['cache-control']).toContain('no-store');
      expect(login.body).toMatchObject({
        data: {
          user: { email: registrationPayload.email, roles: ['ADMIN'] },
          tenant: { name: registrationPayload.organizationName },
        },
        meta: { apiVersion: '1' },
        auth: { tokenType: 'Bearer' },
      });

      const originalToken = (
        login.body as {
          auth: { accessToken: string };
        }
      ).auth.accessToken;
      expect(originalToken).toMatch(/^[A-Za-z0-9_-]{43}$/);

      const current = await request(app.getHttpServer())
        .get('/api/v1/auth/sessions/current')
        .set('Authorization', `Bearer ${originalToken}`)
        .set('X-Tenant-Id', '00000000-0000-0000-0000-000000000000')
        .expect(200);
      const tenantId = (current.body as { data: { tenant: { id: string } } })
        .data.tenant.id;
      const currentUserId = (current.body as { data: { user: { id: string } } })
        .data.user.id;

      await request(app.getHttpServer())
        .get('/api/v1/offline/bootstrap')
        .set('Authorization', `Bearer ${originalToken}`)
        .query({
          protocolVersion: '1.0',
          deviceId: '11111111-1111-4111-8111-111111111111',
          pageSize: 500,
        })
        .expect(200)
        .expect(
          ({
            body,
          }: {
            body: {
              data: {
                scope: { tenantId: string; userId: string };
                identity: { tenant: { id: string } };
              };
            };
          }) => {
            expect(body.data.scope.tenantId).toBe(tenantId);
            expect(body.data.identity.tenant.id).toBe(tenantId);
            expect(body.data.scope.userId).toBe(currentUserId);
          },
        );

      const refresh = await request(app.getHttpServer())
        .post('/api/v1/auth/mobile/sessions/refresh')
        .set('Authorization', `Bearer ${originalToken}`)
        .expect(200);
      const rotatedToken = (
        refresh.body as {
          auth: { accessToken: string };
        }
      ).auth.accessToken;
      expect(refresh.headers['cache-control']).toContain('no-store');
      expect(rotatedToken).not.toBe(originalToken);

      await request(app.getHttpServer())
        .get('/api/v1/auth/sessions/current')
        .set('Authorization', `Bearer ${originalToken}`)
        .expect(401);

      await request(app.getHttpServer())
        .delete('/api/v1/auth/sessions/current')
        .set('Authorization', `Bearer ${rotatedToken}`)
        .expect(204);
      await request(app.getHttpServer())
        .get('/api/v1/auth/sessions/current')
        .set('Authorization', `Bearer ${rotatedToken}`)
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
                  'CASH_DRAWER_OPEN',
                  'CASH_REGISTER_CLOSE',
                  'CASH_REGISTER_MOVE',
                  'CASH_REGISTER_OPEN',
                  'INVENTORY_ADJUST',
                  'INVENTORY_APPROVE',
                  'INVENTORY_COUNT',
                  'INVENTORY_TRANSFER',
                  'INVENTORY_VALUATION_MANAGE',
                  'INVENTORY_VIEW',
                  'PRIVACY_MANAGE',
                  'PRODUCTS_MANAGE',
                  'PURCHASE_ORDERS_APPROVE',
                  'PURCHASE_ORDERS_MANAGE',
                  'PURCHASE_RECEIPTS_OVERAGE',
                  'SALE_REPRINT',
                  'SALES_CREDIT',
                  'SALES_DISCOUNT',
                  'SALES_MANAGE',
                  'SALES_RETURN',
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
      trackLots = false,
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
          trackLots,
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
          quantity: '2.000',
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
                      resultingCatalogCost: '81.80',
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
          valuationQuantity: string;
          valuationValue: string;
          averageUnitCost: string;
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
           (SELECT quantity FROM inventory_valuations
            WHERE product_id = ?) AS valuationQuantity,
           (SELECT inventory_value FROM inventory_valuations
            WHERE product_id = ?) AS valuationValue,
           (SELECT average_unit_cost FROM inventory_valuations
            WHERE product_id = ?) AS averageUnitCost,
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
          order.lines[0].productId,
          order.lines[0].productId,
          order.lines[0].productId,
          order.id,
        ],
      );
      expect(Number(counts.receipts)).toBe(3);
      expect(Number(counts.receiptLines)).toBe(3);
      expect(Number(counts.purchaseMovements)).toBe(3);
      expect(counts.balance).toBe('7.000');
      expect(counts.productCost).toBe('80.77');
      expect(counts.historicalSaleCost).toBe('85.40');
      expect(counts.receivedCost).toBe('480.00');
      expect(counts.valuationQuantity).toBe('7.000');
      expect(counts.valuationValue).toBe('565.4000');
      expect(counts.averageUnitCost).toBe('80.7714');
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
            valuation: {
              unitCost: '80.0000',
              averageUnitCost: '80.7714',
            },
          });
          expect(body.meta).toMatchObject({ pagination: { total: 3 } });
        });
      await request(app.getHttpServer())
        .get('/api/v1/inventory/stock')
        .set('Cookie', cookie)
        .expect(200)
        .expect(
          ({
            body,
          }: {
            body: { data: unknown[]; meta: Record<string, unknown> };
          }) => {
            expect(body.data).toEqual(
              expect.arrayContaining([
                expect.objectContaining({
                  product: {
                    id: order.lines[0].productId,
                    name: 'Receipts Producto',
                    sku: 'RECEIPTS-1',
                    active: true,
                    trackLots: false,
                  },
                  totalQuantity: '7.000',
                  averageUnitCost: '80.7714',
                  inventoryValue: '565.3998',
                  costing: {
                    method: 'MOVING_AVERAGE',
                    currency: 'MXN',
                    quantity: '7.000',
                    inventoryValue: '565.3998',
                    reconciled: true,
                  },
                  valuation: {
                    quantity: '7.000',
                    inventoryValue: '565.4000',
                    quantityReconciled: true,
                    valueReconciled: true,
                    reconciled: true,
                  },
                }),
              ]),
            );
            expect(body.meta).toMatchObject({
              valuation: {
                method: 'MOVING_AVERAGE',
                policyVersion: 1,
                currency: 'MXN',
              },
            });
            expect(
              Number.isNaN(
                Date.parse((body.meta.valuation as { asOf: string }).asOf),
              ),
            ).toBe(false);
          },
        );
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
          valuations: number | string;
          productCost: string;
        }>
      >(
        `SELECT po.status, po.version, pol.received_quantity AS receivedQuantity,
           (SELECT COUNT(*) FROM purchase_receipts WHERE purchase_order_id = po.id) AS receipts,
           (SELECT COUNT(*) FROM inventory_movements
            WHERE purchase_receipt_id IS NOT NULL) AS movements,
           (SELECT COUNT(*) FROM inventory_balances
            WHERE product_id = pol.product_id AND location_id = ?) AS balances,
           (SELECT COUNT(*) FROM inventory_valuations
            WHERE product_id = pol.product_id) AS valuations,
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
        valuations: Number(state.valuations),
        productCost: state.productCost,
      }).toEqual({
        status: 'APPROVED',
        version: 2,
        receivedQuantity: '0.000',
        receipts: 0,
        movements: 0,
        balances: 0,
        valuations: 0,
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
        true,
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
              lotCode: 'LOT-PROVEEDOR-100',
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
                    {
                      lotCode: 'LOT-PROVEEDOR-100',
                      returnedQuantity: '2.000',
                      returnableQuantity: '3.000',
                    },
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
            lots: [
              {
                code: 'LOT-PROVEEDOR-100',
                selectionMode: 'MANUAL',
                unitCost: '80.0000',
                currency: 'MXN',
                valueChange: '-240.0000',
              },
            ],
          });
          expect(body.meta).toMatchObject({ pagination: { total: 2 } });
        });
      await request(app.getHttpServer())
        .get(`/api/v1/inventory/products/${setup.productId}/lots`)
        .set('Cookie', cookie)
        .expect(200)
        .expect(({ body }: { body: unknown }) =>
          expect(body).toMatchObject({
            data: [
              {
                code: 'LOT-PROVEEDOR-100',
                quantity: '0.000',
                unitCost: '80.0000',
                currency: 'MXN',
                inventoryValue: '0.0000',
                origins: [
                  {
                    purchaseReceiptLineId: receipt.lines[0].id,
                    quantity: '5.000',
                    unitCost: '80.0000',
                    currency: 'MXN',
                    receipt: {
                      id: receipt.id,
                      documentReference: 'REM-DEV-100',
                    },
                    purchaseOrder: { id: order.id },
                  },
                ],
              },
            ],
            meta: {
              totalQuantity: '0.000',
              lotQuantity: '0.000',
              reconciled: true,
              currency: 'MXN',
              inventoryValue: '0.0000',
            },
          }),
        );
    });

    it('values the lot actually sold and preserves its receipt cost on void and return', async () => {
      await registerAccount('lot-cost-registration');
      const cookie = await createPersistedSession(registrationPayload.email);
      const setup = await setupProcurement(
        registrationPayload.email,
        cookie,
        'LotCost',
        true,
      );

      const receiveLot = async (
        suffix: string,
        quantity: string,
        unitCost: string,
      ): Promise<{
        orderId: string;
        receiptId: string;
        receiptLineId: string;
      }> => {
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
                quantity,
                unitCost,
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
          .set('Idempotency-Key', `lot-cost-approve-${suffix}`)
          .send({ version: 1 })
          .expect(200);
        let receipt!: { id: string; lines: Array<{ id: string }> };
        await request(app.getHttpServer())
          .post(`/api/v1/purchase-orders/${order.id}/receipts`)
          .set('Cookie', cookie)
          .set('Idempotency-Key', `lot-cost-receive-${suffix}`)
          .send({
            version: 2,
            locationId: setup.locationId,
            documentReference: `REM-LOT-${suffix}`,
            lines: [
              {
                purchaseOrderLineId: order.lines[0].id,
                receivedQuantity: quantity,
                lotCode: `LOT-${suffix}`,
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
        return {
          orderId: order.id,
          receiptId: receipt.id,
          receiptLineId: receipt.lines[0].id,
        };
      };

      await receiveLot('A', '3.000', '80.00');
      const lotBReceipt = await receiveLot('B', '4.000', '120.00');
      const lotResponse = await request(app.getHttpServer())
        .get(`/api/v1/inventory/products/${setup.productId}/lots`)
        .set('Cookie', cookie)
        .expect(200);
      const lots = (
        lotResponse.body as { data: Array<{ id: string; code: string }> }
      ).data;
      const lotB = lots.find(({ code }) => code === 'LOT-B')!;
      expect(lotResponse.body).toMatchObject({
        data: [
          {
            code: 'LOT-A',
            quantity: '3.000',
            unitCost: '80.0000',
            currency: 'MXN',
            inventoryValue: '240.0000',
          },
          {
            code: 'LOT-B',
            quantity: '4.000',
            unitCost: '120.0000',
            currency: 'MXN',
            inventoryValue: '480.0000',
            origins: [
              {
                purchaseReceiptLineId: lotBReceipt.receiptLineId,
                quantity: '4.000',
                unitCost: '120.0000',
                currency: 'MXN',
              },
            ],
          },
        ],
        meta: {
          totalQuantity: '7.000',
          lotQuantity: '7.000',
          reconciled: true,
          currency: 'MXN',
          inventoryValue: '720.0000',
        },
      });

      const fifoResponse = await request(app.getHttpServer())
        .get(`/api/v1/inventory/products/${setup.productId}/fifo-layers`)
        .set('Cookie', cookie)
        .expect(200);
      const fifoLayers = (
        fifoResponse.body as {
          data: Array<{
            id: string;
            source: { purchaseReceiptLineId: string };
          }>;
        }
      ).data;
      const fifoLayerA = fifoLayers[0];
      const fifoLayerB = fifoLayers.find(
        ({ source }) =>
          source.purchaseReceiptLineId === lotBReceipt.receiptLineId,
      )!;
      expect(fifoResponse.body).toMatchObject({
        data: [
          {
            originType: 'PURCHASE_RECEIPT',
            originalQuantity: '3.000',
            remainingQuantity: '3.000',
            unitCost: '80.0000',
            currency: 'MXN',
            inventoryValue: '240.0000',
          },
          {
            originType: 'PURCHASE_RECEIPT',
            originalQuantity: '4.000',
            remainingQuantity: '4.000',
            unitCost: '120.0000',
            currency: 'MXN',
            inventoryValue: '480.0000',
          },
        ],
        meta: {
          method: 'FIFO',
          cutover: {
            migrationRule: 'OPENING_BALANCE_AT_MOVING_AVERAGE',
          },
          totalQuantity: '7.000',
          layerQuantity: '7.000',
          reconciled: true,
          currency: 'MXN',
          inventoryValue: '720.0000',
        },
      });

      await openCurrentCashRegister(cookie, 'lot-cost-open-shift');
      const sale = await request(app.getHttpServer())
        .post('/api/v1/pos/sales')
        .set('Cookie', cookie)
        .set('Idempotency-Key', 'lot-cost-sale')
        .send({
          lines: [
            { productId: setup.productId, lotId: lotB.id, quantity: '2' },
          ],
          payment: { method: 'CASH', amountReceived: '240.00' },
        })
        .expect(201);
      const saleId = (sale.body as { data: { id: string } }).data.id;
      await request(app.getHttpServer())
        .get('/api/v1/inventory/movements')
        .set('Cookie', cookie)
        .query({ productId: setup.productId, type: 'SALE' })
        .expect(200)
        .expect(({ body }: { body: unknown }) =>
          expect(body).toMatchObject({
            data: [
              {
                lots: [
                  {
                    id: lotB.id,
                    unitCost: '120.0000',
                    currency: 'MXN',
                    valueChange: '-240.0000',
                  },
                ],
                fifoValuation: {
                  unitCost: '80.0000',
                  valueChange: '-160.0000',
                  resultingInventoryValue: '560.0000',
                },
                fifoLayers: [
                  {
                    layerId: fifoLayerA.id,
                    quantityChange: '-2.000',
                    unitCost: '80.0000',
                    currency: 'MXN',
                    valueChange: '-160.0000',
                    selectionMode: 'FIFO',
                  },
                ],
              },
            ],
          }),
        );
      await request(app.getHttpServer())
        .post(`/api/v1/pos/sales/${saleId}/void`)
        .set('Cookie', cookie)
        .set('Idempotency-Key', 'lot-cost-sale-void')
        .send({ reason: 'Restaurar el costo específico del lote' })
        .expect(201);

      await request(app.getHttpServer())
        .get('/api/v1/inventory/movements')
        .set('Cookie', cookie)
        .query({ productId: setup.productId, type: 'SALE_VOID' })
        .expect(200)
        .expect(({ body }: { body: unknown }) => {
          expect(body).toMatchObject({
            data: [
              {
                fifoValuation: {
                  unitCost: '80.0000',
                  valueChange: '160.0000',
                  resultingInventoryValue: '720.0000',
                },
                fifoLayers: [
                  {
                    layerId: fifoLayerA.id,
                    quantityChange: '2.000',
                    unitCost: '80.0000',
                    selectionMode: 'RESTORE',
                  },
                ],
              },
            ],
          });
          const response = body as {
            data: Array<{
              fifoLayers: Array<{ sourceAllocationId: string | null }>;
            }>;
          };
          expect(response.data[0].fifoLayers[0].sourceAllocationId).toEqual(
            expect.any(String),
          );
        });

      await request(app.getHttpServer())
        .post(`/api/v1/purchase-orders/${lotBReceipt.orderId}/returns`)
        .set('Cookie', cookie)
        .set('Idempotency-Key', 'lot-cost-supplier-return')
        .send({
          purchaseReceiptId: lotBReceipt.receiptId,
          documentReference: 'DEV-LOT-B',
          reason: 'Devolución parcial del lote B',
          lines: [
            {
              purchaseReceiptLineId: lotBReceipt.receiptLineId,
              returnedQuantity: '1.000',
            },
          ],
        })
        .expect(201);
      await request(app.getHttpServer())
        .get('/api/v1/inventory/movements')
        .set('Cookie', cookie)
        .query({ productId: setup.productId, type: 'SUPPLIER_RETURN' })
        .expect(200)
        .expect(({ body }: { body: unknown }) =>
          expect(body).toMatchObject({
            data: [
              {
                lots: [
                  {
                    id: lotB.id,
                    unitCost: '120.0000',
                    currency: 'MXN',
                    valueChange: '-120.0000',
                  },
                ],
                fifoValuation: {
                  unitCost: '120.0000',
                  valueChange: '-120.0000',
                  resultingInventoryValue: '600.0000',
                },
                fifoLayers: [
                  {
                    layerId: fifoLayerB.id,
                    quantityChange: '-1.000',
                    unitCost: '120.0000',
                    currency: 'MXN',
                    valueChange: '-120.0000',
                    selectionMode: 'ORIGIN_RETURN',
                  },
                ],
              },
            ],
          }),
        );
      await request(app.getHttpServer())
        .get(`/api/v1/inventory/products/${setup.productId}/lots`)
        .set('Cookie', cookie)
        .expect(200)
        .expect(({ body }: { body: unknown }) =>
          expect(body).toMatchObject({
            data: [
              { code: 'LOT-A', quantity: '3.000', inventoryValue: '240.0000' },
              { code: 'LOT-B', quantity: '3.000', inventoryValue: '360.0000' },
            ],
            meta: {
              totalQuantity: '6.000',
              lotQuantity: '6.000',
              inventoryValue: '600.0000',
              reconciled: true,
            },
          }),
        );
      await request(app.getHttpServer())
        .get(`/api/v1/inventory/products/${setup.productId}/fifo-layers`)
        .set('Cookie', cookie)
        .expect(200)
        .expect(({ body }: { body: unknown }) =>
          expect(body).toMatchObject({
            data: [
              {
                id: fifoLayerA.id,
                remainingQuantity: '3.000',
                inventoryValue: '240.0000',
              },
              {
                id: fifoLayerB.id,
                remainingQuantity: '3.000',
                inventoryValue: '360.0000',
              },
            ],
            meta: {
              totalQuantity: '6.000',
              layerQuantity: '6.000',
              inventoryValue: '600.0000',
              reconciled: true,
            },
          }),
        );
      await request(app.getHttpServer())
        .get('/api/v1/inventory/stock')
        .set('Cookie', cookie)
        .query({ productId: setup.productId })
        .expect(200)
        .expect(({ body }: { body: unknown }) =>
          expect(body).toMatchObject({
            data: [
              {
                product: { id: setup.productId },
                totalQuantity: '6.000',
                lotTracking: {
                  lotQuantity: '6.000',
                  reconciled: true,
                  currency: 'MXN',
                  inventoryValue: '600.0000',
                },
                fifoValuation: {
                  quantity: '6.000',
                  inventoryValue: '600.0000',
                  currency: 'MXN',
                  reconciled: true,
                },
              },
            ],
          }),
        );
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

  describe('tenant inventory valuation policy', () => {
    beforeEach(resetIdentityData);

    it('prevalidates, authorizes and cuts over FIFO and specific-lot valuation without rewriting history', async () => {
      await registerAccount('valuation-policy-registration');
      const cookie = await createPersistedSession(registrationPayload.email);
      await request(app.getHttpServer())
        .put('/api/v1/onboarding/company')
        .set('Cookie', cookie)
        .send({
          legalName: 'Valuation SA',
          tradeName: 'Valuation',
          countryCode: 'MX',
        })
        .expect(200);
      await request(app.getHttpServer())
        .put('/api/v1/onboarding/initial-location')
        .set('Cookie', cookie)
        .send({
          branchName: 'Central',
          timezone: 'America/Mexico_City',
          warehouseName: 'General',
          locationName: 'Piso',
        })
        .expect(200);
      await request(app.getHttpServer())
        .put('/api/v1/onboarding/initial-cash-register')
        .set('Cookie', cookie)
        .send({ name: 'Caja' })
        .expect(200);
      const product = await request(app.getHttpServer())
        .post('/api/v1/products')
        .set('Cookie', cookie)
        .send({
          name: 'Producto valorado',
          sku: 'VAL-1',
          cost: '10',
          price: '20',
        })
        .expect(201);
      const [location] = await dataSource.query<Array<{ id: string }>>(
        'SELECT id FROM locations LIMIT 1',
      );
      const productId = (product.body as { data: { id: string } }).data.id;
      await request(app.getHttpServer())
        .post('/api/v1/inventory/movements')
        .set('Cookie', cookie)
        .set('Idempotency-Key', 'valuation-opening-stock')
        .send({
          productId,
          locationId: location.id,
          type: 'INITIAL',
          quantity: '5',
          reason: 'Apertura',
        })
        .expect(201);

      const [adminRole] = await dataSource.query<
        Array<{ id: string; tenant_id: string }>
      >("SELECT id, tenant_id FROM roles WHERE code = 'ADMIN'");
      await dataSource.query(
        `DELETE FROM role_permissions
         WHERE role_id = ? AND tenant_id = ?
           AND permission = 'INVENTORY_VALUATION_MANAGE'`,
        [adminRole.id, adminRole.tenant_id],
      );
      await request(app.getHttpServer())
        .post('/api/v1/inventory/valuation-policy/preview')
        .set('Cookie', cookie)
        .send({ targetMethod: 'FIFO' })
        .expect(403);
      await dataSource.query(
        `INSERT INTO role_permissions (role_id, tenant_id, permission)
         VALUES (?, ?, 'INVENTORY_VALUATION_MANAGE')`,
        [adminRole.id, adminRole.tenant_id],
      );

      const fifoPreview = await request(app.getHttpServer())
        .post('/api/v1/inventory/valuation-policy/preview')
        .set('Cookie', cookie)
        .send({ targetMethod: 'FIFO' })
        .expect(201);
      expect(fifoPreview.body).toMatchObject({
        data: {
          current: { method: 'MOVING_AVERAGE', version: 1 },
          targetMethod: 'FIFO',
          allowed: true,
          strategy: 'USE_MAINTAINED_FIFO_LAYERS',
        },
      });
      const fifoPlan = fifoPreview.body as {
        data: { planFingerprint: string };
      };
      await request(app.getHttpServer())
        .post('/api/v1/inventory/valuation-policy/changes')
        .set('Cookie', cookie)
        .set('Idempotency-Key', 'valuation-fifo-invalid-plan')
        .send({
          targetMethod: 'FIFO',
          expectedVersion: 1,
          planFingerprint: '0'.repeat(64),
        })
        .expect(409);
      const [[unchanged], [historyBefore]] = await Promise.all([
        dataSource.query<Array<{ method: string; version: number | string }>>(
          'SELECT method, version FROM inventory_valuation_policies LIMIT 1',
        ),
        dataSource.query<Array<{ total: number | string }>>(
          'SELECT COUNT(*) AS total FROM inventory_valuation_policy_history',
        ),
      ]);
      expect(unchanged).toMatchObject({ method: 'MOVING_AVERAGE' });
      expect(Number(historyBefore.total)).toBe(0);

      await request(app.getHttpServer())
        .post('/api/v1/inventory/valuation-policy/changes')
        .set('Cookie', cookie)
        .set('Idempotency-Key', 'valuation-fifo-cutover')
        .send({
          targetMethod: 'FIFO',
          expectedVersion: 1,
          planFingerprint: fifoPlan.data.planFingerprint,
        })
        .expect(201)
        .expect(({ body }: { body: unknown }) => {
          expect(body).toMatchObject({
            data: {
              method: 'FIFO',
              version: 2,
              migrationRule: 'FORWARD_ONLY_CUTOVER',
            },
          });
        });
      await request(app.getHttpServer())
        .post('/api/v1/inventory/movements')
        .set('Cookie', cookie)
        .set('Idempotency-Key', 'valuation-fifo-exit')
        .send({
          productId,
          locationId: location.id,
          type: 'EXIT',
          quantity: '1',
          reason: 'Salida FIFO',
          reference: 'FIFO-1',
        })
        .expect(201)
        .expect(({ body }: { body: unknown }) => {
          expect(body).toMatchObject({
            data: { valuation: { method: 'FIFO', policyVersion: 2 } },
          });
        });
      await request(app.getHttpServer())
        .get('/api/v1/inventory/stock')
        .set('Cookie', cookie)
        .expect(200)
        .expect(({ body }: { body: unknown }) => {
          expect(body).toMatchObject({
            data: [
              {
                costing: {
                  method: 'FIFO',
                  currency: 'MXN',
                  quantity: '4.000',
                  inventoryValue: '40.0000',
                  reconciled: true,
                },
              },
            ],
            meta: { valuation: { method: 'FIFO', policyVersion: 2 } },
          });
        });

      const lotPreview = await request(app.getHttpServer())
        .post('/api/v1/inventory/valuation-policy/preview')
        .set('Cookie', cookie)
        .send({ targetMethod: 'SPECIFIC_LOT' })
        .expect(201);
      expect(lotPreview.body).toMatchObject({
        data: {
          allowed: true,
          productsToMigrate: 1,
          locationsToMigrate: 1,
          strategy: 'OPENING_LOTS_AT_MOVING_AVERAGE',
        },
      });
      const lotPlan = lotPreview.body as {
        data: { planFingerprint: string };
      };
      await request(app.getHttpServer())
        .post('/api/v1/inventory/valuation-policy/changes')
        .set('Cookie', cookie)
        .set('Idempotency-Key', 'valuation-specific-lot-cutover')
        .send({
          targetMethod: 'SPECIFIC_LOT',
          expectedVersion: 2,
          planFingerprint: lotPlan.data.planFingerprint,
        })
        .expect(201);
      await request(app.getHttpServer())
        .get('/api/v1/inventory/stock')
        .set('Cookie', cookie)
        .expect(200)
        .expect(({ body }: { body: unknown }) => {
          expect(body).toMatchObject({
            data: [
              {
                costing: {
                  method: 'SPECIFIC_LOT',
                  currency: 'MXN',
                  quantity: '4.000',
                  inventoryValue: '40.0000',
                  reconciled: true,
                },
              },
            ],
            meta: {
              valuation: { method: 'SPECIFIC_LOT', policyVersion: 3 },
            },
          });
        });
      await request(app.getHttpServer())
        .post('/api/v1/inventory/valuation-policy/changes')
        .set('Cookie', cookie)
        .set('Idempotency-Key', 'valuation-fifo-cutover')
        .send({
          targetMethod: 'FIFO',
          expectedVersion: 1,
          planFingerprint: fifoPlan.data.planFingerprint,
        })
        .expect(201)
        .expect(({ body }: { body: unknown }) => {
          expect(body).toMatchObject({
            data: { method: 'FIFO', version: 2 },
            meta: { replay: true },
          });
        });
      const [cut] = await dataSource.query<
        Array<{
          track_lots: number | boolean;
          lot_quantity: string;
          history: number | string;
          audits: number | string;
        }>
      >(
        `SELECT p.track_lots,
           (SELECT SUM(ilb.quantity) FROM inventory_lots il
            INNER JOIN inventory_lot_balances ilb
              ON ilb.lot_id = il.id AND ilb.tenant_id = il.tenant_id
            WHERE il.tenant_id = p.tenant_id AND il.product_id = p.id) AS lot_quantity,
           (SELECT COUNT(*) FROM inventory_valuation_policy_history) AS history,
           (SELECT COUNT(*) FROM audit_events
            WHERE action = 'INVENTORY_VALUATION_METHOD_CHANGED') AS audits
         FROM products p WHERE p.id = ?`,
        [productId],
      );
      expect({
        trackLots: Boolean(cut.track_lots),
        lotQuantity: cut.lot_quantity,
        history: Number(cut.history),
        audits: Number(cut.audits),
      }).toEqual({
        trackLots: true,
        lotQuantity: '4.000',
        history: 2,
        audits: 2,
      });
      const newProduct = await request(app.getHttpServer())
        .post('/api/v1/products')
        .set('Cookie', cookie)
        .send({ name: 'Nuevo por lote', sku: 'VAL-2', cost: '12', price: '24' })
        .expect(201);
      expect(newProduct.body).toMatchObject({ data: { trackLots: true } });

      const bootstrap = await request(app.getHttpServer())
        .get('/api/v1/offline/bootstrap')
        .set('Cookie', cookie)
        .query({ deviceId: randomUUID(), pageSize: 50 })
        .expect(200);
      expect(bootstrap.body).toMatchObject({
        data: { valuationPolicy: { method: 'SPECIFIC_LOT', version: 3 } },
      });
      const bootstrapData = bootstrap.body as {
        data: {
          identity: { tenant: { id: string }; user: { id: string } };
          scope: {
            deviceId: string;
            branchId: string;
            cashRegisterId: string;
          };
        };
      };
      const { identity, scope } = bootstrapData.data;
      const stale = await request(app.getHttpServer())
        .post('/api/v1/offline/commands/batch')
        .set('Cookie', cookie)
        .send({
          commands: [
            {
              protocolVersion: '1.0',
              commandId: randomUUID(),
              idempotencyKey: `valuation-offline-${randomUUID()}`,
              scope: {
                tenantId: identity.tenant.id,
                userId: identity.user.id,
                deviceId: scope.deviceId,
                branchId: scope.branchId,
                cashRegisterId: scope.cashRegisterId,
              },
              sequence: 1,
              createdAt: new Date().toISOString(),
              valuationMethod: 'MOVING_AVERAGE',
              valuationPolicyVersion: 1,
              kind: 'INVENTORY_MOVEMENT',
              payload: {
                productId,
                locationId: location.id,
                type: 'ENTRY',
                quantity: '1',
                reason: 'Snapshot obsoleto',
                reference: 'STALE-1',
              },
            },
          ],
        })
        .expect(201);
      expect(stale.body).toMatchObject({
        data: {
          results: [
            {
              status: 'ERROR',
              error: {
                details: { code: 'OFFLINE_VALUATION_POLICY_STALE' },
              },
            },
          ],
        },
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

    it('manages tenant categories and brands without orphaning product references', async () => {
      await registerAccount('classification-primary-registration');
      const cookie = await createPersistedSession(registrationPayload.email);
      await completeOnboarding(registrationPayload.email, cookie);

      const createClassification = async (
        kind: 'categories' | 'brands',
        name: string,
      ) => {
        const response = await request(app.getHttpServer())
          .post(`/api/v1/catalog/${kind}`)
          .set('Cookie', cookie)
          .send({ name })
          .expect(201);
        return (response.body as { data: { id: string } }).data.id;
      };
      const beveragesId = await createClassification('categories', 'Bebidas');
      const pantryId = await createClassification('categories', 'Despensa');
      const brandId = await createClassification('brands', 'Casa Norte');
      await request(app.getHttpServer())
        .post('/api/v1/catalog/categories')
        .set('Cookie', cookie)
        .send({ name: ' bebidas ' })
        .expect(409);

      const productResponse = await request(app.getHttpServer())
        .post('/api/v1/products')
        .set('Cookie', cookie)
        .send({
          name: 'Agua mineral',
          sku: 'AGUA-1',
          categoryName: 'Bebidas',
          brandName: 'Casa Norte',
          cost: '5.00',
          price: '9.00',
        })
        .expect(201);
      const productId = (productResponse.body as { data: { id: string } }).data
        .id;

      const classificationList = await request(app.getHttpServer())
        .get('/api/v1/catalog/categories')
        .set('Cookie', cookie)
        .expect(200);
      const classificationData = classificationList.body as {
        data: Array<{
          id: string;
          name: string;
          active: boolean;
          productCount: number;
        }>;
      };
      expect(
        classificationData.data.find(({ id }) => id === beveragesId),
      ).toEqual({
        id: beveragesId,
        name: 'Bebidas',
        active: true,
        productCount: 1,
      });
      expect(classificationData.data.find(({ id }) => id === pantryId)).toEqual(
        {
          id: pantryId,
          name: 'Despensa',
          active: true,
          productCount: 0,
        },
      );
      for (const filter of [
        { categoryId: beveragesId },
        { brandId },
        { categoryId: beveragesId, brandId },
      ]) {
        await request(app.getHttpServer())
          .get('/api/v1/products')
          .set('Cookie', cookie)
          .query(filter)
          .expect(200)
          .expect(({ body }: { body: unknown }) =>
            expect(body).toMatchObject({ data: [{ id: productId }] }),
          );
      }

      await request(app.getHttpServer())
        .patch(`/api/v1/catalog/categories/${pantryId}`)
        .set('Cookie', cookie)
        .send({ name: 'Despensa seca' })
        .expect(200)
        .expect(({ body }: { body: unknown }) =>
          expect(body).toMatchObject({ data: { name: 'Despensa seca' } }),
        );
      await request(app.getHttpServer())
        .delete(`/api/v1/catalog/categories/${beveragesId}`)
        .set('Cookie', cookie)
        .query({ replacementId: pantryId })
        .expect(200)
        .expect(({ body }: { body: unknown }) =>
          expect(body).toMatchObject({
            data: {
              classification: { id: beveragesId, active: false },
              reassignedProducts: 1,
            },
          }),
        );
      await request(app.getHttpServer())
        .delete(`/api/v1/catalog/brands/${brandId}`)
        .set('Cookie', cookie)
        .expect(200);
      await request(app.getHttpServer())
        .get(`/api/v1/products/${productId}`)
        .set('Cookie', cookie)
        .expect(200)
        .expect(({ body }: { body: unknown }) =>
          expect(body).toMatchObject({
            data: {
              category: { id: pantryId, name: 'Despensa seca' },
              brand: null,
            },
          }),
        );
      await request(app.getHttpServer())
        .get('/api/v1/products/options')
        .set('Cookie', cookie)
        .expect(200)
        .expect(({ body }: { body: unknown }) =>
          expect(body).toMatchObject({
            data: {
              categories: [{ id: pantryId }],
              brands: [],
            },
          }),
        );

      const secondary = {
        organizationName: 'Clasificaciones aisladas',
        email: 'classification-other@example.com',
        password: registrationPayload.password,
      };
      await request(app.getHttpServer())
        .post('/api/v1/auth/registrations')
        .set('Idempotency-Key', 'classification-secondary-registration')
        .send(secondary)
        .expect(201);
      const secondaryCookie = await createPersistedSession(secondary.email);
      await completeOnboarding(secondary.email, secondaryCookie);
      await request(app.getHttpServer())
        .post('/api/v1/catalog/categories')
        .set('Cookie', secondaryCookie)
        .send({ name: 'Bebidas' })
        .expect(201);
      await request(app.getHttpServer())
        .patch(`/api/v1/catalog/categories/${pantryId}`)
        .set('Cookie', secondaryCookie)
        .send({ name: 'No visible' })
        .expect(404);
    });

    it('resolves exact tenant product codes and rejects unknown or ambiguous values', async () => {
      await registerAccount('product-code-registration');
      const cookie = await createPersistedSession(registrationPayload.email);
      await completeOnboarding(registrationPayload.email, cookie);
      const first = await request(app.getHttpServer())
        .post('/api/v1/products')
        .set('Cookie', cookie)
        .send({
          name: 'Producto escaneable',
          sku: 'SCAN-SKU-1',
          barcode: '7500000000100',
          cost: '1.00',
          price: '2.00',
        })
        .expect(201);
      const firstId = (first.body as { data: { id: string } }).data.id;
      await request(app.getHttpServer())
        .get('/api/v1/products/resolve-code')
        .set('Cookie', cookie)
        .query({ code: ' scan-sku-1 ' })
        .expect(200)
        .expect(({ body }: { body: unknown }) =>
          expect(body).toMatchObject({ data: { id: firstId } }),
        );
      await request(app.getHttpServer())
        .get('/api/v1/products/resolve-code')
        .set('Cookie', cookie)
        .query({ code: '7500000000100' })
        .expect(200)
        .expect(({ body }: { body: unknown }) =>
          expect(body).toMatchObject({ data: { id: firstId } }),
        );
      await request(app.getHttpServer())
        .get('/api/v1/products/resolve-code')
        .set('Cookie', cookie)
        .query({ code: 'NO-EXISTE' })
        .expect(404)
        .expect(({ body }: { body: unknown }) =>
          expect(body).toMatchObject({ code: 'PRODUCT_CODE_NOT_FOUND' }),
        );

      await request(app.getHttpServer())
        .post('/api/v1/products')
        .set('Cookie', cookie)
        .send({
          name: 'SKU ambiguo',
          sku: '7500000000100',
          barcode: '7500000000200',
          cost: '1.00',
          price: '2.00',
        })
        .expect(201);
      await request(app.getHttpServer())
        .get('/api/v1/products/resolve-code')
        .set('Cookie', cookie)
        .query({ code: '7500000000100' })
        .expect(409)
        .expect(({ body }: { body: unknown }) =>
          expect(body).toMatchObject({ code: 'PRODUCT_CODE_AMBIGUOUS' }),
        );

      const secondary = {
        organizationName: 'Escaneo aislado',
        email: 'scan-other@example.com',
        password: registrationPayload.password,
      };
      await request(app.getHttpServer())
        .post('/api/v1/auth/registrations')
        .set('Idempotency-Key', 'product-code-secondary-registration')
        .send(secondary)
        .expect(201);
      const secondaryCookie = await createPersistedSession(secondary.email);
      await completeOnboarding(secondary.email, secondaryCookie);
      await request(app.getHttpServer())
        .get('/api/v1/products/resolve-code')
        .set('Cookie', secondaryCookie)
        .query({ code: 'SCAN-SKU-1' })
        .expect(404);
    });

    it('generates sellable variants with independent stock and preserves retired combinations', async () => {
      await registerAccount('product-variant-registration');
      const cookie = await createPersistedSession(registrationPayload.email);
      await completeOnboarding(registrationPayload.email, cookie);
      const created = await request(app.getHttpServer())
        .post('/api/v1/products')
        .set('Cookie', cookie)
        .send({
          name: 'Playera básica',
          sku: 'PLAYERA',
          barcode: '7500000000300',
          categoryName: 'Ropa',
          cost: '80.00',
          price: '149.00',
        })
        .expect(201);
      const parent = (created.body as { data: { id: string; version: number } })
        .data;
      const [location] = await dataSource.query<
        Array<{ id: string; tenant_id: string }>
      >(
        `SELECT l.id, l.tenant_id FROM locations l
         INNER JOIN users u ON u.tenant_id = l.tenant_id
         WHERE u.normalized_email = ? LIMIT 1`,
        [registrationPayload.email],
      );
      await request(app.getHttpServer())
        .post('/api/v1/inventory/movements')
        .set('Cookie', cookie)
        .set('Idempotency-Key', 'variant-parent-initial-stock')
        .send({
          productId: parent.id,
          locationId: location.id,
          type: 'INITIAL',
          quantity: '1',
          reason: 'Validar conversión con stock',
        })
        .expect(201);

      const attributes = [
        { name: 'Color', values: ['Rojo', 'Azul'] },
        { name: 'Talla', values: ['CH', 'M'] },
      ];
      const variant = (color: string, size: string, suffix: string) => ({
        values: [color, size],
        sku: `PLAYERA-${suffix}`,
        barcode: `75000000003${
          (
            {
              'R-CH': '11',
              'R-M': '12',
              'A-CH': '13',
              'A-M': '14',
              'N-CH': '15',
              'N-M': '16',
            } as Record<string, string>
          )[suffix]
        }`,
        cost: '80.00',
        price: '149.00',
        active: true,
      });
      const initialVariants = [
        variant('Rojo', 'CH', 'R-CH'),
        variant('Rojo', 'M', 'R-M'),
        variant('Azul', 'CH', 'A-CH'),
        variant('Azul', 'M', 'A-M'),
      ];
      await request(app.getHttpServer())
        .put(`/api/v1/products/${parent.id}/variants`)
        .set('Cookie', cookie)
        .send({
          version: parent.version,
          attributes,
          variants: initialVariants,
        })
        .expect(409)
        .expect(({ body }: { body: unknown }) =>
          expect(body).toMatchObject({
            code: 'PRODUCT_VARIANTS_REQUIRE_ZERO_STOCK',
          }),
        );
      await request(app.getHttpServer())
        .post('/api/v1/inventory/movements')
        .set('Cookie', cookie)
        .set('Idempotency-Key', 'variant-parent-clear-stock')
        .send({
          productId: parent.id,
          locationId: location.id,
          type: 'ADJUSTMENT',
          quantity: '-1',
          reason: 'Dejar padre sin stock',
          reference: 'UIN-110-CONVERSION',
        })
        .expect(201);
      await request(app.getHttpServer())
        .put(`/api/v1/products/${parent.id}/variants`)
        .set('Cookie', cookie)
        .send({
          version: parent.version,
          attributes,
          variants: initialVariants.map((item) => ({
            ...item,
            sku: 'DUPLICADO',
          })),
        })
        .expect(409)
        .expect(({ body }: { body: unknown }) =>
          expect(body).toMatchObject({ code: 'SKU_ALREADY_EXISTS' }),
        );

      const configured = await request(app.getHttpServer())
        .put(`/api/v1/products/${parent.id}/variants`)
        .set('Cookie', cookie)
        .send({
          version: parent.version,
          attributes,
          variants: initialVariants,
        })
        .expect(200);
      const configuredData = configured.body as {
        data: {
          id: string;
          version: number;
          sellable: boolean;
          variantAttributes: typeof attributes;
          variants: Array<{
            id: string;
            sku: string;
            version: number;
            active: boolean;
            variantValues: Array<{ attribute: string; value: string }>;
          }>;
        };
      };
      expect(configuredData.data).toMatchObject({
        id: parent.id,
        version: 2,
        sellable: false,
        variantAttributes: attributes,
      });
      expect(configuredData.data.variants).toHaveLength(4);
      const redSmall = configuredData.data.variants.find(
        ({ sku }) => sku === 'PLAYERA-R-CH',
      )!;

      await request(app.getHttpServer())
        .put(`/api/v1/products/${parent.id}/variants`)
        .set('Cookie', cookie)
        .send({
          version: configuredData.data.version,
          attributes,
          variants: configuredData.data.variants.map((item, index) => ({
            id: index === 1 ? configuredData.data.variants[0].id : item.id,
            version:
              index === 1
                ? configuredData.data.variants[0].version
                : item.version,
            values: item.variantValues.map(({ value }) => value),
            sku: item.sku,
            cost: '80.00',
            price: '149.00',
            active: true,
          })),
        })
        .expect(400)
        .expect(({ body }: { body: unknown }) =>
          expect(body).toMatchObject({
            code: 'PRODUCT_VARIANT_CONFIGURATION_INVALID',
          }),
        );

      await request(app.getHttpServer())
        .get('/api/v1/products')
        .set('Cookie', cookie)
        .query({ q: 'PLAYERA', sellableOnly: true, pageSize: 10 })
        .expect(200)
        .expect(
          ({
            body,
          }: {
            body: { data: Array<{ id: string; parentProductId: string }> };
          }) => {
            expect(body.data).toHaveLength(4);
            expect(
              body.data.every((item) => item.parentProductId === parent.id),
            ).toBe(true);
          },
        );
      await request(app.getHttpServer())
        .get('/api/v1/products/resolve-code')
        .set('Cookie', cookie)
        .query({ code: 'PLAYERA' })
        .expect(404);
      await request(app.getHttpServer())
        .get('/api/v1/products/resolve-code')
        .set('Cookie', cookie)
        .query({ code: redSmall.sku })
        .expect(200)
        .expect(({ body }: { body: unknown }) =>
          expect(body).toMatchObject({
            data: { id: redSmall.id, parentProductId: parent.id },
          }),
        );
      await request(app.getHttpServer())
        .post('/api/v1/inventory/movements')
        .set('Cookie', cookie)
        .set('Idempotency-Key', 'variant-independent-stock')
        .send({
          productId: redSmall.id,
          locationId: location.id,
          type: 'INITIAL',
          quantity: '3',
          reason: 'Stock de variante',
        })
        .expect(201);
      await request(app.getHttpServer())
        .post('/api/v1/inventory/movements')
        .set('Cookie', cookie)
        .set('Idempotency-Key', 'parent-stock-rejected')
        .send({
          productId: parent.id,
          locationId: location.id,
          type: 'INITIAL',
          quantity: '1',
          reason: 'No debe aceptar padre',
        })
        .expect(404);

      const blueVariants = configuredData.data.variants.filter(({ sku }) =>
        sku.includes('-A-'),
      );
      const changed = await request(app.getHttpServer())
        .put(`/api/v1/products/${parent.id}/variants`)
        .set('Cookie', cookie)
        .send({
          version: configuredData.data.version,
          attributes: [
            { name: 'Color', values: ['Negro', 'Azul'] },
            attributes[1],
          ],
          variants: [
            variant('Negro', 'CH', 'N-CH'),
            variant('Negro', 'M', 'N-M'),
            ...blueVariants.map((item) => ({
              id: item.id,
              version: item.version,
              values: item.variantValues.map(({ value }) => value),
              sku: item.sku,
              cost: '80.00',
              price: '149.00',
              active: true,
            })),
          ],
        })
        .expect(200);
      expect(
        (
          changed.body as {
            data: { variants: Array<{ sku: string; active: boolean }> };
          }
        ).data.variants,
      ).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ sku: 'PLAYERA-R-CH', active: false }),
        ]),
      );
      const [history] = await dataSource.query<
        Array<{ total: number | string }>
      >(
        'SELECT COUNT(*) AS total FROM inventory_movements WHERE product_id = ?',
        [redSmall.id],
      );
      expect(Number(history.total)).toBe(1);

      await request(app.getHttpServer())
        .delete(`/api/v1/products/${parent.id}`)
        .set('Cookie', cookie)
        .expect(200)
        .expect(({ body }: { body: unknown }) =>
          expect(body).toMatchObject({
            data: { outcome: 'DEACTIVATED', product: { active: false } },
          }),
        );
      const activeFamily = await dataSource.query<Array<{ id: string }>>(
        `SELECT id FROM products
         WHERE tenant_id = ? AND active = TRUE
           AND (id = ? OR parent_product_id = ?)`,
        [location.tenant_id, parent.id, parent.id],
      );
      expect(activeFamily).toEqual([]);
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

    it('transitions low, depleted and recovered alerts once per tenant location', async () => {
      await registerAccount('inventory-alert-registration');
      const cookie = await createPersistedSession(registrationPayload.email);
      await completeInventoryOnboarding(registrationPayload.email, cookie);
      const productResponse = await request(app.getHttpServer())
        .post('/api/v1/products')
        .set('Cookie', cookie)
        .send({
          name: 'Producto con alerta',
          sku: 'ALERT-1',
          cost: '5.00',
          price: '9.00',
        })
        .expect(201);
      const productId = (productResponse.body as { data: { id: string } }).data
        .id;
      const [location] = await dataSource.query<
        Array<{ id: string; tenant_id: string }>
      >(
        `SELECT location.id, location.tenant_id FROM locations location
         INNER JOIN users user ON user.tenant_id = location.tenant_id
         WHERE user.normalized_email = ? LIMIT 1`,
        [registrationPayload.email],
      );
      const movement = (
        key: string,
        type: 'INITIAL' | 'ENTRY' | 'EXIT',
        quantity: string,
      ) =>
        request(app.getHttpServer())
          .post('/api/v1/inventory/movements')
          .set('Cookie', cookie)
          .set('Idempotency-Key', key)
          .send({
            productId,
            locationId: location.id,
            type,
            quantity,
            reason: 'Prueba de transición de alerta',
            reference: `REF-${key}`,
          });

      await movement('stock-alert-initial', 'INITIAL', '8').expect(201);
      await request(app.getHttpServer())
        .get('/api/v1/inventory/stock-alerts')
        .set('Cookie', cookie)
        .expect(200)
        .expect(({ body }: { body: { data: unknown[]; meta: unknown } }) => {
          expect(body.data).toEqual([]);
          expect(body.meta).toMatchObject({ defaultThreshold: '5.000' });
        });

      const low = await request(app.getHttpServer())
        .put(
          `/api/v1/inventory/stock-alerts/products/${productId}/locations/${location.id}/threshold`,
        )
        .set('Cookie', cookie)
        .send({ threshold: '10' })
        .expect(200);
      expect(low.body).toMatchObject({
        data: {
          product: { id: productId, sku: 'ALERT-1' },
          location: { id: location.id },
          status: 'LOW',
          availableQuantity: '8.000',
          threshold: '10.000',
        },
      });
      const lowTransitionedAt = (
        low.body as { data: { transitionedAt: string } }
      ).data.transitionedAt;
      const repeated = await request(app.getHttpServer())
        .put(
          `/api/v1/inventory/stock-alerts/products/${productId}/locations/${location.id}/threshold`,
        )
        .set('Cookie', cookie)
        .send({ threshold: '10' })
        .expect(200);
      expect(
        (repeated.body as { data: { transitionedAt: string } }).data
          .transitionedAt,
      ).toBe(lowTransitionedAt);

      await movement('stock-alert-recovery', 'ENTRY', '5').expect(201);
      const recovered = await request(app.getHttpServer())
        .get('/api/v1/inventory/stock-alerts')
        .query({ status: 'RECOVERED', q: ' alert-1 ' })
        .set('Cookie', cookie)
        .expect(200);
      expect(recovered.body).toMatchObject({
        data: [
          {
            status: 'RECOVERED',
            availableQuantity: '13.000',
            threshold: '10.000',
          },
        ],
        meta: { pagination: { total: 1 } },
      });
      const recoveredAt = (
        recovered.body as { data: Array<{ transitionedAt: string }> }
      ).data[0].transitionedAt;
      await movement('stock-alert-remains-recovered', 'ENTRY', '1').expect(201);
      const stillRecovered = await request(app.getHttpServer())
        .get('/api/v1/inventory/stock-alerts')
        .query({ status: 'RECOVERED' })
        .set('Cookie', cookie)
        .expect(200);
      expect(
        (stillRecovered.body as { data: Array<{ transitionedAt: string }> })
          .data[0].transitionedAt,
      ).toBe(recoveredAt);

      await movement('stock-alert-low-again', 'EXIT', '10').expect(201);
      await movement('stock-alert-depleted', 'EXIT', '4').expect(201);
      await request(app.getHttpServer())
        .get('/api/v1/inventory/stock-alerts')
        .query({ status: 'OUT_OF_STOCK' })
        .set('Cookie', cookie)
        .expect(200)
        .expect(({ body }: { body: unknown }) => {
          expect(body).toMatchObject({
            data: [
              {
                product: { id: productId },
                status: 'OUT_OF_STOCK',
                availableQuantity: '0.000',
              },
            ],
          });
        });

      const secondary = {
        organizationName: 'Alertas aisladas',
        email: 'stock-alert-other@example.com',
        password: registrationPayload.password,
      };
      await request(app.getHttpServer())
        .post('/api/v1/auth/registrations')
        .set('Idempotency-Key', 'stock-alert-secondary-registration')
        .send(secondary)
        .expect(201);
      const secondaryCookie = await createPersistedSession(secondary.email);
      await completeInventoryOnboarding(secondary.email, secondaryCookie);
      await request(app.getHttpServer())
        .get('/api/v1/inventory/stock-alerts')
        .set('Cookie', secondaryCookie)
        .expect(200)
        .expect(({ body }: { body: { data: unknown[] } }) => {
          expect(body.data).toEqual([]);
        });
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
          trackLots: true,
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
          lotCode: 'LOT-TRANSFER-1',
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
                lots: Array<{
                  code: string;
                  quantityChange: string;
                  selectionMode: string;
                }>;
                fifoLayers: Array<{
                  layerId: string;
                  sourceAllocationId: string | null;
                  quantityChange: string;
                  unitCost: string;
                  currency: string;
                  valueChange: string;
                  selectionMode: string;
                }>;
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
            expect(
              body.data.find(({ type }) => type === 'TRANSFER_IN')?.lots,
            ).toEqual([
              expect.objectContaining({
                code: 'LOT-TRANSFER-1',
                quantityChange: '6.000',
                unitCost: '4.0000',
                currency: 'MXN',
                valueChange: '24.0000',
                selectionMode: 'TRANSFER',
              }),
            ]);
            expect(
              body.data.find(({ type }) => type === 'TRANSFER_DISCREPANCY')
                ?.lots,
            ).toEqual([
              expect.objectContaining({
                code: 'LOT-TRANSFER-1',
                quantityChange: '-1.000',
                unitCost: '4.0000',
                currency: 'MXN',
                valueChange: '-4.0000',
                selectionMode: 'AUTOMATIC',
              }),
            ]);
            const fifoTransferIn = body.data.find(
              ({ type }) => type === 'TRANSFER_IN',
            )?.fifoLayers;
            expect(fifoTransferIn).toEqual([
              expect.objectContaining({
                quantityChange: '6.000',
                unitCost: '4.0000',
                currency: 'MXN',
                valueChange: '24.0000',
                selectionMode: 'TRANSFER',
              }),
            ]);
            expect(fifoTransferIn?.[0].sourceAllocationId).toEqual(
              expect.any(String),
            );
            expect(
              body.data.find(({ type }) => type === 'TRANSFER_DISCREPANCY')
                ?.fifoLayers,
            ).toEqual([
              expect.objectContaining({
                layerId: fifoTransferIn![0].layerId,
                quantityChange: '-1.000',
                unitCost: '4.0000',
                currency: 'MXN',
                valueChange: '-4.0000',
                selectionMode: 'FIFO',
              }),
            ]);
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

    it('records blind recounts and closes physical counts without overwriting concurrent stock', async () => {
      await registerAccount('physical-count-registration');
      const cookie = await createPersistedSession(registrationPayload.email);
      await completeInventoryOnboarding(registrationPayload.email, cookie);
      const productResponse = await request(app.getHttpServer())
        .post('/api/v1/products')
        .set('Cookie', cookie)
        .send({
          name: 'Producto contado',
          sku: 'COUNT-1',
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
        .set('Idempotency-Key', 'physical-count-initial-stock')
        .send({
          productId,
          locationId: location.id,
          type: 'INITIAL',
          quantity: '10',
          reason: 'Existencia inicial',
        })
        .expect(201);

      const created = await request(app.getHttpServer())
        .post('/api/v1/inventory/count-sessions')
        .set('Cookie', cookie)
        .set('Idempotency-Key', 'physical-count-session')
        .send({ locationId: location.id, productIds: [productId], blind: true })
        .expect(201);
      const sessionId = (
        created.body as {
          data: {
            id: string;
            lines: Array<{ snapshotQuantity: string | null }>;
          };
        }
      ).data.id;
      expect(created.body).toMatchObject({
        data: {
          status: 'OPEN',
          blind: true,
          lines: [{ snapshotQuantity: null, attemptCount: 0 }],
        },
      });

      await request(app.getHttpServer())
        .put(`/api/v1/inventory/count-sessions/${sessionId}/lines/${productId}`)
        .set('Cookie', cookie)
        .send({ countedQuantity: '8', expectedAttempt: 0 })
        .expect(200)
        .expect(({ body }: { body: unknown }) => {
          expect(body).toMatchObject({
            data: {
              lines: [
                {
                  countedQuantity: '8.000',
                  snapshotQuantity: null,
                  varianceQuantity: null,
                  attemptCount: 1,
                  attempts: [{ attempt: 1, countedQuantity: '8.000' }],
                },
              ],
            },
          });
        });
      await request(app.getHttpServer())
        .put(`/api/v1/inventory/count-sessions/${sessionId}/lines/${productId}`)
        .set('Cookie', cookie)
        .send({ countedQuantity: '9', expectedAttempt: 0 })
        .expect(409)
        .expect(({ body }: { body: { code?: string } }) => {
          expect(body.code).toBe('INVENTORY_COUNT_ATTEMPT_CONFLICT');
        });
      await request(app.getHttpServer())
        .put(`/api/v1/inventory/count-sessions/${sessionId}/lines/${productId}`)
        .set('Cookie', cookie)
        .send({ countedQuantity: '9', expectedAttempt: 1 })
        .expect(200)
        .expect(({ body }: { body: unknown }) => {
          expect(body).toMatchObject({
            data: {
              lines: [
                {
                  countedQuantity: '9.000',
                  attemptCount: 2,
                  attempts: [
                    { attempt: 1, countedQuantity: '8.000' },
                    { attempt: 2, countedQuantity: '9.000' },
                  ],
                },
              ],
            },
          });
        });

      const [adminRole] = await dataSource.query<
        Array<{ role_id: string; tenant_id: string }>
      >(
        `SELECT r.id AS role_id, r.tenant_id FROM roles r
         INNER JOIN users u ON u.tenant_id = r.tenant_id
         WHERE r.code = 'ADMIN' AND u.normalized_email = ?`,
        [registrationPayload.email],
      );
      await dataSource.query(
        `DELETE FROM role_permissions
         WHERE role_id = ? AND tenant_id = ? AND permission = 'INVENTORY_APPROVE'`,
        [adminRole.role_id, adminRole.tenant_id],
      );
      await request(app.getHttpServer())
        .post(`/api/v1/inventory/count-sessions/${sessionId}/close`)
        .set('Cookie', cookie)
        .send({ reason: 'Conteo mensual', reference: 'COUNT-AUG-2026' })
        .expect(403);
      await dataSource.query(
        `INSERT INTO role_permissions (role_id, tenant_id, permission)
         VALUES (?, ?, 'INVENTORY_APPROVE')`,
        [adminRole.role_id, adminRole.tenant_id],
      );

      await request(app.getHttpServer())
        .post(`/api/v1/inventory/count-sessions/${sessionId}/close`)
        .set('Cookie', cookie)
        .send({ reason: 'Conteo mensual', reference: 'COUNT-AUG-2026' })
        .expect(201)
        .expect(({ body }: { body: unknown }) => {
          expect(body).toMatchObject({
            data: {
              status: 'CLOSED',
              lines: [
                {
                  snapshotQuantity: '10.000',
                  countedQuantity: '9.000',
                  varianceQuantity: '-1.000',
                  attemptCount: 2,
                },
              ],
            },
          });
        });

      const stale = await request(app.getHttpServer())
        .post('/api/v1/inventory/count-sessions')
        .set('Cookie', cookie)
        .set('Idempotency-Key', 'physical-count-stale-session')
        .send({
          locationId: location.id,
          productIds: [productId],
          blind: false,
        })
        .expect(201);
      const staleSessionId = (stale.body as { data: { id: string } }).data.id;
      await request(app.getHttpServer())
        .put(
          `/api/v1/inventory/count-sessions/${staleSessionId}/lines/${productId}`,
        )
        .set('Cookie', cookie)
        .send({ countedQuantity: '7', expectedAttempt: 0 })
        .expect(200);
      await request(app.getHttpServer())
        .post('/api/v1/inventory/movements')
        .set('Cookie', cookie)
        .set('Idempotency-Key', 'physical-count-concurrent-entry')
        .send({
          productId,
          locationId: location.id,
          type: 'ENTRY',
          quantity: '1',
          reason: 'Recepción concurrente',
          reference: 'RC-1',
        })
        .expect(201);
      await request(app.getHttpServer())
        .post(`/api/v1/inventory/count-sessions/${staleSessionId}/close`)
        .set('Cookie', cookie)
        .send({
          reason: 'No debe sobrescribir una recepción',
          reference: 'COUNT-STALE',
        })
        .expect(409)
        .expect(({ body }: { body: { code?: string } }) => {
          expect(body.code).toBe('INVENTORY_COUNT_STOCK_CHANGED');
        });

      const [balance] = await dataSource.query<Array<{ quantity: string }>>(
        `SELECT available_quantity AS quantity FROM inventory_balances
         WHERE product_id = ? AND location_id = ?`,
        [productId, location.id],
      );
      expect(balance.quantity).toBe('10.000');
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

    it('resolves scoped price lists deterministically and snapshots the sale price', async () => {
      const { cookie, productId } = await preparePos();
      const [branch] = await dataSource.query<Array<{ id: string }>>(
        'SELECT id FROM branches LIMIT 1',
      );
      const customerResponse = await request(app.getHttpServer())
        .post('/api/v1/customers')
        .set('Cookie', cookie)
        .send({
          name: 'Cliente preferente',
          identifier: 'PREFERENTE-1',
          dataProcessingConsent: false,
        })
        .expect(201);
      const customerId = (customerResponse.body as { data: { id: string } })
        .data.id;
      const validFrom = new Date(Date.now() - 60_000).toISOString();
      const validTo = new Date(Date.now() + 86_400_000).toISOString();
      const createList = (body: Record<string, unknown>) =>
        request(app.getHttpServer())
          .post('/api/v1/price-lists')
          .set('Cookie', cookie)
          .send({
            currency: 'MXN',
            priority: 10,
            validFrom,
            validTo,
            active: true,
            items: [{ productId, price: '109.00' }],
            ...body,
          });
      await createList({ name: 'General POS' }).expect(201);
      await createList({
        name: 'Sucursal POS',
        branchId: branch.id,
        items: [{ productId, price: '108.00' }],
      }).expect(201);
      const preferredResponse = await createList({
        name: 'Preferentes',
        customerId,
        channel: 'POS',
        priority: 20,
        items: [{ productId, price: '99.99' }],
      }).expect(201);
      const preferred = preferredResponse.body as {
        data: { id: string; version: number };
      };
      await createList({
        name: 'Expirada',
        priority: 100,
        validFrom: new Date(Date.now() - 172_800_000).toISOString(),
        validTo: new Date(Date.now() - 86_400_000).toISOString(),
        items: [{ productId, price: '1.00' }],
      }).expect(201);

      await request(app.getHttpServer())
        .get('/api/v1/offline/bootstrap')
        .set('Cookie', cookie)
        .query({ deviceId: randomUUID(), pageSize: 500 })
        .expect(200)
        .expect(({ body }: { body: { data: OfflineBootstrapResponseV1 } }) => {
          expect(body.data.page.entities).toEqual(
            expect.arrayContaining([
              expect.objectContaining({
                kind: 'PRICE_LIST',
                id: preferred.data.id,
                customerId,
                items: [{ productId, price: '99.99' }],
              }),
            ]),
          );
        });

      await request(app.getHttpServer())
        .post('/api/v1/pos/cart/quote')
        .set('Cookie', cookie)
        .send({ channel: 'POS', lines: [{ productId, quantity: '1' }] })
        .expect(200)
        .expect(({ body }: { body: unknown }) => {
          expect(body).toMatchObject({
            data: {
              lines: [
                { unitPrice: '108.00', priceList: { name: 'Sucursal POS' } },
              ],
            },
          });
        });
      await request(app.getHttpServer())
        .post('/api/v1/pos/cart/quote')
        .set('Cookie', cookie)
        .send({
          channel: 'POS',
          customerId,
          lines: [{ productId, quantity: '1.5' }],
        })
        .expect(200)
        .expect(({ body }: { body: unknown }) => {
          expect(body).toMatchObject({
            data: {
              lines: [
                {
                  unitPrice: '99.99',
                  total: '149.99',
                  priceSource: 'PRICE_LIST',
                  priceList: { id: preferred.data.id },
                },
              ],
            },
          });
        });
      const saleResponse = await request(app.getHttpServer())
        .post('/api/v1/pos/sales')
        .set('Cookie', cookie)
        .set('Idempotency-Key', 'price-list-sale-001')
        .send({
          channel: 'POS',
          customerId,
          lines: [{ productId, quantity: '1' }],
          payments: [
            { method: 'CASH', amount: '99.99', amountReceived: '100.00' },
          ],
        })
        .expect(201);
      const sale = saleResponse.body as { data: { id: string } };
      await request(app.getHttpServer())
        .put(`/api/v1/price-lists/${preferred.data.id}`)
        .set('Cookie', cookie)
        .send({
          name: 'Preferentes',
          currency: 'MXN',
          customerId,
          channel: 'POS',
          priority: 20,
          validFrom,
          validTo,
          active: true,
          version: preferred.data.version,
          items: [{ productId, price: '89.99' }],
        })
        .expect(200);
      await request(app.getHttpServer())
        .get(`/api/v1/pos/sales/${sale.data.id}`)
        .set('Cookie', cookie)
        .expect(200)
        .expect(({ body }: { body: unknown }) => {
          expect(body).toMatchObject({
            data: {
              lines: [
                {
                  unitPrice: '99.99',
                  priceSource: 'PRICE_LIST',
                  priceList: { id: preferred.data.id, name: 'Preferentes' },
                },
              ],
            },
          });
        });
    });

    it('accepts the unified sale contract with one cash payment', async () => {
      const { cookie, productId } = await preparePos();

      await request(app.getHttpServer())
        .post('/api/v1/pos/sales')
        .set('Cookie', cookie)
        .set('Idempotency-Key', 'single-cash-payment')
        .send({
          lines: [{ productId, quantity: '1' }],
          payments: [
            {
              method: 'CASH',
              amount: '119.90',
              amountReceived: '120.00',
            },
          ],
        })
        .expect(201)
        .expect(({ body }: { body: unknown }) => {
          expect(body).toMatchObject({
            data: {
              payment: {
                method: 'CASH',
                amountReceived: '120.00',
                amountApplied: '119.90',
                change: '0.10',
              },
              payments: [
                {
                  method: 'CASH',
                  amountReceived: '120.00',
                  amountApplied: '119.90',
                  change: '0.10',
                },
              ],
            },
          });
        });
    });

    it('applies authorized line and sale discounts with exact snapshots, limits and returns', async () => {
      const { cookie, productId } = await preparePos();
      const discountedLines = [
        {
          productId,
          quantity: '1',
          discount: {
            type: 'PERCENT',
            value: '10',
            reason: 'Empaque deteriorado',
          },
        },
      ];
      const discount = {
        type: 'AMOUNT',
        value: '7.91',
        reason: 'Cortesía autorizada',
      };

      await request(app.getHttpServer())
        .post('/api/v1/pos/cart/quote')
        .set('Cookie', cookie)
        .send({ lines: discountedLines, discount })
        .expect(200)
        .expect(({ body }: { body: unknown }) => {
          expect(body).toMatchObject({
            data: {
              discount: { ...discount, value: '7.91', amount: '7.91' },
              lines: [
                {
                  grossTotal: '119.90',
                  discount: {
                    line: {
                      type: 'PERCENT',
                      value: '10.00',
                      reason: 'Empaque deteriorado',
                      amount: '11.99',
                    },
                    sale: { ...discount, value: '7.91', amount: '7.91' },
                    total: '19.90',
                  },
                  subtotal: '86.21',
                  tax: '13.79',
                  total: '100.00',
                },
              ],
              totals: {
                gross: '119.90',
                lineDiscount: '11.99',
                saleDiscount: '7.91',
                discount: '19.90',
                subtotal: '86.21',
                tax: '13.79',
                total: '100.00',
              },
            },
          });
        });

      await request(app.getHttpServer())
        .post('/api/v1/pos/cart/quote')
        .set('Cookie', cookie)
        .send({
          lines: [{ productId, quantity: '1' }],
          discount: {
            type: 'PERCENT',
            value: '50.01',
            reason: 'Fuera del límite',
          },
        })
        .expect(400)
        .expect(({ body }: { body: { code?: string } }) => {
          expect(body.code).toBe('SALE_DISCOUNT_LIMIT_EXCEEDED');
        });

      const createSale = () =>
        request(app.getHttpServer())
          .post('/api/v1/pos/sales')
          .set('Cookie', cookie)
          .set('Idempotency-Key', 'sale-sale-sale')
          .send({
            lines: discountedLines,
            discount,
            payments: [
              {
                method: 'CASH',
                amount: '100.00',
                amountReceived: '100.00',
              },
            ],
          });
      const saleResponse = await createSale()
        .expect(201)
        .expect(({ body }: { body: unknown }) => {
          expect(body).toMatchObject({
            data: {
              discount: { reason: 'Cortesía autorizada', amount: '7.91' },
              lines: [
                {
                  grossTotal: '119.90',
                  discount: { total: '19.90' },
                  grossProfit: '6.21',
                  total: '100.00',
                },
              ],
              totals: {
                discount: '19.90',
                total: '100.00',
                grossProfit: '6.21',
              },
            },
            meta: { idempotentReplay: false },
          });
        });
      await createSale()
        .expect(201)
        .expect(({ body }: { body: unknown }) => {
          expect(body).toMatchObject({ meta: { idempotentReplay: true } });
        });
      await request(app.getHttpServer())
        .post('/api/v1/pos/sales')
        .set('Cookie', cookie)
        .set('Idempotency-Key', 'sale-sale-sale')
        .send({
          lines: [
            {
              productId,
              quantity: '0.5',
              discount: {
                type: 'PERCENT',
                value: '5',
                reason: 'Descuento contradictorio',
              },
            },
            { ...discountedLines[0], quantity: '0.5' },
          ],
          discount,
          payments: [
            {
              method: 'CASH',
              amount: '100.00',
              amountReceived: '100.00',
            },
          ],
        })
        .expect(400)
        .expect(({ body }: { body: { code?: string } }) => {
          expect(body.code).toBe('MIXED_PRODUCT_DISCOUNTS');
        });
      const sale = saleResponse.body as {
        data: { id: string; lines: Array<{ id: string }> };
      };

      await request(app.getHttpServer())
        .post(`/api/v1/pos/sales/${sale.data.id}/receipt/reprints`)
        .set('Cookie', cookie)
        .expect(200)
        .expect(({ body }: { body: unknown }) => {
          expect(body).toMatchObject({
            data: {
              lines: [
                {
                  grossTotal: '119.90',
                  discountTotal: '19.90',
                  lineDiscountReason: 'Empaque deteriorado',
                  saleDiscountReason: 'Cortesía autorizada',
                  total: '100.00',
                },
              ],
              totals: { gross: '119.90', discount: '19.90', total: '100.00' },
            },
          });
        });
      await request(app.getHttpServer())
        .post(`/api/v1/pos/sales/${sale.data.id}/returns`)
        .set('Cookie', cookie)
        .set('Idempotency-Key', 'return-return-return')
        .send({
          reason: 'Devolución total con descuento',
          lines: [
            {
              saleLineId: sale.data.lines[0].id,
              quantity: '1',
              condition: 'SELLABLE',
            },
          ],
        })
        .expect(201)
        .expect(({ body }: { body: unknown }) => {
          expect(body).toMatchObject({
            data: {
              totals: { subtotal: '86.21', tax: '13.79', total: '100.00' },
            },
          });
        });
      await request(app.getHttpServer())
        .get('/api/v1/audit-events')
        .query({ entityType: 'SALE', q: sale.data.id, page: 1, pageSize: 10 })
        .set('Cookie', cookie)
        .expect(200)
        .expect(
          ({
            body,
          }: {
            body: { data: Array<{ action: string; after: unknown }> };
          }) => {
            const completed = body.data.find(
              ({ action }) => action === 'SALE_COMPLETED',
            );
            expect(completed).toBeDefined();
            const after = completed?.after as {
              discountTotal?: unknown;
              discountReasons?: unknown;
            };
            expect(after.discountTotal).toBe('19.90');
            expect(after.discountReasons).toEqual(
              expect.arrayContaining([
                'Cortesía autorizada',
                'Empaque deteriorado',
              ]),
            );
          },
        );

      const [principal] = await dataSource.query<
        Array<{ tenant_id: string; role_id: string }>
      >(
        `SELECT user.tenant_id, user_role.role_id FROM users user
         INNER JOIN user_roles user_role
           ON user_role.user_id = user.id AND user_role.tenant_id = user.tenant_id
         WHERE user.normalized_email = ? LIMIT 1`,
        [registrationPayload.email],
      );
      await dataSource.query(
        `DELETE FROM role_permissions
         WHERE role_id = ? AND tenant_id = ? AND permission = 'INVENTORY_VALUATION_MANAGE'`,
        [principal.role_id, principal.tenant_id],
      );
      await request(app.getHttpServer())
        .get(`/api/v1/pos/sales/${sale.data.id}`)
        .set('Cookie', cookie)
        .expect(200)
        .expect(({ body }: { body: unknown }) => {
          expect(body).toMatchObject({
            data: {
              lines: [{ grossProfit: null }],
              totals: { grossProfit: null },
            },
          });
        });
      await dataSource.query(
        `DELETE FROM role_permissions
         WHERE role_id = ? AND tenant_id = ? AND permission = 'SALES_DISCOUNT'`,
        [principal.role_id, principal.tenant_id],
      );
      await request(app.getHttpServer())
        .post('/api/v1/pos/cart/quote')
        .set('Cookie', cookie)
        .send({
          lines: [{ productId, quantity: '1' }],
          discount: {
            type: 'PERCENT',
            value: '5',
            reason: 'Sin autorización',
          },
        })
        .expect(403)
        .expect(({ body }: { body: { code?: string } }) => {
          expect(body.code).toBe('SALE_DISCOUNT_PERMISSION_REQUIRED');
        });
    });

    it('suspends, isolates, recalculates and transactionally consumes a pending sale', async () => {
      const { cookie, productId, locationId } = await preparePos();
      const suspendedResponse = await request(app.getHttpServer())
        .post('/api/v1/pos/suspended-sales')
        .set('Cookie', cookie)
        .set('Idempotency-Key', 'suspended-sale-create-001')
        .send({
          notes: 'Cliente vuelve en unos minutos',
          lines: [{ productId, quantity: '2' }],
        })
        .expect(201);
      const suspended = suspendedResponse.body as {
        data: { id: string; status: string; notes: string; lines: unknown[] };
        meta: { idempotentReplay: boolean };
      };
      expect(suspended).toMatchObject({
        data: {
          status: 'ACTIVE',
          notes: 'Cliente vuelve en unos minutos',
          lines: [
            expect.objectContaining({
              quantity: '2.000',
              unitPriceSnapshot: '119.90',
            }),
          ],
        },
        meta: { idempotentReplay: false },
      });
      await request(app.getHttpServer())
        .post('/api/v1/pos/suspended-sales')
        .set('Cookie', cookie)
        .set('Idempotency-Key', 'suspended-sale-create-001')
        .send({
          notes: 'Cliente vuelve en unos minutos',
          lines: [{ productId, quantity: '2' }],
        })
        .expect(201)
        .expect(({ body }: { body: unknown }) => {
          expect(body).toMatchObject({
            data: { id: suspended.data.id },
            meta: { idempotentReplay: true },
          });
        });

      const [before] = await dataSource.query<Array<{ quantity: string }>>(
        `SELECT available_quantity AS quantity FROM inventory_balances
         WHERE product_id = ? AND location_id = ?`,
        [productId, locationId],
      );
      const [{ salesBefore }] = await dataSource.query<
        Array<{ salesBefore: string }>
      >('SELECT COUNT(*) AS salesBefore FROM sales');
      expect(before.quantity).toBe('5.000');
      expect(Number(salesBefore)).toBe(0);
      await request(app.getHttpServer())
        .get('/api/v1/pos/register-shifts/current/movements')
        .set('Cookie', cookie)
        .expect(200)
        .expect(({ body }: { body: unknown }) => {
          expect(body).toMatchObject({ meta: { expectedCash: '250.00' } });
        });

      const [scope] = await dataSource.query<
        Array<{
          tenant_id: string;
          branch_id: string;
          cash_register_id: string;
          role_id: string;
        }>
      >(
        `SELECT u.tenant_id, b.id AS branch_id, cr.id AS cash_register_id, r.id AS role_id
         FROM users u
         INNER JOIN roles r ON r.tenant_id = u.tenant_id AND r.code = 'ADMIN'
         INNER JOIN branches b ON b.tenant_id = u.tenant_id
         INNER JOIN cash_registers cr ON cr.tenant_id = u.tenant_id AND cr.branch_id = b.id
         WHERE u.normalized_email = ? LIMIT 1`,
        [registrationPayload.email],
      );
      const otherUserId = randomUUID();
      await dataSource.query(
        `INSERT INTO users (id, tenant_id, email, normalized_email, password_hash)
         VALUES (?, ?, 'other-cashier@example.com', 'other-cashier@example.com', 'not-used')`,
        [otherUserId, scope.tenant_id],
      );
      await dataSource.query(
        'INSERT INTO user_roles (user_id, role_id, tenant_id) VALUES (?, ?, ?)',
        [otherUserId, scope.role_id, scope.tenant_id],
      );
      await dataSource.query(
        'INSERT INTO user_branch_access (user_id, tenant_id, branch_id) VALUES (?, ?, ?)',
        [otherUserId, scope.tenant_id, scope.branch_id],
      );
      await dataSource.query(
        `INSERT INTO user_cash_register_access (user_id, tenant_id, branch_id, cash_register_id)
         VALUES (?, ?, ?, ?)`,
        [otherUserId, scope.tenant_id, scope.branch_id, scope.cash_register_id],
      );
      const otherCookie = await createPersistedSession(
        'other-cashier@example.com',
      );
      await request(app.getHttpServer())
        .post(`/api/v1/pos/suspended-sales/${suspended.data.id}/resume`)
        .set('Cookie', otherCookie)
        .expect(404);

      await dataSource.query('UPDATE products SET price = ? WHERE id = ?', [
        '129.90',
        productId,
      ]);
      await request(app.getHttpServer())
        .post(`/api/v1/pos/suspended-sales/${suspended.data.id}/resume`)
        .set('Cookie', cookie)
        .expect(201)
        .expect(({ body }: { body: unknown }) => {
          expect(body).toMatchObject({
            data: {
              suspendedSale: { id: suspended.data.id, status: 'ACTIVE' },
              quote: { totals: { total: '259.80' } },
              conflicts: [
                expect.objectContaining({
                  code: 'PRICE_CHANGED',
                  productId,
                  previous: '119.90',
                  current: '129.90',
                }),
              ],
            },
          });
        });

      const completed = await request(app.getHttpServer())
        .post('/api/v1/pos/sales')
        .set('Cookie', cookie)
        .set('Idempotency-Key', 'suspended-sale-complete-001')
        .send({
          suspendedSaleId: suspended.data.id,
          lines: [{ productId, quantity: '2' }],
          payment: { method: 'CASH', amountReceived: '260.00' },
        })
        .expect(201);
      const completedId = (completed.body as { data: { id: string } }).data.id;
      const [state] = await dataSource.query<
        Array<{ status: string; completed_sale_id: string }>
      >('SELECT status, completed_sale_id FROM suspended_sales WHERE id = ?', [
        suspended.data.id,
      ]);
      expect(state).toEqual({
        status: 'RESUMED',
        completed_sale_id: completedId,
      });
      const [after] = await dataSource.query<Array<{ quantity: string }>>(
        `SELECT available_quantity AS quantity FROM inventory_balances
         WHERE product_id = ? AND location_id = ?`,
        [productId, locationId],
      );
      expect(after.quantity).toBe('3.000');
      await request(app.getHttpServer())
        .post('/api/v1/pos/sales')
        .set('Cookie', cookie)
        .set('Idempotency-Key', 'suspended-sale-complete-duplicate')
        .send({
          suspendedSaleId: suspended.data.id,
          lines: [{ productId, quantity: '1' }],
          payment: { method: 'CASH', amountReceived: '130.00' },
        })
        .expect(409)
        .expect(({ body }: { body: { code?: string; status?: string } }) => {
          expect(body).toMatchObject({
            code: 'SUSPENDED_SALE_NOT_ACTIVE',
            status: 'RESUMED',
          });
        });

      const cancellable = await request(app.getHttpServer())
        .post('/api/v1/pos/suspended-sales')
        .set('Cookie', cookie)
        .set('Idempotency-Key', 'suspended-sale-cancel-001')
        .send({ notes: 'Cancelar', lines: [{ productId, quantity: '1' }] })
        .expect(201);
      const cancellableId = (cancellable.body as { data: { id: string } }).data
        .id;
      await request(app.getHttpServer())
        .post(`/api/v1/pos/suspended-sales/${cancellableId}/cancel`)
        .set('Cookie', cookie)
        .expect(201)
        .expect(({ body }: { body: unknown }) => {
          expect(body).toMatchObject({
            data: { status: 'CANCELLED' },
            meta: { idempotentReplay: false },
          });
        });
      await request(app.getHttpServer())
        .post(`/api/v1/pos/suspended-sales/${cancellableId}/cancel`)
        .set('Cookie', cookie)
        .expect(201)
        .expect(({ body }: { body: unknown }) => {
          expect(body).toMatchObject({ meta: { idempotentReplay: true } });
        });

      const expirable = await request(app.getHttpServer())
        .post('/api/v1/pos/suspended-sales')
        .set('Cookie', cookie)
        .set('Idempotency-Key', 'suspended-sale-expire-001')
        .send({ notes: 'Expirar', lines: [{ productId, quantity: '1' }] })
        .expect(201);
      const expirableId = (expirable.body as { data: { id: string } }).data.id;
      await dataSource.query(
        `UPDATE suspended_sales SET expires_at = DATE_SUB(CURRENT_TIMESTAMP(6), INTERVAL 1 SECOND)
         WHERE id = ?`,
        [expirableId],
      );
      await request(app.getHttpServer())
        .post(`/api/v1/pos/suspended-sales/${expirableId}/resume`)
        .set('Cookie', cookie)
        .expect(409)
        .expect(({ body }: { body: unknown }) => {
          expect(body).toMatchObject({
            code: 'SUSPENDED_SALE_EXPIRED',
            status: 'EXPIRED',
          });
        });
      await request(app.getHttpServer())
        .get('/api/v1/pos/suspended-sales')
        .set('Cookie', cookie)
        .expect(200);
      const [expirationAudit] = await dataSource.query<
        Array<{ total: string }>
      >(
        `SELECT COUNT(*) AS total FROM audit_events
         WHERE entity_id = ? AND action = 'SALE_SUSPENSION_EXPIRED'`,
        [expirableId],
      );
      expect(Number(expirationAudit.total)).toBe(1);

      const audit = await dataSource.query<Array<{ action: string }>>(
        `SELECT action FROM audit_events WHERE entity_id = ? ORDER BY created_at, id`,
        [suspended.data.id],
      );
      expect(audit.map(({ action }) => action)).toEqual([
        'SALE_SUSPENDED',
        'SALE_SUSPENSION_RESUMED',
      ]);
    });

    it('authorizes card, transfer and voucher payments without affecting expected cash', async () => {
      const { cookie, productId, locationId } = await preparePos();
      await request(app.getHttpServer())
        .get('/api/v1/pos/payment-options')
        .set('Cookie', cookie)
        .expect(200)
        .expect(({ body }: { body: unknown }) => {
          expect(body).toMatchObject({
            data: {
              methods: ['CASH', 'CARD', 'TRANSFER', 'VOUCHER'],
              nonCashProvider: 'SIMULATOR',
            },
          });
        });

      const sale = (
        method: 'CARD' | 'TRANSFER' | 'VOUCHER',
        reference: string,
      ) => ({
        lines: [{ productId, quantity: '1' }],
        payment: { method, reference },
      });
      await request(app.getHttpServer())
        .post('/api/v1/pos/sales')
        .set('Cookie', cookie)
        .set('Idempotency-Key', 'noncash-declined')
        .send(sale('CARD', 'DECLINE-001'))
        .expect(409)
        .expect(({ body }: { body: { code?: string } }) => {
          expect(body.code).toBe('PAYMENT_DECLINED');
        });

      for (const [index, method] of (
        ['CARD', 'TRANSFER', 'VOUCHER'] as const
      ).entries()) {
        const reference = `${method}-REF-001`;
        await request(app.getHttpServer())
          .post('/api/v1/pos/sales')
          .set('Cookie', cookie)
          .set('Idempotency-Key', `noncash-approved-${index}`)
          .send(sale(method, reference))
          .expect(201)
          .expect(({ body }: { body: unknown }) => {
            expect(body).toMatchObject({
              data: {
                payment: {
                  method,
                  status: 'COMPLETED',
                  amountReceived: '119.90',
                  amountApplied: '119.90',
                  change: '0.00',
                  reference,
                  provider: 'SIMULATOR',
                },
              },
            });
          });
      }

      await request(app.getHttpServer())
        .post('/api/v1/pos/sales')
        .set('Cookie', cookie)
        .set('Idempotency-Key', 'noncash-duplicate-reference')
        .send(sale('CARD', 'CARD-REF-001'))
        .expect(409)
        .expect(({ body }: { body: { code?: string } }) => {
          expect(body.code).toBe('PAYMENT_REFERENCE_REUSED');
        });
      const mixed = (reference: string, cardAmount = '59.90') => ({
        lines: [{ productId, quantity: '1' }],
        payments: [
          { method: 'CASH', amount: '60.00', amountReceived: '70.00' },
          { method: 'CARD', amount: cardAmount, reference },
        ],
      });
      await request(app.getHttpServer())
        .post('/api/v1/pos/sales')
        .set('Cookie', cookie)
        .set('Idempotency-Key', 'mixed-invalid-fields')
        .send({
          lines: [{ productId, quantity: '1' }],
          payment: {
            method: 'CASH',
            amountReceived: '120.00',
            reference: 'NOT-ALLOWED',
          },
        })
        .expect(400)
        .expect(({ body }: { body: { code?: string } }) => {
          expect(body.code).toBe('PAYMENT_FIELDS_INVALID');
        });
      await request(app.getHttpServer())
        .post('/api/v1/pos/sales')
        .set('Cookie', cookie)
        .set('Idempotency-Key', 'mixed-total-mismatch')
        .send(mixed('MIXED-MISMATCH', '59.89'))
        .expect(400)
        .expect(({ body }: { body: { code?: string } }) => {
          expect(body.code).toBe('PAYMENT_TOTAL_MISMATCH');
        });
      await request(app.getHttpServer())
        .post('/api/v1/pos/sales')
        .set('Cookie', cookie)
        .set('Idempotency-Key', 'mixed-retry-after-decline')
        .send(mixed('DECLINE-MIXED'))
        .expect(409);
      const mixedSale = await request(app.getHttpServer())
        .post('/api/v1/pos/sales')
        .set('Cookie', cookie)
        .set('Idempotency-Key', 'mixed-retry-after-decline')
        .send(mixed('MIXED-CARD-001'))
        .expect(201);
      const mixedSaleData = mixedSale.body as {
        data: { id: string; payments: unknown[] };
      };
      expect(mixedSaleData.data.payments).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            method: 'CASH',
            amountReceived: '70.00',
            amountApplied: '60.00',
            change: '10.00',
          }),
          expect.objectContaining({
            method: 'CARD',
            amountApplied: '59.90',
            reference: 'MIXED-CARD-001',
            provider: 'SIMULATOR',
          }),
        ]),
      );
      await request(app.getHttpServer())
        .get(`/api/v1/pos/sales/${mixedSaleData.data.id}`)
        .set('Cookie', cookie)
        .expect(200)
        .expect(({ body }: { body: { data: { payments: unknown[] } } }) => {
          expect(body.data.payments).toHaveLength(2);
        });
      await request(app.getHttpServer())
        .get('/api/v1/pos/sales')
        .set('Cookie', cookie)
        .expect(200)
        .expect(
          ({
            body,
          }: {
            body: { data: Array<{ id: string; paymentMethod: string }> };
          }) => {
            expect(body.data).toContainEqual(
              expect.objectContaining({
                id: mixedSaleData.data.id,
                paymentMethod: 'MIXED',
              }),
            );
          },
        );
      await request(app.getHttpServer())
        .get('/api/v1/pos/register-shifts/current/movements')
        .set('Cookie', cookie)
        .expect(200)
        .expect(({ body }: { body: unknown }) => {
          expect(body).toMatchObject({ meta: { expectedCash: '310.00' } });
        });
      const [balance] = await dataSource.query<Array<{ quantity: string }>>(
        `SELECT available_quantity AS quantity FROM inventory_balances
         WHERE product_id = ? AND location_id = ?`,
        [productId, locationId],
      );
      expect(balance.quantity).toBe('1.000');
    });

    it('reconciles tenant-scoped sales, payments and cash shifts with local-date filters', async () => {
      const { cookie, productId } = await preparePos();
      const mixedSale = await request(app.getHttpServer())
        .post('/api/v1/pos/sales')
        .set('Cookie', cookie)
        .set('Idempotency-Key', 'report-mixed-sale')
        .send({
          lines: [{ productId, quantity: '1' }],
          payments: [
            { method: 'CASH', amount: '60.00', amountReceived: '70.00' },
            { method: 'CARD', amount: '59.90', reference: 'REPORT-CARD-001' },
          ],
        })
        .expect(201);
      const mixedData = mixedSale.body as {
        data: { id: string; context: { branch: { id: string } } };
      };
      const cashSale = await request(app.getHttpServer())
        .post('/api/v1/pos/sales/cash')
        .set('Cookie', cookie)
        .set('Idempotency-Key', 'report-cash-sale')
        .send({ lines: [{ productId, quantity: '1' }], cashReceived: '120.00' })
        .expect(201);
      const cashData = cashSale.body as { data: { id: string } };
      await request(app.getHttpServer())
        .post(`/api/v1/pos/sales/${cashData.data.id}/void`)
        .set('Cookie', cookie)
        .set('Idempotency-Key', 'report-cash-sale-void')
        .send({ reason: 'Venta anulada para conciliación' })
        .expect(201);
      await request(app.getHttpServer())
        .post('/api/v1/pos/register-shifts/current/closure')
        .set('Cookie', cookie)
        .set('Idempotency-Key', 'report-shift-close')
        .send({ countedAmount: '310.00' })
        .expect(201);

      await request(app.getHttpServer())
        .get('/api/v1/pos/reports/sales-cash')
        .set('Cookie', cookie)
        .query({
          branchId: mixedData.data.context.branch.id,
          page: 1,
          pageSize: 1,
        })
        .expect(200)
        .expect(
          ({
            body,
          }: {
            body: {
              data: {
                summary: {
                  sales: unknown;
                  payments: unknown[];
                  cash: unknown;
                  reconciliation: unknown;
                };
                sales: unknown[];
                shifts: unknown[];
              };
              meta: unknown;
            };
          }) => {
            expect(body).toMatchObject({
              data: {
                summary: {
                  sales: {
                    total: 2,
                    completed: 1,
                    voided: 1,
                    net: '119.90',
                    voidedAmount: '119.90',
                  },
                  cash: {
                    shifts: 1,
                    open: 0,
                    closed: 1,
                    expected: '310.00',
                    counted: '310.00',
                    difference: '0.00',
                  },
                  reconciliation: {
                    salesNet: '119.90',
                    paymentsApplied: '119.90',
                    matches: true,
                  },
                },
                shifts: [
                  expect.objectContaining({
                    status: 'CLOSED',
                    difference: '0.00',
                  }),
                ],
              },
              meta: {
                pagination: { page: 1, pageSize: 1, total: 2, totalPages: 2 },
                periodTimezone: 'BRANCH_LOCAL',
              },
            });
            expect(body.data.sales).toHaveLength(1);
            expect(body.data.summary.payments).toEqual(
              expect.arrayContaining([
                expect.objectContaining({
                  method: 'CASH',
                  status: 'COMPLETED',
                  amount: '60.00',
                }),
                expect.objectContaining({
                  method: 'CARD',
                  status: 'COMPLETED',
                  amount: '59.90',
                }),
                expect.objectContaining({
                  method: 'CASH',
                  status: 'REVERSED',
                  amount: '119.90',
                }),
              ]),
            );
          },
        );
      await request(app.getHttpServer())
        .get('/api/v1/pos/reports/sales-cash')
        .set('Cookie', cookie)
        .query({ status: 'VOIDED' })
        .expect(200)
        .expect(({ body }: { body: unknown }) => {
          expect(body).toMatchObject({
            data: { summary: { sales: { total: 1, completed: 0, voided: 1 } } },
          });
        });

      await dataSource.query(
        `UPDATE sales SET created_at = '2026-01-02 05:30:00' WHERE id = ?`,
        [mixedData.data.id],
      );
      await dataSource.query(
        `UPDATE sales SET created_at = '2026-01-02 06:30:00' WHERE id = ?`,
        [cashData.data.id],
      );
      await request(app.getHttpServer())
        .get('/api/v1/pos/reports/sales-cash')
        .set('Cookie', cookie)
        .query({ dateFrom: '2026-01-01', dateTo: '2026-01-01' })
        .expect(200)
        .expect(({ body }: { body: unknown }) => {
          expect(body).toMatchObject({
            data: { summary: { sales: { total: 1, completed: 1, voided: 0 } } },
          });
        });
      await request(app.getHttpServer())
        .get('/api/v1/pos/reports/sales-cash')
        .set('Cookie', cookie)
        .query({ dateFrom: '2026-01-01T00:00:00Z' })
        .expect(400);
    });

    it('exports filtered operational data asynchronously without formulas or tenant leakage', async () => {
      const { cookie, productId } = await preparePos();
      await dataSource.query('UPDATE products SET name = ? WHERE id = ?', [
        '=2+2 producto',
        productId,
      ]);
      const exportSale = await request(app.getHttpServer())
        .post('/api/v1/pos/sales/cash')
        .set('Cookie', cookie)
        .set('Idempotency-Key', 'export-sale')
        .send({
          lines: [{ productId, quantity: '1' }],
          cashReceived: '120.00',
        })
        .expect(201);
      const exportSaleData = exportSale.body as {
        data: { id: string; receiptNumber: string };
      };
      const exportSaleId = exportSaleData.data.id;
      await dataSource.query(
        `UPDATE sales SET created_at = '2026-01-02 05:30:00' WHERE id = ?`,
        [exportSaleId],
      );

      const waitForExport = async (id: string) => {
        for (let attempt = 0; attempt < 30; attempt += 1) {
          const response = await request(app.getHttpServer())
            .get(`/api/v1/data-exports/${id}`)
            .set('Cookie', cookie)
            .expect(200);
          const body = response.body as { data: { status: string } };
          if (!['PENDING', 'PROCESSING'].includes(body.data.status))
            return body;
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
        throw new Error('Export did not complete');
      };
      const createExport = async (body: Record<string, unknown>) => {
        const created = await request(app.getHttpServer())
          .post('/api/v1/data-exports')
          .set('Cookie', cookie)
          .send(body)
          .expect(202);
        const id = (created.body as { data: { id: string } }).data.id;
        const completed = (await waitForExport(id)) as {
          data: {
            status: string;
            rowCount: number;
            excludedColumns: string[];
          };
        };
        expect(completed.data.status).toBe('COMPLETED');
        return { id, data: completed.data };
      };
      await request(app.getHttpServer())
        .post('/api/v1/data-exports')
        .set('Cookie', cookie)
        .send({ dataset: 'SALES', format: 'CSV', dateFrom: '2026-99-99' })
        .expect(400);

      const productsExport = await createExport({
        dataset: 'PRODUCTS',
        format: 'CSV',
        q: 'producto',
        productStatus: 'ALL',
      });
      expect(productsExport.data).toMatchObject({ rowCount: 1 });
      expect(productsExport.data.excludedColumns).toContain('customer');
      const productsFile = await request(app.getHttpServer())
        .get(`/api/v1/data-exports/${productsExport.id}/download`)
        .set('Cookie', cookie)
        .expect(200)
        .expect('Content-Type', /text\/csv/);
      const csv = Buffer.isBuffer(productsFile.body)
        ? productsFile.body.toString('utf8')
        : String(productsFile.text);
      expect(csv).toContain("'=2+2 producto");
      expect(csv).toContain('80.00');

      const stockExport = await createExport({
        dataset: 'STOCK',
        format: 'XLSX',
        productId,
      });
      const stockFile = await request(app.getHttpServer())
        .get(`/api/v1/data-exports/${stockExport.id}/download`)
        .set('Cookie', cookie)
        .buffer(true)
        .parse((response, callback) => {
          const chunks: Buffer[] = [];
          response.on('data', (chunk: Buffer) =>
            chunks.push(Buffer.from(chunk)),
          );
          response.on('end', () => callback(null, Buffer.concat(chunks)));
        })
        .expect(200)
        .expect('Content-Type', /spreadsheetml/);
      const workbook = new ExcelJS.Workbook();
      const workbookBuffer = stockFile.body as unknown as Buffer;
      await workbook.xlsx.load(
        workbookBuffer as unknown as Parameters<typeof workbook.xlsx.load>[0],
      );
      expect(workbook.worksheets[0].getCell('D2').value).toBe(4);
      expect(workbook.worksheets[0].getCell('I2').value).toBe('MOVING_AVERAGE');
      expect(workbook.worksheets[0].getCell('J2').value).toBe('MXN');
      expect(workbook.worksheets[0].getCell('K2').value).toBe(true);
      expect(workbook.worksheets[0].getCell('L2').value).toBe(320);

      const salesExport = await createExport({
        dataset: 'SALES',
        format: 'CSV',
        saleStatus: 'COMPLETED',
        q: exportSaleData.data.receiptNumber,
        dateFrom: '2026-01-01',
        dateTo: '2026-01-01',
      });
      expect(salesExport.data.rowCount).toBe(1);
      const movementsExport = await createExport({
        dataset: 'MOVEMENTS',
        format: 'CSV',
        q: 'producto',
      });
      expect(movementsExport.data.rowCount).toBeGreaterThanOrEqual(2);

      const [adminRole] = await dataSource.query<
        Array<{ role_id: string; tenant_id: string }>
      >(
        `SELECT r.id AS role_id, r.tenant_id FROM roles r
         INNER JOIN users u ON u.tenant_id = r.tenant_id
         WHERE r.code = 'ADMIN' AND u.normalized_email = ?`,
        [registrationPayload.email],
      );
      await dataSource.query(
        `DELETE FROM role_permissions WHERE role_id = ? AND tenant_id = ?
         AND permission IN ('TENANT_MANAGE', 'PRODUCTS_MANAGE')`,
        [adminRole.role_id, adminRole.tenant_id],
      );
      const restrictedStock = await createExport({
        dataset: 'STOCK',
        format: 'CSV',
      });
      expect(restrictedStock.data.excludedColumns).toContain('inventoryValue');
      await request(app.getHttpServer())
        .post('/api/v1/data-exports')
        .set('Cookie', cookie)
        .send({ dataset: 'PRODUCTS', format: 'CSV' })
        .expect(403);

      await request(app.getHttpServer())
        .post('/api/v1/auth/registrations')
        .set('Idempotency-Key', 'export-other-tenant')
        .send({
          organizationName: 'Otra empresa',
          email: 'other-export@example.com',
          password: registrationPayload.password,
        })
        .expect(201);
      const otherCookie = await createPersistedSession(
        'other-export@example.com',
      );
      await request(app.getHttpServer())
        .put('/api/v1/onboarding/company')
        .set('Cookie', otherCookie)
        .send({
          legalName: 'Otra empresa legal',
          tradeName: 'Otra empresa',
          countryCode: 'MX',
        })
        .expect(200);
      await request(app.getHttpServer())
        .put('/api/v1/onboarding/initial-location')
        .set('Cookie', otherCookie)
        .send({
          branchName: 'Otra sucursal',
          timezone: 'America/Mexico_City',
          warehouseName: 'Otra bodega',
          locationName: 'Otra ubicación',
        })
        .expect(200);
      await request(app.getHttpServer())
        .put('/api/v1/onboarding/initial-cash-register')
        .set('Cookie', otherCookie)
        .send({ name: 'Otra caja' })
        .expect(200);
      await request(app.getHttpServer())
        .get(`/api/v1/data-exports/${productsExport.id}`)
        .set('Cookie', otherCookie)
        .expect(404);
    });

    it('previews and atomically confirms idempotent CSV and Excel product imports', async () => {
      const { cookie, productId } = await preparePos(false);
      const csv = [
        'name,sku,barcode,category,brand,cost,price,active',
        'Café actualizado,CAFE-POS,7501234500000,Bebidas,Marca Casa,81.50,125.00,true',
        '=2+2 Tea,TE-VERDE,7501234500099,Bebidas,Marca Casa,35.00,65.00,true',
      ].join('\n');
      const preview = await request(app.getHttpServer())
        .post('/api/v1/products/imports/preview')
        .set('Cookie', cookie)
        .attach('file', Buffer.from(csv), {
          filename: 'productos-v1.csv',
          contentType: 'text/csv',
        })
        .expect(201);
      const previewData = preview.body as {
        data: {
          id: string;
          status: string;
          templateVersion: string;
          summary: { creates: number; updates: number; errors: number };
          canConfirm: boolean;
        };
      };
      expect(previewData.data).toMatchObject({
        status: 'PREVIEWED',
        templateVersion: '1.0',
        summary: { creates: 1, updates: 1, errors: 0 },
        canConfirm: true,
      });
      const [before] = await dataSource.query<Array<{ name: string }>>(
        'SELECT name FROM products WHERE id = ?',
        [productId],
      );
      expect(before.name).not.toBe('Café actualizado');

      const confirmationKey = 'product-import-confirm-001';
      await request(app.getHttpServer())
        .post(`/api/v1/products/imports/${previewData.data.id}/confirm`)
        .set('Cookie', cookie)
        .set('Idempotency-Key', confirmationKey)
        .expect(201)
        .expect(({ body }: { body: unknown }) => {
          expect(body).toMatchObject({ data: { status: 'CONFIRMED' } });
        });
      await request(app.getHttpServer())
        .post(`/api/v1/products/imports/${previewData.data.id}/confirm`)
        .set('Cookie', cookie)
        .set('Idempotency-Key', confirmationKey)
        .expect(201);
      const products = await dataSource.query<
        Array<{
          sku: string;
          name: string;
          cost: string;
          category: string;
          brand: string;
        }>
      >(
        `SELECT p.sku, p.name, p.cost, c.name AS category, b.name AS brand
         FROM products p LEFT JOIN categories c ON c.id = p.category_id
         LEFT JOIN brands b ON b.id = p.brand_id
         WHERE p.tenant_id = (SELECT tenant_id FROM users WHERE normalized_email = ?)
         ORDER BY p.sku`,
        [registrationPayload.email],
      );
      expect(products).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            sku: 'CAFE-POS',
            name: 'Café actualizado',
            cost: '81.50',
          }),
          expect.objectContaining({
            sku: 'TE-VERDE',
            category: 'Bebidas',
            brand: 'Marca Casa',
          }),
        ]),
      );
      await request(app.getHttpServer())
        .get(`/api/v1/products/imports/${previewData.data.id}/result`)
        .set('Cookie', cookie)
        .expect(200)
        .expect('Content-Type', /text\/csv/)
        .expect(({ text }: { text: string }) => {
          expect(text).toContain('TE-VERDE');
          expect(text).toContain(`"'=2+2 Tea"`);
          expect(text).toContain('APPLIED');
        });
      const [auditCount] = await dataSource.query<Array<{ total: string }>>(
        `SELECT COUNT(*) AS total FROM audit_events
         WHERE action = 'PRODUCT_IMPORT_CONFIRMED' AND entity_id = ?`,
        [previewData.data.id],
      );
      expect(Number(auditCount.total)).toBe(1);

      const workbook = new ExcelJS.Workbook();
      const sheet = workbook.addWorksheet('Productos');
      sheet.addRow([
        'name',
        'sku',
        'barcode',
        'category',
        'brand',
        'cost',
        'price',
        'active',
      ]);
      sheet.addRow(['Duplicado A', 'DUP-1', 'BAR-0001', '', '', 1, 2, true]);
      sheet.addRow(['Duplicado B', 'DUP-1', 'BAR-0002', '', '', 1, 2, true]);
      const xlsx = Buffer.from(await workbook.xlsx.writeBuffer());
      const invalid = await request(app.getHttpServer())
        .post('/api/v1/products/imports/preview')
        .set('Cookie', cookie)
        .attach('file', xlsx, {
          filename: 'productos-invalidos.xlsx',
          contentType:
            'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        })
        .expect(201);
      const invalidData = invalid.body as {
        data: { id: string; summary: { errors: number }; canConfirm: boolean };
      };
      expect(invalidData.data.summary.errors).toBe(1);
      expect(invalidData.data.canConfirm).toBe(false);
      await request(app.getHttpServer())
        .post(`/api/v1/products/imports/${invalidData.data.id}/confirm`)
        .set('Cookie', cookie)
        .set('Idempotency-Key', 'product-import-invalid-001')
        .expect(409);
    });

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
      const voidedCustomerSale = await request(app.getHttpServer())
        .post('/api/v1/pos/sales/cash')
        .set('Cookie', cookie)
        .set('Idempotency-Key', 'customer-linked-voided-sale')
        .send({
          customerId: customer.id,
          lines: [{ productId, quantity: '1' }],
          cashReceived: '120.00',
        })
        .expect(201);
      const voidedCustomerSaleId = (
        voidedCustomerSale.body as { data: { id: string } }
      ).data.id;
      await request(app.getHttpServer())
        .post(`/api/v1/pos/sales/${voidedCustomerSaleId}/void`)
        .set('Cookie', cookie)
        .set('Idempotency-Key', 'customer-history-void')
        .send({ reason: 'Cambio solicitado por el cliente' })
        .expect(201);

      await request(app.getHttpServer())
        .get(`/api/v1/customers/${customer.id}/history`)
        .query({
          dateFrom: '2020-01-01',
          dateTo: '2030-12-31',
          status: 'ALL',
          page: 1,
          pageSize: 1,
        })
        .set('Cookie', cookie)
        .expect(200)
        .expect(({ body }: { body: unknown }) => {
          expect(body).toMatchObject({
            data: {
              customer: { id: customer.id, name: 'Ana Pérez López' },
              summary: {
                salesCount: 2,
                completedCount: 1,
                voidedCount: 1,
              },
              items: [
                {
                  id: voidedCustomerSaleId,
                  status: 'VOIDED',
                  payments: [{ method: 'CASH', status: 'REVERSED' }],
                  reversal: { reason: 'Cambio solicitado por el cliente' },
                },
              ],
            },
            meta: {
              pagination: { page: 1, pageSize: 1, total: 2, totalPages: 2 },
            },
          });
        });
      await request(app.getHttpServer())
        .get(`/api/v1/customers/${customer.id}/history`)
        .query({ status: 'COMPLETED', page: 1, pageSize: 10 })
        .set('Cookie', cookie)
        .expect(200)
        .expect(({ body }: { body: unknown }) => {
          expect(body).toMatchObject({
            data: {
              summary: { salesCount: 1, completedCount: 1, voidedCount: 0 },
              items: [{ id: customerSaleId, status: 'COMPLETED' }],
            },
          });
        });
      const [salesRole] = await dataSource.query<
        Array<{ role_id: string; tenant_id: string }>
      >(
        `SELECT r.id AS role_id, r.tenant_id FROM roles r
         INNER JOIN users u ON u.tenant_id = r.tenant_id
         WHERE r.code = 'ADMIN' AND u.normalized_email = ?`,
        [registrationPayload.email],
      );
      await dataSource.query(
        `DELETE FROM role_permissions
         WHERE role_id = ? AND tenant_id = ? AND permission = 'SALES_MANAGE'`,
        [salesRole.role_id, salesRole.tenant_id],
      );
      await request(app.getHttpServer())
        .get(`/api/v1/customers/${customer.id}/history`)
        .set('Cookie', cookie)
        .expect(403);
      await dataSource.query(
        `INSERT INTO role_permissions (role_id, tenant_id, permission)
         VALUES (?, ?, 'SALES_MANAGE')`,
        [salesRole.role_id, salesRole.tenant_id],
      );

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
      await request(app.getHttpServer())
        .get(`/api/v1/customers/${customer.id}/history`)
        .set('Cookie', otherCookie)
        .expect(404);
    });

    it('sells on customer credit within the locked limit and reverses debt on void', async () => {
      const { cookie, productId, locationId } = await preparePos();
      const customerResponse = await request(app.getHttpServer())
        .post('/api/v1/customers')
        .set('Cookie', cookie)
        .send({
          name: 'Cliente crédito',
          identifier: 'CREDIT-001',
          dataProcessingConsent: false,
        })
        .expect(201);
      const customer = (
        customerResponse.body as {
          data: { id: string; version: number };
        }
      ).data;
      await request(app.getHttpServer())
        .patch(`/api/v1/customers/${customer.id}/credit`)
        .set('Cookie', cookie)
        .send({
          enabled: true,
          creditLimit: '150.00',
          currency: 'MXN',
          termDays: 30,
          maxInstallments: 3,
          version: customer.version,
        })
        .expect(200)
        .expect(({ body }: { body: unknown }) => {
          expect(body).toMatchObject({
            data: {
              version: 2,
              credit: {
                enabled: true,
                limit: '150.00',
                balance: '0.00',
                available: '150.00',
                status: 'AVAILABLE',
              },
            },
          });
        });

      const [creditRole] = await dataSource.query<
        Array<{ role_id: string; tenant_id: string }>
      >(
        `SELECT r.id AS role_id, r.tenant_id FROM roles r
         INNER JOIN users u ON u.tenant_id = r.tenant_id
         WHERE r.code = 'ADMIN' AND u.normalized_email = ? LIMIT 1`,
        [registrationPayload.email],
      );
      await dataSource.query(
        `DELETE FROM role_permissions
         WHERE role_id = ? AND tenant_id = ? AND permission = 'SALES_CREDIT'`,
        [creditRole.role_id, creditRole.tenant_id],
      );
      await request(app.getHttpServer())
        .post('/api/v1/pos/sales')
        .set('Cookie', cookie)
        .set('Idempotency-Key', 'credit-forbidden')
        .send({
          customerId: customer.id,
          lines: [{ productId, quantity: '1' }],
          credit: { installmentCount: 1 },
        })
        .expect(403);
      await dataSource.query(
        `INSERT INTO role_permissions (role_id, tenant_id, permission)
         VALUES (?, ?, 'SALES_CREDIT')`,
        [creditRole.role_id, creditRole.tenant_id],
      );

      const payload = {
        customerId: customer.id,
        lines: [{ productId, quantity: '1' }],
        credit: { installmentCount: 3 },
      };
      const attempts = await Promise.all(
        ['credit-concurrent-a', 'credit-concurrent-b'].map((key) =>
          request(app.getHttpServer())
            .post('/api/v1/pos/sales')
            .set('Cookie', cookie)
            .set('Idempotency-Key', key)
            .send(payload),
        ),
      );
      expect(attempts.map(({ status }) => status).sort()).toEqual([201, 409]);
      expect(attempts.find(({ status }) => status === 409)?.body).toMatchObject(
        {
          code: 'CUSTOMER_CREDIT_LIMIT_EXCEEDED',
          balance: '119.90',
          limit: '150.00',
        },
      );
      const completed = attempts.find(({ status }) => status === 201)!;
      expect(completed.body).toMatchObject({
        data: {
          customer: { id: customer.id },
          payment: {
            method: 'CREDIT',
            status: 'PENDING',
            amountReceived: '0.00',
            amountApplied: '119.90',
          },
          credit: {
            originalAmount: '119.90',
            balance: '119.90',
            currency: 'MXN',
            termDays: 30,
            status: 'OPEN',
            installments: [
              { number: 1, amount: '39.97' },
              { number: 2, amount: '39.97' },
              { number: 3, amount: '39.96' },
            ],
          },
        },
      });
      const successfulKey =
        attempts[0].status === 201
          ? 'credit-concurrent-a'
          : 'credit-concurrent-b';
      await request(app.getHttpServer())
        .post('/api/v1/pos/sales')
        .set('Cookie', cookie)
        .set('Idempotency-Key', successfulKey)
        .send(payload)
        .expect(201)
        .expect(({ body }: { body: unknown }) => {
          expect(body).toMatchObject({ meta: { idempotentReplay: true } });
        });
      await request(app.getHttpServer())
        .get(`/api/v1/customers/${customer.id}`)
        .set('Cookie', cookie)
        .expect(200)
        .expect(({ body }: { body: unknown }) => {
          expect(body).toMatchObject({
            data: {
              credit: {
                balance: '119.90',
                available: '30.10',
                overdueAmount: '0.00',
              },
            },
          });
        });
      await request(app.getHttpServer())
        .get('/api/v1/pos/register-shifts/current/movements')
        .set('Cookie', cookie)
        .expect(200)
        .expect(({ body }: { body: unknown }) => {
          expect(body).toMatchObject({ meta: { expectedCash: '250.00' } });
        });
      await request(app.getHttpServer())
        .get('/api/v1/pos/reports/sales-cash')
        .set('Cookie', cookie)
        .expect(200)
        .expect(({ body }: { body: unknown }) => {
          expect(body).toMatchObject({
            data: {
              summary: {
                payments: [
                  {
                    method: 'CREDIT',
                    status: 'PENDING',
                    count: 1,
                    amount: '119.90',
                  },
                ],
                cash: { expected: '250.00' },
                reconciliation: {
                  salesNet: '119.90',
                  paymentsApplied: '119.90',
                  matches: true,
                },
              },
            },
          });
        });
      const saleId = (completed.body as { data: { id: string } }).data.id;
      await dataSource.query(
        `UPDATE customer_credit_installments
         SET due_date = DATE_SUB(CURRENT_DATE(), INTERVAL 1 DAY)
         WHERE tenant_id = ? AND account_id = (
           SELECT id FROM customer_credit_accounts WHERE tenant_id = ? AND sale_id = ?
         ) AND installment_number = 1`,
        [creditRole.tenant_id, creditRole.tenant_id, saleId],
      );
      await request(app.getHttpServer())
        .get(`/api/v1/customers/${customer.id}`)
        .set('Cookie', cookie)
        .expect(200)
        .expect(({ body }: { body: unknown }) => {
          expect(body).toMatchObject({
            data: {
              credit: {
                balance: '119.90',
                overdueAmount: '39.97',
                status: 'OVERDUE',
              },
            },
          });
        });
      await request(app.getHttpServer())
        .post(`/api/v1/pos/sales/${saleId}/void`)
        .set('Cookie', cookie)
        .set('Idempotency-Key', 'credit-sale-void')
        .send({ reason: 'Crédito capturado por error' })
        .expect(201)
        .expect(({ body }: { body: unknown }) => {
          expect(body).toMatchObject({
            data: {
              status: 'VOIDED',
              payment: { method: 'CREDIT', status: 'REVERSED' },
              credit: { balance: '0.00', status: 'CANCELLED' },
            },
          });
        });
      const [state] = await dataSource.query<
        Array<{
          balance: string;
          stock: string;
          sales: number | string;
          debits: number | string;
          credits: number | string;
        }>
      >(
        `SELECT
          (SELECT COALESCE(SUM(CASE WHEN entry_type = 'DEBIT' THEN amount ELSE -amount END), 0)
           FROM customer_debt_ledger WHERE customer_id = ?) AS balance,
          (SELECT quantity FROM inventory_balances
           WHERE product_id = ? AND location_id = ?) AS stock,
          (SELECT COUNT(*) FROM sales WHERE customer_id = ?) AS sales,
          (SELECT COUNT(*) FROM customer_debt_ledger
           WHERE customer_id = ? AND entry_type = 'DEBIT') AS debits,
          (SELECT COUNT(*) FROM customer_debt_ledger
           WHERE customer_id = ? AND entry_type = 'CREDIT') AS credits`,
        [
          customer.id,
          productId,
          locationId,
          customer.id,
          customer.id,
          customer.id,
        ],
      );
      expect({
        balance: state.balance,
        stock: state.stock,
        sales: Number(state.sales),
        debits: Number(state.debits),
        credits: Number(state.credits),
      }).toEqual({
        balance: '0.00',
        stock: '5.000',
        sales: 1,
        debits: 1,
        credits: 1,
      });

      const other = {
        organizationName: 'Otro tenant crédito',
        email: 'other-credit@example.com',
        password: registrationPayload.password,
      };
      await request(app.getHttpServer())
        .post('/api/v1/auth/registrations')
        .set('Idempotency-Key', 'other-credit-registration')
        .send(other)
        .expect(201);
      const otherCookie = await createPersistedSession(other.email);
      await request(app.getHttpServer())
        .put('/api/v1/onboarding/company')
        .set('Cookie', otherCookie)
        .send({
          legalName: 'Otro tenant crédito Legal',
          tradeName: 'Otro tenant crédito',
          countryCode: 'MX',
        })
        .expect(200);
      await request(app.getHttpServer())
        .put('/api/v1/onboarding/initial-location')
        .set('Cookie', otherCookie)
        .send({
          branchName: 'Sucursal crédito',
          timezone: 'America/Mexico_City',
          warehouseName: 'Bodega crédito',
          locationName: 'General crédito',
        })
        .expect(200);
      await request(app.getHttpServer())
        .put('/api/v1/onboarding/initial-cash-register')
        .set('Cookie', otherCookie)
        .send({ name: 'Caja crédito' })
        .expect(200);
      await request(app.getHttpServer())
        .patch(`/api/v1/customers/${customer.id}/credit`)
        .set('Cookie', otherCookie)
        .send({
          enabled: true,
          creditLimit: '999.00',
          currency: 'MXN',
          termDays: 30,
          maxInstallments: 3,
          version: 2,
        })
        .expect(404);
    });

    it('applies credit payments to installments and reverses them idempotently', async () => {
      const { cookie, productId } = await preparePos();
      const customerResponse = await request(app.getHttpServer())
        .post('/api/v1/customers')
        .set('Cookie', cookie)
        .send({
          name: 'Cliente con abonos',
          identifier: 'PAYMENTS-001',
          dataProcessingConsent: false,
        })
        .expect(201);
      const customer = (
        customerResponse.body as { data: { id: string; version: number } }
      ).data;
      await request(app.getHttpServer())
        .patch(`/api/v1/customers/${customer.id}/credit`)
        .set('Cookie', cookie)
        .send({
          enabled: true,
          creditLimit: '300.00',
          currency: 'MXN',
          termDays: 30,
          maxInstallments: 3,
          version: customer.version,
        })
        .expect(200);
      const saleResponse = await request(app.getHttpServer())
        .post('/api/v1/pos/sales')
        .set('Cookie', cookie)
        .set('Idempotency-Key', 'credit-payment-source-sale')
        .send({
          customerId: customer.id,
          lines: [{ productId, quantity: '1' }],
          credit: { installmentCount: 3 },
        })
        .expect(201);
      const sale = (
        saleResponse.body as {
          data: { id: string; credit: { accountId: string } };
        }
      ).data;
      await dataSource.query(
        `UPDATE customer_credit_installments
         SET due_date = DATE_SUB(CURRENT_DATE(), INTERVAL 1 DAY)
         WHERE tenant_id = (SELECT tenant_id FROM customers WHERE id = ?)
           AND account_id = ? AND installment_number = 1`,
        [customer.id, sale.credit.accountId],
      );

      const [creditRole] = await dataSource.query<
        Array<{ role_id: string; tenant_id: string }>
      >(
        `SELECT role.id AS role_id, role.tenant_id FROM roles role
         INNER JOIN users user ON user.tenant_id = role.tenant_id
         WHERE role.code = 'ADMIN' AND user.normalized_email = ? LIMIT 1`,
        [registrationPayload.email],
      );
      await dataSource.query(
        `DELETE FROM role_permissions
         WHERE role_id = ? AND tenant_id = ? AND permission = 'SALES_CREDIT'`,
        [creditRole.role_id, creditRole.tenant_id],
      );
      await request(app.getHttpServer())
        .post(`/api/v1/customers/${customer.id}/credit/payments`)
        .set('Cookie', cookie)
        .set('Idempotency-Key', 'credit-payment-forbidden')
        .send({ amount: '20.00', method: 'CASH' })
        .expect(403);
      await dataSource.query(
        `INSERT INTO role_permissions (role_id, tenant_id, permission)
         VALUES (?, ?, 'SALES_CREDIT')`,
        [creditRole.role_id, creditRole.tenant_id],
      );

      const cashPayment = await request(app.getHttpServer())
        .post(`/api/v1/customers/${customer.id}/credit/payments`)
        .set('Cookie', cookie)
        .set('Idempotency-Key', 'credit-payment-cash-partial')
        .send({ amount: '20.00', method: 'CASH' })
        .expect(201);
      const cashPaymentBody = cashPayment.body as {
        data: {
          payment: { id: string; receiptNumber: string };
          credit: {
            accounts: Array<{
              installments: Array<Record<string, unknown>>;
            }>;
          };
        };
      };
      expect(cashPaymentBody.data.payment.receiptNumber).toMatch(
        /^CP-[A-F0-9]{32}$/,
      );
      expect(cashPaymentBody).toMatchObject({
        data: {
          payment: {
            amount: '20.00',
            method: 'CASH',
            status: 'COMPLETED',
            allocations: [{ installmentNumber: 1, amount: '20.00' }],
          },
          credit: {
            balance: '99.90',
            overdueAmount: '19.97',
            accounts: [
              {
                id: sale.credit.accountId,
                balance: '99.90',
                status: 'OVERDUE',
              },
            ],
          },
        },
        meta: { idempotentReplay: false },
      });
      expect(cashPaymentBody.data.credit.accounts[0].installments).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            number: 1,
            amount: '39.97',
            paidAmount: '20.00',
            balance: '19.97',
            status: 'OVERDUE',
          }),
        ]),
      );
      const cashPaymentId = cashPaymentBody.data.payment.id;
      await request(app.getHttpServer())
        .post(`/api/v1/customers/${customer.id}/credit/payments`)
        .set('Cookie', cookie)
        .set('Idempotency-Key', 'credit-payment-cash-partial')
        .send({ amount: '20.00', method: 'CASH' })
        .expect(201)
        .expect(({ body }: { body: unknown }) => {
          expect(body).toMatchObject({
            data: { payment: { id: cashPaymentId } },
            meta: { idempotentReplay: true },
          });
        });
      await request(app.getHttpServer())
        .post(`/api/v1/customers/${customer.id}/credit/payments`)
        .set('Cookie', cookie)
        .set('Idempotency-Key', 'credit-payment-over-balance')
        .send({ amount: '100.00', method: 'CASH' })
        .expect(409)
        .expect(({ body }: { body: unknown }) => {
          expect(body).toMatchObject({
            code: 'CREDIT_PAYMENT_EXCEEDS_BALANCE',
          });
        });
      await request(app.getHttpServer())
        .get('/api/v1/pos/register-shifts/current/movements')
        .set('Cookie', cookie)
        .expect(200)
        .expect(({ body }: { body: unknown }) => {
          const response = body as {
            data: Array<{ reason: string }>;
            meta: { expectedCash: string };
          };
          expect(body).toMatchObject({
            data: [
              {
                type: 'INCOME',
                amount: '20.00',
              },
            ],
            meta: { expectedCash: '270.00' },
          });
          expect(response.data[0].reason).toMatch(/^Abono de crédito CP-/);
        });

      const transferPayment = await request(app.getHttpServer())
        .post(`/api/v1/customers/${customer.id}/credit/payments`)
        .set('Cookie', cookie)
        .set('Idempotency-Key', 'credit-payment-transfer-total')
        .send({
          amount: '99.90',
          method: 'TRANSFER',
          reference: 'TRANSFER-0001',
        })
        .expect(201);
      expect(transferPayment.body).toMatchObject({
        data: {
          payment: {
            amount: '99.90',
            method: 'TRANSFER',
            status: 'COMPLETED',
          },
          credit: {
            balance: '0.00',
            overdueAmount: '0.00',
            accounts: [{ status: 'PAID', balance: '0.00' }],
          },
        },
      });
      const transferPaymentId = (
        transferPayment.body as { data: { payment: { id: string } } }
      ).data.payment.id;
      await request(app.getHttpServer())
        .get(`/api/v1/customers/${customer.id}/history`)
        .set('Cookie', cookie)
        .expect(200)
        .expect(({ body }: { body: unknown }) => {
          expect(body).toMatchObject({
            data: {
              credit: {
                balance: '0.00',
                payments: [
                  {
                    id: transferPaymentId,
                    method: 'TRANSFER',
                    status: 'COMPLETED',
                  },
                  {
                    id: cashPaymentId,
                    method: 'CASH',
                    status: 'COMPLETED',
                  },
                ],
              },
            },
          });
        });

      const reversalPayload = { reason: 'Transferencia aplicada por error' };
      await request(app.getHttpServer())
        .post(
          `/api/v1/customers/${customer.id}/credit/payments/${transferPaymentId}/reversal`,
        )
        .set('Cookie', cookie)
        .set('Idempotency-Key', 'credit-payment-transfer-reversal')
        .send(reversalPayload)
        .expect(201)
        .expect(({ body }: { body: unknown }) => {
          expect(body).toMatchObject({
            data: {
              payment: { status: 'REVERSED', reversal: reversalPayload },
              credit: { balance: '99.90', overdueAmount: '19.97' },
            },
            meta: { idempotentReplay: false },
          });
        });
      await request(app.getHttpServer())
        .post(
          `/api/v1/customers/${customer.id}/credit/payments/${transferPaymentId}/reversal`,
        )
        .set('Cookie', cookie)
        .set('Idempotency-Key', 'credit-payment-transfer-reversal')
        .send(reversalPayload)
        .expect(201)
        .expect(({ body }: { body: unknown }) => {
          expect(body).toMatchObject({ meta: { idempotentReplay: true } });
        });
      await request(app.getHttpServer())
        .post(
          `/api/v1/customers/${customer.id}/credit/payments/${cashPaymentId}/reversal`,
        )
        .set('Cookie', cookie)
        .set('Idempotency-Key', 'credit-payment-cash-reversal')
        .send({ reason: 'Efectivo devuelto al cliente' })
        .expect(201)
        .expect(({ body }: { body: unknown }) => {
          expect(body).toMatchObject({
            data: {
              payment: { status: 'REVERSED' },
              credit: { balance: '119.90', overdueAmount: '39.97' },
            },
          });
        });
      await request(app.getHttpServer())
        .get('/api/v1/pos/register-shifts/current/movements')
        .set('Cookie', cookie)
        .expect(200)
        .expect(({ body }: { body: unknown }) => {
          expect(body).toMatchObject({ meta: { expectedCash: '250.00' } });
        });
      const [state] = await dataSource.query<
        Array<{
          payments: number | string;
          allocations: number | string;
          balance: string;
          cash_movements: number | string;
        }>
      >(
        `SELECT
          (SELECT COUNT(*) FROM customer_credit_payments
           WHERE customer_id = ?) AS payments,
          (SELECT COUNT(*) FROM customer_credit_payment_allocations allocation
           INNER JOIN customer_credit_payments payment
             ON payment.id = allocation.payment_id
            AND payment.tenant_id = allocation.tenant_id
           WHERE payment.customer_id = ?) AS allocations,
          (SELECT COALESCE(SUM(CASE WHEN entry_type = 'DEBIT'
            THEN amount ELSE -amount END), 0)
           FROM customer_debt_ledger WHERE customer_id = ?) AS balance,
          (SELECT COUNT(*) FROM cash_register_movements
           WHERE reason LIKE '%crédito%') AS cash_movements`,
        [customer.id, customer.id, customer.id],
      );
      expect({
        payments: Number(state.payments),
        allocations: Number(state.allocations),
        balance: state.balance,
        cashMovements: Number(state.cash_movements),
      }).toEqual({
        payments: 2,
        allocations: 4,
        balance: '119.90',
        cashMovements: 1,
      });

      const other = {
        organizationName: 'Empresa ajena a abonos',
        email: 'other-credit-payments@example.com',
        password: registrationPayload.password,
      };
      await request(app.getHttpServer())
        .post('/api/v1/auth/registrations')
        .set('Idempotency-Key', 'other-credit-payments-registration')
        .send(other)
        .expect(201);
      const otherCookie = await createPersistedSession(other.email);
      await request(app.getHttpServer())
        .put('/api/v1/onboarding/company')
        .set('Cookie', otherCookie)
        .send({
          legalName: 'Empresa ajena a abonos Legal',
          tradeName: 'Empresa ajena a abonos',
          countryCode: 'MX',
        })
        .expect(200);
      await request(app.getHttpServer())
        .put('/api/v1/onboarding/initial-location')
        .set('Cookie', otherCookie)
        .send({
          branchName: 'Sucursal ajena',
          timezone: 'America/Mexico_City',
          warehouseName: 'Bodega ajena',
          locationName: 'General ajena',
        })
        .expect(200);
      await request(app.getHttpServer())
        .put('/api/v1/onboarding/initial-cash-register')
        .set('Cookie', otherCookie)
        .send({ name: 'Caja ajena' })
        .expect(200);
      await request(app.getHttpServer())
        .get(`/api/v1/customers/${customer.id}/credit`)
        .set('Cookie', otherCookie)
        .expect(404);
      await request(app.getHttpServer())
        .post(`/api/v1/customers/${customer.id}/credit/payments`)
        .set('Cookie', otherCookie)
        .set('Idempotency-Key', 'other-tenant-credit-payment')
        .send({ amount: '10.00', method: 'CASH' })
        .expect(404);
    });

    it('exports, protects and anonymizes customer PII without deleting transactions', async () => {
      const { cookie, productId } = await preparePos();
      const customerResponse = await request(app.getHttpServer())
        .post('/api/v1/customers')
        .set('Cookie', cookie)
        .send({
          name: 'María Privada',
          identifier: 'PRIV-001',
          email: 'maria.privacy@example.com',
          phone: '+52 55 9876 5432',
          dataProcessingConsent: true,
        })
        .expect(201);
      const customerId = (customerResponse.body as { data: { id: string } })
        .data.id;

      await request(app.getHttpServer())
        .get('/api/v1/privacy/classification')
        .set('Cookie', cookie)
        .expect(200)
        .expect(({ body }: { body: unknown }) => {
          const data = (
            body as {
              data: {
                version: number;
                deletionMode: string;
                classes: Array<{ code: string }>;
              };
            }
          ).data;
          expect(data.version).toBe(1);
          expect(data.deletionMode).toBe('CONTROLLED_ANONYMIZATION');
          expect(data.classes.map(({ code }) => code)).toContain(
            'CUSTOMER_PII',
          );
        });
      const policyResponse = await request(app.getHttpServer())
        .get('/api/v1/privacy/policy')
        .set('Cookie', cookie)
        .expect(200);
      const policy = (
        policyResponse.body as {
          data: { version: number; minimumTransactionRetentionDays: number };
        }
      ).data;
      expect(policy.minimumTransactionRetentionDays).toBe(1825);
      await request(app.getHttpServer())
        .patch('/api/v1/privacy/policy')
        .set('Cookie', cookie)
        .set('Idempotency-Key', 'privacy-policy-below-minimum')
        .send({
          expectedVersion: policy.version,
          transactionRetentionDays: 1824,
          reason: 'Prueba del mínimo legal',
        })
        .expect(400)
        .expect(({ body }: { body: { code?: string } }) => {
          expect(body.code).toBe('PRIVACY_RETENTION_BELOW_COUNTRY_MINIMUM');
        });
      const updatedPolicy = await request(app.getHttpServer())
        .patch('/api/v1/privacy/policy')
        .set('Cookie', cookie)
        .set('Idempotency-Key', 'privacy-policy-increase')
        .send({
          expectedVersion: policy.version,
          transactionRetentionDays: 2000,
          reason: 'Política interna ampliada',
        })
        .expect(200);
      expect(updatedPolicy.body).toMatchObject({
        data: { transactionRetentionDays: 2000, version: policy.version + 1 },
      });
      await request(app.getHttpServer())
        .patch('/api/v1/privacy/policy')
        .set('Cookie', cookie)
        .set('Idempotency-Key', 'privacy-policy-increase')
        .send({
          expectedVersion: policy.version,
          transactionRetentionDays: 2000,
          reason: 'Política interna ampliada',
        })
        .expect(200)
        .expect(({ body }: { body: unknown }) => {
          expect(body).toMatchObject({ data: { version: policy.version + 1 } });
        });

      const saleResponse = await request(app.getHttpServer())
        .post('/api/v1/pos/sales/cash')
        .set('Cookie', cookie)
        .set('Idempotency-Key', 'privacy-customer-sale')
        .send({
          customerId,
          lines: [{ productId, quantity: '1' }],
          cashReceived: '120.00',
        })
        .expect(201);
      const saleId = (saleResponse.body as { data: { id: string } }).data.id;

      await request(app.getHttpServer())
        .get(`/api/v1/privacy/customers/${customerId}/report`)
        .set('Cookie', cookie)
        .expect(200)
        .expect(({ body }: { body: unknown }) => {
          expect(body).toMatchObject({
            data: {
              subject: {
                id: customerId,
                email: 'maria.privacy@example.com',
                privacyStatus: 'ACTIVE',
              },
              transactions: {
                count: 1,
                disposition: 'PRESERVED_WITHOUT_CASCADE_DELETE',
              },
              policy: { transactionRetentionDays: 2000 },
              activeLegalHold: null,
            },
          });
        });
      await request(app.getHttpServer())
        .get(`/api/v1/privacy/customers/${customerId}/export`)
        .set('Cookie', cookie)
        .expect(200)
        .expect('Content-Type', /application\/json/)
        .expect('Content-Disposition', /attachment/);

      const [adminRole] = await dataSource.query<
        Array<{ role_id: string; tenant_id: string }>
      >(
        `SELECT r.id AS role_id, r.tenant_id FROM roles r
         INNER JOIN users u ON u.tenant_id = r.tenant_id
         WHERE r.code = 'ADMIN' AND u.normalized_email = ?`,
        [registrationPayload.email],
      );
      await dataSource.query(
        `DELETE FROM role_permissions
         WHERE role_id = ? AND tenant_id = ? AND permission = 'PRIVACY_MANAGE'`,
        [adminRole.role_id, adminRole.tenant_id],
      );
      await request(app.getHttpServer())
        .get('/api/v1/privacy/classification')
        .set('Cookie', cookie)
        .expect(403);
      await dataSource.query(
        `INSERT INTO role_permissions (role_id, tenant_id, permission)
         VALUES (?, ?, 'PRIVACY_MANAGE')`,
        [adminRole.role_id, adminRole.tenant_id],
      );

      const other = {
        organizationName: 'Tenant privacidad ajeno',
        email: 'other-privacy@example.com',
        password: registrationPayload.password,
      };
      await request(app.getHttpServer())
        .post('/api/v1/auth/registrations')
        .set('Idempotency-Key', 'other-privacy-registration')
        .send(other)
        .expect(201);
      const otherCookie = await createPersistedSession(other.email);
      await request(app.getHttpServer())
        .put('/api/v1/onboarding/company')
        .set('Cookie', otherCookie)
        .send({
          legalName: 'Tenant privacidad ajeno Legal',
          tradeName: other.organizationName,
          countryCode: 'MX',
        })
        .expect(200);
      await request(app.getHttpServer())
        .put('/api/v1/onboarding/initial-location')
        .set('Cookie', otherCookie)
        .send({
          branchName: 'Sucursal privacidad',
          timezone: 'America/Mexico_City',
          warehouseName: 'Bodega privacidad',
          locationName: 'General privacidad',
        })
        .expect(200);
      await request(app.getHttpServer())
        .put('/api/v1/onboarding/initial-cash-register')
        .set('Cookie', otherCookie)
        .send({ name: 'Caja privacidad' })
        .expect(200);
      await request(app.getHttpServer())
        .get(`/api/v1/privacy/customers/${customerId}/report`)
        .set('Cookie', otherCookie)
        .expect(404);

      await request(app.getHttpServer())
        .post(`/api/v1/privacy/customers/${customerId}/legal-holds`)
        .set('Cookie', cookie)
        .set('Idempotency-Key', 'privacy-hold-create')
        .send({
          reason: 'Investigación legal simulada',
          requestReference: 'LEGAL-2026-001',
        })
        .expect(201)
        .expect(({ body }: { body: unknown }) => {
          expect(body).toMatchObject({ data: { active: true } });
        });
      await request(app.getHttpServer())
        .post(`/api/v1/privacy/customers/${customerId}/anonymization`)
        .set('Cookie', cookie)
        .set('Idempotency-Key', 'privacy-anonymize-blocked')
        .send({
          reason: 'Solicitud de cancelación del titular',
          requestReference: 'ARCO-2026-001',
        })
        .expect(409)
        .expect(({ body }: { body: { code?: string } }) => {
          expect(body.code).toBe(
            'CUSTOMER_ANONYMIZATION_BLOCKED_BY_LEGAL_HOLD',
          );
        });
      await request(app.getHttpServer())
        .get(`/api/v1/customers/${customerId}`)
        .set('Cookie', cookie)
        .expect(200)
        .expect(({ body }: { body: unknown }) => {
          expect(body).toMatchObject({
            data: { email: 'maria.privacy@example.com' },
          });
        });
      await request(app.getHttpServer())
        .post(`/api/v1/privacy/customers/${customerId}/legal-holds/release`)
        .set('Cookie', cookie)
        .set('Idempotency-Key', 'privacy-hold-release')
        .send({ reason: 'Investigación legal concluida' })
        .expect(201)
        .expect(({ body }: { body: unknown }) => {
          expect(body).toMatchObject({ data: { released: true } });
        });
      const anonymizationBody = {
        reason: 'Solicitud de cancelación verificada',
        requestReference: 'ARCO-2026-001',
      };
      await request(app.getHttpServer())
        .post(`/api/v1/privacy/customers/${customerId}/anonymization`)
        .set('Cookie', cookie)
        .set('Idempotency-Key', 'privacy-anonymize-complete')
        .send(anonymizationBody)
        .expect(201)
        .expect(({ body }: { body: unknown }) => {
          expect(body).toMatchObject({
            data: { anonymized: true, privacyStatus: 'ANONYMIZED' },
          });
        });
      await request(app.getHttpServer())
        .post(`/api/v1/privacy/customers/${customerId}/anonymization`)
        .set('Cookie', cookie)
        .set('Idempotency-Key', 'privacy-anonymize-complete')
        .send(anonymizationBody)
        .expect(201);

      await request(app.getHttpServer())
        .get(`/api/v1/customers/${customerId}`)
        .set('Cookie', cookie)
        .expect(200)
        .expect(({ body }: { body: unknown }) => {
          expect(body).toMatchObject({
            data: {
              id: customerId,
              identifier: null,
              email: null,
              phone: null,
              active: false,
              privacyStatus: 'ANONYMIZED',
            },
          });
          expect(JSON.stringify(body)).not.toContain(
            'maria.privacy@example.com',
          );
        });
      await request(app.getHttpServer())
        .get('/api/v1/customers')
        .query({
          q: 'maria.privacy@example.com',
          status: 'ALL',
          page: 1,
          pageSize: 10,
        })
        .set('Cookie', cookie)
        .expect(200)
        .expect(({ body }: { body: { data: unknown[] } }) => {
          expect(body.data).toEqual([]);
        });
      await request(app.getHttpServer())
        .get(`/api/v1/pos/sales/${saleId}`)
        .set('Cookie', cookie)
        .expect(200)
        .expect(({ body }: { body: unknown }) => {
          expect(body).toMatchObject({
            data: {
              id: saleId,
              customer: { id: customerId, identifier: null },
            },
          });
          expect(JSON.stringify(body)).not.toContain(
            'maria.privacy@example.com',
          );
        });
      const [decisions] = await dataSource.query<
        Array<{ blocked: number | string; completed: number | string }>
      >(
        `SELECT SUM(status = 'BLOCKED') AS blocked,
                SUM(status = 'COMPLETED') AS completed
         FROM privacy_requests WHERE tenant_id = ? AND customer_id = ?`,
        [adminRole.tenant_id, customerId],
      );
      expect(Number(decisions.blocked)).toBe(1);
      expect(Number(decisions.completed)).toBeGreaterThanOrEqual(4);
      const [audit] = await dataSource.query<Array<{ total: number | string }>>(
        `SELECT COUNT(*) AS total FROM audit_events
         WHERE tenant_id = ? AND entity_id = ?
           AND action IN (
             'CUSTOMER_ANONYMIZATION_BLOCKED', 'CUSTOMER_PII_ANONYMIZED'
           )`,
        [adminRole.tenant_id, customerId],
      );
      expect(Number(audit.total)).toBe(2);
    });

    it('creates customer reservations atomically, idempotently and without over-reserving', async () => {
      const { cookie, productId, locationId } = await preparePos(false);
      const customerResponse = await request(app.getHttpServer())
        .post('/api/v1/customers')
        .set('Cookie', cookie)
        .send({ name: 'Cliente reserva', dataProcessingConsent: false })
        .expect(201);
      const customerId = (customerResponse.body as { data: { id: string } })
        .data.id;
      const input = {
        customerId,
        locationId,
        expiresInHours: 24,
        lines: [{ productId, quantity: '1' }],
      };
      const created = await request(app.getHttpServer())
        .post('/api/v1/reservations')
        .set('Cookie', cookie)
        .set('Idempotency-Key', 'reservation-create-one')
        .send(input)
        .expect(201);
      const createdData = (
        created.body as {
          data: { id: string; reservationNumber: string; expiresAt: string };
        }
      ).data;
      expect(createdData.reservationNumber).toMatch(/^R-[A-F0-9]{12}$/);
      expect(created.body).toMatchObject({
        data: {
          status: 'ACTIVE',
          customer: { id: customerId, name: 'Cliente reserva' },
          context: {
            branch: { name: 'Sucursal POS' },
            warehouse: { name: 'Bodega POS' },
            location: { id: locationId, name: 'General POS' },
          },
          responsible: { email: registrationPayload.email },
          lines: [
            { product: { id: productId, sku: 'CAFE-POS' }, quantity: '1.000' },
          ],
        },
        meta: { idempotentReplay: false },
      });
      const expiresAt = new Date(createdData.expiresAt).getTime();
      expect(expiresAt - Date.now()).toBeGreaterThan(23 * 60 * 60_000);

      await request(app.getHttpServer())
        .post('/api/v1/reservations')
        .set('Cookie', cookie)
        .set('Idempotency-Key', 'reservation-create-one')
        .send(input)
        .expect(201)
        .expect(({ body }: { body: unknown }) => {
          expect(body).toMatchObject({
            data: { id: createdData.id },
            meta: { idempotentReplay: true },
          });
        });
      await request(app.getHttpServer())
        .post('/api/v1/reservations')
        .set('Cookie', cookie)
        .set('Idempotency-Key', 'reservation-create-one')
        .send({ ...input, expiresInHours: 48 })
        .expect(409)
        .expect(({ body }: { body: { code?: string } }) => {
          expect(body.code).toBe('IDEMPOTENCY_KEY_REUSED');
        });

      const concurrent = await Promise.all(
        ['reservation-concurrent-a', 'reservation-concurrent-b'].map((key) =>
          request(app.getHttpServer())
            .post('/api/v1/reservations')
            .set('Cookie', cookie)
            .set('Idempotency-Key', key)
            .send({ ...input, lines: [{ productId, quantity: '3' }] }),
        ),
      );
      expect(concurrent.map(({ status }) => status).sort()).toEqual([201, 409]);
      expect(
        concurrent.find(({ status }) => status === 409)?.body,
      ).toMatchObject({
        code: 'PRODUCT_RESERVATION_INSUFFICIENT_STOCK',
        productId,
      });
      await request(app.getHttpServer())
        .get(`/api/v1/inventory/products/${productId}/balance`)
        .query({ locationId })
        .set('Cookie', cookie)
        .expect(200)
        .expect(({ body }: { body: unknown }) => {
          expect(body).toMatchObject({
            data: {
              totalQuantity: '5.000',
              availableQuantity: '1.000',
              states: [
                { code: 'AVAILABLE', quantity: '1.000' },
                { code: 'RESERVED', quantity: '4.000' },
                { code: 'DAMAGED', quantity: '0.000' },
                { code: 'IN_TRANSIT', quantity: '0.000' },
              ],
            },
          });
        });
      await request(app.getHttpServer())
        .get('/api/v1/reservations')
        .set('Cookie', cookie)
        .expect(200)
        .expect(({ body }: { body: { data: unknown[] } }) => {
          expect(body.data).toHaveLength(2);
        });
      const [[trace], [audit]] = await Promise.all([
        dataSource.query<Array<{ total: number | string }>>(
          `SELECT COUNT(*) AS total FROM inventory_movements
           WHERE reservation_id = ?`,
          [createdData.id],
        ),
        dataSource.query<Array<{ total: number | string }>>(
          `SELECT COUNT(*) AS total FROM audit_events
           WHERE entity_type = 'PRODUCT_RESERVATION' AND entity_id = ?`,
          [createdData.id],
        ),
      ]);
      expect(Number(trace.total)).toBe(1);
      expect(Number(audit.total)).toBe(1);

      const other = {
        organizationName: 'Otra empresa reservas',
        email: 'other-reservations@example.com',
        password: registrationPayload.password,
      };
      await request(app.getHttpServer())
        .post('/api/v1/auth/registrations')
        .set('Idempotency-Key', 'other-reservations-registration')
        .send(other)
        .expect(201);
      const otherCookie = await createPersistedSession(other.email);
      await request(app.getHttpServer())
        .put('/api/v1/onboarding/company')
        .set('Cookie', otherCookie)
        .send({
          legalName: 'Otra empresa reservas Legal',
          tradeName: 'Otra empresa reservas',
          countryCode: 'MX',
        })
        .expect(200);
      await request(app.getHttpServer())
        .put('/api/v1/onboarding/initial-location')
        .set('Cookie', otherCookie)
        .send({
          branchName: 'Sucursal reservas',
          timezone: 'America/Mexico_City',
          warehouseName: 'Bodega reservas',
          locationName: 'General reservas',
        })
        .expect(200);
      await request(app.getHttpServer())
        .put('/api/v1/onboarding/initial-cash-register')
        .set('Cookie', otherCookie)
        .send({ name: 'Caja reservas' })
        .expect(200);
      await request(app.getHttpServer())
        .get('/api/v1/reservations')
        .set('Cookie', otherCookie)
        .expect(200)
        .expect(({ body }: { body: { data: unknown[] } }) => {
          expect(body.data).toEqual([]);
        });

      await request(app.getHttpServer())
        .delete(`/api/v1/customers/${customerId}`)
        .set('Cookie', cookie)
        .expect(200);
      await request(app.getHttpServer())
        .post('/api/v1/reservations')
        .set('Cookie', cookie)
        .set('Idempotency-Key', 'reservation-inactive-customer')
        .send({ ...input, lines: [{ productId, quantity: '0.500' }] })
        .expect(404);

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
         WHERE role_id = ? AND tenant_id = ? AND permission = 'SALES_MANAGE'`,
        [admin.role_id, admin.tenant_id],
      );
      await request(app.getHttpServer())
        .get('/api/v1/reservations')
        .set('Cookie', cookie)
        .expect(403);
    });

    it('releases, expires and consumes reservations without decrementing stock twice', async () => {
      const { cookie, productId, locationId } = await preparePos();
      const customerResponse = await request(app.getHttpServer())
        .post('/api/v1/customers')
        .set('Cookie', cookie)
        .send({ name: 'Cliente ciclo reserva', dataProcessingConsent: false })
        .expect(201);
      const customerId = (customerResponse.body as { data: { id: string } })
        .data.id;
      const createReservation = async (key: string, quantity: string) => {
        const response = await request(app.getHttpServer())
          .post('/api/v1/reservations')
          .set('Cookie', cookie)
          .set('Idempotency-Key', key)
          .send({
            customerId,
            locationId,
            expiresInHours: 24,
            lines: [{ productId, quantity }],
          })
          .expect(201);
        return (response.body as { data: { id: string } }).data.id;
      };

      const releasedId = await createReservation(
        'reservation-release-create',
        '1',
      );
      await request(app.getHttpServer())
        .post(`/api/v1/reservations/${releasedId}/release`)
        .set('Cookie', cookie)
        .set('Idempotency-Key', 'reservation-release-action')
        .send({ reason: 'Cliente canceló la reserva' })
        .expect(201)
        .expect(({ body }: { body: unknown }) => {
          expect(body).toMatchObject({
            data: { status: 'RELEASED' },
            meta: { idempotentReplay: false },
          });
        });
      await request(app.getHttpServer())
        .post(`/api/v1/reservations/${releasedId}/release`)
        .set('Cookie', cookie)
        .set('Idempotency-Key', 'reservation-release-action')
        .send({ reason: 'Cliente canceló la reserva' })
        .expect(201)
        .expect(({ body }: { body: unknown }) => {
          expect(body).toMatchObject({ meta: { idempotentReplay: true } });
        });

      const expiredId = await createReservation(
        'reservation-expire-create',
        '1',
      );
      await dataSource.query(
        `UPDATE product_reservations
         SET created_at = DATE_SUB(CURRENT_TIMESTAMP(6), INTERVAL 2 HOUR),
             expires_at = DATE_SUB(CURRENT_TIMESTAMP(6), INTERVAL 1 MINUTE)
         WHERE id = ?`,
        [expiredId],
      );
      await request(app.getHttpServer())
        .post('/api/v1/reservations/expire-due')
        .set('Cookie', cookie)
        .expect(201)
        .expect(({ body }: { body: unknown }) => {
          expect(body).toMatchObject({
            data: [{ id: expiredId, status: 'EXPIRED' }],
            meta: { expiredCount: 1 },
          });
        });
      await request(app.getHttpServer())
        .post('/api/v1/reservations/expire-due')
        .set('Cookie', cookie)
        .expect(201)
        .expect(({ body }: { body: unknown }) => {
          expect(body).toMatchObject({ data: [], meta: { expiredCount: 0 } });
        });

      const consumedId = await createReservation(
        'reservation-consume-create',
        '2',
      );
      const sale = await request(app.getHttpServer())
        .post('/api/v1/pos/sales/cash')
        .set('Cookie', cookie)
        .set('Idempotency-Key', 'reservation-consume-sale')
        .send({
          reservationId: consumedId,
          customerId,
          lines: [{ productId, quantity: '2' }],
          cashReceived: '300.00',
        });
      expect(sale.status).toBe(201);
      const saleId = (sale.body as { data: { id: string } }).data.id;
      await request(app.getHttpServer())
        .post('/api/v1/pos/sales/cash')
        .set('Cookie', cookie)
        .set('Idempotency-Key', 'reservation-consume-sale')
        .send({
          reservationId: consumedId,
          customerId,
          lines: [{ productId, quantity: '2' }],
          cashReceived: '300.00',
        })
        .expect(201)
        .expect(({ body }: { body: unknown }) => {
          expect(body).toMatchObject({
            data: { id: saleId },
            meta: { idempotentReplay: true },
          });
        });
      await request(app.getHttpServer())
        .get('/api/v1/reservations')
        .set('Cookie', cookie)
        .expect(200)
        .expect(
          ({
            body,
          }: {
            body: {
              data: Array<{
                id: string;
                status: string;
                sale: { id: string } | null;
              }>;
            };
          }) => {
            expect(body.data.find(({ id }) => id === consumedId)).toMatchObject(
              {
                status: 'CONSUMED',
                sale: { id: saleId },
              },
            );
          },
        );
      await request(app.getHttpServer())
        .get(`/api/v1/inventory/products/${productId}/balance`)
        .query({ locationId })
        .set('Cookie', cookie)
        .expect(200)
        .expect(
          ({
            body,
          }: {
            body: {
              data: {
                totalQuantity: string;
                availableQuantity: string;
                states: Array<{ code: string; quantity: string }>;
              };
            };
          }) => {
            expect(body.data.totalQuantity).toBe('3.000');
            expect(body.data.availableQuantity).toBe('3.000');
            expect(
              body.data.states.find(({ code }) => code === 'AVAILABLE'),
            ).toEqual({
              code: 'AVAILABLE',
              quantity: '3.000',
            });
            expect(
              body.data.states.find(({ code }) => code === 'RESERVED'),
            ).toEqual({
              code: 'RESERVED',
              quantity: '0.000',
            });
          },
        );
      const [movementCount] = await dataSource.query<
        Array<{ total: number | string }>
      >(
        `SELECT COUNT(*) AS total FROM inventory_movements
         WHERE reservation_id = ? AND type = 'SALE'`,
        [consumedId],
      );
      expect(Number(movementCount.total)).toBe(1);

      const racedId = await createReservation('reservation-race-create', '1');
      const race = await Promise.all([
        request(app.getHttpServer())
          .post(`/api/v1/reservations/${racedId}/release`)
          .set('Cookie', cookie)
          .set('Idempotency-Key', 'reservation-race-release')
          .send({ reason: 'Liberación simultánea' }),
        request(app.getHttpServer())
          .post('/api/v1/pos/sales/cash')
          .set('Cookie', cookie)
          .set('Idempotency-Key', 'reservation-race-sale')
          .send({
            reservationId: racedId,
            customerId,
            lines: [{ productId, quantity: '1' }],
            cashReceived: '150.00',
          }),
      ]);
      expect(race.map(({ status }) => status).sort()).toEqual([201, 409]);
      const [raceReservation] = await dataSource.query<
        Array<{ status: 'RELEASED' | 'CONSUMED' }>
      >(`SELECT status FROM product_reservations WHERE id = ?`, [racedId]);
      const [raceBalance] = await dataSource.query<
        Array<{
          quantity: string;
          available_quantity: string;
          reserved_quantity: string;
        }>
      >(
        `SELECT quantity, available_quantity, reserved_quantity
         FROM inventory_balances WHERE product_id = ? AND location_id = ?`,
        [productId, locationId],
      );
      expect(raceBalance.reserved_quantity).toBe('0.000');
      expect(raceBalance.available_quantity).toBe(raceBalance.quantity);
      expect(['RELEASED', 'CONSUMED']).toContain(raceReservation.status);

      const auditActions = await dataSource.query<Array<{ action: string }>>(
        `SELECT action FROM audit_events
         WHERE entity_type = 'PRODUCT_RESERVATION' AND entity_id IN (?, ?, ?)`,
        [releasedId, expiredId, consumedId],
      );
      expect(auditActions.map(({ action }) => action)).toEqual(
        expect.arrayContaining([
          'PRODUCT_RESERVATION_RELEASED',
          'PRODUCT_RESERVATION_EXPIRED',
          'PRODUCT_RESERVATION_CONSUMED',
        ]),
      );
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

    it('reprints an immutable non-fiscal receipt and sends it through the email simulator', async () => {
      const { cookie, productId } = await preparePos();
      const sale = await request(app.getHttpServer())
        .post('/api/v1/pos/sales/cash')
        .set('Cookie', cookie)
        .set('Idempotency-Key', 'receipt-sale')
        .send({
          lines: [{ productId, quantity: '1' }],
          cashReceived: '120.00',
        })
        .expect(201);
      const saleId = (sale.body as { data: { id: string } }).data.id;
      const [principal] = await dataSource.query<
        Array<{ tenant_id: string; role_id: string }>
      >(
        `SELECT user.tenant_id, user_role.role_id FROM users user
         INNER JOIN user_roles user_role
           ON user_role.user_id = user.id AND user_role.tenant_id = user.tenant_id
         WHERE user.normalized_email = ? LIMIT 1`,
        [registrationPayload.email],
      );

      await dataSource.query(
        `DELETE FROM role_permissions
         WHERE role_id = ? AND tenant_id = ? AND permission = 'SALE_REPRINT'`,
        [principal.role_id, principal.tenant_id],
      );
      await request(app.getHttpServer())
        .post(`/api/v1/pos/sales/${saleId}/receipt/reprints`)
        .set('Cookie', cookie)
        .expect(403)
        .expect(({ body }: { body: { code?: string } }) => {
          expect(body.code).toBe('PERMISSION_DENIED');
        });
      await dataSource.query(
        `INSERT INTO role_permissions (role_id, tenant_id, permission)
         VALUES (?, ?, 'SALE_REPRINT')`,
        [principal.role_id, principal.tenant_id],
      );

      await dataSource.query(
        `UPDATE tenants SET name = 'Nombre nuevo', legal_name = 'Razón social nueva'
         WHERE id = ?`,
        [principal.tenant_id],
      );
      await dataSource.query(
        `UPDATE cash_registers SET name = 'Caja renombrada' WHERE tenant_id = ?`,
        [principal.tenant_id],
      );
      await dataSource.query(
        `UPDATE sale_lines SET product_name = 'Producto alterado' WHERE sale_id = ?`,
        [saleId],
      );

      for (const requestId of ['receipt-print-1', 'receipt-print-2']) {
        await request(app.getHttpServer())
          .post(`/api/v1/pos/sales/${saleId}/receipt/reprints`)
          .set('Cookie', cookie)
          .set('X-Request-Id', requestId)
          .expect(200)
          .expect(({ body }: { body: unknown }) => {
            expect(body).toMatchObject({
              data: {
                saleId,
                documentType: 'NON_FISCAL_SALE_RECEIPT',
                fiscalNotice: 'COMPROBANTE NO FISCAL',
                merchant: {
                  name: 'Tienda POS',
                  legalName: 'Tienda POS Legal',
                  countryCode: 'MX',
                },
                branchName: 'Sucursal POS',
                cashRegister: { name: 'Caja POS', code: 'MAIN' },
                sellerEmail: registrationPayload.email,
                currency: 'MXN',
                lines: [
                  {
                    productName: 'Café POS',
                    productSku: 'CAFE-POS',
                    quantity: '1.000',
                    unitPrice: '119.90',
                    total: '119.90',
                  },
                ],
                payments: [
                  {
                    method: 'CASH',
                    amountReceived: '120.00',
                    amountApplied: '119.90',
                    change: '0.10',
                  },
                ],
                totals: { subtotal: '103.36', tax: '16.54', total: '119.90' },
                saleStatus: 'COMPLETED',
              },
              meta: { apiVersion: '1' },
            });
          });
      }

      await request(app.getHttpServer())
        .post(`/api/v1/pos/sales/${saleId}/receipt/deliveries`)
        .set('Cookie', cookie)
        .send({ email: 'no-es-correo' })
        .expect(400);
      const recipient = 'cliente.recibo@example.com';
      await request(app.getHttpServer())
        .post(`/api/v1/pos/sales/${saleId}/receipt/deliveries`)
        .set('Cookie', cookie)
        .set('X-Request-Id', 'receipt-email-1')
        .send({ email: recipient })
        .expect(200)
        .expect(({ body }: { body: unknown }) => {
          expect(body).toMatchObject({
            data: {
              receipt: { saleId, fiscalNotice: 'COMPROBANTE NO FISCAL' },
              delivery: {
                mode: 'SIMULATED',
                channel: 'EMAIL',
                recipient,
              },
            },
          });
        });

      const foreignEmail = 'foreign.receipt@example.com';
      await request(app.getHttpServer())
        .post('/api/v1/auth/registrations')
        .set('Idempotency-Key', 'receipt-foreign-registration')
        .send({
          organizationName: 'Comercio ajeno',
          email: foreignEmail,
          password: registrationPayload.password,
        })
        .expect(201);
      const foreignCookie = await createPersistedSession(foreignEmail);
      await request(app.getHttpServer())
        .put('/api/v1/onboarding/company')
        .set('Cookie', foreignCookie)
        .send({
          legalName: 'Ajeno Legal',
          tradeName: 'Ajeno',
          countryCode: 'MX',
        })
        .expect(200);
      await request(app.getHttpServer())
        .put('/api/v1/onboarding/initial-location')
        .set('Cookie', foreignCookie)
        .send({
          branchName: 'Sucursal ajena',
          timezone: 'America/Mexico_City',
          warehouseName: 'Bodega ajena',
          locationName: 'General ajena',
        })
        .expect(200);
      await request(app.getHttpServer())
        .put('/api/v1/onboarding/initial-cash-register')
        .set('Cookie', foreignCookie)
        .send({ name: 'Caja ajena' })
        .expect(200);
      await request(app.getHttpServer())
        .post(`/api/v1/pos/sales/${saleId}/receipt/reprints`)
        .set('Cookie', foreignCookie)
        .expect(404);

      const [state] = await dataSource.query<
        Array<{
          snapshots: number | string;
          reprints: number | string;
          sends: number | string;
          send_data: string | { recipientHash: string };
        }>
      >(
        `SELECT
           (SELECT COUNT(*) FROM sale_receipt_snapshots WHERE sale_id = ?) AS snapshots,
           (SELECT COUNT(*) FROM audit_events
             WHERE action = 'SALE_RECEIPT_REPRINTED' AND entity_id = ?) AS reprints,
           (SELECT COUNT(*) FROM audit_events
             WHERE action = 'SALE_RECEIPT_SENT' AND entity_id = ?) AS sends,
           (SELECT after_data FROM audit_events
             WHERE action = 'SALE_RECEIPT_SENT' AND entity_id = ? LIMIT 1) AS send_data`,
        [saleId, saleId, saleId, saleId],
      );
      const sendData =
        typeof state.send_data === 'string'
          ? (JSON.parse(state.send_data) as { recipientHash: string })
          : state.send_data;
      expect({
        snapshots: Number(state.snapshots),
        reprints: Number(state.reprints),
        sends: Number(state.sends),
      }).toEqual({ snapshots: 1, reprints: 2, sends: 1 });
      expect(sendData.recipientHash).toBe(
        createHash('sha256').update(recipient).digest('hex'),
      );
      expect(JSON.stringify(sendData)).not.toContain(recipient);
    });

    it('operates configured POS peripherals without duplicating sales and with safe retries', async () => {
      const { cookie, productId } = await preparePos();
      const sale = await request(app.getHttpServer())
        .post('/api/v1/pos/sales/cash')
        .set('Cookie', cookie)
        .set('Idempotency-Key', 'peripheral-sale')
        .send({ lines: [{ productId, quantity: '1' }], cashReceived: '120.00' })
        .expect(201);
      const saleId = (sale.body as { data: { id: string } }).data.id;

      await request(app.getHttpServer())
        .get('/api/v1/pos/peripherals/profile')
        .set('Cookie', cookie)
        .expect(200)
        .expect(({ body }: { body: unknown }) => {
          expect(body).toMatchObject({
            data: {
              adapter: 'SIMULATOR',
              printerEnabled: true,
              drawerEnabled: true,
              autoOpenCashSale: true,
              cashRegister: { code: 'MAIN' },
            },
          });
        });

      await request(app.getHttpServer())
        .put('/api/v1/pos/peripherals/profile')
        .set('Cookie', cookie)
        .send({
          deviceId: 'FAIL-PRINTER-1',
          label: 'Impresora simulada con fallo',
          adapter: 'SIMULATOR',
          printerEnabled: true,
          drawerEnabled: true,
          autoOpenCashSale: true,
        })
        .expect(200);

      let failedOperationId = '';
      for (const replay of [false, true]) {
        await request(app.getHttpServer())
          .post(`/api/v1/pos/peripherals/receipts/${saleId}/prints`)
          .set('Cookie', cookie)
          .set('Idempotency-Key', 'peripheral-print-failure')
          .expect(201)
          .expect(
            ({
              body,
            }: {
              body: {
                data: {
                  operation: { id: string; status: string; errorCode: string };
                };
                meta: { idempotentReplay: boolean };
              };
            }) => {
              failedOperationId ||= body.data.operation.id;
              expect(body.data.operation).toMatchObject({
                id: failedOperationId,
                status: 'FAILED',
                errorCode: 'DEVICE_UNAVAILABLE',
              });
              expect(body.meta.idempotentReplay).toBe(replay);
            },
          );
      }

      await request(app.getHttpServer())
        .put('/api/v1/pos/peripherals/profile')
        .set('Cookie', cookie)
        .send({
          deviceId: 'SIM-POS-1',
          label: 'Impresora y cajon principal',
          adapter: 'SIMULATOR',
          printerEnabled: true,
          drawerEnabled: true,
          autoOpenCashSale: true,
        })
        .expect(200);
      await request(app.getHttpServer())
        .post(`/api/v1/pos/peripherals/receipts/${saleId}/prints`)
        .set('Cookie', cookie)
        .set('Idempotency-Key', 'peripheral-print-retry')
        .expect(201)
        .expect(({ body }: { body: unknown }) => {
          expect(body).toMatchObject({
            data: {
              receipt: { saleId },
              operation: { status: 'COMPLETED', deviceId: 'SIM-POS-1' },
            },
            meta: { idempotentReplay: false },
          });
        });

      const [principal] = await dataSource.query<
        Array<{ tenant_id: string; role_id: string }>
      >(
        `SELECT user.tenant_id, user_role.role_id FROM users user
         INNER JOIN user_roles user_role
           ON user_role.user_id = user.id AND user_role.tenant_id = user.tenant_id
         WHERE user.normalized_email = ? LIMIT 1`,
        [registrationPayload.email],
      );
      await dataSource.query(
        `DELETE FROM role_permissions
         WHERE role_id = ? AND tenant_id = ? AND permission = 'CASH_DRAWER_OPEN'`,
        [principal.role_id, principal.tenant_id],
      );
      await request(app.getHttpServer())
        .post('/api/v1/pos/peripherals/cash-drawer/openings')
        .set('Cookie', cookie)
        .set('Idempotency-Key', 'drawer-without-permission')
        .send({ trigger: 'CASH_SALE_COMPLETED', saleId })
        .expect(403);
      await dataSource.query(
        `INSERT INTO role_permissions (role_id, tenant_id, permission)
         VALUES (?, ?, 'CASH_DRAWER_OPEN')`,
        [principal.role_id, principal.tenant_id],
      );

      for (const replay of [false, true]) {
        await request(app.getHttpServer())
          .post('/api/v1/pos/peripherals/cash-drawer/openings')
          .set('Cookie', cookie)
          .set('Idempotency-Key', 'drawer-after-cash-sale')
          .send({ trigger: 'CASH_SALE_COMPLETED', saleId })
          .expect(201)
          .expect(
            ({
              body,
            }: {
              body: { data: unknown; meta: { idempotentReplay: boolean } };
            }) => {
              expect(body.data).toMatchObject({
                action: 'OPEN_DRAWER',
                trigger: 'CASH_SALE_COMPLETED',
                status: 'COMPLETED',
                saleId,
              });
              expect(body.meta.idempotentReplay).toBe(replay);
            },
          );
      }

      const [state] = await dataSource.query<
        Array<{
          sales: number | string;
          operations: number | string;
          audits: number | string;
          failed_device: string;
        }>
      >(
        `SELECT
           (SELECT COUNT(*) FROM sales WHERE id = ?) AS sales,
           (SELECT COUNT(*) FROM pos_peripheral_operations WHERE tenant_id = ?) AS operations,
           (SELECT COUNT(*) FROM audit_events
             WHERE entity_type = 'POS_PERIPHERAL_OPERATION') AS audits,
           (SELECT device_id FROM pos_peripheral_operations WHERE id = ?) AS failed_device`,
        [saleId, principal.tenant_id, failedOperationId],
      );
      expect({
        sales: Number(state.sales),
        operations: Number(state.operations),
        audits: Number(state.audits),
        failedDevice: state.failed_device,
      }).toEqual({
        sales: 1,
        operations: 3,
        audits: 3,
        failedDevice: 'FAIL-PRINTER-1',
      });
    });

    it('returns sale quantities once, restores the right stock state and links an exchange', async () => {
      const { cookie, productId, locationId } = await preparePos();
      const original = await request(app.getHttpServer())
        .post('/api/v1/pos/sales/cash')
        .set('Cookie', cookie)
        .set('Idempotency-Key', 'sale-return-original')
        .send({
          lines: [{ productId, quantity: '4' }],
          cashReceived: '500.00',
        })
        .expect(201);
      const originalData = original.body as {
        data: { id: string; lines: Array<{ id: string }> };
      };
      const exchange = await request(app.getHttpServer())
        .post('/api/v1/pos/sales/cash')
        .set('Cookie', cookie)
        .set('Idempotency-Key', 'sale-return-exchange')
        .send({
          lines: [{ productId, quantity: '1' }],
          cashReceived: '150.00',
        })
        .expect(201);
      const exchangeId = (exchange.body as { data: { id: string } }).data.id;
      const saleId = originalData.data.id;
      const saleLineId = originalData.data.lines[0].id;
      const [principal] = await dataSource.query<
        Array<{ tenant_id: string; role_id: string }>
      >(
        `SELECT u.tenant_id, ur.role_id FROM users u
         INNER JOIN user_roles ur
           ON ur.user_id = u.id AND ur.tenant_id = u.tenant_id
         WHERE u.normalized_email = ? LIMIT 1`,
        [registrationPayload.email],
      );

      await dataSource.query(
        `DELETE FROM role_permissions
         WHERE role_id = ? AND tenant_id = ? AND permission = 'SALES_RETURN'`,
        [principal.role_id, principal.tenant_id],
      );
      await request(app.getHttpServer())
        .post(`/api/v1/pos/sales/${saleId}/returns`)
        .set('Cookie', cookie)
        .set('Idempotency-Key', 'sale-return-no-permission')
        .send({
          reason: 'Cliente solicita cambio',
          lines: [{ saleLineId, quantity: '1', condition: 'SELLABLE' }],
        })
        .expect(403);
      await dataSource.query(
        `INSERT INTO role_permissions (role_id, tenant_id, permission)
         VALUES (?, ?, 'SALES_RETURN')`,
        [principal.role_id, principal.tenant_id],
      );

      const firstPayload = {
        reason: 'Cliente solicita cambio de presentación',
        exchangeSaleId: exchangeId,
        lines: [{ saleLineId, quantity: '1', condition: 'SELLABLE' }],
      };
      const first = await request(app.getHttpServer())
        .post(`/api/v1/pos/sales/${saleId}/returns`)
        .set('Cookie', cookie)
        .set('X-Request-Id', 'sale-return-first-audit')
        .set('Idempotency-Key', 'sale-return-first')
        .send(firstPayload)
        .expect(201);
      expect(first.body).toMatchObject({
        data: {
          saleId,
          exchangeSale: { id: exchangeId },
          settlementStatus: 'PENDING',
          reason: firstPayload.reason,
          lines: [
            {
              saleLineId,
              quantity: '1.000',
              condition: 'SELLABLE',
            },
          ],
        },
        meta: { idempotentReplay: false },
      });
      await request(app.getHttpServer())
        .post(`/api/v1/pos/sales/${saleId}/returns`)
        .set('Cookie', cookie)
        .set('Idempotency-Key', 'sale-return-first')
        .send(firstPayload)
        .expect(201)
        .expect(
          ({ body }: { body: { meta: { idempotentReplay: boolean } } }) => {
            expect(body.meta.idempotentReplay).toBe(true);
          },
        );

      const concurrent = await Promise.all(
        ['sale-return-concurrent-a', 'sale-return-concurrent-b'].map((key) =>
          request(app.getHttpServer())
            .post(`/api/v1/pos/sales/${saleId}/returns`)
            .set('Cookie', cookie)
            .set('Idempotency-Key', key)
            .send({
              reason: 'Producto abierto y dañado',
              lines: [{ saleLineId, quantity: '2', condition: 'DAMAGED' }],
            }),
        ),
      );
      expect(concurrent.map(({ status }) => status).sort()).toEqual([201, 409]);
      expect(
        concurrent.find(({ status }) => status === 409)?.body,
      ).toMatchObject({
        code: 'SALE_RETURN_QUANTITY_EXCEEDED',
      });
      await request(app.getHttpServer())
        .post(`/api/v1/pos/sales/${saleId}/returns`)
        .set('Cookie', cookie)
        .set('Idempotency-Key', 'sale-return-over-limit')
        .send({
          reason: 'Intento por encima del remanente',
          lines: [{ saleLineId, quantity: '2', condition: 'SELLABLE' }],
        })
        .expect(409)
        .expect(({ body }: { body: { code?: string } }) => {
          expect(body.code).toBe('SALE_RETURN_QUANTITY_EXCEEDED');
        });
      await request(app.getHttpServer())
        .post(`/api/v1/pos/sales/${saleId}/void`)
        .set('Cookie', cookie)
        .set('Idempotency-Key', 'sale-void-after-return')
        .send({ reason: 'No debe anular tras devolver' })
        .expect(409)
        .expect(({ body }: { body: { code?: string } }) => {
          expect(body.code).toBe('SALE_VOID_NOT_ALLOWED');
        });

      await request(app.getHttpServer())
        .get(`/api/v1/pos/sales/${saleId}/returns`)
        .set('Cookie', cookie)
        .expect(200)
        .expect(({ body }: { body: { data: unknown[] } }) => {
          expect(body.data).toHaveLength(2);
        });
      const [state] = await dataSource.query<
        Array<{
          returns: number | string;
          return_lines: number | string;
          return_movements: number | string;
          available_quantity: string;
          damaged_quantity: string;
          quantity: string;
          valuation_quantity: string;
          fifo_quantity: string;
          audits: number | string;
        }>
      >(
        `SELECT
           (SELECT COUNT(*) FROM sale_returns WHERE sale_id = ?) AS returns,
           (SELECT COUNT(*) FROM sale_return_lines srl
             INNER JOIN sale_returns sr ON sr.id = srl.sale_return_id
             WHERE sr.sale_id = ?) AS return_lines,
           (SELECT COUNT(*) FROM inventory_movements
             WHERE sale_id = ? AND type = 'SALE_RETURN') AS return_movements,
           ib.available_quantity, ib.damaged_quantity, ib.quantity,
           iv.quantity AS valuation_quantity,
           (SELECT COALESCE(SUM(remaining_quantity), 0)
              FROM inventory_fifo_layers WHERE product_id = ?) AS fifo_quantity,
           (SELECT COUNT(*) FROM audit_events
              WHERE action = 'SALE_RETURNED') AS audits
         FROM inventory_balances ib
         INNER JOIN inventory_valuations iv
           ON iv.tenant_id = ib.tenant_id AND iv.product_id = ib.product_id
         WHERE ib.product_id = ? AND ib.location_id = ?`,
        [saleId, saleId, saleId, productId, productId, locationId],
      );
      expect({
        returns: Number(state.returns),
        returnLines: Number(state.return_lines),
        returnMovements: Number(state.return_movements),
        available: state.available_quantity,
        damaged: state.damaged_quantity,
        quantity: state.quantity,
        valuation: state.valuation_quantity,
        fifo: state.fifo_quantity,
        audits: Number(state.audits),
      }).toEqual({
        returns: 2,
        returnLines: 2,
        returnMovements: 2,
        available: '1.000',
        damaged: '2.000',
        quantity: '3.000',
        valuation: '3.000',
        fifo: '3.000',
        audits: 2,
      });
      await request(app.getHttpServer())
        .get('/api/v1/inventory/movements')
        .set('Cookie', cookie)
        .query({ productId, type: 'SALE_RETURN' })
        .expect(200)
        .expect(({ body }: { body: { data: unknown[] } }) => {
          expect(body.data).toHaveLength(2);
          expect(body.data[0]).toMatchObject({
            type: 'SALE_RETURN',
            direction: 'IN',
            responsible: { email: registrationPayload.email },
            document: { type: 'SALE_RETURN' },
          });
        });
    });

    it('settles returns partially, credits customers and records failed provider refunds once', async () => {
      const { cookie, productId } = await preparePos();
      const customerResponse = await request(app.getHttpServer())
        .post('/api/v1/customers')
        .set('Cookie', cookie)
        .send({
          name: 'Cliente con saldo',
          identifier: 'CREDIT-001',
          dataProcessingConsent: false,
        })
        .expect(201);
      const customerId = (customerResponse.body as { data: { id: string } })
        .data.id;

      const cashSale = await request(app.getHttpServer())
        .post('/api/v1/pos/sales/cash')
        .set('Cookie', cookie)
        .set('Idempotency-Key', 'settlement-cash-sale')
        .send({
          customerId,
          lines: [{ productId, quantity: '2' }],
          cashReceived: '240.00',
        })
        .expect(201);
      const cashSaleData = cashSale.body as {
        data: {
          id: string;
          lines: Array<{ id: string }>;
          payments: Array<{ id: string }>;
        };
      };
      const cashReturn = await request(app.getHttpServer())
        .post(`/api/v1/pos/sales/${cashSaleData.data.id}/returns`)
        .set('Cookie', cookie)
        .set('Idempotency-Key', 'settlement-cash-return')
        .send({
          reason: 'DevoluciÃ³n completa con liquidaciÃ³n mixta',
          lines: [
            {
              saleLineId: cashSaleData.data.lines[0].id,
              quantity: '2',
              condition: 'SELLABLE',
            },
          ],
        })
        .expect(201);
      const cashReturnId = (cashReturn.body as { data: { id: string } }).data
        .id;
      const partialPayload = {
        mode: 'REFUND',
        amount: '100.00',
        originalPaymentId: cashSaleData.data.payments[0].id,
      };
      await request(app.getHttpServer())
        .post(
          `/api/v1/pos/sales/${cashSaleData.data.id}/returns/${cashReturnId}/settlements`,
        )
        .set('Cookie', cookie)
        .set('X-Request-Id', 'return-settlement-partial-audit')
        .set('Idempotency-Key', 'return-settlement-partial')
        .send(partialPayload)
        .expect(201)
        .expect(({ body }: { body: unknown }) => {
          expect(body).toMatchObject({
            data: {
              saleReturn: {
                id: cashReturnId,
                settlementStatus: 'PARTIALLY_SETTLED',
                refundableAmount: '139.80',
              },
              settlement: {
                mode: 'REFUND',
                method: 'CASH',
                status: 'COMPLETED',
                amount: '100.00',
                originalPayment: { id: cashSaleData.data.payments[0].id },
              },
            },
            meta: { idempotentReplay: false },
          });
        });
      await request(app.getHttpServer())
        .post(
          `/api/v1/pos/sales/${cashSaleData.data.id}/returns/${cashReturnId}/settlements`,
        )
        .set('Cookie', cookie)
        .set('Idempotency-Key', 'return-settlement-partial')
        .send(partialPayload)
        .expect(201)
        .expect(
          ({ body }: { body: { meta: { idempotentReplay: boolean } } }) => {
            expect(body.meta.idempotentReplay).toBe(true);
          },
        );
      await request(app.getHttpServer())
        .post(
          `/api/v1/pos/sales/${cashSaleData.data.id}/returns/${cashReturnId}/settlements`,
        )
        .set('Cookie', cookie)
        .set('Idempotency-Key', 'return-settlement-over-limit')
        .send({ ...partialPayload, amount: '140.00' })
        .expect(409)
        .expect(({ body }: { body: { code?: string } }) => {
          expect(body.code).toBe('SALE_RETURN_SETTLEMENT_EXCEEDS_BALANCE');
        });
      await request(app.getHttpServer())
        .post(
          `/api/v1/pos/sales/${cashSaleData.data.id}/returns/${cashReturnId}/settlements`,
        )
        .set('Cookie', cookie)
        .set('Idempotency-Key', 'return-settlement-credit')
        .send({ mode: 'STORE_CREDIT', amount: '139.80' })
        .expect(201)
        .expect(({ body }: { body: unknown }) => {
          expect(body).toMatchObject({
            data: {
              saleReturn: {
                settlementStatus: 'SETTLED',
                refundableAmount: '0.00',
              },
              settlement: {
                mode: 'STORE_CREDIT',
                method: 'STORE_CREDIT',
                status: 'COMPLETED',
                amount: '139.80',
              },
            },
          });
        });

      const cardSale = await request(app.getHttpServer())
        .post('/api/v1/pos/sales')
        .set('Cookie', cookie)
        .set('Idempotency-Key', 'settlement-card-sale')
        .send({
          lines: [{ productId, quantity: '1' }],
          payment: { method: 'CARD', reference: 'FAIL-REFUND-CARD-001' },
        })
        .expect(201);
      const cardSaleData = cardSale.body as {
        data: {
          id: string;
          lines: Array<{ id: string }>;
          payments: Array<{ id: string }>;
        };
      };
      const cardReturn = await request(app.getHttpServer())
        .post(`/api/v1/pos/sales/${cardSaleData.data.id}/returns`)
        .set('Cookie', cookie)
        .set('Idempotency-Key', 'settlement-card-return')
        .send({
          reason: 'Proveedor simula fallo del reembolso',
          lines: [
            {
              saleLineId: cardSaleData.data.lines[0].id,
              quantity: '1',
              condition: 'SELLABLE',
            },
          ],
        })
        .expect(201);
      const cardReturnId = (cardReturn.body as { data: { id: string } }).data
        .id;
      const failedPayload = {
        mode: 'REFUND',
        amount: '119.90',
        originalPaymentId: cardSaleData.data.payments[0].id,
      };
      for (const replay of [false, true]) {
        await request(app.getHttpServer())
          .post(
            `/api/v1/pos/sales/${cardSaleData.data.id}/returns/${cardReturnId}/settlements`,
          )
          .set('Cookie', cookie)
          .set('Idempotency-Key', 'return-settlement-provider-failure')
          .send(failedPayload)
          .expect(201)
          .expect(({ body }: { body: unknown }) => {
            expect(body).toMatchObject({
              data: {
                saleReturn: {
                  settlementStatus: 'PENDING',
                  refundableAmount: '119.90',
                },
                settlement: {
                  method: 'CARD',
                  status: 'FAILED',
                  failureCode: 'SIMULATED_REFUND_FAILURE',
                },
              },
              meta: { idempotentReplay: replay },
            });
          });
      }

      const foreignEmail = 'foreign.settlement@example.com';
      await request(app.getHttpServer())
        .post('/api/v1/auth/registrations')
        .set('Idempotency-Key', 'settlement-foreign-registration')
        .send({
          organizationName: 'Comercio externo',
          email: foreignEmail,
          password: registrationPayload.password,
        })
        .expect(201);
      const foreignCookie = await createPersistedSession(foreignEmail);
      await request(app.getHttpServer())
        .put('/api/v1/onboarding/company')
        .set('Cookie', foreignCookie)
        .send({
          legalName: 'Comercio externo legal',
          tradeName: 'Externo',
          countryCode: 'MX',
        })
        .expect(200);
      await request(app.getHttpServer())
        .put('/api/v1/onboarding/initial-location')
        .set('Cookie', foreignCookie)
        .send({
          branchName: 'Sucursal externa',
          timezone: 'America/Mexico_City',
          warehouseName: 'Bodega externa',
          locationName: 'General externa',
        })
        .expect(200);
      await request(app.getHttpServer())
        .put('/api/v1/onboarding/initial-cash-register')
        .set('Cookie', foreignCookie)
        .send({ name: 'Caja externa' })
        .expect(200);
      await request(app.getHttpServer())
        .post(
          `/api/v1/pos/sales/${cashSaleData.data.id}/returns/${cashReturnId}/settlements`,
        )
        .set('Cookie', foreignCookie)
        .set('Idempotency-Key', 'settlement-foreign-attempt')
        .send({ mode: 'STORE_CREDIT', amount: '1.00' })
        .expect(404);

      await request(app.getHttpServer())
        .get('/api/v1/pos/register-shifts/current/movements')
        .set('Cookie', cookie)
        .expect(200)
        .expect(({ body }: { body: unknown }) => {
          expect(body).toMatchObject({ meta: { expectedCash: '389.80' } });
        });
      await request(app.getHttpServer())
        .post('/api/v1/pos/register-shifts/current/closure')
        .set('Cookie', cookie)
        .set('Idempotency-Key', 'return-settlement-close-shift')
        .send({ countedAmount: '389.80' })
        .expect(201)
        .expect(({ body }: { body: unknown }) => {
          expect(body).toMatchObject({
            data: { expectedCash: '389.80', difference: '0.00' },
          });
        });
      await request(app.getHttpServer())
        .post(
          `/api/v1/pos/sales/${cashSaleData.data.id}/returns/${cashReturnId}/settlements`,
        )
        .set('Cookie', cookie)
        .set('Idempotency-Key', 'return-settlement-partial')
        .send(partialPayload)
        .expect(201)
        .expect(
          ({ body }: { body: { meta: { idempotentReplay: boolean } } }) => {
            expect(body.meta.idempotentReplay).toBe(true);
          },
        );
      const [state] = await dataSource.query<
        Array<{
          settlements: number | string;
          credits: number | string;
          credit_amount: string;
          completed_audits: number | string;
          failed_audits: number | string;
        }>
      >(
        `SELECT
           (SELECT COUNT(*) FROM sale_return_settlements) AS settlements,
           (SELECT COUNT(*) FROM customer_credit_ledger
             WHERE tenant_id = ? AND customer_id = ?) AS credits,
           (SELECT COALESCE(SUM(amount), 0) FROM customer_credit_ledger
             WHERE tenant_id = ? AND customer_id = ?) AS credit_amount,
           (SELECT COUNT(*) FROM audit_events
             WHERE action = 'SALE_RETURN_SETTLED') AS completed_audits,
           (SELECT COUNT(*) FROM audit_events
             WHERE action = 'SALE_RETURN_SETTLEMENT_FAILED') AS failed_audits`,
        [
          (
            await dataSource.query<Array<{ tenant_id: string }>>(
              'SELECT tenant_id FROM customers WHERE id = ?',
              [customerId],
            )
          )[0].tenant_id,
          customerId,
          (
            await dataSource.query<Array<{ tenant_id: string }>>(
              'SELECT tenant_id FROM customers WHERE id = ?',
              [customerId],
            )
          )[0].tenant_id,
          customerId,
        ],
      );
      expect({
        settlements: Number(state.settlements),
        credits: Number(state.credits),
        creditAmount: state.credit_amount,
        completedAudits: Number(state.completed_audits),
        failedAudits: Number(state.failed_audits),
      }).toEqual({
        settlements: 3,
        credits: 1,
        creditAmount: '139.80',
        completedAudits: 2,
        failedAudits: 1,
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
          valuationQuantity: string;
          valuationValue: string;
          averageUnitCost: string;
          saleUnitCost: string;
          voidUnitCost: string;
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
                (SELECT quantity FROM inventory_valuations
                  WHERE product_id = ?) AS valuationQuantity,
                (SELECT inventory_value FROM inventory_valuations
                  WHERE product_id = ?) AS valuationValue,
                (SELECT average_unit_cost FROM inventory_valuations
                  WHERE product_id = ?) AS averageUnitCost,
                (SELECT unit_cost FROM inventory_movements
                  WHERE product_id = ? AND type = 'SALE' LIMIT 1) AS saleUnitCost,
                (SELECT unit_cost FROM inventory_movements
                  WHERE product_id = ? AND type = 'SALE_VOID' LIMIT 1) AS voidUnitCost,
                (SELECT COUNT(*) FROM audit_events WHERE action = 'SALE_VOIDED') AS audit_events,
                (SELECT before_data FROM audit_events WHERE action = 'SALE_VOIDED' LIMIT 1) AS before_data,
                (SELECT after_data FROM audit_events WHERE action = 'SALE_VOIDED' LIMIT 1) AS after_data`,
        [
          productId,
          locationId,
          productId,
          productId,
          productId,
          productId,
          productId,
        ],
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
        valuationQuantity: state.valuationQuantity,
        valuationValue: state.valuationValue,
        averageUnitCost: state.averageUnitCost,
        saleUnitCost: state.saleUnitCost,
        voidUnitCost: state.voidUnitCost,
        auditEvents: Number(state.audit_events),
        before,
        after,
      }).toEqual({
        sales: 1,
        reversedPayments: 1,
        saleVoidMovements: 1,
        balance: '5.000',
        valuationQuantity: '5.000',
        valuationValue: '400.0000',
        averageUnitCost: '80.0000',
        saleUnitCost: '80.0000',
        voidUnitCost: '80.0000',
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
                valuation: {
                  unitCost: '80.0000',
                  valueChange: '160.0000',
                  resultingInventoryValue: '400.0000',
                  averageUnitCost: '80.0000',
                },
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
      await request(app.getHttpServer())
        .get(`/api/v1/pos/sales/${saleId}/returns`)
        .set('Cookie', cookie)
        .expect(404);
      await request(app.getHttpServer())
        .post(`/api/v1/pos/sales/${saleId}/returns`)
        .set('Cookie', cookie)
        .set('Idempotency-Key', 'pos-return-branch-scope')
        .send({
          reason: 'No debe revelar la venta',
          lines: [
            { saleLineId: randomUUID(), quantity: '1', condition: 'SELLABLE' },
          ],
        })
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
          valuationQuantity: string;
          valuationValue: string;
          fifoQuantity: string;
          fifoValue: string;
          fifoAllocations: number | string;
        }>
      >(
        `SELECT (SELECT COUNT(*) FROM sales) AS sales,
                (SELECT COUNT(*) FROM inventory_movements WHERE type = 'SALE') AS sale_movements,
                (SELECT quantity FROM inventory_balances
                  WHERE product_id = ? AND location_id = ?) AS balance,
                (SELECT quantity FROM inventory_valuations
                  WHERE product_id = ?) AS valuationQuantity,
                (SELECT inventory_value FROM inventory_valuations
                  WHERE product_id = ?) AS valuationValue,
                (SELECT COALESCE(SUM(remaining_quantity), 0)
                  FROM inventory_fifo_layers WHERE product_id = ?) AS fifoQuantity,
                (SELECT CAST(COALESCE(SUM(remaining_quantity * unit_cost), 0) AS DECIMAL(21,4))
                  FROM inventory_fifo_layers WHERE product_id = ?) AS fifoValue,
                (SELECT COUNT(*) FROM inventory_movement_fifo_layers imfl
                  INNER JOIN inventory_movements im ON im.id = imfl.movement_id
                  WHERE im.product_id = ? AND im.type = 'SALE') AS fifoAllocations`,
        [
          productId,
          locationId,
          productId,
          productId,
          productId,
          productId,
          productId,
        ],
      );
      expect({
        sales: Number(state.sales),
        saleMovements: Number(state.sale_movements),
        balance: state.balance,
        valuationQuantity: state.valuationQuantity,
        valuationValue: state.valuationValue,
        fifoQuantity: state.fifoQuantity,
        fifoValue: state.fifoValue,
        fifoAllocations: Number(state.fifoAllocations),
      }).toEqual({
        sales: 1,
        saleMovements: 1,
        balance: '2.000',
        valuationQuantity: '2.000',
        valuationValue: '160.0000',
        fifoQuantity: '2.000',
        fifoValue: '160.0000',
        fifoAllocations: 1,
      });

      await dataSource.query(
        `UPDATE inventory_fifo_layers SET remaining_quantity = 0
         WHERE product_id = ?`,
        [productId],
      );
      await request(app.getHttpServer())
        .post('/api/v1/pos/sales/cash')
        .set('Cookie', cookie)
        .set('Idempotency-Key', 'pos-fifo-shortage')
        .send({
          lines: [{ productId, quantity: '1' }],
          cashReceived: '200.00',
        })
        .expect(409)
        .expect(({ body }: { body: { code?: string } }) => {
          expect(body.code).toBe('INVENTORY_FIFO_LAYER_SHORTAGE');
        });
      const [rollback] = await dataSource.query<
        Array<{ sales: number | string; balance: string }>
      >(
        `SELECT (SELECT COUNT(*) FROM sales) AS sales,
                (SELECT quantity FROM inventory_balances
                  WHERE product_id = ? AND location_id = ?) AS balance`,
        [productId, locationId],
      );
      expect({
        sales: Number(rollback.sales),
        balance: rollback.balance,
      }).toEqual({ sales: 1, balance: '2.000' });
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
        app.get(SalesRepository).persistSale({
          tenantId: principal.tenant_id,
          userId: principal.id,
          idempotencyKey: 'pos-payment-rollback',
          fingerprint: 'f'.repeat(64),
          cashRegisterShiftId: shift.id,
          quote,
          payments: [
            {
              method: 'CASH',
              amountReceived: '10000000000000.00',
              amountApplied: quote.totals.total,
              change: '0.00',
              reference: null,
              provider: 'CASH',
              providerReference: null,
              authorizationCode: null,
            },
          ],
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

  describe('authenticated offline bootstrap', () => {
    beforeEach(resetIdentityData);

    it('pages a resumable tenant-scoped compact snapshot without sensitive fields', async () => {
      await registerAccount('offline-bootstrap-registration');
      const cookie = await createPersistedSession(registrationPayload.email);
      await request(app.getHttpServer())
        .put('/api/v1/onboarding/company')
        .set('Cookie', cookie)
        .send({
          legalName: 'Tienda Offline, S.A. de C.V.',
          tradeName: 'Tienda Offline',
          countryCode: 'MX',
        })
        .expect(200);
      const location = await request(app.getHttpServer())
        .put('/api/v1/onboarding/initial-location')
        .set('Cookie', cookie)
        .send({
          branchName: 'Sucursal Offline',
          timezone: 'America/Mexico_City',
          warehouseName: 'Bodega Offline',
          locationName: 'General Offline',
        })
        .expect(200);
      const cashRegister = await request(app.getHttpServer())
        .put('/api/v1/onboarding/initial-cash-register')
        .set('Cookie', cookie)
        .send({ name: 'Caja Offline' })
        .expect(200);
      const product = await request(app.getHttpServer())
        .post('/api/v1/products')
        .set('Cookie', cookie)
        .send({
          name: 'Producto Offline',
          sku: 'OFFLINE-1',
          cost: '5.00',
          price: '12.50',
        })
        .expect(201);
      const productId = (product.body as { data: { id: string } }).data.id;
      const locationId = (
        location.body as { data: { location: { id: string } } }
      ).data.location.id;
      await request(app.getHttpServer())
        .post('/api/v1/inventory/movements')
        .set('Cookie', cookie)
        .set('Idempotency-Key', 'offline-bootstrap-stock')
        .send({
          productId,
          locationId,
          type: 'INITIAL',
          quantity: '4',
          reason: 'Bootstrap offline',
        })
        .expect(201);
      await request(app.getHttpServer())
        .post('/api/v1/organization/branches')
        .set('Cookie', cookie)
        .send({
          name: 'Sucursal no autorizada',
          timezone: 'America/Mexico_City',
          warehouseName: 'Bodega no autorizada',
          locationName: 'General no autorizada',
          locationCode: 'HIDDEN',
        })
        .expect(201);

      const deviceId = randomUUID();
      const first = await request(app.getHttpServer())
        .get('/api/v1/offline/bootstrap')
        .set('Cookie', cookie)
        .query({ deviceId, pageSize: 2 })
        .expect(200);
      const firstData = (first.body as { data: OfflineBootstrapResponseV1 })
        .data;
      expect(firstData.page.complete).toBe(false);
      expect(firstData.page.entities).toHaveLength(2);
      expect(firstData.page.initialSyncCursor).toEqual(expect.any(String));

      const collected = [...firstData.page.entities];
      let nextCursor: string | null = firstData.page.nextCursor;
      while (nextCursor) {
        const page = await request(app.getHttpServer())
          .get('/api/v1/offline/bootstrap')
          .set('Cookie', cookie)
          .query({ deviceId, pageSize: 2, cursor: nextCursor })
          .expect(200);
        const data = (page.body as { data: OfflineBootstrapResponseV1 }).data;
        expect(data.page.initialSyncCursor).toBe(
          firstData.page.initialSyncCursor,
        );
        collected.push(...data.page.entities);
        nextCursor = data.page.nextCursor;
      }

      expect(collected).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ kind: 'BRANCH', name: 'Sucursal Offline' }),
          expect.objectContaining({
            kind: 'PRODUCT',
            sku: 'OFFLINE-1',
            price: '12.50',
          }),
          expect.objectContaining({
            kind: 'INVENTORY_AVAILABILITY',
            productId,
            availableQuantity: '4.000',
          }),
        ]),
      );
      expect(JSON.stringify(first.body)).not.toMatch(
        /admin@example\.com|Correcta-2026|"cost"|password|token/i,
      );

      const viewerRole = await request(app.getHttpServer())
        .post('/api/v1/access/roles')
        .set('Cookie', cookie)
        .send({ name: 'Offline autorizado', permissions: ['INVENTORY_VIEW'] })
        .expect(201);
      const branchId = (location.body as { data: { branch: { id: string } } })
        .data.branch.id;
      const cashRegisterId = (
        cashRegister.body as { data: { cashRegister: { id: string } } }
      ).data.cashRegister.id;
      const viewerPassword = 'Offline-2026!';
      await request(app.getHttpServer())
        .post('/api/v1/access/users')
        .set('Cookie', cookie)
        .send({
          email: 'offline-viewer@example.com',
          password: viewerPassword,
          roleIds: [(viewerRole.body as { data: { id: string } }).data.id],
          branchIds: [branchId],
          cashRegisterIds: [cashRegisterId],
        })
        .expect(201);
      const viewerLogin = await request(app.getHttpServer())
        .post('/api/v1/auth/sessions')
        .send({ email: 'offline-viewer@example.com', password: viewerPassword })
        .expect(200);
      const viewerCookie = (
        viewerLogin.headers['set-cookie'] as unknown as string[]
      )[0].split(';')[0];
      const viewerBootstrap = await request(app.getHttpServer())
        .get('/api/v1/offline/bootstrap')
        .set('Cookie', viewerCookie)
        .query({ deviceId: randomUUID(), pageSize: 500 })
        .expect(200);
      const viewerEntities = (
        viewerBootstrap.body as { data: OfflineBootstrapResponseV1 }
      ).data.page.entities;
      expect(
        viewerEntities
          .filter(({ kind }) => kind === 'BRANCH')
          .map(({ id }) => id),
      ).toEqual([branchId]);
      expect(
        viewerEntities
          .filter(({ kind }) => kind === 'CASH_REGISTER')
          .map(({ id }) => id),
      ).toEqual([cashRegisterId]);
      expect(viewerEntities).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ kind: 'PRODUCT', id: productId }),
          expect.objectContaining({
            kind: 'INVENTORY_AVAILABILITY',
            productId,
          }),
        ]),
      );

      await request(app.getHttpServer())
        .patch(`/api/v1/products/${productId}`)
        .set('Cookie', cookie)
        .send({
          name: 'Producto Offline actualizado',
          sku: 'OFFLINE-1',
          cost: '5.00',
          price: '13.50',
          version: 1,
        })
        .expect(200);
      const firstChanges = await request(app.getHttpServer())
        .get('/api/v1/offline/changes')
        .set('Cookie', cookie)
        .query({
          deviceId,
          cursor: firstData.page.initialSyncCursor,
          pageSize: 1,
        })
        .expect(200);
      const firstChangeData = (
        firstChanges.body as { data: OfflineChangesResponseV1 }
      ).data;
      expect(firstChangeData.changes).toHaveLength(1);
      expect(firstChangeData.changes[0]?.operation).toBe('UPSERT');
      expect(firstChangeData.changes[0]?.entity).toMatchObject({
        kind: 'PRODUCT',
        id: productId,
        price: '13.50',
      });
      const retryChanges = await request(app.getHttpServer())
        .get('/api/v1/offline/changes')
        .set('Cookie', cookie)
        .query({
          deviceId,
          cursor: firstData.page.initialSyncCursor,
          pageSize: 1,
        })
        .expect(200);
      expect(
        (retryChanges.body as { data: OfflineChangesResponseV1 }).data.changes,
      ).toEqual(firstChangeData.changes);

      await request(app.getHttpServer())
        .delete(`/api/v1/products/${productId}`)
        .set('Cookie', cookie)
        .expect(200);
      const tombstone = await request(app.getHttpServer())
        .get('/api/v1/offline/changes')
        .set('Cookie', cookie)
        .query({ deviceId, cursor: firstChangeData.nextCursor, pageSize: 10 })
        .expect(200);
      const deletedProduct = (
        tombstone.body as { data: OfflineChangesResponseV1 }
      ).data.changes.find(
        ({ operation, entity }) =>
          operation === 'DELETE' && entity.id === productId,
      );
      expect(deletedProduct?.entity).toMatchObject({
        kind: 'PRODUCT',
        id: productId,
        active: false,
      });

      const disposable = await request(app.getHttpServer())
        .post('/api/v1/products')
        .set('Cookie', cookie)
        .send({
          name: 'Producto temporal offline',
          sku: 'OFFLINE-TEMP',
          cost: '1.00',
          price: '2.00',
        })
        .expect(201);
      const disposableId = (disposable.body as { data: { id: string } }).data
        .id;
      await request(app.getHttpServer())
        .delete(`/api/v1/products/${disposableId}`)
        .set('Cookie', cookie)
        .expect(200)
        .expect(({ body }: { body: unknown }) =>
          expect(body).toMatchObject({ data: { outcome: 'DELETED' } }),
        );
      const hardTombstone = await request(app.getHttpServer())
        .get('/api/v1/offline/changes')
        .set('Cookie', cookie)
        .query({
          deviceId,
          cursor: (tombstone.body as { data: OfflineChangesResponseV1 }).data
            .nextCursor,
          pageSize: 10,
        })
        .expect(200);
      expect(
        (
          hardTombstone.body as { data: OfflineChangesResponseV1 }
        ).data.changes.some(
          ({ operation, entity }) =>
            operation === 'DELETE' && entity.id === disposableId,
        ),
      ).toBe(true);

      await request(app.getHttpServer())
        .get('/api/v1/offline/bootstrap')
        .set('Cookie', cookie)
        .query({
          deviceId: randomUUID(),
          pageSize: 2,
          cursor: firstData.page.nextCursor,
        })
        .expect(400);
      const replacementSession = await createPersistedSession(
        registrationPayload.email,
      );
      await request(app.getHttpServer())
        .get('/api/v1/offline/bootstrap')
        .set('Cookie', replacementSession)
        .query({ deviceId, pageSize: 2, cursor: firstData.page.nextCursor })
        .expect(400);
      await request(app.getHttpServer())
        .get('/api/v1/offline/bootstrap')
        .query({ deviceId })
        .expect(401);
    });

    it('applies offline commands once, preserves causal order and resumes partial batches', async () => {
      const payload = {
        organizationName: 'Comandos Offline',
        email: 'offline-commands@example.com',
        password: 'Offline-Commands-2026!',
      };
      await request(app.getHttpServer())
        .post('/api/v1/auth/registrations')
        .set('Idempotency-Key', 'offline-commands-registration')
        .send(payload)
        .expect(201);
      const cookie = await createPersistedSession(payload.email);
      await request(app.getHttpServer())
        .put('/api/v1/onboarding/company')
        .set('Cookie', cookie)
        .send({
          legalName: 'Comandos Offline, S.A. de C.V.',
          tradeName: 'Comandos Offline',
          countryCode: 'MX',
        })
        .expect(200);
      const location = await request(app.getHttpServer())
        .put('/api/v1/onboarding/initial-location')
        .set('Cookie', cookie)
        .send({
          branchName: 'Sucursal Offline',
          timezone: 'America/Mexico_City',
          warehouseName: 'Bodega Offline',
          locationName: 'General Offline',
        })
        .expect(200);
      await request(app.getHttpServer())
        .put('/api/v1/onboarding/initial-cash-register')
        .set('Cookie', cookie)
        .send({ name: 'Caja Offline' })
        .expect(200);
      await request(app.getHttpServer())
        .post('/api/v1/pos/register-shifts')
        .set('Cookie', cookie)
        .set('Idempotency-Key', 'offline-command-shift-open')
        .send({ openingAmount: '100.00' })
        .expect(201);
      const product = await request(app.getHttpServer())
        .post('/api/v1/products')
        .set('Cookie', cookie)
        .send({
          name: 'Producto comando offline',
          sku: 'OFFLINE-COMMAND-1',
          cost: '5.00',
          price: '9.00',
        })
        .expect(201);
      const current = await request(app.getHttpServer())
        .get('/api/v1/auth/sessions/current')
        .set('Cookie', cookie)
        .expect(200);
      const identity = (
        current.body as {
          data: {
            tenant: { id: string };
            user: { id: string };
            context: {
              branch: { id: string };
              warehouse: { id: string };
              cashRegister: { id: string };
            };
          };
        }
      ).data;
      const productId = (product.body as { data: { id: string } }).data.id;
      const locationId = (
        location.body as { data: { location: { id: string } } }
      ).data.location.id;
      const deviceId = randomUUID();
      const posBootstrap = await request(app.getHttpServer())
        .get('/api/v1/offline/bootstrap')
        .set('Cookie', cookie)
        .query({ deviceId, pageSize: 500 })
        .expect(200);
      expect(
        (posBootstrap.body as { data: OfflineBootstrapResponseV1 }).data
          .posPolicy,
      ).toEqual(
        expect.objectContaining({
          kind: 'POS_POLICY',
          warehouseId: identity.context.warehouse.id,
          cashRegisterId: identity.context.cashRegister.id,
          currency: 'MXN',
          taxRate: '0.1600',
          paymentMethods: ['CASH'],
          negativeStock: 'DENY',
        }),
      );
      const scope = {
        tenantId: identity.tenant.id,
        userId: identity.user.id,
        deviceId,
        branchId: identity.context.branch.id,
        cashRegisterId: identity.context.cashRegister.id,
      };
      const firstCommand = {
        protocolVersion: '1.0',
        commandId: randomUUID(),
        idempotencyKey: `offline-command-${randomUUID()}`,
        scope,
        sequence: 1,
        createdAt: new Date().toISOString(),
        valuationMethod: 'MOVING_AVERAGE',
        valuationPolicyVersion: 1,
        kind: 'INVENTORY_MOVEMENT',
        payload: {
          productId,
          locationId,
          type: 'ENTRY',
          quantity: '3',
          reason: 'Comando offline inicial',
          reference: 'OFFLINE-ENTRY-1',
        },
      };
      const first = await request(app.getHttpServer())
        .post('/api/v1/offline/commands/batch')
        .set('Cookie', cookie)
        .send({ commands: [firstCommand] })
        .expect(201);
      const replay = await request(app.getHttpServer())
        .post('/api/v1/offline/commands/batch')
        .set('Cookie', cookie)
        .send({ commands: [firstCommand] })
        .expect(201);
      expect(first.body).toMatchObject({
        data: {
          results: [
            {
              status: 'CONFIRMED',
              replay: false,
              result: {
                meta: {
                  offlineResolution: {
                    domain: 'STOCK',
                    strategy: 'AUTO_MERGE',
                  },
                },
              },
            },
          ],
        },
      });
      expect(replay.body).toMatchObject({
        data: { results: [{ status: 'CONFIRMED', replay: true }] },
      });
      const firstResult = (
        first.body as { data: { results: Array<{ result: unknown }> } }
      ).data.results[0].result;
      const replayResult = (
        replay.body as { data: { results: Array<{ result: unknown }> } }
      ).data.results[0].result;
      expect(replayResult).toEqual(firstResult);

      const partial = await request(app.getHttpServer())
        .post('/api/v1/offline/commands/batch')
        .set('Cookie', cookie)
        .send({
          commands: [
            {
              ...firstCommand,
              commandId: randomUUID(),
              idempotencyKey: `offline-command-${randomUUID()}`,
              sequence: 2,
              payload: {
                ...firstCommand.payload,
                productId: randomUUID(),
                type: 'ENTRY',
              },
            },
            {
              ...firstCommand,
              commandId: randomUUID(),
              idempotencyKey: `offline-command-${randomUUID()}`,
              sequence: 3,
              payload: {
                ...firstCommand.payload,
                type: 'ENTRY',
                quantity: '2',
                reason: 'Reanudación causal',
                reference: 'OFFLINE-ENTRY-2',
              },
            },
          ],
        })
        .expect(201);
      expect(partial.body).toMatchObject({
        data: {
          results: [
            { sequence: 2, status: 'ERROR' },
            { sequence: 3, status: 'CONFIRMED' },
          ],
        },
      });
      await request(app.getHttpServer())
        .get(`/api/v1/inventory/products/${productId}/balance`)
        .set('Cookie', cookie)
        .query({ locationId })
        .expect(200)
        .expect(({ body }: { body: unknown }) =>
          expect(body).toMatchObject({ data: { quantity: '5.000' } }),
        );

      await request(app.getHttpServer())
        .post('/api/v1/offline/commands/batch')
        .set('Cookie', cookie)
        .send({
          commands: [
            {
              ...firstCommand,
              commandId: randomUUID(),
              idempotencyKey: `offline-command-${randomUUID()}`,
              sequence: 5,
            },
          ],
        })
        .expect(409)
        .expect(({ body }: { body: unknown }) =>
          expect(body).toMatchObject({
            code: 'OFFLINE_COMMAND_SEQUENCE_GAP',
            expectedSequence: 4,
          }),
        );
      await request(app.getHttpServer())
        .post('/api/v1/offline/commands/batch')
        .set('Cookie', cookie)
        .send({
          commands: [
            {
              ...firstCommand,
              commandId: randomUUID(),
              idempotencyKey: `offline-command-${randomUUID()}`,
              scope: { ...scope, tenantId: randomUUID() },
              sequence: 4,
            },
          ],
        })
        .expect(403);

      const staleQuoteResponse = await request(app.getHttpServer())
        .post('/api/v1/pos/cart/quote')
        .set('Cookie', cookie)
        .send({ lines: [{ productId, quantity: '3' }] })
        .expect(200);
      const staleQuote = (
        staleQuoteResponse.body as {
          data: {
            context: {
              branch: { id: string };
              warehouse: { id: string };
              cashRegister: { id: string };
            };
            currency: string;
            taxRate: string;
            lines: Array<{
              product: { id: string; name: string; sku: string };
              quantity: string;
              unitPrice: string;
              subtotal: string;
              tax: string;
              total: string;
            }>;
            totals: { subtotal: string; tax: string; total: string };
          };
        }
      ).data;
      const cashSnapshot = {
        capturedAt: new Date().toISOString(),
        branchId: staleQuote.context.branch.id,
        warehouseId: staleQuote.context.warehouse.id,
        cashRegisterId: staleQuote.context.cashRegister.id,
        currency: staleQuote.currency,
        taxRate: staleQuote.taxRate,
        paymentMethod: 'CASH',
        negativeStock: 'DENY',
        lines: staleQuote.lines.map((line) => ({
          productId: line.product.id,
          name: line.product.name,
          sku: line.product.sku,
          quantity: line.quantity,
          unitPrice: line.unitPrice,
          subtotal: line.subtotal,
          tax: line.tax,
          total: line.total,
        })),
        totals: staleQuote.totals,
      };
      const cashCommand = {
        protocolVersion: '1.0',
        commandId: randomUUID(),
        idempotencyKey: `offline-sale-${randomUUID()}`,
        scope,
        sequence: 4,
        createdAt: new Date().toISOString(),
        valuationMethod: 'MOVING_AVERAGE',
        valuationPolicyVersion: 1,
        kind: 'CASH_SALE',
        payload: {
          lines: [{ productId, quantity: '3' }],
          cashReceived: staleQuote.totals.total,
          snapshot: cashSnapshot,
        },
      };
      const offlineSale = await request(app.getHttpServer())
        .post('/api/v1/offline/commands/batch')
        .set('Cookie', cookie)
        .send({ commands: [cashCommand] })
        .expect(201);
      const offlineSaleReplay = await request(app.getHttpServer())
        .post('/api/v1/offline/commands/batch')
        .set('Cookie', cookie)
        .send({ commands: [cashCommand] })
        .expect(201);
      expect(offlineSale.body).toMatchObject({
        data: { results: [{ status: 'CONFIRMED', replay: false }] },
      });
      expect(offlineSaleReplay.body).toMatchObject({
        data: { results: [{ status: 'CONFIRMED', replay: true }] },
      });

      const secondDeviceCommand = {
        ...cashCommand,
        commandId: randomUUID(),
        idempotencyKey: `offline-sale-${randomUUID()}`,
        scope: { ...scope, deviceId: randomUUID() },
        sequence: 1,
      };
      await request(app.getHttpServer())
        .post('/api/v1/offline/commands/batch')
        .set('Cookie', cookie)
        .send({ commands: [secondDeviceCommand] })
        .expect(201)
        .expect(({ body }: { body: unknown }) =>
          expect(body).toMatchObject({
            data: {
              results: [
                {
                  status: 'ERROR',
                  error: {
                    status: 409,
                    details: { code: 'INSUFFICIENT_STOCK' },
                  },
                },
              ],
            },
          }),
        );
      await request(app.getHttpServer())
        .get(`/api/v1/inventory/products/${productId}/balance`)
        .set('Cookie', cookie)
        .query({ locationId })
        .expect(200)
        .expect(({ body }: { body: unknown }) =>
          expect(body).toMatchObject({ data: { quantity: '2.000' } }),
        );

      const priceQuoteResponse = await request(app.getHttpServer())
        .post('/api/v1/pos/cart/quote')
        .set('Cookie', cookie)
        .send({ lines: [{ productId, quantity: '1' }] })
        .expect(200);
      const priceQuote = (
        priceQuoteResponse.body as { data: typeof staleQuote }
      ).data;
      await request(app.getHttpServer())
        .patch(`/api/v1/products/${productId}`)
        .set('Cookie', cookie)
        .send({
          name: 'Producto comando offline',
          sku: 'OFFLINE-COMMAND-1',
          cost: '5.00',
          price: '10.00',
          version: 1,
        })
        .expect(200);
      const priceConflictCommand = {
        ...cashCommand,
        commandId: randomUUID(),
        idempotencyKey: `offline-sale-${randomUUID()}`,
        scope: { ...scope, deviceId: randomUUID() },
        sequence: 1,
        payload: {
          lines: [{ productId, quantity: '1' }],
          cashReceived: priceQuote.totals.total,
          snapshot: {
            ...cashSnapshot,
            capturedAt: new Date().toISOString(),
            lines: priceQuote.lines.map((line) => ({
              productId: line.product.id,
              name: line.product.name,
              sku: line.product.sku,
              quantity: line.quantity,
              unitPrice: line.unitPrice,
              subtotal: line.subtotal,
              tax: line.tax,
              total: line.total,
            })),
            totals: priceQuote.totals,
          },
        },
      };
      await request(app.getHttpServer())
        .post('/api/v1/offline/commands/batch')
        .set('Cookie', cookie)
        .send({ commands: [priceConflictCommand] })
        .expect(201)
        .expect(({ body }: { body: unknown }) =>
          expect(body).toMatchObject({
            data: {
              results: [
                {
                  status: 'ERROR',
                  error: {
                    status: 409,
                    details: { code: 'OFFLINE_SALE_SNAPSHOT_CONFLICT' },
                    conflict: { domain: 'SALE', strategy: 'REJECT' },
                  },
                },
              ],
            },
          }),
        );

      const countScopeA = { ...scope, deviceId: randomUUID() };
      const countScopeB = { ...scope, deviceId: randomUUID() };
      const countCommand = (
        countScope: typeof scope,
        countedQuantity: string,
        reference: string,
      ) => ({
        protocolVersion: '1.0',
        commandId: randomUUID(),
        idempotencyKey: `offline-count-${randomUUID()}`,
        scope: countScope,
        sequence: 1,
        createdAt: new Date().toISOString(),
        valuationMethod: 'MOVING_AVERAGE',
        valuationPolicyVersion: 1,
        kind: 'INVENTORY_COUNT',
        payload: {
          productId,
          locationId,
          snapshotQuantity: '2.000',
          countedQuantity,
          reason: 'Conteo capturado sin conexión',
          reference,
          capturedAt: new Date().toISOString(),
        },
      });
      const concurrentCounts = await Promise.all([
        request(app.getHttpServer())
          .post('/api/v1/offline/commands/batch')
          .set('Cookie', cookie)
          .send({
            commands: [countCommand(countScopeA, '4', 'COUNT-DEVICE-A')],
          })
          .expect(201),
        request(app.getHttpServer())
          .post('/api/v1/offline/commands/batch')
          .set('Cookie', cookie)
          .send({
            commands: [countCommand(countScopeB, '3', 'COUNT-DEVICE-B')],
          })
          .expect(201),
      ]);
      const countResults = concurrentCounts.map(
        (response) =>
          (
            response.body as {
              data: {
                results: Array<{
                  status: string;
                  error?: {
                    details?: { code?: string };
                    conflict?: {
                      domain?: string;
                      strategy?: string;
                      currentState?: { quantity?: string };
                    };
                  };
                }>;
              };
            }
          ).data.results[0],
      );
      expect(
        countResults.filter(({ status }) => status === 'CONFIRMED'),
      ).toHaveLength(1);
      const countErrors = countResults.filter(
        ({ status }) => status === 'ERROR',
      );
      expect(countErrors).toHaveLength(1);
      expect(countErrors[0].error?.details?.code).toBe(
        'INVENTORY_COUNT_CONFLICT',
      );
      expect(countErrors[0].error?.conflict?.domain).toBe('STOCK');
      expect(countErrors[0].error?.conflict?.strategy).toBe('REVIEW');
      expect(countErrors[0].error?.conflict?.currentState?.quantity).toMatch(
        /^[34]\.000$/,
      );

      const rejectedAdjustment = {
        ...firstCommand,
        commandId: randomUUID(),
        idempotencyKey: `offline-adjustment-${randomUUID()}`,
        scope: { ...scope, deviceId: randomUUID() },
        sequence: 1,
        payload: {
          productId,
          locationId,
          type: 'ADJUSTMENT',
          quantity: '-10',
          reason: 'Ajuste absoluto no autorizado',
          reference: 'COUNT-ABSOLUTE-DENIED',
        },
      };
      const rejected = await request(app.getHttpServer())
        .post('/api/v1/offline/commands/batch')
        .set('Cookie', cookie)
        .send({ commands: [rejectedAdjustment] })
        .expect(201);
      const rejectedReplay = await request(app.getHttpServer())
        .post('/api/v1/offline/commands/batch')
        .set('Cookie', cookie)
        .send({ commands: [rejectedAdjustment] })
        .expect(201);
      expect(rejected.body).toMatchObject({
        data: {
          results: [
            {
              status: 'ERROR',
              replay: false,
              error: {
                status: 400,
                details: { code: 'INVALID_OFFLINE_COMMAND_PAYLOAD' },
              },
            },
          ],
        },
      });
      expect(rejectedReplay.body).toMatchObject({
        data: { results: [{ status: 'ERROR', replay: true }] },
      });
      const [rejectionAudit] = await dataSource.query<
        Array<{ total: number | string }>
      >(
        `SELECT COUNT(*) AS total FROM audit_events
         WHERE action = 'OFFLINE_COMMAND_REJECTED' AND entity_id = ?`,
        [rejectedAdjustment.commandId],
      );
      expect(Number(rejectionAudit.total)).toBe(1);

      const staleDeviceId = randomUUID();
      const staleCommand = {
        ...firstCommand,
        commandId: randomUUID(),
        idempotencyKey: `offline-stale-${randomUUID()}`,
        scope: { ...scope, deviceId: staleDeviceId },
        sequence: 1,
        createdAt: new Date(Date.now() - 61 * 60_000).toISOString(),
        payload: {
          productId,
          locationId,
          type: 'ENTRY',
          quantity: '1',
          reason: 'Movimiento con permisos obsoletos',
          reference: 'STALE-OFFLINE-MOVEMENT',
        },
      };
      await request(app.getHttpServer())
        .post('/api/v1/offline/commands/batch')
        .set('Cookie', cookie)
        .send({ commands: [staleCommand] })
        .expect(201)
        .expect(({ body }: { body: unknown }) =>
          expect(body).toMatchObject({
            data: {
              results: [
                {
                  status: 'ERROR',
                  error: { details: { code: 'OFFLINE_COMMAND_STALE' } },
                },
              ],
            },
          }),
        );

      const revokedDeviceId = randomUUID();
      await request(app.getHttpServer())
        .get('/api/v1/offline/bootstrap')
        .set('Cookie', cookie)
        .query({ deviceId: revokedDeviceId, pageSize: 500 })
        .expect(200);
      await request(app.getHttpServer())
        .delete(`/api/v1/offline/devices/${revokedDeviceId}`)
        .set('Cookie', cookie)
        .expect(200);
      await request(app.getHttpServer())
        .get('/api/v1/offline/bootstrap')
        .set('Cookie', cookie)
        .query({ deviceId: revokedDeviceId, pageSize: 500 })
        .expect(403)
        .expect(({ body }: { body: unknown }) =>
          expect(body).toMatchObject({ code: 'OFFLINE_DEVICE_REVOKED' }),
        );

      const refreshedCookie = await createPersistedSession(payload.email);
      await request(app.getHttpServer())
        .get('/api/v1/offline/bootstrap')
        .set('Cookie', refreshedCookie)
        .query({ deviceId: revokedDeviceId, pageSize: 500 })
        .expect(200);
      const deviceHealth = await request(app.getHttpServer())
        .get('/api/v1/offline/devices')
        .set('Cookie', refreshedCookie)
        .expect(200);
      const deviceHealthBody = deviceHealth.body as {
        data: Array<{
          deviceId: string;
          user: { id: string; email: string };
          health: string;
          revokedAt: string | null;
          bootstrapRequiredAt: string | null;
          cursorFingerprint: string | null;
          correlationId: string | null;
          metrics: Record<string, number | string | null>;
        }>;
      };
      const reauthorized = deviceHealthBody.data.find(
        ({ deviceId }) => deviceId === revokedDeviceId,
      );
      expect(reauthorized).toBeDefined();
      expect(reauthorized?.user).toEqual({
        id: identity.user.id,
        email: payload.email,
      });
      expect(reauthorized?.health).toBe('HEALTHY');
      expect(reauthorized?.revokedAt).toBeNull();
      expect(reauthorized?.bootstrapRequiredAt).toBeNull();
      expect(reauthorized?.cursorFingerprint).toMatch(/^[a-f0-9]{12}$/);
      expect(typeof reauthorized?.correlationId).toBe('string');
      expect(reauthorized?.metrics).toEqual({
        pending: 0,
        errors: 0,
        conflicts: 0,
        retries: 0,
        oldestPendingAt: null,
      });
      expect(JSON.stringify(deviceHealthBody)).not.toMatch(
        /request_fingerprint|result_json|error_json|payload/i,
      );
      const isolatedPayload = {
        organizationName: 'Otro tenant offline',
        email: 'otro-offline@example.com',
        password: 'Otro-Offline-2026!',
      };
      await request(app.getHttpServer())
        .post('/api/v1/auth/registrations')
        .set('Idempotency-Key', 'other-offline-health-registration')
        .send(isolatedPayload)
        .expect(201);
      const isolatedDeviceId = randomUUID();
      const [isolatedIdentity] = await dataSource.query<
        Array<{ user_id: string; tenant_id: string }>
      >(
        'SELECT id AS user_id, tenant_id FROM users WHERE normalized_email = ?',
        [isolatedPayload.email],
      );
      await dataSource.query(
        `INSERT INTO offline_devices (tenant_id, user_id, device_id)
         VALUES (?, ?, ?)`,
        [
          isolatedIdentity.tenant_id,
          isolatedIdentity.user_id,
          isolatedDeviceId,
        ],
      );
      await request(app.getHttpServer())
        .get('/api/v1/offline/devices')
        .set('Cookie', refreshedCookie)
        .expect(200)
        .expect(({ body }: { body: { data: Array<{ deviceId: string }> } }) => {
          expect(
            body.data.some(({ deviceId }) => deviceId === isolatedDeviceId),
          ).toBe(false);
        });
      const [revocationAudit] = await dataSource.query<
        Array<{ total: string | number }>
      >(
        `SELECT COUNT(*) AS total FROM audit_events
         WHERE tenant_id = ? AND action = 'OFFLINE_DEVICE_REVOKED' AND entity_id = ?`,
        [identity.tenant.id, revokedDeviceId],
      );
      expect(Number(revocationAudit.total)).toBe(1);

      await dataSource.query(
        'DELETE FROM user_roles WHERE tenant_id = ? AND user_id = ?',
        [identity.tenant.id, identity.user.id],
      );
      await request(app.getHttpServer())
        .get('/api/v1/offline/devices')
        .set('Cookie', refreshedCookie)
        .expect(403);
      await request(app.getHttpServer())
        .post('/api/v1/offline/commands/batch')
        .set('Cookie', cookie)
        .send({
          commands: [
            {
              ...firstCommand,
              commandId: randomUUID(),
              idempotencyKey: `offline-revoked-user-${randomUUID()}`,
              scope: { ...scope, deviceId: randomUUID() },
              sequence: 1,
              payload: {
                productId,
                locationId,
                type: 'ENTRY',
                quantity: '1',
                reason: 'Permiso revocado al reconectar',
                reference: 'REVOKED-USER-MOVEMENT',
              },
            },
          ],
        })
        .expect(403);
    });
  });

  describe('inventory lot traceability', () => {
    beforeEach(resetIdentityData);

    it('tracks, selects, restores and reconciles lots without crossing tenants', async () => {
      await registerAccount('lot-tracking-registration');
      const cookie = await createPersistedSession(registrationPayload.email);
      await request(app.getHttpServer())
        .put('/api/v1/onboarding/company')
        .set('Cookie', cookie)
        .send({
          legalName: 'Lotes Legal',
          tradeName: 'Lotes',
          countryCode: 'MX',
        })
        .expect(200);
      await request(app.getHttpServer())
        .put('/api/v1/onboarding/initial-location')
        .set('Cookie', cookie)
        .send({
          branchName: 'Sucursal Lotes',
          timezone: 'America/Mexico_City',
          warehouseName: 'Bodega Lotes',
          locationName: 'General Lotes',
        })
        .expect(200);
      await request(app.getHttpServer())
        .put('/api/v1/onboarding/initial-cash-register')
        .set('Cookie', cookie)
        .send({ name: 'Caja Lotes' })
        .expect(200);
      const productResponse = await request(app.getHttpServer())
        .post('/api/v1/products')
        .set('Cookie', cookie)
        .send({
          name: 'Producto por lote',
          sku: 'LOT-001',
          cost: '6.00',
          price: '10.00',
          trackLots: true,
        })
        .expect(201);
      const productId = (productResponse.body as { data: { id: string } }).data
        .id;
      expect(productResponse.body).toMatchObject({
        data: { trackLots: true },
      });
      const [location] = await dataSource.query<Array<{ id: string }>>(
        `SELECT l.id FROM locations l
         INNER JOIN users u ON u.tenant_id = l.tenant_id
         WHERE u.normalized_email = ? LIMIT 1`,
        [registrationPayload.email],
      );

      await request(app.getHttpServer())
        .post('/api/v1/inventory/movements')
        .set('Cookie', cookie)
        .set('Idempotency-Key', 'lot-missing-code')
        .send({
          productId,
          locationId: location.id,
          type: 'INITIAL',
          quantity: '3',
          reason: 'Alta de lote',
        })
        .expect(400)
        .expect(({ body }: { body: { code?: string } }) =>
          expect(body.code).toBe('INVENTORY_LOT_REQUIRED'),
        );
      for (const [index, lot] of ['LOT-A', 'LOT-B'].entries()) {
        await request(app.getHttpServer())
          .post('/api/v1/inventory/movements')
          .set('Cookie', cookie)
          .set('Idempotency-Key', `lot-stock-${index}`)
          .send({
            productId,
            locationId: location.id,
            type: index === 0 ? 'INITIAL' : 'ENTRY',
            quantity: index === 0 ? '3' : '4',
            reason: 'Alta de lote',
            reference: index === 0 ? undefined : 'RECEPCION-LOT-B',
            lotCode: lot,
          })
          .expect(201);
      }
      const lotsBeforeSale = await request(app.getHttpServer())
        .get(`/api/v1/inventory/products/${productId}/lots`)
        .set('Cookie', cookie)
        .expect(200);
      const lots = (
        lotsBeforeSale.body as {
          data: Array<{
            id: string;
            code: string;
            quantity: string;
            unitCost: string;
            currency: string;
            inventoryValue: string;
          }>;
        }
      ).data;
      expect(lotsBeforeSale.body).toMatchObject({
        meta: {
          tracked: true,
          totalQuantity: '7.000',
          lotQuantity: '7.000',
          reconciled: true,
          currency: 'MXN',
          inventoryValue: '42.0000',
        },
      });
      expect(
        lots.map(({ code, quantity, unitCost, currency, inventoryValue }) => ({
          code,
          quantity,
          unitCost,
          currency,
          inventoryValue,
        })),
      ).toEqual([
        {
          code: 'LOT-A',
          quantity: '3.000',
          unitCost: '6.0000',
          currency: 'MXN',
          inventoryValue: '18.0000',
        },
        {
          code: 'LOT-B',
          quantity: '4.000',
          unitCost: '6.0000',
          currency: 'MXN',
          inventoryValue: '24.0000',
        },
      ]);
      const lotB = lots.find(({ code }) => code === 'LOT-B')!;

      await openCurrentCashRegister(cookie, 'lot-open-shift');
      await request(app.getHttpServer())
        .post('/api/v1/pos/cart/quote')
        .set('Cookie', cookie)
        .send({ lines: [{ productId, lotId: lotB.id, quantity: '5' }] })
        .expect(409);
      const saleResponse = await request(app.getHttpServer())
        .post('/api/v1/pos/sales')
        .set('Cookie', cookie)
        .set('Idempotency-Key', 'lot-manual-sale')
        .send({
          lines: [{ productId, lotId: lotB.id, quantity: '2' }],
          payment: { method: 'CASH', amountReceived: '20.00' },
        })
        .expect(201);
      const saleId = (saleResponse.body as { data: { id: string } }).data.id;
      await request(app.getHttpServer())
        .get(`/api/v1/inventory/products/${productId}/lots`)
        .set('Cookie', cookie)
        .expect(200)
        .expect(({ body }: { body: unknown }) =>
          expect(body).toMatchObject({
            data: [
              { code: 'LOT-A', quantity: '3.000' },
              { code: 'LOT-B', quantity: '2.000' },
            ],
            meta: { totalQuantity: '5.000', reconciled: true },
          }),
        );
      await request(app.getHttpServer())
        .post(`/api/v1/pos/sales/${saleId}/void`)
        .set('Cookie', cookie)
        .set('Idempotency-Key', 'lot-sale-void')
        .send({ reason: 'Prueba de restauración de lote' })
        .expect(201);
      await request(app.getHttpServer())
        .get('/api/v1/inventory/movements')
        .set('Cookie', cookie)
        .query({ productId, page: 1, pageSize: 20 })
        .expect(200)
        .expect(
          ({
            body,
          }: {
            body: { data: Array<{ type: string; lots: unknown[] }> };
          }) => {
            expect(body.data.find(({ type }) => type === 'SALE')?.lots).toEqual(
              [
                expect.objectContaining({
                  id: lotB.id,
                  code: 'LOT-B',
                  quantityChange: '-2.000',
                  unitCost: '6.0000',
                  currency: 'MXN',
                  valueChange: '-12.0000',
                  selectionMode: 'MANUAL',
                }),
              ],
            );
            expect(
              body.data.find(({ type }) => type === 'SALE_VOID')?.lots,
            ).toEqual([
              expect.objectContaining({
                id: lotB.id,
                quantityChange: '2.000',
                unitCost: '6.0000',
                currency: 'MXN',
                valueChange: '12.0000',
                selectionMode: 'RESTORE',
              }),
            ]);
          },
        );

      const partialLotSale = await request(app.getHttpServer())
        .post('/api/v1/pos/sales')
        .set('Cookie', cookie)
        .set('Idempotency-Key', 'lot-partial-return-sale')
        .send({
          lines: [{ productId, lotId: lotB.id, quantity: '2' }],
          payment: { method: 'CASH', amountReceived: '20.00' },
        })
        .expect(201);
      const partialLotSaleData = partialLotSale.body as {
        data: { id: string; lines: Array<{ id: string }> };
      };
      await request(app.getHttpServer())
        .post(`/api/v1/pos/sales/${partialLotSaleData.data.id}/returns`)
        .set('Cookie', cookie)
        .set('Idempotency-Key', 'lot-partial-return')
        .send({
          reason: 'Una unidad regresa en buen estado',
          lines: [
            {
              saleLineId: partialLotSaleData.data.lines[0].id,
              quantity: '1',
              condition: 'SELLABLE',
            },
          ],
        })
        .expect(201);
      await request(app.getHttpServer())
        .get(`/api/v1/inventory/products/${productId}/lots`)
        .set('Cookie', cookie)
        .expect(200)
        .expect(({ body }: { body: unknown }) =>
          expect(body).toMatchObject({
            data: [
              { code: 'LOT-A', quantity: '3.000' },
              { code: 'LOT-B', quantity: '3.000' },
            ],
            meta: { totalQuantity: '6.000', reconciled: true },
          }),
        );

      const isolated = {
        organizationName: 'Otro tenant lotes',
        email: 'otro-lotes@example.com',
        password: registrationPayload.password,
      };
      await request(app.getHttpServer())
        .post('/api/v1/auth/registrations')
        .set('Idempotency-Key', 'lot-isolated-registration')
        .send(isolated)
        .expect(201);
      const isolatedCookie = await createPersistedSession(isolated.email);
      await request(app.getHttpServer())
        .put('/api/v1/onboarding/company')
        .set('Cookie', isolatedCookie)
        .send({ legalName: 'Otro Lotes', tradeName: 'Otro', countryCode: 'MX' })
        .expect(200);
      await request(app.getHttpServer())
        .put('/api/v1/onboarding/initial-location')
        .set('Cookie', isolatedCookie)
        .send({
          branchName: 'Otra Sucursal',
          timezone: 'America/Mexico_City',
          warehouseName: 'Otra Bodega',
          locationName: 'Otra Ubicación',
        })
        .expect(200);
      await request(app.getHttpServer())
        .put('/api/v1/onboarding/initial-cash-register')
        .set('Cookie', isolatedCookie)
        .send({ name: 'Otra Caja' })
        .expect(200);
      await request(app.getHttpServer())
        .get(`/api/v1/inventory/products/${productId}/lots`)
        .set('Cookie', isolatedCookie)
        .expect(404);
    });
  });

  describe('inventory serial traceability', () => {
    beforeEach(resetIdentityData);

    it('keeps one serial atomic through entry, concurrent sale, void and tenant-scoped history', async () => {
      await request(app.getHttpServer())
        .post('/api/v1/auth/registrations')
        .set('Idempotency-Key', 'serial-registration')
        .send(registrationPayload)
        .expect(201);
      const cookie = await createPersistedSession(registrationPayload.email);
      await request(app.getHttpServer())
        .put('/api/v1/onboarding/company')
        .set('Cookie', cookie)
        .send({
          legalName: 'Series SA',
          tradeName: 'Series',
          countryCode: 'MX',
        })
        .expect(200);
      await request(app.getHttpServer())
        .put('/api/v1/onboarding/initial-location')
        .set('Cookie', cookie)
        .send({
          branchName: 'Principal',
          timezone: 'America/Mexico_City',
          warehouseName: 'Bodega Principal',
          locationName: 'General',
        })
        .expect(200);
      await request(app.getHttpServer())
        .put('/api/v1/onboarding/initial-cash-register')
        .set('Cookie', cookie)
        .send({ name: 'Caja Principal' })
        .expect(200);

      const productResponse = await request(app.getHttpServer())
        .post('/api/v1/products')
        .set('Cookie', cookie)
        .send({
          name: 'Terminal serializada',
          sku: 'SER-001',
          cost: '100.00',
          price: '150.00',
          trackSerials: true,
        })
        .expect(201);
      const productId = (productResponse.body as { data: { id: string } }).data
        .id;
      expect(productResponse.body).toMatchObject({
        data: { trackSerials: true },
      });
      const [location] = await dataSource.query<Array<{ id: string }>>(
        `SELECT l.id FROM locations l
         INNER JOIN users u ON u.tenant_id = l.tenant_id
         WHERE u.normalized_email = ? LIMIT 1`,
        [registrationPayload.email],
      );

      await request(app.getHttpServer())
        .post('/api/v1/inventory/movements')
        .set('Cookie', cookie)
        .set('Idempotency-Key', 'serial-initial-missing')
        .send({
          productId,
          locationId: location.id,
          type: 'INITIAL',
          quantity: '1',
          reason: 'Alta inicial',
        })
        .expect(400)
        .expect(({ body }: { body: { code: string } }) =>
          expect(body.code).toBe('INVENTORY_SERIALS_REQUIRED'),
        );
      await request(app.getHttpServer())
        .post('/api/v1/inventory/movements')
        .set('Cookie', cookie)
        .set('Idempotency-Key', 'serial-initial')
        .send({
          productId,
          locationId: location.id,
          type: 'INITIAL',
          quantity: '1',
          reason: 'Alta inicial',
          serialNumbers: ['SN-0001'],
        })
        .expect(201);
      const serialList = await request(app.getHttpServer())
        .get(`/api/v1/inventory/products/${productId}/serials`)
        .set('Cookie', cookie)
        .expect(200);
      const serialId = (
        serialList.body as { data: Array<{ id: string; serialNumber: string }> }
      ).data[0].id;
      expect(serialList.body).toMatchObject({
        data: [{ serialNumber: 'SN-0001', status: 'AVAILABLE' }],
        meta: { tracked: true },
      });

      const customerResponse = await request(app.getHttpServer())
        .post('/api/v1/customers')
        .set('Cookie', cookie)
        .send({ name: 'Cliente serial', dataProcessingConsent: false })
        .expect(201);
      const customerId = (customerResponse.body as { data: { id: string } })
        .data.id;
      const reservationResponse = await request(app.getHttpServer())
        .post('/api/v1/reservations')
        .set('Cookie', cookie)
        .set('Idempotency-Key', 'serial-reservation')
        .send({
          customerId,
          locationId: location.id,
          expiresInHours: 24,
          lines: [
            {
              productId,
              quantity: '1',
              serialNumbers: ['SN-0001'],
            },
          ],
        })
        .expect(201);
      const reservationId = (
        reservationResponse.body as { data: { id: string } }
      ).data.id;
      expect(reservationResponse.body).toMatchObject({
        data: {
          lines: [{ serialNumbers: ['SN-0001'] }],
        },
      });
      await request(app.getHttpServer())
        .post(`/api/v1/reservations/${reservationId}/release`)
        .set('Cookie', cookie)
        .set('Idempotency-Key', 'serial-reservation-release')
        .send({ reason: 'Liberar para venta concurrente' })
        .expect(201);

      await openCurrentCashRegister(cookie, 'serial-open-shift');
      const attempts = await Promise.all(
        ['serial-sale-a', 'serial-sale-b'].map((key) =>
          request(app.getHttpServer())
            .post('/api/v1/pos/sales')
            .set('Cookie', cookie)
            .set('Idempotency-Key', key)
            .send({
              lines: [
                {
                  productId,
                  quantity: '1',
                  serialNumbers: ['sn-0001'],
                },
              ],
              payment: { method: 'CASH', amountReceived: '150.00' },
            }),
        ),
      );
      expect(attempts.map(({ status }) => status).sort()).toEqual([201, 409]);
      const successfulSale = attempts.find(({ status }) => status === 201)!;
      const saleId = (successfulSale.body as { data: { id: string } }).data.id;

      await request(app.getHttpServer())
        .get(`/api/v1/inventory/serials/${serialId}/history`)
        .set('Cookie', cookie)
        .expect(200)
        .expect(
          ({ body }: { body: { data: { serial: { status: string } } } }) =>
            expect(body.data.serial.status).toBe('SOLD'),
        );
      await request(app.getHttpServer())
        .post(`/api/v1/pos/sales/${saleId}/void`)
        .set('Cookie', cookie)
        .set('Idempotency-Key', 'serial-sale-void')
        .send({ reason: 'DevoluciÃ³n de prueba' })
        .expect(201);
      await request(app.getHttpServer())
        .get(`/api/v1/inventory/serials/${serialId}/history`)
        .set('Cookie', cookie)
        .expect(200)
        .expect(
          ({
            body,
          }: {
            body: {
              data: {
                serial: { status: string };
                events: Array<{ toStatus: string; movement: { type: string } }>;
              };
            };
          }) => {
            expect(body.data.serial.status).toBe('AVAILABLE');
            expect(
              body.data.events.map(({ movement, toStatus }) => ({
                type: movement.type,
                toStatus,
              })),
            ).toEqual([
              { type: 'INITIAL', toStatus: 'AVAILABLE' },
              { type: 'STATE_TRANSITION', toStatus: 'RESERVED' },
              { type: 'STATE_TRANSITION', toStatus: 'AVAILABLE' },
              { type: 'SALE', toStatus: 'SOLD' },
              { type: 'SALE_VOID', toStatus: 'AVAILABLE' },
            ]);
          },
        );

      const returnableSerialSale = await request(app.getHttpServer())
        .post('/api/v1/pos/sales')
        .set('Cookie', cookie)
        .set('Idempotency-Key', 'serial-return-sale')
        .send({
          lines: [
            {
              productId,
              quantity: '1',
              serialNumbers: ['SN-0001'],
            },
          ],
          payment: { method: 'CASH', amountReceived: '150.00' },
        })
        .expect(201);
      const returnableSerialSaleData = returnableSerialSale.body as {
        data: { id: string; lines: Array<{ id: string }> };
      };
      await request(app.getHttpServer())
        .post(`/api/v1/pos/sales/${returnableSerialSaleData.data.id}/returns`)
        .set('Cookie', cookie)
        .set('Idempotency-Key', 'serial-return')
        .send({
          reason: 'Equipo devuelto con serie verificada',
          lines: [
            {
              saleLineId: returnableSerialSaleData.data.lines[0].id,
              quantity: '1',
              condition: 'SELLABLE',
              serialNumbers: ['sn-0001'],
            },
          ],
        })
        .expect(201);
      await request(app.getHttpServer())
        .get(`/api/v1/inventory/serials/${serialId}/history`)
        .set('Cookie', cookie)
        .expect(200)
        .expect(
          ({
            body,
          }: {
            body: {
              data: {
                serial: { status: string };
                events: Array<{ movement: { type: string }; toStatus: string }>;
              };
            };
          }) => {
            expect(body.data.serial.status).toBe('AVAILABLE');
            expect(
              body.data.events.slice(-2).map(({ movement, toStatus }) => ({
                type: movement.type,
                toStatus,
              })),
            ).toEqual([
              { type: 'SALE', toStatus: 'SOLD' },
              { type: 'SALE_RETURN', toStatus: 'AVAILABLE' },
            ]);
          },
        );

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
          name: 'Sucursal Series Destino',
          timezone: 'America/Mexico_City',
          warehouseName: 'Bodega Series Destino',
          locationName: 'RecepciÃ³n Series',
          locationCode: 'SERDEST',
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
      const transferResponse = await request(app.getHttpServer())
        .post('/api/v1/inventory/transfers')
        .set('Cookie', cookie)
        .set('Idempotency-Key', 'serial-transfer-create')
        .send({
          destinationWarehouseId: destination.warehouses[0].id,
          reference: 'SER-TR-001',
          reason: 'Validar custodia serial',
          lines: [
            {
              productId,
              sourceLocationId: origin.warehouses[0].locations[0].id,
              destinationLocationId: destination.warehouses[0].locations[0].id,
              quantity: '1',
              serialNumbers: ['SN-0001'],
            },
          ],
        })
        .expect(201);
      const transfer = transferResponse.body as {
        data: { id: string; lines: Array<{ id: string }> };
      };
      await request(app.getHttpServer())
        .post(`/api/v1/inventory/transfers/${transfer.data.id}/dispatch`)
        .set('Cookie', cookie)
        .set('Idempotency-Key', 'serial-transfer-dispatch')
        .expect(200);
      await request(app.getHttpServer())
        .patch('/api/v1/auth/sessions/current/context')
        .set('Cookie', cookie)
        .send({
          branchId: destination.id,
          warehouseId: destination.warehouses[0].id,
        })
        .expect(200);
      await request(app.getHttpServer())
        .post(`/api/v1/inventory/transfers/${transfer.data.id}/receipts`)
        .set('Cookie', cookie)
        .set('Idempotency-Key', 'serial-transfer-receipt')
        .send({
          lines: [
            {
              transferLineId: transfer.data.lines[0].id,
              receivedQuantity: '1',
              discrepancyQuantity: '0',
              receivedSerialNumbers: ['SN-0001'],
            },
          ],
        })
        .expect(200);
      await request(app.getHttpServer())
        .get(`/api/v1/inventory/serials/${serialId}/history`)
        .set('Cookie', cookie)
        .expect(200)
        .expect(
          ({
            body,
          }: {
            body: {
              data: {
                serial: { status: string; currentLocation: { id: string } };
                events: Array<{ movement: { type: string } }>;
              };
            };
          }) => {
            expect(body.data.serial).toMatchObject({
              status: 'AVAILABLE',
              currentLocation: {
                id: destination.warehouses[0].locations[0].id,
              },
            });
            expect(
              body.data.events.slice(-2).map(({ movement }) => movement.type),
            ).toEqual(['TRANSFER_OUT', 'TRANSFER_RECEIPT']);
          },
        );

      const other = {
        organizationName: 'Otro tenant series',
        email: 'other-serial@example.com',
        password: registrationPayload.password,
      };
      await request(app.getHttpServer())
        .post('/api/v1/auth/registrations')
        .set('Idempotency-Key', 'serial-other-registration')
        .send(other)
        .expect(201);
      const otherCookie = await createPersistedSession(other.email);
      await request(app.getHttpServer())
        .put('/api/v1/onboarding/company')
        .set('Cookie', otherCookie)
        .send({
          legalName: 'Otro Series',
          tradeName: 'Otro',
          countryCode: 'MX',
        })
        .expect(200);
      await request(app.getHttpServer())
        .put('/api/v1/onboarding/initial-location')
        .set('Cookie', otherCookie)
        .send({
          branchName: 'Otra Principal',
          timezone: 'America/Mexico_City',
          warehouseName: 'Otra Bodega',
          locationName: 'Otra General',
        })
        .expect(200);
      await request(app.getHttpServer())
        .put('/api/v1/onboarding/initial-cash-register')
        .set('Cookie', otherCookie)
        .send({ name: 'Otra Caja Series' })
        .expect(200);
      await request(app.getHttpServer())
        .get(`/api/v1/inventory/serials/${serialId}/history`)
        .set('Cookie', otherCookie)
        .expect(404);
    });
  });

  describe('inventory reconciliation', () => {
    beforeEach(resetIdentityData);

    it('is tenant-scoped, idempotent and blocks operations until a critical mismatch is resolved', async () => {
      await registerAccount('reconciliation-registration');
      const cookie = await createPersistedSession(registrationPayload.email);
      await request(app.getHttpServer())
        .put('/api/v1/onboarding/company')
        .set('Cookie', cookie)
        .send({
          legalName: 'Reconciliación SA',
          tradeName: 'Reconciliación',
          countryCode: 'MX',
        })
        .expect(200);
      await request(app.getHttpServer())
        .put('/api/v1/onboarding/initial-location')
        .set('Cookie', cookie)
        .send({
          branchName: 'Principal',
          timezone: 'America/Mexico_City',
          warehouseName: 'Bodega Principal',
          locationName: 'General',
        })
        .expect(200);
      await request(app.getHttpServer())
        .put('/api/v1/onboarding/initial-cash-register')
        .set('Cookie', cookie)
        .send({ name: 'Caja Principal' })
        .expect(200);
      const product = await request(app.getHttpServer())
        .post('/api/v1/products')
        .set('Cookie', cookie)
        .send({
          name: 'Producto conciliable',
          sku: 'REC-001',
          cost: '10',
          price: '15',
          trackLots: true,
          trackSerials: true,
        })
        .expect(201);
      const productId = (product.body as { data: { id: string } }).data.id;
      const [location] = await dataSource.query<Array<{ id: string }>>(
        `SELECT l.id FROM locations l
         INNER JOIN users u ON u.tenant_id = l.tenant_id
         WHERE u.normalized_email = ? LIMIT 1`,
        [registrationPayload.email],
      );
      await request(app.getHttpServer())
        .post('/api/v1/inventory/movements')
        .set('Cookie', cookie)
        .set('Idempotency-Key', 'reconciliation-initial')
        .send({
          productId,
          locationId: location.id,
          type: 'INITIAL',
          quantity: '2',
          reason: 'Saldo inicial conciliado',
          lotCode: 'LOT-REC',
          serialNumbers: ['REC-SN-001', 'REC-SN-002'],
        })
        .expect(201);

      const healthy = await request(app.getHttpServer())
        .post('/api/v1/inventory/reconciliations')
        .set('Cookie', cookie)
        .set('Idempotency-Key', 'reconciliation-healthy')
        .send({})
        .expect(201);
      expect(healthy.body).toMatchObject({
        data: {
          overallStatus: 'HEALTHY',
          summary: { findings: 0, warnings: 0, critical: 0 },
          policy: { releaseBlocked: false, operationsBlocked: false },
          findings: [],
        },
        meta: { idempotentReplay: false },
      });
      const healthyBody = healthy.body as { data: { id: string } };
      await request(app.getHttpServer())
        .post('/api/v1/inventory/reconciliations')
        .set('Cookie', cookie)
        .set('Idempotency-Key', 'reconciliation-healthy')
        .send({})
        .expect(201)
        .expect(
          ({
            body,
          }: {
            body: { data: { id: string }; meta: { idempotentReplay: boolean } };
          }) => {
            expect(body.data.id).toBe(healthyBody.data.id);
            expect(body.meta.idempotentReplay).toBe(true);
          },
        );

      await dataSource.query(
        `UPDATE inventory_balances
         SET quantity = quantity + 1, available_quantity = available_quantity + 1
         WHERE product_id = ? AND location_id = ?`,
        [productId, location.id],
      );
      const critical = await request(app.getHttpServer())
        .post('/api/v1/inventory/reconciliations')
        .set('Cookie', cookie)
        .set('Idempotency-Key', 'reconciliation-critical')
        .send({})
        .expect(201);
      expect(critical.body).toMatchObject({
        data: {
          overallStatus: 'CRITICAL',
          policy: { releaseBlocked: true, operationsBlocked: true },
        },
      });
      const criticalBody = critical.body as {
        data: { id: string; findings: Array<{ code: string }> };
      };
      expect(criticalBody.data.findings.map(({ code }) => code)).toEqual(
        expect.arrayContaining([
          'BALANCE_MOVEMENT_MISMATCH',
          'VALUATION_QUANTITY_MISMATCH',
          'LOT_BALANCE_MISMATCH',
          'SERIAL_STATE_MISMATCH',
        ]),
      );
      await request(app.getHttpServer())
        .post('/api/v1/inventory/movements')
        .set('Cookie', cookie)
        .set('Idempotency-Key', 'reconciliation-blocked-movement')
        .send({
          productId,
          locationId: location.id,
          type: 'ENTRY',
          quantity: '1',
          reason: 'Debe bloquearse',
          reference: 'REC-BLOCKED',
          lotCode: 'LOT-REC',
          serialNumbers: ['REC-SN-003'],
        })
        .expect(409)
        .expect(
          ({
            body,
          }: {
            body: { code: string; reconciliationRunId: string };
          }) => {
            expect(body.code).toBe('INVENTORY_RECONCILIATION_BLOCKED');
            expect(body.reconciliationRunId).toBe(criticalBody.data.id);
          },
        );

      const other = {
        organizationName: 'Otro tenant reconciliación',
        email: 'other-reconciliation@example.com',
        password: registrationPayload.password,
      };
      await request(app.getHttpServer())
        .post('/api/v1/auth/registrations')
        .set('Idempotency-Key', 'reconciliation-other-registration')
        .send(other)
        .expect(201);
      const otherCookie = await createPersistedSession(other.email);
      await request(app.getHttpServer())
        .put('/api/v1/onboarding/company')
        .set('Cookie', otherCookie)
        .send({
          legalName: 'Otro tenant',
          tradeName: 'Otro',
          countryCode: 'MX',
        })
        .expect(200);
      await request(app.getHttpServer())
        .put('/api/v1/onboarding/initial-location')
        .set('Cookie', otherCookie)
        .send({
          branchName: 'Otra principal',
          timezone: 'America/Mexico_City',
          warehouseName: 'Otra bodega',
          locationName: 'Otra general',
        })
        .expect(200);
      await request(app.getHttpServer())
        .put('/api/v1/onboarding/initial-cash-register')
        .set('Cookie', otherCookie)
        .send({ name: 'Otra caja' })
        .expect(200);
      await request(app.getHttpServer())
        .get('/api/v1/inventory/reconciliations/latest')
        .set('Cookie', otherCookie)
        .expect(200)
        .expect({ data: null, meta: { apiVersion: '1' } });

      await dataSource.query(
        `UPDATE inventory_balances
         SET quantity = quantity - 1, available_quantity = available_quantity - 1
         WHERE product_id = ? AND location_id = ?`,
        [productId, location.id],
      );
      await request(app.getHttpServer())
        .post('/api/v1/inventory/reconciliations')
        .set('Cookie', cookie)
        .set('Idempotency-Key', 'reconciliation-restored')
        .send({})
        .expect(201)
        .expect(({ body }: { body: { data: { overallStatus: string } } }) =>
          expect(body.data.overallStatus).toBe('HEALTHY'),
        );
      await request(app.getHttpServer())
        .post('/api/v1/inventory/movements')
        .set('Cookie', cookie)
        .set('Idempotency-Key', 'reconciliation-unblocked-movement')
        .send({
          productId,
          locationId: location.id,
          type: 'ENTRY',
          quantity: '1',
          reason: 'Operación desbloqueada',
          reference: 'REC-UNBLOCKED',
          lotCode: 'LOT-REC',
          serialNumbers: ['REC-SN-003'],
        })
        .expect(201);
    });
  });

  describe('customer order lifecycle', () => {
    beforeEach(resetIdentityData);

    it('reserves, prepares and delivers once while cancellation compensates stock and tenants stay isolated', async () => {
      await registerAccount('order-registration');
      const cookie = await createPersistedSession(registrationPayload.email);
      await request(app.getHttpServer())
        .put('/api/v1/onboarding/company')
        .set('Cookie', cookie)
        .send({
          legalName: 'Pedidos SA',
          tradeName: 'Pedidos',
          countryCode: 'MX',
        })
        .expect(200);
      await request(app.getHttpServer())
        .put('/api/v1/onboarding/initial-location')
        .set('Cookie', cookie)
        .send({
          branchName: 'Principal',
          timezone: 'America/Mexico_City',
          warehouseName: 'Bodega Principal',
          locationName: 'General',
        })
        .expect(200);
      await request(app.getHttpServer())
        .put('/api/v1/onboarding/initial-cash-register')
        .set('Cookie', cookie)
        .send({ name: 'Caja Principal' })
        .expect(200);
      const [location] = await dataSource.query<Array<{ id: string }>>(
        `SELECT l.id FROM locations l
         INNER JOIN users u ON u.tenant_id = l.tenant_id
         WHERE u.normalized_email = ? LIMIT 1`,
        [registrationPayload.email],
      );
      const product = await request(app.getHttpServer())
        .post('/api/v1/products')
        .set('Cookie', cookie)
        .send({
          name: 'Pedido preparado',
          sku: 'ORD-001',
          cost: '40',
          price: '100',
        })
        .expect(201);
      const productId = (product.body as { data: { id: string } }).data.id;
      await request(app.getHttpServer())
        .post('/api/v1/inventory/movements')
        .set('Cookie', cookie)
        .set('Idempotency-Key', 'order-stock')
        .send({
          productId,
          locationId: location.id,
          type: 'INITIAL',
          quantity: '5',
          reason: 'Stock para pedidos',
        })
        .expect(201);
      const customer = await request(app.getHttpServer())
        .post('/api/v1/customers')
        .set('Cookie', cookie)
        .send({ name: 'Cliente de pedidos', dataProcessingConsent: false })
        .expect(201);
      const customerId = (customer.body as { data: { id: string } }).data.id;
      await openCurrentCashRegister(cookie, 'order-open-shift', '200.00');

      const orderPayload = {
        channel: 'WEB',
        customerId,
        locationId: location.id,
        priority: 'HIGH',
        expiresInHours: 48,
        lines: [{ productId, quantity: '2' }],
        payments: [{ method: 'CASH', amountReceived: '500.00' }],
      };
      const created = await request(app.getHttpServer())
        .post('/api/v1/orders')
        .set('Cookie', cookie)
        .set('Idempotency-Key', 'order-create-main')
        .send(orderPayload)
        .expect(201);
      const createdData = created.body as {
        data: { id: string; version: number; totals: { total: string } };
      };
      expect(created.body).toMatchObject({
        data: {
          channel: 'WEB',
          priority: 'HIGH',
          status: 'DRAFT',
          customer: { id: customerId },
          lines: [{ product: { id: productId }, quantity: '2.000' }],
          payments: [{ method: 'CASH', status: 'PLANNED' }],
          reservation: null,
          sale: null,
        },
        meta: { idempotentReplay: false },
      });
      await request(app.getHttpServer())
        .post('/api/v1/orders')
        .set('Cookie', cookie)
        .set('Idempotency-Key', 'order-create-main')
        .send(orderPayload)
        .expect(201)
        .expect(
          ({
            body,
          }: {
            body: { data: { id: string }; meta: { idempotentReplay: boolean } };
          }) => {
            expect(body.data.id).toBe(createdData.data.id);
            expect(body.meta.idempotentReplay).toBe(true);
          },
        );

      const confirmed = await request(app.getHttpServer())
        .post(`/api/v1/orders/${createdData.data.id}/confirm`)
        .set('Cookie', cookie)
        .set('Idempotency-Key', 'order-confirm-main')
        .send({ version: createdData.data.version })
        .expect(201);
      const confirmedData = confirmed.body as {
        data: { version: number; reservation: { id: string; status: string } };
      };
      expect(confirmed.body).toMatchObject({
        data: { status: 'CONFIRMED', reservation: { status: 'ACTIVE' } },
      });
      await request(app.getHttpServer())
        .post(`/api/v1/orders/${createdData.data.id}/confirm`)
        .set('Cookie', cookie)
        .set('Idempotency-Key', 'order-confirm-main')
        .send({ version: createdData.data.version })
        .expect(201)
        .expect(({ body }: { body: { meta: { idempotentReplay: boolean } } }) =>
          expect(body.meta.idempotentReplay).toBe(true),
        );

      const prepareAttempts = await Promise.all(
        ['order-prepare-a', 'order-prepare-b'].map((key) =>
          request(app.getHttpServer())
            .post(`/api/v1/orders/${createdData.data.id}/prepare`)
            .set('Cookie', cookie)
            .set('Idempotency-Key', key)
            .send({ version: confirmedData.data.version }),
        ),
      );
      expect(prepareAttempts.map(({ status }) => status).sort()).toEqual([
        201, 409,
      ]);
      const prepared = prepareAttempts.find(({ status }) => status === 201)!
        .body as {
        data: { version: number };
      };
      const ready = await request(app.getHttpServer())
        .post(`/api/v1/orders/${createdData.data.id}/ready`)
        .set('Cookie', cookie)
        .set('Idempotency-Key', 'order-ready-main')
        .send({ version: prepared.data.version })
        .expect(201);
      const readyData = ready.body as { data: { version: number } };
      const delivered = await request(app.getHttpServer())
        .post(`/api/v1/orders/${createdData.data.id}/deliver`)
        .set('Cookie', cookie)
        .set('Idempotency-Key', 'order-deliver-main')
        .send({ version: readyData.data.version })
        .expect(201);
      expect(delivered.body).toMatchObject({
        data: {
          status: 'DELIVERED',
          reservation: { status: 'CONSUMED' },
          payments: [{ status: 'COMPLETED' }],
        },
      });
      expect(
        (delivered.body as { data: { sale: { receiptNumber: string } } }).data
          .sale.receiptNumber,
      ).toMatch(/^V-/);
      await request(app.getHttpServer())
        .post(`/api/v1/orders/${createdData.data.id}/deliver`)
        .set('Cookie', cookie)
        .set('Idempotency-Key', 'order-deliver-main')
        .send({ version: readyData.data.version })
        .expect(201)
        .expect(({ body }: { body: { meta: { idempotentReplay: boolean } } }) =>
          expect(body.meta.idempotentReplay).toBe(true),
        );

      const cancellable = await request(app.getHttpServer())
        .post('/api/v1/orders')
        .set('Cookie', cookie)
        .set('Idempotency-Key', 'order-create-cancel')
        .send({
          ...orderPayload,
          lines: [{ productId, quantity: '1' }],
          payments: [{ method: 'CASH', amountReceived: '500.00' }],
        })
        .expect(201);
      const cancellableData = cancellable.body as {
        data: { id: string; version: number };
      };
      const cancellableConfirmed = await request(app.getHttpServer())
        .post(`/api/v1/orders/${cancellableData.data.id}/confirm`)
        .set('Cookie', cookie)
        .set('Idempotency-Key', 'order-confirm-cancel')
        .send({ version: cancellableData.data.version })
        .expect(201);
      const cancellableState = (
        cancellableConfirmed.body as {
          data: { version: number; reservation: { id: string } };
        }
      ).data;
      await dataSource.query(
        `UPDATE product_reservations
         SET created_at = DATE_SUB(CURRENT_TIMESTAMP(6), INTERVAL 2 SECOND),
             expires_at = DATE_SUB(CURRENT_TIMESTAMP(6), INTERVAL 1 SECOND)
         WHERE id = ?`,
        [cancellableState.reservation.id],
      );
      await request(app.getHttpServer())
        .post(`/api/v1/orders/${cancellableData.data.id}/prepare`)
        .set('Cookie', cookie)
        .set('Idempotency-Key', 'order-prepare-expired')
        .send({ version: cancellableState.version })
        .expect(409)
        .expect(({ body }: { body: { code: string } }) =>
          expect(body.code).toBe('CUSTOMER_ORDER_RESERVATION_UNAVAILABLE'),
        );
      await request(app.getHttpServer())
        .post(`/api/v1/orders/${cancellableData.data.id}/cancel`)
        .set('Cookie', cookie)
        .set('Idempotency-Key', 'order-cancel-main')
        .send({
          version: cancellableState.version,
          reason: 'Cliente desistió del pedido',
        })
        .expect(201)
        .expect(
          ({
            body,
          }: {
            body: { data: { status: string; reservation: { status: string } } };
          }) => {
            expect(body.data.status).toBe('CANCELLED');
            expect(body.data.reservation.status).toBe('RELEASED');
          },
        );
      await request(app.getHttpServer())
        .post(`/api/v1/orders/${cancellableData.data.id}/cancel`)
        .set('Cookie', cookie)
        .set('Idempotency-Key', 'order-cancel-main')
        .send({
          version: cancellableState.version,
          reason: 'Cliente desistió del pedido',
        })
        .expect(201)
        .expect(({ body }: { body: { meta: { idempotentReplay: boolean } } }) =>
          expect(body.meta.idempotentReplay).toBe(true),
        );

      const [balance] = await dataSource.query<
        Array<{
          quantity: string;
          available_quantity: string;
          reserved_quantity: string;
        }>
      >(
        `SELECT quantity, available_quantity, reserved_quantity FROM inventory_balances
         WHERE product_id = ? AND location_id = ?`,
        [productId, location.id],
      );
      expect(balance).toMatchObject({
        quantity: '3.000',
        available_quantity: '3.000',
        reserved_quantity: '0.000',
      });
      const [counts] = await dataSource.query<
        Array<{ sales: number | string; transitions: number | string }>
      >(
        `SELECT
           (SELECT COUNT(*) FROM sales) AS sales,
           (SELECT COUNT(*) FROM customer_order_transitions) AS transitions`,
      );
      expect(Number(counts.sales)).toBe(1);
      expect(Number(counts.transitions)).toBe(6);
      const auditActions = await dataSource.query<Array<{ action: string }>>(
        `SELECT action FROM audit_events
         WHERE action LIKE 'CUSTOMER_ORDER_%' OR action IN (
           'PRODUCT_RESERVATION_CREATED', 'PRODUCT_RESERVATION_RELEASED',
           'PRODUCT_RESERVATION_CONSUMED', 'SALE_COMPLETED'
         )`,
      );
      expect(auditActions.map(({ action }) => action)).toEqual(
        expect.arrayContaining([
          'CUSTOMER_ORDER_CREATED',
          'CUSTOMER_ORDER_CONFIRMED',
          'CUSTOMER_ORDER_PREPARED',
          'CUSTOMER_ORDER_READY',
          'CUSTOMER_ORDER_DELIVERED',
          'CUSTOMER_ORDER_CANCELLED',
          'PRODUCT_RESERVATION_CREATED',
          'PRODUCT_RESERVATION_RELEASED',
          'PRODUCT_RESERVATION_CONSUMED',
          'SALE_COMPLETED',
        ]),
      );

      const other = {
        organizationName: 'Otro tenant pedidos',
        email: 'other-orders@example.com',
        password: registrationPayload.password,
      };
      await request(app.getHttpServer())
        .post('/api/v1/auth/registrations')
        .set('Idempotency-Key', 'order-other-registration')
        .send(other)
        .expect(201);
      const otherCookie = await createPersistedSession(other.email);
      await request(app.getHttpServer())
        .put('/api/v1/onboarding/company')
        .set('Cookie', otherCookie)
        .send({
          legalName: 'Otro Pedidos',
          tradeName: 'Otro',
          countryCode: 'MX',
        })
        .expect(200);
      await request(app.getHttpServer())
        .put('/api/v1/onboarding/initial-location')
        .set('Cookie', otherCookie)
        .send({
          branchName: 'Otra Principal',
          timezone: 'America/Mexico_City',
          warehouseName: 'Otra Bodega',
          locationName: 'Otra General',
        })
        .expect(200);
      await request(app.getHttpServer())
        .put('/api/v1/onboarding/initial-cash-register')
        .set('Cookie', otherCookie)
        .send({ name: 'Otra Caja' })
        .expect(200);
      await request(app.getHttpServer())
        .get(`/api/v1/orders/${createdData.data.id}`)
        .set('Cookie', otherCookie)
        .expect(404);
      await request(app.getHttpServer())
        .get('/api/v1/orders')
        .set('Cookie', otherCookie)
        .expect(200)
        .expect(({ body }: { body: { data: unknown[] } }) =>
          expect(body.data).toEqual([]),
        );
    });
  });

  afterAll(async () => {
    await app.close();
  });
});
