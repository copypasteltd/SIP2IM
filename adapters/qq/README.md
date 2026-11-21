# QQ adapter

The executable currently advertises all platform capabilities as disabled. With its default handler, a valid command receives `CAPABILITY_UNSUPPORTED`. A native QQ platform backend for account sign-in, messages, calls, and audio is still missing.

The IPC reader validates the shared ACK error vocabulary and timestamp range. An outgoing report has ten seconds from local write, measured with a monotonic clock. Only an ACK processed before the deadline on the current socket with the exact pending reference settles the send. Timeout leaves the outcome unknown and does not replay the report. Malformed ACKs and invalid UTF-8 close the connection. A command with a valid envelope ID and an invalid timestamp receives `BAD_MESSAGE`.

From the repository root, run the native offline tests with Node 22. The tests use in-memory IPC and a fake backend.

```bash
node --check adapters/qq/src/main.mjs
node --test adapters/qq/test/client.test.mjs adapters/qq/test/shared-fixtures.test.mjs adapters/qq/test/ipc.test.ts
```
