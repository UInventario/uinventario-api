# CI/CD con Cloud Build

Los límites de costo, retención y alertas están documentados en [cost-guardrails.md](./cost-guardrails.md).

UIN-24 usa una conexión GitHub regional de segunda generación y cuatro triggers:

| Proyecto | Rama | Trigger API | Trigger Web |
| --- | --- | --- | --- |
| `software-inventario-dev` | `develop` | `uinventario-api-develop` | `uinventario-web-develop` |
| `software-inventario-prod` | `master` | `uinventario-api-master` | `uinventario-web-master` |

Cada repositorio contiene su propio `cloudbuild.yaml`. El pipeline valida primero
la combinación rama/ambiente/Project ID, ejecuta sus gates, construye una imagen
inmutable con el commit SHA, la publica en Artifact Registry y sólo entonces
actualiza Cloud Run. Una rama o proyecto incorrecto detiene el build antes de
crear una imagen o revisión.

## Aprovisionamiento reproducible

Desde `uinventario-api`:

```bash
sh deploy/configure-cloud-build.sh dev
sh deploy/configure-cloud-build.sh prod
```

El script habilita únicamente las APIs necesarias, crea el repositorio Docker y
las identidades dedicadas, aplica permisos de build/runtime y registra repositorios
y triggers cuando la conexión `uinventario-github` está completa. No crea bases de
datos ni lee valores de Secret Manager.

La primera conexión requiere OAuth e instalar la aplicación oficial Cloud Build
en la organización GitHub. GCP devuelve una `installationState.actionUri`; se abre
esa URL, se autoriza sólo la organización/repositorios necesarios y se vuelve a
ejecutar el script. Durante ese alta, el agente administrado de Cloud Build recibe
temporalmente `roles/secretmanager.admin`; el script lo revoca tan pronto la
conexión llega a `COMPLETE`.

## Identidades mínimas

- `uinventario-cloud-build`: escritura en el repositorio Artifact Registry,
  administración de los servicios/jobs Cloud Run, logs y `actAs` únicamente sobre
  las dos cuentas runtime. Si existe el bucket temporal `PROJECT_ID_cloudbuild`,
  recibe lectura de objetos sólo sobre ese bucket para builds manuales.
- `uinventario-api-runtime`: acceso sólo a los secrets de base de datos y del
  proveedor de correo del ambiente, aplicado automáticamente cuando existe cada
  contenedor. Cloud Build sólo puede consultar sus metadatos para decidir si debe
  activar la integración; no puede leer los valores.
- `uinventario-web-runtime`: sin acceso a secretos ni datos GCP.

Dev y Prod usan cuentas, imágenes, conexión, Project ID y secrets separados.

## Orden y dependencia de base

Web puede desplegar primero con `https://placeholder.invalid`; su health queda
disponible, pero el proxy no sirve operaciones hasta que exista API. API se detiene
antes de migrar o desplegar si falta una versión `latest` habilitada del secret de
UIN-27. Crear sólo el contenedor no habilita un despliegue con datos ficticios.
Cuando API queda lista, su pipeline actualiza `API_UPSTREAM` de Web y verifica ambos
health checks.

## Verificación

```bash
gcloud builds triggers list --project=software-inventario-dev --region=us-central1
gcloud builds triggers list --project=software-inventario-prod --region=us-central1
gcloud run services describe uinventario-web --project=software-inventario-dev --region=us-central1
gcloud run services describe uinventario-api --project=software-inventario-dev --region=us-central1
```

Para probar un trigger sin un push, ejecutar `gcloud builds triggers run` indicando
la rama esperada. Un fallo en gates impide los pasos de imagen y deploy por el orden
estricto del pipeline.

## Rollback

Listar revisiones y enviar todo el tráfico a una revisión anterior:

```bash
gcloud run revisions list --service=uinventario-api --region=us-central1 --project=PROJECT_ID
gcloud run services update-traffic uinventario-api --to-revisions=REVISION=100 --region=us-central1 --project=PROJECT_ID
```

Repetir para `uinventario-web` cuando corresponda. Un rollback de aplicación no
revierte migraciones; éstas deben seguir siendo compatibles hacia atrás.
