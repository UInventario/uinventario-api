# Adaptadores externos v1

UInventario selecciona adaptadores por `tenant`, capacidad, país, proveedor y versión. El contrato v1 incluye clave idempotente, correlación, timeout, reintentos y resultados normalizados (`SUCCEEDED`, `REJECTED`, `RETRYABLE_FAILURE` o `TIMED_OUT`). Las ejecuciones guardan únicamente metadatos operativos; no persisten destinatarios, cuerpos ni credenciales.

Las capacidades iniciales son `NOTIFICATION_EMAIL` y `NOTIFICATION_PUSH`. Ambas conservan `SIMULATOR` v1; correo también ofrece `RESEND` v1. Los diagnósticos permiten probar éxito, rechazo, timeout y recuperación tras reintento sin datos de negocio. Con `RESEND`, sólo `SUCCESS` realiza un envío al destinatario sandbox del secret.

Administración autenticada con `TENANT_MANAGE`:

- `GET /api/v1/integrations/adapters`: configuración y catálogo compatible.
- `PUT /api/v1/integrations/adapters/:capability`: selección por tenant.
- `POST /api/v1/integrations/adapters/:capability/diagnostics`: prueba idempotente con `Idempotency-Key`.
- `GET /api/v1/integrations/adapters/executions`: estados y errores sanitizados.
- `GET /api/v1/integrations/adapters/email-events`: estados de entrega, demora, rebote, supresión y queja sin destinatario ni contenido.
- `POST /api/v1/integrations/webhooks/resend`: webhook público verificado criptográficamente; no acepta eventos sin firma válida.

## Secretos

La API sólo acepta `secretReference`, el nombre no sensible de un secret externo. Nunca acepta ni devuelve el valor. Al incorporar un proveedor real, crear un secret distinto por ambiente en Secret Manager, conceder acceso sólo a la service account runtime y exponerlo como variable de entorno. La configuración de tenant conserva la referencia, no la credencial.

Para alta o rotación:

1. Crear una nueva versión del secret en el proyecto Dev o Prod correspondiente.
2. Desplegar una nueva revisión con esa versión y permisos mínimos.
3. Seleccionar proveedor/versión en la configuración del tenant.
4. Ejecutar diagnóstico y consultar la ejecución por `correlationId`.

El secret de cada ambiente se llama `uinventario-dev-resend-config` o `uinventario-prod-resend-config` y contiene un JSON con `apiKey`, `from`, `diagnosticRecipient` y `webhookSecret`. Cloud Run lo expone como `RESEND_CONFIG`; el nombre no sensible se expone por separado como `EMAIL_PROVIDER_SECRET_REFERENCE`. Si no existe una versión habilitada, el despliegue continúa sin correo real y recuperación queda desactivada de forma explícita.

Las plantillas locales v1 son `PASSWORD_RESET`, `SALE_RECEIPT` y `OPERATIONAL_NOTIFICATION`. Recuperación, comprobantes y notificaciones comparten el mismo puerto idempotente y sus reintentos; la cola persistente de notificaciones conserva su backoff. Resend acepta el mensaje en su propia cola y el webhook actualiza la observabilidad posterior (`DELIVERED`, `BOUNCED`, `FAILED`, etc.).

Ante fallos, revisar `errorCode`, intentos, duración y eventos de correo. No copiar payloads, destinatarios, detalles de bounce ni valores de secrets a logs, Jira o Git.
