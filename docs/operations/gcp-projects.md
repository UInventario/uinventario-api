# Mapeo de proyectos GCP

Verificado el 27 de agosto de 2026 con la cuenta interactiva activa de `gcloud`.
Los dos proyectos están `ACTIVE`, tienen facturación habilitada y la cuenta dispone
actualmente de `roles/owner`.

| Ambiente | Nombre visible | Project ID | Project number |
| --- | --- | --- | --- |
| Dev | Software Inventario Dev | `software-inventario-dev` | `624020863656` |
| Prod | Software Inventario Prod | `software-inventario-prod` | `356622377746` |

## Verificación de sólo lectura

Ejecutar cada operación con `--project` o con el Project ID como argumento. No se
debe confiar en el proyecto predeterminado de una estación de trabajo.

```bash
gcloud auth list --filter=status:ACTIVE --format="table(account,status)"
gcloud projects describe software-inventario-dev --format="yaml(name,projectId,projectNumber,lifecycleState)"
gcloud projects describe software-inventario-prod --format="yaml(name,projectId,projectNumber,lifecycleState)"
gcloud billing projects describe software-inventario-dev --format="value(billingEnabled)"
gcloud billing projects describe software-inventario-prod --format="value(billingEnabled)"
```

La cuenta interactiva tiene permisos más amplios de los que debe recibir CI/CD.
Las service accounts de Cloud Build y runtime deberán crearse posteriormente con
roles mínimos por ambiente. UIN-18 no aprovisiona recursos ni modifica IAM.

## Guarda de ambiente

- `develop` sólo puede usar `software-inventario-dev`.
- `master` sólo puede usar `software-inventario-prod`.
- Nunca derivar un Project ID desde el nombre visible.
- Los pipelines deben recibir el Project ID explícitamente y validar que coincide
  con la rama antes de construir, migrar o desplegar.
