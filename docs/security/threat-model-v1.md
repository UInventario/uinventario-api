# Threat model v1

## Alcance y activos

El modelo cubre API, Web/proxy same-origin, MySQL, sincronización offline, Cloud
Build/Run, Artifact Registry y Secret Manager. Los activos prioritarios son sesiones y
credenciales, aislamiento de tenant, PII de usuarios/clientes/proveedores, importes y
pagos, stock/valorización, comandos offline pendientes, auditoría y secretos.

## Trust boundaries

1. Navegador/dispositivo no confiable → Web público → API pública autenticada.
2. API → MySQL externo mediante `DATABASE_URL` de Secret Manager.
3. GitHub → Cloud Build → Artifact Registry/Cloud Run mediante identidades separadas.
4. Dispositivo offline → almacenamiento local → sync, cursores y comandos idempotentes.
5. Import/export e integraciones → archivos o proveedores controlados por terceros.

El servidor deriva tenant, usuario, permisos, sucursal y caja desde la sesión; ningún
ID del cliente cambia ese alcance. Los runtimes API/Web/backup son cuentas distintas.
API runtime sólo accede al secreto de su ambiente; Cloud Build no lee su valor.

## Escenarios priorizados y controles

| Riesgo             | Abuso concreto                                              | Controles verificados                                                                                                                               |
| ------------------ | ----------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| Identidad          | credential stuffing, robo/fijación de cookie, enumeración   | Argon2, error uniforme, token opaco hasheado, rotación/revocación, cookie HttpOnly/Secure/SameSite, Origin exacto y throttling por identidad/sesión |
| Tenant/privilegios | usar IDs ajenos o elevar rol                                | principal server-side, claves foráneas compuestas, guards de permiso/contexto, matriz E2E de dos tenants y auditoría                                |
| Dinero/stock       | replay, carrera o edición de totales                        | transacciones, locks, importes decimales server-side, idempotencia, versiones optimistas, trazabilidad y reconciliación                             |
| Offline            | replay, cursor robado, dispositivo revocado, store mezclado | scope firmado por sesión/tenant/usuario/dispositivo, secuencia, idempotencia, TTL, revocación y bootstrap seguro                                    |
| PII/importación    | exportación sin permiso, fórmula/archivo hostil             | permisos explícitos, auditoría, límites/tipos, sanitización CSV y ausencia de secretos en bootstrap                                                 |
| Secretos           | exposición en Git/logs/imagen                               | Secret Manager, redacción, gitleaks de historial, logs estructurados sin cuerpos/tokens e imágenes sin `.env`                                       |
| Supply chain       | dependencia/action/image comprometida                       | lockfiles, `npm audit --audit-level=high`, Semgrep OSS, actions e imágenes fijadas por SHA/digest y tags inmutables                                 |
| Web                | XSS/clickjacking/path traversal/proxy abierto               | escape Angular, CSP, frame-ancestors/X-Frame-Options, raíz normalizada, upstream fijo y proxy same-origin                                           |

## Gates y verificación por ambiente

- GitHub ejecuta Semgrep SAST, dependency audit, gitleaks, contratos, tests y DAST
  focalizado. DAST comprueba headers, endpoint protegido, Origin hostil, JSON inválido,
  respuestas sin detalles internos y rate limit de login.
- Cloud Build repite el DAST contra cada revisión desplegada en Dev/Prod. HTTPS/HSTS,
  CSP, no-store, Permissions-Policy y health de base de datos son bloqueantes.
- Los secretos permanecen separados por Project ID. Prod y Dev usan sus propias
  cuentas runtime y el límite Cloud Run `min=0`, `max=3` acota abuso y costo.

## Hallazgos y riesgo residual aceptado

No quedan hallazgos críticos/altos conocidos. Se aceptan explícitamente estos riesgos
medios para v1:

- Throttling es por instancia; con tres instancias un atacante distribuido puede
  superar el límite individual. El tracker hashea email o cookie de sesión para no
  agrupar usuarios detrás del proxy Web. El máximo de instancias, errores uniformes
  y Argon2 reducen impacto; WAF/rate limit distribuido requiere evidencia de abuso.
- CSP Web conserva `style-src 'unsafe-inline'` porque Angular inyecta estilos de
  componentes. Scripts y objetos no permiten inline; retirar esta excepción requiere
  nonces en el runtime y no bloquea v1.
- API y Web son públicos en Cloud Run por necesidad del producto. Autorización vive
  en la aplicación; los endpoints de health sólo exponen estado agregado.
- El proveedor de correo productivo continúa deshabilitado hasta disponer de una
  integración externa; no se exponen tokens mediante el mailbox local en Dev/Prod.

Todo hallazgo futuro crítico/alto bloquea merge/release. Una excepción requiere Jira,
responsable, vencimiento y control compensatorio; no basta una aceptación verbal.
