# Presupuesto de rendimiento y concurrencia

Este presupuesto protege los recorridos críticos sin introducir infraestructura
permanente. Los tiempos son p95 del API, medidos con una base MySQL real y sin
contar el renderizado del cliente.

| Recorrido                   | Presupuesto p95 E2E |
| --------------------------- | ------------------: |
| Login                       |            3,000 ms |
| Búsqueda de productos       |            1,500 ms |
| Cotización POS              |            1,500 ms |
| Consulta de stock           |            1,500 ms |
| Bootstrap de sincronización |            2,500 ms |
| Reporte de ventas/caja      |            2,500 ms |

`test/performance.e2e-spec.ts` mide estos recorridos con dos empresas aisladas,
dos cajas y una base real. También fuerza dos ventas simultáneas contra una sola
unidad: exactamente una debe confirmarse, la otra debe recibir conflicto y el
saldo final debe ser cero.

Después de cada despliegue, `deploy/performance-smoke.mjs` envía 80 readiness
checks con concurrencia 40. Exige cero errores, p95 menor a 2.5 segundos y
recuperación en menos de 5 segundos. Esta sonda es deliberadamente de sólo
lectura: valida capacidad y dependencia de base de datos sin crear ventas ni
datos productivos.

## Límites operativos iniciales

- Cloud Run API: 1 CPU, 512 MiB, CPU sólo durante solicitudes.
- Concurrencia por instancia: 40.
- Instancias mínimas: 0; el servicio puede escalar a cero.
- Instancias máximas: 3; limita costo y presión sobre MySQL.
- Timeout de solicitud: 60 segundos.
- Alerta operativa: p95 del API mayor a 2 segundos durante cinco minutos.

`deploy/verify-cloud-run-scaling.py` detiene el despliegue si `min=0`, `max=3` o
`concurrency=40` dejan de cumplirse. Antes de aumentar `max`, se debe comprobar
la capacidad de conexiones de la base; el límite actual admite hasta 120
solicitudes simultáneas en ejecución. Un incumplimiento sostenido del presupuesto
requiere revisar primero consultas, índices y contención; no aumentar recursos
automáticamente.
