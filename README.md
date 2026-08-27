# UInventario API

Backend NestJS de UInventario. Expone los contratos y reglas de negocio del producto; la persistencia se incorporará mediante migraciones en el incremento que la necesite.

## Desarrollo local

```bash
npm install
copy .env.example .env
npm run start:dev
```

El servicio escucha en `http://localhost:3000` por defecto.

- `GET /health/live`: proceso disponible.
- `GET /health/ready`: servicio preparado para aceptar tráfico. Las dependencias externas se añadirán a esta comprobación cuando existan.

Toda configuración se recibe mediante variables de entorno. `.env.example` contiene únicamente valores locales no sensibles.

## Gates

```bash
npm run lint
npm test
npm run test:e2e
npm run build
```

## Ramas

- `master`: última versión estable publicada.
- `develop`: integración preparada para el siguiente despliegue.
- `feature/*`: trabajo aislado por ticket Jira.
