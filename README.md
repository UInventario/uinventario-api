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

La autenticación crea una sesión opaca en una cookie `HttpOnly`, `SameSite=Lax` y
`Secure` en producción. El servidor persiste únicamente el hash del token y deriva
el usuario, sus roles y el tenant de esa sesión.

- `GET /health/live`: proceso disponible.
- `GET /health/ready`: servicio y base de datos preparados.
- `POST /api/v1/auth/registrations`: crea atómicamente tenant, usuario y rol administrador; requiere `Idempotency-Key`.

- `POST /api/v1/auth/sessions`: valida credenciales e inicia la sesión.
- `GET /api/v1/auth/sessions/current`: devuelve la identidad de la sesión vigente.
- `POST /api/v1/auth/sessions/refresh`: rota el token opaco y renueva su expiración.
- `DELETE /api/v1/auth/sessions/current`: revoca la sesión actual y elimina la cookie.

Cada login crea una sesión independiente por dispositivo. Las pestañas de un mismo
navegador comparten la cookie; una rotación invalida el token anterior y logout no
revoca las sesiones de otros dispositivos.

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
