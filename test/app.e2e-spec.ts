import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import request from 'supertest';
import { App } from 'supertest/types';
import { AppModule } from './../src/app.module';
import { DataSource } from 'typeorm';

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
    beforeEach(async () => {
      await dataSource.query('SET FOREIGN_KEY_CHECKS = 0');
      for (const table of [
        'registration_requests',
        'user_roles',
        'users',
        'roles',
        'tenants',
      ]) {
        await dataSource.query(`TRUNCATE TABLE ${table}`);
      }
      await dataSource.query('SET FOREIGN_KEY_CHECKS = 1');
    });

    const payload = {
      organizationName: 'Tienda Central',
      email: 'admin@example.com',
      password: 'Correcta-2026!',
    };

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

  afterAll(async () => {
    await app.close();
  });
});
