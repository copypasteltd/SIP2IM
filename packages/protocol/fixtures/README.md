# Shared protocol fixtures

These are synthetic repository test inputs, not a wire schema or evidence of platform support.
Tests read the same source files from this directory; do not copy them into an adapter.

| Fixtures | Consumers and what they verify |
| --- | --- |
| [Device call rejection and generation](device/call-reject-generation.tsv) | TypeScript device parser and Android JVM command validator: seven cases for `call.reject` command ID and optional generation. Android projects the row into ID, type, and payload; it does not decode or validate the full device envelope in this test. A generation of `-` means omitted. |
| [v1 media](media-v1.tsv) | TypeScript and Android JVM codecs: three exact encode/decode vectors (8 kHz PCM and 16/48 kHz silence) and four malformed decode vectors. Wire bytes are the literal header followed by a repeated PCM sample; `-` marks fields unused for malformed rows. |
| [IPC messages](ipc/messages.json), [command boundaries](ipc/command-boundaries.json), and [ULID suffixes](ulid-boundaries.json) | TypeScript schema tests and the Telegram/QQ receive-side subset: `account.login`, `account.login.submit`, `account.logout`, `message.send`, `call.dial`, `call.hangup`, and `ack`. Base invalid envelopes use the wrong version; the boundary file independently varies payload fields. Adapter tests do not validate every IPC type or assert complete schema parity. |
| [IPC frame bytes](ipc/frames.json) | TypeScript IPC/media codecs, Telegram framing and receive path, and QQ receive path. The control sample uses compact UTF-8 JSON with multilingual text. Telegram's raw framer can handle kind 2 bytes, but both adapter clients reject kind 2 on ingress. The tests exercise in-memory IPC only, not an audio session. |

Run the scoped checks from the repository root using the existing local tools:

- `npm run -w packages/protocol test`
- `npm run -w adapters/qq check`
- `PYTHONPATH=adapters/telegram/src python -B -m unittest discover -s adapters/telegram/tests` (Bash; set the equivalent environment variable in other shells)
- `gradle --offline --configure-on-demand -p android :protocol:test --tests io.voipgw.protocol.SharedFixturesTest` with JDK 17 and an existing compatible Gradle/dependency cache. Only the two selected vectors are copied into the protocol module's test classpath.
