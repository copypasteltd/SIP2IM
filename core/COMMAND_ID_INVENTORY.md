# Read-only command ID inventory

Build Core, then run from the repository root with the usual configuration file:

```sh
npm run build --workspace @voipgw/core
VOIPGW_CONFIG=/path/to/config.toml node core/dist/cli.js command-id:inventory --page-size 100 --max-rows 10000 > inventory.ndjson
```

Both options are optional. Page size is 1–1000 (default 100); max rows is a positive safe integer and defaults to unlimited. The database account needs SELECT on call_outbound_attempt, sms_dispatch_attempt and command_namespace_reservation. No dispatch or database mutation occurs. A dedicated client holds one REPEATABLE READ READ ONLY transaction across every page; long scans hold a database snapshot open.

Output is newline-delimited JSON: one metadata record containing limitations, one row record per result, then a status record with `complete`, `rows`, `reason`, and `continuation`. Every field of each source inventory row is retained. Output is streamed with backpressure, bounded to one page. A complete status is written only after COMMIT and connection cleanup. A max-row cutoff or any error has `complete:false` and a nonzero exit status. A missing final status (for example, a broken pipe or interrupted process) also means incomplete output. On a max-row cutoff, continuation is the last emitted command ID, including possibly the empty string; it is evidence of the boundary, not a resumable snapshot token. A new invocation takes a new snapshot and cannot guarantee a consistent continuation. Errors may prevent even the partial status from being written. The status `errors` array reports sanitized failure stages (including cleanup failures), without connection details.

Rows show current persisted evidence only. Both attempt identifiers indicate an observed cross-table duplicate; an attempt without a registry owner is an unregistered legacy candidate. Registry-only rows are retained. Equal IDs alone do not establish a harmful collision, ownership, safe activation, or historical completeness. Android in-memory and other allocator histories are unavailable; migration 0020 began empty and existing allocators do not necessarily consult it. IDs use case-sensitive C collation. The underlying function remains available for caller-managed snapshots; independent pages without a stable transaction may miss or repeat changes.
