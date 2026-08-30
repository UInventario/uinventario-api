# Commerce API v1

La API externa se publica bajo `/api/v1/external/v1`. Un administrador emite y revoca credenciales desde Web; la clave completa se muestra una sola vez y el servidor conserva sólo su SHA-256.

Envía `Authorization: Bearer <api-key>`. Cada credencial pertenece a una empresa, fija su sucursal, bodega, caja, ubicación de reserva y cliente operativo, y limita solicitudes por minuto.

## Endpoints y scopes

- `GET /catalog`: `CATALOG_READ`; agrega existencias sólo con `STOCK_READ`. Acepta `cursor` y `limit` (1–200). Nunca devuelve costo ni datos personales.
- `POST /orders`: `ORDERS_WRITE`. `externalOrderId` es la clave idempotente del canal; crea el pedido, valida precios y reserva stock.
- `GET /orders/:externalOrderId`: `ORDERS_READ`. Devuelve estados de pedido, fulfillment, reserva y pago.

Reutilizar `externalOrderId` con el mismo cuerpo devuelve el pedido existente; reutilizarlo con otro cuerpo responde `409`.

## Webhooks

Los eventos se deduplican por credencial, pedido, tipo y versión. La firma persistida tiene el formato `sha256=<hex>` y corresponde a HMAC-SHA256 del JSON exacto, usando como secreto el texto hexadecimal `SHA256(api-key)`.

El adaptador incluido es `SIMULATOR`: una URL cuyo host contiene `retry` falla el primer intento y después tiene éxito; `reject` produce un rechazo permanente. No realiza tráfico de red ni representa una conexión productiva. Un adaptador de proveedor puede sustituirlo conservando el contrato.
