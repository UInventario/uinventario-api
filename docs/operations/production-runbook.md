# Runbook de release v1.0

Este runbook promueve `develop` a `master` sin cambiar el contrato de ambientes:
`develop` despliega Dev y `master` despliega Prod. La release abarca API y Web con
tags equivalentes; Mobile y Desktop mantienen sus ciclos independientes cuando
existan repositorios publicables.

## Identidad y puntos de servicio

| Ambiente | Project ID | API | Web |
| --- | --- | --- | --- |
| Dev | `software-inventario-dev` | `https://uinventario-api-6w7v33traa-uc.a.run.app` | `https://uinventario-web-6w7v33traa-uc.a.run.app` |
| Prod | `software-inventario-prod` | `https://uinventario-api-cfvk7uvacq-uc.a.run.app` | `https://uinventario-web-cfvk7uvacq-uc.a.run.app` |

Health de API: `/health/live` comprueba el proceso y `/health/ready` comprueba
también MySQL. Health de Web: `/health/live`; `/config.json` debe declarar el
ambiente y usar `/api/v1`, sin secretos.

Responsable de producto y decisión de rollback: propietario del proyecto Jira
UInventario. Responsable técnico durante la release: persona que ejecuta y enlaza
los PR de release. Escalación de infraestructura: propietario de los proyectos GCP.
No se incluyen nombres personales para evitar que el runbook quede obsoleto.

## Checklist previo

- [ ] Jira de la capacidad y sus P0/P1 están cerrados; no hay una feature parcial.
- [ ] API y Web están limpios, sincronizados con `origin/develop` y sus versiones
  declaran el mismo tag.
- [ ] CI y security checks del candidato están verdes.
- [ ] Gate API: formato, lint, tipos, unitarias, build, migraciones y E2E.
- [ ] Gate Web: formato, lint, tipos, unitarias, servidor, build y E2E crítico.
- [ ] Dev ejecuta las imágenes del SHA candidato y pasa
  `sh deploy/release-smoke.sh dev`.
- [ ] La versión `latest` de `uinventario-prod-database-url` está `ENABLED`; nunca
  se lee ni imprime su valor.
- [ ] El último backup de Prod y el último restore drill controlado están exitosos
  según `docs/operations/database-recovery.md`.
- [ ] Las migraciones del candidato son aditivas o compatibles hacia atrás con la
  revisión estable anterior. Una migración destructiva requiere ticket y plan propio.
- [ ] Se anotan las revisiones estables de API y Web antes de promover.

## Promoción y smoke

1. Crear PR `develop` → `master` en API y Web y revisar cada diff una vez.
2. Fusionar API y esperar que Cloud Build termine migración, deploy y health de Prod.
3. Fusionar Web y esperar su deploy. El pipeline Web conserva proxy same-origin.
4. Ejecutar `sh deploy/release-smoke.sh prod`.
5. Crear tags anotados `v1.0.0` en los commits merge de `master`, hacer push y crear
   las GitHub Releases con Jira, gates, migraciones y rollback.

Los triggers rechazan `develop` en Prod y `master` en Dev. El job de migración tiene
una tarea, sin reintentos automáticos, y debe terminar antes de publicar la API.

## Rollback coordinado

Antes de la release, listar y guardar las revisiones que reciben 100% de tráfico:

```bash
gcloud run services describe uinventario-api --project=software-inventario-prod --region=us-central1 --format='value(status.traffic[0].revisionName)'
gcloud run services describe uinventario-web --project=software-inventario-prod --region=us-central1 --format='value(status.traffic[0].revisionName)'
```

Si el smoke falla, revertir ambos servicios a esas revisiones y validar health:

```bash
sh deploy/rollback-release.sh prod API_REVISION WEB_REVISION
```

El script valida que cada revisión pertenezca al servicio y proyecto correctos,
cambia tráfico, ejecuta smoke y restaura automáticamente el estado original si algo
falla. Para ensayar sin dejar Dev revertido:

```bash
sh deploy/rollback-release.sh dev API_REVISION_ANTERIOR WEB_REVISION_ANTERIOR --rehearse
```

El rollback de aplicación recupera también la configuración fijada en las revisiones,
pero no revierte datos. Las migraciones productivas no se revierten automáticamente:
la revisión anterior debe funcionar contra el esquema expandido. Ante corrupción o
una migración incompatible, detener escrituras, seguir el restore aislado documentado
y abrir incidente antes de modificar Prod.

## Verificación y alertas

Cloud Build y Cloud Run son la fuente inmediata para fallos de gates, migración,
deploy y probes. Revisar los builds del trigger y los eventos estructurados de
`uinventario-api`, `uinventario-web` y `uinventario-api-migrate` con el Project ID
explícito. UIN-155 mantiene alertas de disponibilidad, errores, latencia y colas
críticas; consultar `docs/operations/observability.md` para correlación, retención y
umbrales. Un fallo del pipeline o smoke sigue siendo condición de rollback aunque
todavía no haya abierto un incidente de Monitoring.

Tras un rollback, conservar las revisiones, SHA, build IDs y resultado de smoke en el
ticket. Corregir mediante `hotfix/*` desde `master`; nunca alterar el tag publicado.
