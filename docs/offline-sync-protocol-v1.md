# Protocolo offline v1

El contrato canónico está en `src/offline-sync/offline-sync-v1.contract.ts`. La versión `1.x` admite cambios aditivos; quitar, renombrar o cambiar la semántica de un campo requiere una versión mayor.

## Alcance inmediato

El bootstrap autenticado identifica `tenant`, usuario y dispositivo, entrega permisos y sólo la estructura operativa autorizada: sucursales, bodegas, ubicaciones, cajas, clasificaciones, productos y disponibilidad. Las páginas son compactas, reanudables mediante cursores opacos y están limitadas a 500 entidades.

Cada entidad contiene un ID global, `tenantId`, `version` creciente y `updatedAt` UTC. Un cambio incremental conserva esos campos, suma `changeId`, operación y fecha, y avanza un cursor opaco. Los comandos futuros llevan ID, clave idempotente, alcance completo, secuencia causal y fecha del dispositivo.

## Límites de confianza

- El servidor deriva tenant, usuario, permisos y alcance desde la sesión; nunca confía en esos valores para autorizar una solicitud.
- Un cambio de sesión, tenant, usuario o dispositivo invalida cualquier almacén cuyo alcance no coincida exactamente.
- No se almacenan offline contraseñas, hashes, cookies, tokens de sesión/refresh/reset, claves API o privadas.
- El bootstrap no incluye costo, datos personales de clientes, cuerpos de auditoría, datos fiscales, credenciales de pago ni secretos de integraciones.
- Un cursor no es credencial ni concede acceso; toda reanudación vuelve a autenticar y autorizar el alcance.
- Ante versión incompatible, migración local fallida o duda de identidad, el cliente descarta el almacén incompatible y conserva el modo online seguro.

Los fixtures versionados prueban compatibilidad, aislamiento estructural, reanudación y ausencia de campos secretos antes de implementar persistencia o comandos offline.
