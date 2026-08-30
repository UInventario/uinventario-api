# Carrier contract v1

`/shipping/v1` exposes rate quotation, shipment creation, printable labels, cancellation and tracking
for delivery orders. `SIMULATOR` version `1` is the only enabled provider and requires no external
credentials. A live adapter must keep the same contract and use a Secret Manager reference.

Recipient and address data remain masked in order responses and audit records. The repository reads
the unmasked delivery payload only while invoking the configured carrier; simulator results, labels
and tracking events do not persist that source address.

Shipment and cancellation failures never delete or complete the order. They set a retry/manual-action
signal so the operator can retry or continue the dispatch outside the adapter. Polling and webhook
events use provider event IDs plus monotonic sequences: duplicates replay safely and older events are
stored without regressing the current tracking state. Tracking delivery does not charge or decrement
stock; the operator must still complete the existing order-delivery transaction.

The simulator event endpoint requires an authenticated operator. A live provider endpoint must verify
its webhook signature before mapping the event into this contract.
