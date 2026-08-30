# ERP exchange contract v1

`/integrations/erp/v1` is a tenant-admin, non-production simulator for ERP integration. It exposes
ordered incremental exports for `PRODUCT`, `SUPPLIER`, `CUSTOMER`, `PURCHASE_ORDER`,
`PURCHASE_RECEIPT` and `SALE`. Cursors are opaque and must be stored per tenant, provider and
resource. A consumer must not reuse a cursor across those boundaries.
The returned cursor is also the durable high-water mark when `hasMore` is false, so consumers retain
it for the next polling cycle instead of restarting the export.

Mapping imports link an external ERP identity to an existing UInventario identity. They never
create sales, receipts or other domain records directly, which prevents circular synchronization
and bypassing stock/money workflows. Each batch requires an `Idempotency-Key`; results preserve
input order and report `INTERNAL_RECORD_NOT_FOUND` or `MAPPING_CONFLICT` per record while valid
records commit. Repeating an identical batch or mapping is safe.

The simulator requires an authenticated UInventario administrator and stores no ERP credentials.
A future live adapter must use scoped API credentials, retain the v1 payloads and cursor semantics,
and pass the contract/idempotency suite before activation.
