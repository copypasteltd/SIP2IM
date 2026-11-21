# Android command namespace prototype — incomplete

The live Android implementation remains unchanged: SMS and other commands use separate databases, and the other-command ledger retains only 500 entries. Cross-type ID collisions can therefore cause repeated effects; global durable idempotency is not implemented. Do not deploy this as a verified command gateway.

The files under `prototypes/command-namespace/` are isolated, noncompiled sketches, not a migration or an operational feature. They assume schema changes not present in the live app. The backfill sketch retains sources, marks collisions and null legacy identity as ambiguous, and never activates execution; it is not crash-safe or verified. It does not establish a quiescent old ledger snapshot or immutable provenance.

A complete solution requires a trustworthy fresh-install identity, quiesced legacy writers, lossless source snapshots, checked transactional backfill and atomic destination marker, explicit conflict handling including existing queued tasks, and Android SQLite crash/restart tests. Previously evicted ledger IDs cannot be recovered. No SDK, device, network, Docker or WSL was used; no Android build or migration was verified.
