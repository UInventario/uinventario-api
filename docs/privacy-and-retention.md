# Privacidad, retención y anonimización

UInventario clasifica como PII el nombre, identificador, correo y teléfono del
cliente. Contraseñas, sesiones y tokens son secretos y nunca forman parte de una
exportación. Ventas, pagos, líneas y movimientos de inventario son documentos
transaccionales: una solicitud de cancelación anonimiza la identidad del cliente, pero
no elimina ni modifica esos registros.

La política `MX_CFF_ARTICLE_30` establece un mínimo de 1,825 días para documentos
transaccionales mexicanos. El mínimo se basa en el artículo 30 del
[Código Fiscal de la Federación](https://www.diputados.gob.mx/LeyesBiblio/pdf/CFF.pdf).
Para otros países se aplica `DEFAULT_CONSERVATIVE` de 365 días hasta incorporar una
política local verificada. Un administrador puede aumentar el plazo, nunca reducirlo
por debajo del mínimo vigente.

Los derechos de acceso, rectificación, cancelación y oposición siguen los artículos
21 a 25 de la
[Ley Federal de Protección de Datos Personales en Posesión de los Particulares](https://www.diputados.gob.mx/LeyesBiblio/pdf/LFPDPPP.pdf).
La corrección utiliza `PATCH /customers/:id`; el reporte y exportación usan
`GET /privacy/customers/:id/report` y `GET /privacy/customers/:id/export`. La
cancelación controlada usa `POST /privacy/customers/:id/anonymization` y requiere
`Idempotency-Key`. Un bloqueo legal activo produce una decisión `BLOCKED` trazable y
no altera la PII.

Todas las operaciones administrativas requieren `PRIVACY_MANAGE`, filtran por tenant
y generan auditoría sin copiar PII. Las solicitudes conservan sólo referencias,
decisiones y resultados no sensibles. Los backups incluyen las tablas de privacidad;
una restauración debe reproducir las anonimizaciones posteriores a su RPO antes de
servir tráfico. UInventario no tiene actualmente una integración externa que exporte
PII de clientes.
