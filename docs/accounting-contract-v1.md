# Accounting candidate contract v1

`/integrations/accounting/v1` creates balanced, auditable **candidate** journals from confirmed sales,
sale voids, sale returns and cash movements. Candidates are snapshots with account references,
currency, occurrence date, source reference, debits and credits. They are not presented as posted or
legally final accounting entries.

Source transactions are read-only. Export rejection or timeout cannot alter a sale, return, stock or
cash record. Every delivery uses an idempotency key; an `INDETERMINATE` delivery must be reconciled
before another delivery attempt. The simulator supports success, rejection and timeout without any
external credentials. A live ledger adapter must preserve contract v1, use tenant/environment secret
references and pass the same balance, compensation, retry and reconciliation tests.
