# Audio probe primitives

`probe.mjs` generates 16 kHz PCM16 tone frames, decodes format-2 media frames and records WAV and level/sequence statistics. `live.mjs` supplies an injectable call-request and browser-leg authentication workflow. Its transport and clock are injected; the tests do not open a network connection.

An injectable localhost HTTP/WebSocket transport initiates the call and streams a tone every 20 ms; a caller must supply a Node-compatible WebSocket implementation. This is not yet a runnable G0 probe: CLI, inbound answering, prerecorded WAV input, live latency measurement and G0 evidence generation are unavailable. The documented internal probe response shape is not specified; the helper assumes the normal `browserLeg` response shape and requires integration verification. Capture timestamps alone do not establish synchronized clocks.

Run `node --test tools/audio-probe/*.test.mjs` from the repository root.
