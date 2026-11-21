# Telegram adapter

Optional Telethon backend: install this package with the `telegram` extra and supply `TELEGRAM_API_ID` and `TELEGRAM_API_HASH` in the process environment. Without both credentials it remains fail-closed. The core IPC login flow uses phone, code and optional two-step password; QR login and voice are unsupported. The Telethon session is held in memory only, so process restart requires login again. No login values or session data are logged. Only incoming private text is forwarded; delivery during core disconnection is not queued. Outbound recipient IDs must be numeric Telegram user IDs already resolvable by Telethon. This implementation has only been tested with fakes, not an account or server. Configuration-file loading and automatic rejection of incoming calls remain unimplemented. Outbound text remains unavailable through Core, which rejects `message.send`. [Core adapter manager](../../core/src/channels/adapter-manager.ts#L71)

## Native offline tests

The IPC reader validates the shared ACK error vocabulary and timestamp range. Both `drain()` and receipt of the exact ACK on the same current writer must finish within ten seconds from the local write, measured with a monotonic clock. Late receipts do not settle the report; timeout leaves the outcome unknown and does not replay it. Cancelling startup retires its local send and drain. Malformed ACKs and invalid UTF-8 close the connection. A command with a valid envelope ID and an invalid timestamp receives `BAD_MESSAGE`.

Run from the repository root. The tests use memory streams and a fake Telegram client.

```bash
env -u TELEGRAM_API_ID -u TELEGRAM_API_HASH PYTHONPATH=adapters/telegram/src python -B -m unittest discover -s adapters/telegram/tests
```

## Dependency notes

Dependency declarations checked against PyPI metadata on 2026-11-20: Telethon 1.41.2 MIT, pyaes 1.6.1 MIT, rsa 4.9.1 Apache-2.0, pyasn1 0.6.1 BSD-2-Clause. Sources: https://pypi.org/pypi/Telethon/1.41.2/json, https://pypi.org/pypi/pyaes/1.6.1/json, https://pypi.org/pypi/rsa/4.9.1/json, https://pypi.org/pypi/pyasn1/0.6.1/json. These are declared metadata, not a full distribution/license audit; upstream Telethon license text fetch failed. Root third-party notices must also be updated before release.
