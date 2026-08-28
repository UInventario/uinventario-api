# Despliegue económico en Cloud Run

UIN-22 prepara dos imágenes independientes y el mismo procedimiento para Dev y
Prod. No aprovisiona Cloud SQL: la persistencia externa sigue gobernada por UIN-27.

## Mapeo fijo

| Ambiente | Project ID | Secret de base | Servicios |
| --- | --- | --- | --- |
| Dev | `software-inventario-dev` | `uinventario-dev-database-url` | `uinventario-api`, `uinventario-web`, job `uinventario-api-migrate` |
| Prod | `software-inventario-prod` | `uinventario-prod-database-url` | `uinventario-api`, `uinventario-web`, job `uinventario-api-migrate` |

La región predeterminada es `us-central1` y puede cambiarse explícitamente con
`CLOUD_RUN_REGION`. No se infieren Project IDs a partir del nombre visible.

## Requisitos externos

Antes del primer despliegue deben estar habilitadas las APIs `run.googleapis.com`,
`artifactregistry.googleapis.com` y `secretmanager.googleapis.com`. La cuenta de
CI necesita sólo permisos para cargar la imagen, actualizar Cloud Run, ejecutar el
job y actuar como las service accounts de runtime.

Cada proyecto debe tener estas identidades dedicadas:

- `uinventario-api-runtime@PROJECT_ID.iam.gserviceaccount.com`, con acceso sólo al
  secret `uinventario-ENV-database-url` correspondiente;
- `uinventario-web-runtime@PROJECT_ID.iam.gserviceaccount.com`, sin roles de acceso
  a datos de GCP.

UIN-19 controla permisos y conexión externa. UIN-27 controla las dos bases y sus
secrets. Los scripts terminan antes de crear una revisión si el secret requerido no
está disponible y nunca leen ni imprimen su valor.

## Construcción reproducible

Usar el SHA Git como tag inmutable. Desde cada repositorio:

```bash
docker build --tag REGION-docker.pkg.dev/PROJECT_ID/uinventario/api:GIT_SHA .
docker build --tag REGION-docker.pkg.dev/PROJECT_ID/uinventario/web:GIT_SHA .
docker push REGION-docker.pkg.dev/PROJECT_ID/uinventario/api:GIT_SHA
docker push REGION-docker.pkg.dev/PROJECT_ID/uinventario/web:GIT_SHA
```

Las imágenes usan Node 24, `npm ci`, usuario sin privilegios y puerto 8080. La API
incluye únicamente dependencias productivas. La Web sirve los artefactos Angular y
actúa como proxy same-origin para `/api`; así la cookie `HttpOnly` no depende de
cookies de terceros entre dos dominios `run.app`.

## Despliegue

La API recibe el origin HTTPS de Web y ejecuta primero un Cloud Run Job único de
migraciones. La aplicación siempre arranca con `DB_MIGRATIONS_RUN=false`, evitando
que varias instancias compitan por migrar durante el autoscaling.

```bash
cd uinventario-api
sh deploy/cloud-run.sh dev IMAGE_API HTTPS_WEB_ORIGIN

cd ../uinventario-web
sh deploy/cloud-run.sh dev IMAGE_WEB HTTPS_API_ORIGIN
```

Repetir con `prod` y las imágenes aprobadas para `master`. En el primer bootstrap,
si todavía no existe ninguna URL, se puede desplegar Web con
`https://placeholder.invalid`, obtener su URL, desplegar API con ese origin y volver
a desplegar Web con la URL real de API. El placeholder nunca da acceso a datos.

Cada script fija `min=0`, CPU throttling, máximo de tres instancias y recursos
pequeños: API `1 CPU / 512 MiB / concurrency 40`; Web `1 CPU / 256 MiB /
concurrency 80`. Los probes y smoke finales usan `/health/live`; API además exige
`/health/ready` con conexión real a MySQL.

## Rollback

Listar revisiones y devolver el tráfico a una imagen anterior no revierte datos:

```bash
gcloud run revisions list --service=SERVICE --region=REGION --project=PROJECT_ID
gcloud run services update-traffic SERVICE --to-revisions=REVISION=100 --region=REGION --project=PROJECT_ID
```

Las migraciones deben ser compatibles hacia atrás con la revisión anterior. Si una
migración futura no lo permite, requiere su propio plan de rollback antes de llegar
a `master`; nunca se ejecuta `migration:revert` automáticamente en Prod.
