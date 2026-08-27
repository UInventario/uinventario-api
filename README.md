# UInventario API

Backend NestJS de UInventario. Expone contratos, persistencia y reglas de negocio con aislamiento por tenant.

## Desarrollo local

```bash
npm install
copy .env.example .env
npm run db:up
npm run migration:run
npm run start:dev
```

El servicio escucha en `http://localhost:3000` por defecto.

- `GET /health/live`: proceso disponible.
- `GET /health/ready`: servicio y base de datos preparados.
- `POST /api/v1/auth/registrations`: crea atómicamente tenant, usuario y rol administrador; requiere `Idempotency-Key`.

MySQL 8.4 local corre en Docker con volumen persistente. Dev y Prod reciben una `DATABASE_URL` independiente mediante secretos; el repositorio no contiene credenciales productivas.

## Gates

```bash
npm run lint
npm test
npm run test:e2e
npm run build
```

## Ramas

- `master`: última versión estable publicada.
- `develop`: integración preparada para el siguiente despliegue.
- `feature/*`: trabajo aislado por ticket Jira.
