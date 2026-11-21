# QQ adapter

The executable currently advertises all platform capabilities as disabled. With its default handler, a valid command receives `CAPABILITY_UNSUPPORTED`. A native QQ platform backend for account sign-in, messages, calls, and audio is still missing.

The IPC reader checks the shared ACK error vocabulary and the timestamp range. It settles sends only by the exact pending reference on the current connection. Malformed ACKs and invalid UTF-8 close the connection. A command with a valid envelope ID and an invalid timestamp receives `BAD_MESSAGE`.

From the repository root, run the native offline tests with Node 22. The tests use in-memory IPC and a fake backend.

```bash
.toolchain/node/node.exe --check adapters/qq/src/main.mjs
.toolchain/node/node.exe --test adapters/qq/test/client.test.mjs adapters/qq/test/shared-fixtures.test.mjs adapters/qq/test/ipc.test.ts
```
