# Contrato de ambientes y secretos

La API valida su configuración antes de abrir el servidor. La Web carga configuración
pública en runtime desde `/config.json`; ningún rebuild debe ser necesario para cambiar
URLs o rotar credenciales del backend.

## Matriz de ambientes

| Rama/uso | `NODE_ENV` | `DEPLOY_ENV` | Proyecto GCP | Web `environment` |
| --- | --- | --- | --- | --- |
| Local | `development` | `local` | ninguno | `local` |
| `develop` / Dev | `production` | `dev` | `software-inventario-dev` | `dev` |
| `master` / Prod | `production` | `prod` | `software-inventario-prod` | `prod` |

En Dev y Prod, `CORS_ORIGINS` y `PASSWORD_RESET_PUBLIC_URL` son obligatorias;
recuperación sólo admite una URL HTTPS. La Web exige `apiBaseUrl` HTTP(S), sin
credenciales, query ni fragmento, y requiere HTTPS fuera de local.

## Variables API

| Variable | Secreta | Regla |
| --- | --- | --- |
| `NODE_ENV` | no | `production` en Cloud Run |
| `DEPLOY_ENV` | no | obligatoria como `dev` o `prod` en producción |
| `PORT` | no | la inyecta Cloud Run; local usa `3000` |
| `CORS_ORIGINS` | no | lista de orígenes sin paths/credenciales; sólo HTTPS en producción |
| `DATABASE_URL` | sí | URI MySQL obligatoria y distinta por ambiente |
| `DB_MIGRATIONS_RUN` | no | `false` en runtime; el despliegue ejecutará migración controlada |
| `SESSION_COOKIE_NAME` | no | identificador de cookie, no contiene material criptográfico |
| `SESSION_TTL_MINUTES` | no | entre 5 y 10080 minutos |
| `PASSWORD_RESET_TTL_MINUTES` | no | entre 5 y 1440 minutos |
| `PASSWORD_RESET_PUBLIC_URL` | no | HTTPS obligatoria en producción |
| `PASSWORD_RESET_DELIVERY` | no | `disabled` hasta conectar proveedor; `local` sólo local |
| `POS_TAX_RATES` | no | mapa público de país/tasa validado al arrancar |

`DB_PASSWORD` y `DB_ROOT_PASSWORD` pertenecen sólo al Docker Compose local. No deben
existir como variables del runtime de Cloud Run.

## Secret Manager

| Ambiente | Nombre esperado | Variable expuesta |
| --- | --- | --- |
| Dev | `uinventario-dev-database-url` | `DATABASE_URL` |
| Prod | `uinventario-prod-database-url` | `DATABASE_URL` |

UIN-27 es la acción externa para proporcionar ambas conexiones. El ticket debe apuntar
a esos nombres, nunca contener los valores. UIN-162 cubre el futuro proveedor de correo;
hasta entonces `PASSWORD_RESET_DELIVERY=disabled` mantiene el flujo preparado sin
simular entrega productiva.

Los contenedores pueden existir sin versiones para que el propietario cargue las URI
reales directamente en Secret Manager. El despliegue exige que `latest` exista y esté
habilitada; nunca se crea una versión vacía o aleatoria para superar el guard.

Para rotar la base, agregar una nueva versión del secret y desplegar una nueva revisión
que la referencie. El nombre de variable y el código no cambian. Dev y Prod nunca deben
compartir secret, conexión ni versión.

## Configuración pública Web

El pipeline sustituirá `config.json` al desplegar, usando este contrato:

```json
{
  "environment": "dev",
  "apiBaseUrl": "https://API_DEV_URL/api/v1"
}
```

`environment`, Project ID y rama deben coincidir antes del despliegue. `config.json` es
público: no puede contener tokens, connection strings, API keys ni otros secretos.
