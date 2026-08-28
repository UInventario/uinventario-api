# Observabilidad operativa

UIN-155 usa capacidades nativas de Cloud Run, Cloud Logging y Cloud Monitoring;
no despliega agentes, collectors ni instancias permanentes.

## Eventos y correlación

Cada error y una muestra determinista de respuestas exitosas generan un JSON de una
línea `request_completed`. Contiene `correlationId`, `traceId`, ruta normalizada,
operación, estado y duración. El tenant se representa como `tenantRef`, un SHA-256
recortado y separado por ambiente; nunca se registran tenant/user IDs, cuerpos,
cookies, tokens, queries ni mensajes del driver.

Las respuestas exitosas se muestrean al 20% en Dev y 5% en Prod. Los 4xx y 5xx se
conservan siempre. Un `x-cloud-trace-context` válido enlaza el evento con Cloud
Trace; sin él, `traceId` sigue siendo una referencia determinista de la solicitud.
El correlation ID no se convierte en etiqueta métrica: hacerlo produciría una serie
por petición y costo/cardinalidad innecesarios. Se consulta en el log fuente.

Operaciones agregadas: `authentication`, `inventory`, `pos`, `offline_sync`,
`integration` y `general`. Las métricas de colas críticas cubren fallos 5xx de sync
offline e integraciones; la idempotencia sigue gobernando cualquier reintento.

## Health y datos sensibles

- `/health/live` sólo comprueba que el proceso atiende solicitudes.
- `/health/ready` ejecuta `SELECT 1` y nombra únicamente la dependencia `database`
  como `up` o `down`. Nunca devuelve mensajes, host, usuario ni connection string.
- El Web expone `/health/live` sin consultar datos.

## SLO y alertas mínimos

`deploy/configure-observability.sh` crea por ambiente únicamente:

1. disponibilidad API por `/health/ready` y Web por `/health/live` (<99%/5 min);
2. errores 5xx sanitizados (más de 5/5 min en Dev, más de 1/5 min en Prod);
3. latencia p95 API (>2 s/5 min);
4. errores de `offline_sync` o `integration` (>0/5 min).

Las políticas abren incidentes en Cloud Monitoring aunque no exista un canal externo.
Agregar email, PagerDuty u otro canal requiere una decisión explícita del propietario;
no se inventan destinos ni credenciales. Los dashboards nativos de Cloud Run cubren
CPU, memoria, instancias y latencia sin duplicar métricas.

## Retención y operación

El bucket `_Default` conserva 7 días en Dev y 30 días en Prod. No se crean buckets,
sinks, BigQuery ni almacenamiento premium. Para aplicar o verificar:

```bash
sh deploy/configure-observability.sh dev
sh deploy/verify-observability.sh dev
sh deploy/configure-observability.sh prod
sh deploy/verify-observability.sh prod
```

Ante una alerta, buscar primero `correlationId`, `tenantRef`, `operation` y revisión.
No copiar PII o secretos a Jira. Una alerta de readiness apunta a MySQL; live fallando
apunta al proceso/revisión. Para rollback seguir el runbook productivo.
