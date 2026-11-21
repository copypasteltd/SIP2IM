# Device rename concurrency

The web client uses `PATCH /api/devices/:id/name` with `{ "name": "New name", "expectedName": "Name last read" }`. A successful response is `{ "data": { "id": "device id", "name": "New name" } }`, reflecting the committed update rather than a later read. Both strings are required; the server compares the exact stored name under a row lock and atomically writes only if it matches. A stale value returns HTTP 409 with error code `CONFLICT`; a missing or revoked device returns 404. Unknown or invalid fields return 400. The web client retains the draft on conflict and fetches the current name for explicit reload.

The existing `PATCH /api/devices/:id` remains supported and unconditional, including legacy rename, enable and other operations. An older server does not recognize the dedicated path, so an updated web client cannot accidentally perform an unconditional rename against it. Deploy Core before the updated web client.

This is value-based compare-and-set, not a revision counter: an intervening name change that returns to the original value (ABA) is not detected. Legacy unconditional writers can overwrite any name; they participate in locking but do not provide lost-update protection for their own changes.
