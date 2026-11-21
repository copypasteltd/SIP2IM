# Device simulator

Run `node tools/device-simulator/cli.mjs --count 25 --server ws://host:47860 --bind-codes codes.txt`, with one binding code per line. The runner binds each device, sends hello, snapshot and periodic heartbeats, handles simulated SMS/call commands, reconnects and retains unacknowledged SMS and call events in memory. SIGINT reports per-device counts and acknowledgement latencies. Binding codes and tokens are not logged. Use only against an authorized test core.

The transport declares the Node 20-compatible `ws` dependency; install workspace dependencies before use. Event retention is in memory only. A format-2 media helper sends 1 kHz or zero-valued PCM, but call states are synthetic and do not claim an active connection. A media-open failure is not yet propagated as a protocol failure, so this is not yet a conforming call simulator. Automatic randomized SMS and inbound call generation, server heartbeat configuration, persistent outbox and percentile summaries are not implemented. Synthetic call success does not prove a media connection. Binding is sequential and subject to the core binding rate limit; large runs may fail without pacing.

Run `node --test tools/device-simulator/*.test.mjs` for fake-only tests. No server is required for tests.
