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
- `POST /api/v1/auth/password-resets`: acepta solicitudes sin revelar si existe la cuenta.
- `POST /api/v1/auth/password-resets/complete`: consume un token temporal una sola vez, cambia la contraseña y revoca sesiones activas.
- `GET /api/v1/auth/password-resets/local-mailbox`: simulador disponible sólo fuera de producción cuando `PASSWORD_RESET_DELIVERY=local`.
- `GET /api/v1/onboarding/company`: recupera empresa y progreso del tenant autenticado.
- `PUT /api/v1/onboarding/company`: guarda nombre legal/comercial y país sin aceptar IDs de tenant del cliente.
- `GET/PUT /api/v1/onboarding/initial-location`: recupera o crea transaccionalmente la sucursal, bodega y ubicación iniciales.
- `GET/PUT /api/v1/onboarding/initial-cash-register`: crea la caja inicial y completa el onboarding sólo cuando existe todo el contexto operativo.
- `POST /api/v1/products`: crea un producto con importes decimales exactos e identificadores únicos por tenant.
- `GET /api/v1/products/options`: recupera categorías y marcas disponibles para el tenant autenticado.
- `GET /api/v1/products`: lista y busca productos con paginación tenant-scoped.
- `GET /api/v1/products/:id`: consulta el detalle sólo dentro del tenant autenticado.
- `PATCH /api/v1/products/:id`: actualiza datos comerciales con versión optimista y rechaza ediciones obsoletas.

- `GET /api/v1/inventory/locations`: lista ubicaciones de la bodega activa.
- `GET /api/v1/inventory/stock`: lista existencias reales por sucursal, bodega y producto.
- `GET /api/v1/inventory/products/:productId/balance?locationId=...`: consulta el saldo persistido.
- `POST /api/v1/inventory/movements`: registra stock inicial, entrada o ajuste con `Idempotency-Key`.
- `POST /api/v1/pos/cart/quote`: valida productos, stock y cantidades, y recalcula precios/impuesto/totales del carrito.
- `POST /api/v1/pos/sales/cash`: persiste venta, pago y descuento trazable de inventario en una sola transacción idempotente.
- `GET /api/v1/pos/sales`: lista ventas de la sucursal activa con filtros y paginación.
- `GET /api/v1/pos/sales/:id`: consulta líneas, pago, operador y movimientos de una venta autorizada.

Cada login crea una sesión independiente por dispositivo. Las pestañas de un mismo
navegador comparten la cookie; una rotación invalida el token anterior y logout no
revoca las sesiones de otros dispositivos.
La sesión expone permisos Core y el contexto activo de sucursal, bodega y caja; las claves foráneas
compuestas impiden relacionar recursos de tenants distintos.

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
