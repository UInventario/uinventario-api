# Adaptadores externos v1

UInventario selecciona adaptadores por `tenant`, capacidad, país, proveedor y versión. El contrato v1 incluye clave idempotente, correlación, timeout, reintentos y resultados normalizados (`SUCCEEDED`, `REJECTED`, `RETRYABLE_FAILURE` o `TIMED_OUT`). Las ejecuciones guardan únicamente metadatos operativos; no persisten destinatarios, cuerpos ni credenciales.

Las capacidades iniciales son `NOTIFICATION_EMAIL` y `NOTIFICATION_PUSH`. Ambas usan `SIMULATOR` v1 hasta que una Story de proveedor conecte una implementación real. Los diagnósticos permiten probar éxito, rechazo, timeout y recuperación tras reintento sin enviar datos externos.

Administración autenticada con `TENANT_MANAGE`:

- `GET /api/v1/integrations/adapters`: configuración y catálogo compatible.
- `PUT /api/v1/integrations/adapters/:capability`: selección por tenant.
- `POST /api/v1/integrations/adapters/:capability/diagnostics`: prueba idempotente con `Idempotency-Key`.
- `GET /api/v1/integrations/adapters/executions`: estados y errores sanitizados.

## Secretos

La API sólo acepta `secretReference`, el nombre no sensible de un secret externo. Nunca acepta ni devuelve el valor. Al incorporar un proveedor real, crear un secret distinto por ambiente en Secret Manager, conceder acceso sólo a la service account runtime y exponerlo como variable de entorno. La configuración de tenant conserva la referencia, no la credencial.

Para alta o rotación:

1. Crear una nueva versión del secret en el proyecto Dev o Prod correspondiente.
2. Desplegar una nueva revisión con esa versión y permisos mínimos.
3. Seleccionar proveedor/versión en la configuración del tenant.
4. Ejecutar diagnóstico y consultar la ejecución por `correlationId`.

Ante fallos, revisar `errorCode`, intentos y duración. No copiar payloads, destinatarios ni valores de secrets a logs, Jira o Git.
