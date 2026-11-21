# Partial Core/Web deployment preparation

This is a review draft for an isolated acceptance environment, not a telephony release. Do not connect real devices, SIMs, QQ/Telegram accounts, or production data. A loopback-only staging run on local-server was performed on 2026-11-20 and stopped afterward. This was not a production deployment or telephony acceptance. Core startup applies migrations and runs reconciliation, which changes database state. Use a dedicated empty PostgreSQL database; protect and back it up before any future reuse.

## Reproducible staging package

Use Node 22 and npm with access to the npm registry. The package is scoped to Core, Web and protocol, not a complete telephony release. The repository has three independent npm v3 lockfiles and no root lock. From the repository root, build with the per-package locks:

```sh
node tools/staging/build.mjs release/voip-core-web.tgz
```

The builder copies selected source extensions and named build inputs to a temporary directory, installs from each lock and builds there, fails on errors, and refuses to overwrite the output. Existing workspace outputs are preserved. Build subprocesses receive a minimal environment and a temporary home and npm cache; user npm settings, custom registries and proxy variables are not inherited, so the default npm registry must be reachable. This is not an OS sandbox: dependency and build scripts execute with the operator’s permissions. Build only from a trusted, quiescent source tree: a secret placed in an allowed source file may be copied or embedded into generated output, and path checks are not atomic against concurrent changes. It creates a deterministic archive for identical build bytes with an explicit file list; No node_modules or named excluded configuration files are intentionally packaged; selected source or generated files can still contain embedded secrets. Review archive contents before transfer. The archive contains executable application code and is not a substitute for a trusted build environment. Web's lock is used for the build and Web output is static; only Core and protocol manifests and locks are included for runtime installation.

On a future native Linux staging host, unpack into a fresh empty directory, select Node 22, and run:

```sh
node tools/staging/install.mjs
```

This runs `npm ci --omit=dev --workspaces=false` in protocol and Core separately. Core's local protocol dependency links to the sibling directory: installing Core alone does not place zod where the sibling can resolve it. The installer imports protocol and native argon2 afterwards. Registry access and target-compatible native optional dependencies are needed. The installer inherits the operator’s environment and npm configuration; review them for credentials and registry settings before running. It refuses to start if either package already has a node_modules path; the preflight is not atomic, so use a private, quiescent extraction. After a failed partial install, use a fresh extraction. The current fresh-directory installer was exercised on native Linux with Node 22; both protocol and native argon2 import checks passed. This does not prove reproducibility across other distributions or architectures.

## Configuration and start sequence

The operator must provision a dedicated local PostgreSQL instance/database and a nonempty password themselves; do not share credentials in commands or logs. Supply a private TOML file (for example chmod 600 on Linux), outside the package, matching this structure; replace placeholders locally:

```toml
[server]
host = "127.0.0.1"
port = 47860
public_host = "127.0.0.1"
[database]
host = "127.0.0.1"
port = 47432
database = "DEDICATED_DATABASE"
user = "DEDICATED_USER"
password = "REPLACE_LOCALLY"
[paths]
assets = "/path/to/core/assets"
web = "/path/to/web/dist"
run = "/path/to/private/run"
[adapters.qq]
enabled = false
socket = "/path/to/private/run/qq.sock"
[adapters.telegram]
enabled = false
socket = "/path/to/private/run/telegram.sock"
api_id = 0
api_hash = ""
[log]
level = "info"
[test]
probe_api = false
probe_answer_inbound = false
```

After target-compatible dependencies are installed and the database is ready, run from the staging root with `VOIPGW_CONFIG` set to the private config path and `VOIPGW_MIGRATIONS` set to the absolute core/migrations path:

```text
node core/dist/main.js
```

Startup automatically migrates. If an administrator is needed, run the following against the same dedicated database after migration, in an interactive terminal; choose a test username and enter the password at the prompt (minimum 10 characters):

```text
node core/dist/cli.js admin:create --username test-admin
```

The CLI only creates the first administrator and requires a TTY. Preserve the private configuration and database separately from release files. Stop the foreground process with Ctrl+C.

## Web and acceptance limitations

Core currently serves API and WebSocket routes, not the built Web assets. A separate loopback-only static server or reverse proxy is required; route /api and /ws to Core with WebSocket upgrades, serve web/dist at / with SPA fallback, and use the same browser origin. These proxy instructions are architectural requirements, not a tested proxy configuration. Keep services on loopback; no external exposure is assessed here.

Once the prerequisites and proxy exist, check that GET /api/health reports data.ok=true and data.db=ok, then verify the Web loads and a test administrator can log in. A healthy database and successful login do not prove calls, SMS, device binding, audio, adapters, security, or real-world operation. The isolated staging run checked health, static and SPA HTTP responses, unauthorized access, administrator login, and authenticated settings/devices/calls/channels/dashboard GETs. It did not exercise a real browser or devices. Core and protocol were upgraded to Zod 4.6.7; production-only npm audits reported zero known vulnerabilities at verification time. The exported generic apiData(z.unknown()/z.any()) omission behavior and raw Zod diagnostics differ from v3; sampled compatibility tests do not prove exhaustive compatibility. An Android debug APK was subsequently built and JVM-tested, but not validated on a physical device; real voice adapters are incomplete. See [current handover](18-开发部署与交接现状-2026-11-21.md).
