# Backup y recuperación de base de datos

UIN-138 mantiene una copia lógica diaria de MySQL y demuestra semanalmente que la
copia más reciente puede restaurarse. Dev y Prod usan recursos independientes; ningún
job conoce el secret, bucket o Project ID del otro ambiente.

## Objetivos y alcance

| Ambiente | RPO objetivo | RTO objetivo | Retención | Restore drill              |
| -------- | ------------ | ------------ | --------- | -------------------------- |
| Dev      | 24 horas     | 4 horas      | 14 días   | semanal, domingo 05:00 UTC |
| Prod     | 24 horas     | 4 horas      | 35 días   | semanal, domingo 05:00 UTC |

El backup incluye esquema, datos, triggers, eventos y rutinas de la base configurada en
`DATABASE_URL`. Los binarios de aplicación se conservan en Artifact Registry, la
configuración reproducible está en Git y los secretos se versionan por separado en
Secret Manager. UInventario todavía no guarda archivos de usuario fuera de MySQL; si
eso cambia, el almacenamiento nuevo deberá añadirse explícitamente a este alcance.

## Seguridad y costo

- Buckets regionales separados: `software-inventario-ENV-uinventario-backups`.
- Uniform bucket-level access, public access prevention y cifrado administrado por GCS
  en reposo; la transferencia usa TLS.
- La cuenta `uinventario-backup-runtime` sólo puede leer el secret del ambiente y
  crear/leer objetos del bucket. No puede borrar backups.
- Retención mínima no bloqueada de 1 día en Dev y 7 días en Prod. Lifecycle elimina
  objetos a los 14/35 días. Se usa clase Standard para evitar cargos mínimos de
  almacenamiento frío sobre copias de vida corta.
- Cloud Run Jobs tiene cero instancias permanentes: sólo consume durante backup o drill.

## Aprovisionamiento y despliegue

Ejecutar una vez por ambiente con una identidad de infraestructura:

```bash
sh deploy/provision-database-backups.sh dev
sh deploy/provision-database-backups.sh prod
```

El pipeline construye `deploy/Dockerfile.backup` con tag inmutable y actualiza los jobs:

```bash
sh deploy/database-backup-jobs.sh dev REGION-docker.pkg.dev/PROJECT/uinventario/database-backup:GIT_SHA
```

Después del primer despliegue de los jobs, repetir `provision-database-backups.sh` para
crear o actualizar los schedules. El script es idempotente.

## Restore drill seguro

El drill descarga el backup completado más reciente y su metadata, verifica SHA-256,
crea una base temporal cuyo nombre debe cumplir
`uinventario_restore_drill_ENV_YYYYMMDDHHMMSS_*`, restaura y compara:

- tablas presentes;
- versión y cantidad de migraciones;
- conteos exactos de tablas críticas de tenant, usuarios, catálogo, stock, ventas,
  auditoría, políticas, bloqueos legales y solicitudes de privacidad.

Una restauración que pudiera volver a producción no debe atender tráfico hasta
reaplicar las solicitudes de privacidad y anonimizaciones confirmadas después del
instante del backup. El operador compara `privacy_requests` con la evidencia de
auditoría posterior al RPO, reproduce primero esos cambios en la base aislada y sólo
entonces autoriza el cambio de servicio. Los datos anonimizados no se reidentifican
manualmente: permanecen inaccesibles hasta que el ciclo de vida de 14/35 días elimine
las copias antiguas.

La base temporal se elimina en `finally`. El código rechaza cualquier nombre fuera del
prefijo o igual a la base fuente, por lo que nunca importa ni elimina Dev/Prod.

Ejecución manual y evidencia:

```bash
gcloud run jobs execute uinventario-database-backup --wait --region=us-central1 --project=PROJECT_ID
gcloud run jobs execute uinventario-database-restore-drill --wait --region=us-central1 --project=PROJECT_ID
gcloud run jobs logs read uinventario-database-restore-drill --region=us-central1 --project=PROJECT_ID
```

Un backup sólo es elegible para restore después de publicar su sidecar `.json`. Los
reintentos pueden dejar un objeto huérfano, pero nunca lo seleccionan ni sobrescriben
una copia confirmada. Los eventos estructurados `database_backup_completed` y
`database_restore_drill_completed` constituyen la evidencia operativa; cualquier
checksum, restore o comparación fallida termina el job con estado fallido.
