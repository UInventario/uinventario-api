# Política de compatibilidad y migraciones

## API y sync

- `/api/v1` sólo recibe cambios aditivos y conserva la semántica de campos ya
  publicados. Un cambio incompatible requiere `/api/v2`.
- El protocolo offline `1.x` acepta revisiones menores aditivas. La versión actual
  y mínima es `1.0`; bootstrap y changes aceptan que clientes antiguos omitan
  `protocolVersion` y aplican `1.0`.
- Mobile y Desktop con protocolo `1.x` se soportan durante al menos 180 días desde
  la disponibilidad general de una versión mayor sustituta. El retiro requiere
  aviso en release notes, telemetría de uso, fecha de sunset y ticket propio.
- Una versión incompatible nunca intenta migrar silenciosamente el almacén local:
  conserva operaciones pendientes exportables, descarta sólo el catálogo derivado
  y pasa a modo online seguro hasta completar un nuevo bootstrap.

## Expand/contract

1. **Expand:** añadir tablas, columnas anulables/defaults, índices o contratos
   aditivos. La revisión N-1 debe seguir funcionando con el esquema expandido.
2. **Migrate:** desplegar lectores compatibles, poblar datos de forma reintentable y
   medir que clientes anteriores dejaron de usar el contrato viejo.
3. **Contract:** eliminar o cambiar datos sólo en una release posterior, con ticket,
   backup verificado y ventana de compatibilidad cumplida.

`npm run migration:compatibility` rechaza operaciones destructivas dentro de `up()`
en migraciones cambiadas desde `v1.0.0` (la referencia puede cambiarse con
`COMPATIBILITY_BASE_REF`). CI crea el esquema de esa versión, lo actualiza a la rama
candidata y vuelve a ejecutar migraciones para probar N-1→N e idempotencia del
runner.

## Rollback

El rollback normal mueve API y Web a sus revisiones anteriores; no ejecuta
`migration:revert`. Como las migraciones de expansión conservan compatibilidad, la
revisión N-1 funciona sobre el esquema N. Un error de datos se corrige con migración
forward; corrupción o una operación contract no autorizada exige detener escrituras
y seguir el restore aislado del runbook productivo.
