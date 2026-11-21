# Usage and operations / 使用与运维手册

[简体中文](#简体中文) · [English](#english)

## 简体中文

### 演示、原生工具与构建

先按首页的合成演示了解流程。演示不需要绑定 Android 硬件、PostgreSQL、真实账户或运营商服务。[快速演示](../README.md#快速演示)

从仓库根目录运行下方共用命令。Core、Web 和共享 TypeScript 协议通过各包的锁文件安装，构建先运行协议包。推荐 Node.js 22，项目声明范围为 `>=20.19 <23`。Android 用原生 JDK 17、SDK Platform 35、已获授权的 SDK 许可和兼容 AGP 8.7.3 的 Gradle 8.x（至少 8.9）。仓库没有随附 Gradle wrapper。Python 工具需要 Python 3.10+，演示和多数离线夹具无需登录平台。缺依赖时在受授权的准备环境取得并核验依赖。[Core 构建入口](../core/package.json) · [Android 构建配置](../android/build.gradle.kts) · [Telegram 包](../adapters/telegram/pyproject.toml) · [共用构建与测试命令](#native-builds-and-checks)

### 首次安装与启动

1. 准备专用原生 PostgreSQL 数据库（使用 PostgreSQL 14 或更新的兼容版本）。以本机回环作为隔离测试默认设置，使用私有配置、空数据库、专用角色和合成数据。保持适配器和探测关闭。确认证书、身份与访问控制之前，只在隔离环境使用当前 Android 明文绑定入口。[配置结构](#shared-configuration-example)
2. 构建协议、Core、Web。为管理后台配置同一来源的静态文件与 SPA 回退，并转发 `/api` 和 `/ws`（保留 WebSocket upgrade）。Core 当前只提供 API 和 WebSocket，静态入口单独提供。`VITE_API_BASE` 可用于受控构建。相关反向代理和平台设置需在目标环境独立验收。[构建命令](#native-builds-and-checks) · [Core 路由](../core/src/main.ts) · [Web 客户端](../web/src/api/client.ts)
3. 在 Core 停止的情况下执行 `migrate`，核对迁移顺序及已应用版本。可在专用库执行只读查询 `SELECT version FROM schema_migration ORDER BY version`，并与迁移目录核对。运行 `admin:create --username demo-admin` 创建首个测试管理员。它要求交互终端，提示输入两次密码，长度至少为 10。每个数据库启动一个 Core。普通启动也会在监听前核对并应用迁移。停止使用 Ctrl+C，确认进程退出、工作排空和锁释放后再启动替代进程。[CLI 与启动](#shared-cli-commands)
4. 在授权的验证环境检查 `GET /api/health` 的 `data.ok=true` 和 `data.db=ok`。使用合成管理员核对登录、设备与短信页面。真实设备上线另行审批，只有匹配绑定、活动连接、可用 SIM 与权限都验证后才允许对设备做测试。健康检查和后台读回只覆盖各自功能。[发布检查](RELEASE-CHECKLIST.md)

### 首次绑定 Android

在经授权的隔离环境，用管理员打开设备页的绑定弹窗，保留该次签发的记录 ID。在经授权的全新 Android 安装中，输入经核对的 HTTP 地址和六位码。确认地址和绑定操作。核对 Android 已保存的设备身份和 Core 的绑定记录，等待匹配的连接和 SIM 状态。二维码与六位码同样作为短期敏感数据处理。[Web 绑定界面](../web/src/features/devices/binding.tsx) · [Android 界面](../android/app/src/main/kotlin/io/voipgw/gateway/ui/MainActivity.kt)

### 失败与对账

| 情景 | 执行步骤 |
| --- | --- |
| Android 显示绑定结果未知 | 保留应用数据、原绑定码记录和待确认凭据。使用应用的原尝试恢复按钮，在退避后只重试初始请求。以 Core 返回的匹配身份和 Android 的持久化读回作为绑定完成证据。过期、限流、HTTP 错误、超时或空列表本身不能解释之前的提交。 |
| 码丢失、重复绑定风险、旧设备或安装恢复 | 在设备页打开绑定记录，选择并核实 `recordId`，复核关联设备，再确认取消。在权威主库上核对已提交的取消与必要的会话和媒体清理。清理不确定时以同一记录重新查询和核对。调查旧设备、旧凭据及队列后单独批准替代绑定。Android 没有把历史身份、短信或未归属队列自动迁给新绑定的操作。 |
| WebSocket 已打开但设备仍未完成握手 | 核对 Core 是否返回匹配的 `hello.ok`。Android 会在握手到期后退出该连接，确认持久代次释放后按退避重连。若提示终止或需核对，不要清空绑定或队列来强制重连。 |
| 设备完成握手但反复重连，队头不前进 | 按原事件 ID 核对 Core 的持久化与托管证据，检查是否有匹配的正向 ACK。Android 对同一未确认队头延长重连退避，不跳过该事件。不要清空队列或用新任务再次发送短信。 |
| 连接终止、升级后提示核对、存储故障 | 保留 Android 数据库与相关日志文件（包括现有 WAL 或回滚日志），按敏感数据处理。先检查正确设备、Core 授权、绑定身份与已记录队列。完整且静止的一致副本可用于授权的离线盘点。 |
| Web 短信提交超时或显示待确认 | 保留相同管理员、API 来源、SIM、号码、正文和幂等键。用短信页面的检查操作读回同一键。仅在匹配的记录出现时清除待确认信息，或在可用时明确恢复同一个意图。会话存储有浏览器生命周期边界。空结果不能排除迟到提交。 |
| 短信仍在排队 | 先检查原任务、设备在线和暂停状态、SIM 观测以及限速设置。Core 分批扫描和派发，积压可能需要多个周期才能轮到。等待或重新读回原任务，不以新幂等键再次发送。 |
| 入站短信未自动显示或重复收到更新提示 | 先刷新短信会话、按原短信记录核对。WebSocket 只是读回提示；设备 ACK 表示 Core 的持久化边界，不表示浏览器收到消息。不要因通知缺失或重复而重发短信、删除标记或改写历史。 |
| Core 任务 `unknown` 或 ACK 与结果矛盾 | 查同一任务、调度尝试、设备/SIM、事件和审计，再分别核对申领、ACK 与结果。`SMS_PARTIAL_SEND` 表示部分分段成功。`SMS_RESULT_CONFLICT` 表示存在矛盾证据，可从原事件检查 `SMS_CALLBACK_CONFLICT`。保留原任务，按原键对账。手工改状态或换键重发可能造成重复发送。 |
| 心跳或语言设置已保存，设备还未应用 | 先在 Core 读回已提交设置，再检查设备是否已完成握手且仍在线。Core 会分批对账，失败后退避。HTTP 保存仅证明 Core 持久化，不证明设备应用。禁止用发送短信或拨打电话来验证配置。 |
| 设备健康告警 | 从告警记录定位设备或 SIM。核对在线状态、SIM 状态、Shizuku 和短信权限的观测时效。确认告警可减少重复提示。有效恢复的观测会结束同一次故障。授权变更设备或平台前先完成核对。 |
| 需要挂断，但浏览器音频已断开 | 使用原管理员会话返回拨号页，刷新原通话状态。若仍可挂断，点击「挂断」后再确认。已受理或结果未知时只读回，不换会话或幂等键重试。仅断开本地音频不会主动发出挂断请求。 |
| Web 通话已记录，但无音频或日志出现 `media_stalled` | 分别核对原通话信令、媒体腿 ID 和本地音频状态。断流日志不能证明设备已挂断，浏览器显示本地监听也不能证明双向音频可用。不要换幂等键重拨来试探原结果。 |
| Core 重启或浏览器通话结果未知 | 先核对原会话与设备的终止证据。只有证明未执行拨号的预约才可自动关闭；未知会话可能继续占用设备。不要换幂等键尝试重拨。 |
| 管理页面一直连接中或反复断开 | 核对 Core 是否可达，以及管理会话是否仍有效。若初始鉴权超过 Core 的 5 秒截止，Core 按 `4401` 关闭；这不是凭据被拒绝。Web 会淘汰超时连接并退避重连；重连后的首个有效心跳应答会触发查询刷新。断线或恢复不等于上一项操作成功或失败；先按原记录只读核对，不重复提交。 |
| 渠道显示在线但没有新登录提示，或账号操作结果未知 | 区分 IPC 就绪、账号状态和管理通知。原管理员会话可在「平台渠道」点击「读取当前登录步骤」，这不会重新触发登录。读回为空时先核对操作记录；结果未知时不要重发。只有在重新显示当前挑战后才填写新资料。更新时协调 Core 与 Web 版本。[恢复边界](platform-login-recovery.md) |
| 渠道、通话或设备运维告警 | 在告警页按未处理、已确认或已解除筛选，按页浏览；使用「最新」返回最新告警。确认与操作日志同事务写入，仅标记已查看，不会重新登录、拨打电话或更改设备。分别核对渠道报告、原通话会话、设备协议版本和经授权的自启报告。确认超时先读回告警和操作日志，不自动重试确认。未知通话不可自动重拨。 |
| 入站短信被隔离或队列停在同一事件 | 核对配置的托管模式、告警、原事件 ID 及设备。指定管理员在短信隔离清单查看元数据，按授权审计导出指定条目。将导出当作敏感内容。启用正向 ACK 的模式前按清单验证持久化、同事件重放和恢复。避免清除 Android outbox。 |
| 短信速率设置的提交结果未知 | 确认旧 Core 已停止，在权威主库上核对设置与待处理任务，验证有效速率后按独占流程重启。进程在提交结果不明确期间暂停新的下发，排队记录保留。 |
| Core 锁丢失、数据库迁移或提交结果未知 | 停止同库写入。核对旧进程和会话已结束。用权威主库读回 `schema_migration`、结构和相关业务记录，再决定重启、继续或从演练过的备份恢复。保留日志、证据和业务数据。迁移版本记录与对应 SQL 在同一事务提交。 |

参阅 [状态与 ACK](IMPLEMENTATION.md#短信调度和-ack)、[托管模式](IMPLEMENTATION.md#异常短信托管) 与 [离线盘点](../tools/COMMAND-INVENTORY.md)。

## English

### Demo, native tooling and builds

Start with the synthetic demo on the home page. It runs independently of Android hardware, PostgreSQL, real accounts and carrier services. [Quick demo](../README.md#quick-demo)

Run the shared commands below from the repository root. Install Core, Web and the shared TypeScript protocol from their individual lockfiles. Build the protocol first. Node.js 22 is recommended and the project declares `>=20.19 <23`. Android requires native JDK 17, SDK Platform 35 and the appropriate license, plus Gradle 8.x compatible with AGP 8.7.3 (8.9 or later). The repository omits a wrapper. Python tools require Python 3.10+. The demo and most offline fixtures need no platform sign-in. Obtain and verify missing dependencies in an authorized preparation environment. [Core build](../core/package.json) · [Android build](../android/build.gradle.kts) · [Telegram package](../adapters/telegram/pyproject.toml) · [Shared build and test commands](#native-builds-and-checks)

### Fresh installation and startup

1. Prepare a dedicated native PostgreSQL database. Use PostgreSQL 14 or a compatible newer version, loopback isolation, private configuration, an empty database, a dedicated role and synthetic data. Keep adapters and probes disabled. Restrict the current Android cleartext bind flow to an isolated environment while authenticated transport and access controls are unresolved. [Configuration shape](#shared-configuration-example)
2. Build protocol, Core and Web. Host the static Web bundle on the same origin, configure SPA fallback, and forward `/api` and `/ws` with WebSocket upgrades. Core serves the API and WebSocket routes. Provide the static entry point separately. `VITE_API_BASE` is available for a controlled build. Validate proxy and platform settings on the intended target. [Build commands](#native-builds-and-checks) · [Core startup](../core/src/main.ts) · [Web API client](../web/src/api/client.ts)
3. With Core stopped, run `migrate` and verify the applied migration versions. Use `SELECT version FROM schema_migration ORDER BY version` on the dedicated database and compare the result with the migrations directory. Run `admin:create --username demo-admin` to create the first test administrator. It requires an interactive terminal and prompts for a password of at least 10 characters twice. Start a single Core per database. Normal startup also applies outstanding migrations before listening. Stop with Ctrl+C and confirm exit, draining and lock release before a replacement starts. [CLI and startup](#shared-cli-commands)
4. In the authorized acceptance environment, check that `GET /api/health` reports `data.ok=true` and `data.db=ok`. Use a synthetic administrator to verify login and readback on Devices and SMS. Authorize any physical-device connection separately. Verify the binding, current connection, SIM readiness and permissions before a device test. [Release gates](RELEASE-CHECKLIST.md)

### First Android binding

In an authorized isolated setup, sign in as administrator, open the binding dialog on Devices, and keep the issued record ID. On an authorized fresh Android installation, enter the checked HTTP origin and six-digit code. Confirm the address and the binding action. Check the stored Android identity against the Core record, then wait for the matching connection and SIM status. Treat the QR payload and code as short-lived sensitive data. [Web binding UI](../web/src/features/devices/binding.tsx) · [Android UI](../android/app/src/main/kotlin/io/voipgw/gateway/ui/MainActivity.kt)

### Failure reconciliation

| Situation | Operator action |
| --- | --- |
| Android shows an unknown binding outcome | Preserve app data, the original code record and pending credential. Use the app’s resume control for the same attempt after backoff. Confirm the correlated Core result and durable Android readback. Expiry, rate limits, HTTP errors, timeout and an empty list cannot settle an earlier transaction by themselves. |
| Code loss, possible duplicate binding, or a restored installation | Open Binding records on the Devices page, select the verified `recordId`, review the linked device, and confirm cancellation. Verify durable cancellation and any required session and media teardown on the authoritative primary. Reconcile the same record if cleanup is uncertain. Investigate the old device, credential and queue before authorizing a new binding. Automatic reassignment of old identity, SMS or unscoped records is unsupported. |
| The WebSocket opens but the device does not complete its handshake | Check whether Core returns a matching `hello.ok`. After the handshake deadline Android retires the connection and backs off after confirmed generation release. If the service reports a terminal state or requires reconciliation, do not clear the binding or queue to force a reconnect. |
| The device completes hello but keeps reconnecting without advancing the head | Reconcile Core persistence and custody under the original event ID, and look for its matching positive ACK. Android increases reconnect backoff for the same unacknowledged head without skipping it. Do not clear the queue or submit a new SMS task. |
| Terminal connection, an upgrade that requires reconciliation, or storage failure | Preserve the Android databases and associated journals, including any WAL or rollback journal. Treat them as sensitive. Verify the device, Core authorization, binding identity and retained queue. Use a complete quiescent copy for authorized offline inventory. |
| Web SMS submission times out or shows a pending intent | Preserve the administrator, API origin, SIM, recipient, message and idempotency key. Use the SMS page to read back the original key. Clear the local intent after a matching record is verified or explicitly resume the same intent where available. Session storage follows the browser session lifecycle. An absent read can race a late commit. |
| SMS remains queued | Check the original task, whether the device is online and unpaused, the SIM observation, and the configured rate. Discovery and dispatch operate in batches, so a backlog can take several passes. Read back the original task rather than sending it again under a new key. |
| An incoming message does not appear automatically, or an update hint is repeated | Refresh the SMS thread and reconcile the original record. A WebSocket event is a readback hint. The device ACK concerns Core persistence, not browser receipt. Do not resend the SMS, delete markers, or rewrite history to resolve a missed or repeated hint. |
| Core task is `unknown` or ACK and result conflict | Inspect the original task, attempt, device/SIM, events and audit log, then verify each claim, ACK and result separately. `SMS_PARTIAL_SEND` indicates a mix of successful and failed parts. `SMS_RESULT_CONFLICT` records contradictory evidence. The source event can carry `SMS_CALLBACK_CONFLICT`. Preserve the task and reconcile under its original key. Manual state changes or a fresh key can duplicate sends. |
| Heartbeat or locale saved but not yet applied | Read back the committed settings in Core and check the device has completed hello and remains attached. Core reconciles in batches and backs off after a failed attempt. An HTTP save confirms Core persistence, not device application. Do not test configuration by sending an SMS or making a call. |
| Device health alert | Match the alert to its device or SIM. Check the freshness of reachability, SIM status, Shizuku and SMS permission observations. Acknowledgement suppresses repeated warnings. A valid recovery observation closes the incident. Complete reconciliation before an authorized device or platform change. |
| Need to hang up after browser audio disconnects | Return to the dialer in the original administrator session and refresh the call status. If hangup is still available, select Hang up and confirm. If a request was accepted or its outcome is unknown, read back rather than trying another session or key. Disconnecting local audio does not explicitly send hangup. |
| Call is recorded but audio is missing or `media_stalled` appears | Check the existing call signalling, media leg ID, and local audio separately. A stall does not prove the handset hung up. Browser listening is not proof of working two-way audio. Do not try another dial under a fresh idempotency key to settle the first one. |
| Uncertain browser call after Core restart | Read back the original session and verify terminal device evidence. Only a reservation proven never to have been armed can close automatically. An unknown call can continue to occupy its device. Do not use a fresh idempotency key to try another dial. |
| The admin console stays connecting or repeatedly disconnects | Check Core reachability and whether the admin session is still valid. Core closes first-auth expiry after five seconds with `4401`; this is not a rejected credential. Web retires timed-out attempts and retries with backoff. The first timely heartbeat response after a reconnect requests a query refresh. Neither disconnect nor reconnect settles a previous operation; read back the original record before acting. |
| Adapter is reachable but the login prompt is missing, or an account operation is uncertain | Distinguish IPC readiness, account state, and admin notifications. In the current admin session, use Read current login step on Platform channels; it does not initiate sign-in. If no step is returned, check the operation record. Do not resend an uncertain operation. Enter new material only for the displayed current challenge. Upgrade Core and Web together. [Recovery boundaries](platform-login-recovery.md) |
| Channel, call or device operational alert | Filter Alerts by Open, Acknowledged or Resolved. Use Latest to return to the newest page. Acknowledgement is recorded with an audit entry and neither logs a channel in nor changes devices or places calls. Check the adapter report, original call session, device protocol version or authorized host report. After an uncertain acknowledgement, read back the alert and audit log; do not retry blindly. Never automatically redial to resolve an unknown outcome. |
| Inbound SMS is quarantined or the device stalls on one event | Verify the custody mode, relevant alert, event ID and device. The designated administrator can inspect metadata and make an audited, authorized single-record export. Protect the export as sensitive data. Verify durability, exact replay and restoration before enabling the ACK mode. Preserve the Android outbox. |
| SMS rate change has an unknown commit outcome | Confirm the old Core has stopped and reconcile the setting and pending tasks on the authoritative primary. Verify the effective rate before restarting under exclusive ownership. New sends are held after an uncertain rate write. Queued records are retained. |
| Core loses its lock, or migration/commit outcome is uncertain | Stop writes to the database. Confirm the previous process and session are gone. Inspect `schema_migration`, schema and related records on the authoritative primary before restarting, continuing or restoring a rehearsed backup. Preserve logs, evidence and business data. Each migration commits its version record with the SQL. |

See [states and ACKs](IMPLEMENTATION.md#sms-scheduling-and-acks), [custody modes](IMPLEMENTATION.md#exceptional-sms-custody) and [offline inventory](../tools/COMMAND-INVENTORY.md).

The native USB Shizuku helper runs separately and requires a compatible host, explicitly enrolled serials and authorized ADB access. Its process reports and Android’s own binder observation provide separate status signals. Record physical-device and audio verification separately.

原生 USB Shizuku 助手独立运行，需要兼容宿主机、明确登记的设备序列号及经授权的 ADB 访问。宿主机进程报告与 Android 的 Binder 观察分别提供状态。真机和音频验证另记。[Shizuku USB helper / USB 助手](../tools/shizuku-autostart/README.md)

## Native builds and checks

Install only with an authorized registry or fully provisioned npm cache. The commands request offline installation using the checked-in package lockfiles. `node_modules` must match the target OS and architecture. When the cache misses, provision the applicable locked dependency in the approved environment before retrying.

仅使用经授权的注册表或完整的 npm 缓存。命令使用仓库中的包锁文件要求离线安装。`node_modules` 必须与目标操作系统和架构匹配。若缓存缺失，先在经授权的环境准备对应的锁定依赖。

```sh
npm --prefix packages/protocol ci --workspaces=false --offline
npm --prefix packages/protocol run build --workspaces=false
npm --prefix core ci --workspaces=false --offline
npm --prefix web ci --workspaces=false --offline
npm --prefix core run build --workspaces=false
npm --prefix web run build --workspaces=false
```

Build and verify Android with its native SDK and local Gradle cache. Set `JAVA_HOME`, `ANDROID_HOME`, and the Gradle cache for the installed tools. Use `gradle.bat` on Windows if that is the available entry point; offline mode still requires cached dependencies. The APK is emitted under `android/app/build/outputs/apk/debug/`. Use the package checks and focused test paths below from the repo root.

Android 使用原生 SDK 和本地 Gradle 缓存构建。配置已安装工具的 `JAVA_HOME`、`ANDROID_HOME` 和 Gradle 缓存；Windows 可使用 `gradle.bat`。离线模式仍需要预先缓存依赖。APK 在 `android/app/build/outputs/apk/debug/` 下生成。包检查与聚焦测试从仓库根目录执行。

```sh
gradle --offline -p android -Pandroid.builder.sdkDownload=false -Porg.gradle.java.installations.auto-download=false :protocol:test --rerun :app:testDebugUnitTest --rerun :app:lintDebug :app:assembleDebug
npm --prefix packages/protocol run check --workspaces=false
npm --prefix core run check --workspaces=false
npm --prefix web run check --workspaces=false
npm --prefix web run i18n:check --workspaces=false
node --test adapters/qq/test/client.test.mjs adapters/qq/test/shared-fixtures.test.mjs
python -B -m unittest discover -s tools -p test_sms_intent_model.py -v
```

Telegram fixture tests load local source using `PYTHONPATH`. Example for Bash / Bash 示例。

```sh
PYTHONPATH=adapters/telegram/src python -B -m unittest discover -s adapters/telegram/tests -v
```

Use pre-cached dependencies for these focused Core and Web checks. PostgreSQL-dependent suites need their own isolated database and setup. Consult the corresponding fixture before running them.

从依赖缓存运行以下 Core 与 Web 聚焦测试。依赖 PostgreSQL 的测试有单独的隔离库和配置前提，运行前检查对应测试夹具。

```sh
npm --prefix core run test --workspaces=false -- test/binding-v2-http.test.ts test/binding-v2-repo.test.ts test/db-ownership.test.ts test/migrate-lifecycle.test.ts test/sms-dispatch-stop.test.ts test/sms-attempt-repo.test.ts
npm --prefix core run test --workspaces=false -- test/sim-rate-limiter.test.ts test/sms-rate-runtime.test.ts test/sms-rate-scheduling.test.ts test/sms-maintenance-invalidation.test.ts test/sms-maintenance-invalidation-extra.test.ts test/web-calls.test.ts test/http.test.ts
npm --prefix web run test --workspaces=false -- src/features/sms/send-sms.test.tsx src/features/sms/quarantine-inventory.test.tsx src/features/settings/account-settings.test.tsx src/features/devices/binding.test.tsx
node --test tools/demo/demo.test.mjs
```

The demo tests exercise the in-process request handler and use the existing Web build. Build Web first. [Demo tests](../tools/demo/demo.test.mjs)

演示测试直接调用进程内请求处理器并读取 Web 产物，需要先构建 Web。[演示测试](../tools/demo/demo.test.mjs)

## Shared configuration example

Create a private TOML file. Fill the example placeholders locally and use private, existing directories for paths. Keep paired Android devices and all production data out of the fresh-install fixture. Keep real passwords, tokens, QR payloads and message contents out of the repository and logs.

配置私有 TOML 文件，在本地填写占位项并使用独立的已有目录。首次安装夹具使用独立数据库和合成数据。勿把真实密码、令牌、二维码内容或短信正文写入仓库和日志。

```toml
[server]
host = "127.0.0.1"
port = 47860
public_host = "127.0.0.1"

[database]
host = "127.0.0.1"
port = 5432
database = "DEDICATED_DATABASE"
user = "DEDICATED_USER"
password = "FILL_IN_PRIVATELY"

[paths]
assets = "PRIVATE_ASSET_DIRECTORY"
web = "WEB_DIST_DIRECTORY"
run = "PRIVATE_RUNTIME_DIRECTORY"

[adapters.qq]
enabled = false
socket = "PRIVATE_RUNTIME_DIRECTORY/qq.sock"

[adapters.telegram]
enabled = false
socket = "PRIVATE_RUNTIME_DIRECTORY/telegram.sock"
api_id = 0
api_hash = ""

[log]
level = "info"

[test]
probe_api = false
probe_answer_inbound = false
```

Use `VOIPGW_SMS_CUSTODY_MODE=disabled` for the baseline and leave `VOIPGW_SMS_CUSTODY_ADMIN_ID` unset. To enable `retain` or `acknowledge`, configure the administrator ID from the target environment and verify the custody prerequisites and recovery workflow. Keep integration flags and adapter credentials private.

基线使用 `VOIPGW_SMS_CUSTODY_MODE=disabled`，不设置 `VOIPGW_SMS_CUSTODY_ADMIN_ID`。启用 `retain` 或 `acknowledge` 时，配置目标环境中的管理员 ID，并验证托管前提与恢复流程。将集成开关和适配器凭据留在私有配置中。[配置实现 / Configuration](../core/src/config/load.ts) · [托管模式 / Custody modes](IMPLEMENTATION.md#exceptional-sms-custody)

## Shared CLI commands

Run against the dedicated database from the root of the checkout. Replace the TOML path before running. A fresh database has no administrator until the interactive step completes. The following is a Bash example for an authorized native integration environment.

在仓库根目录使用专用数据库，先替换 TOML 路径。管理员需交互式创建。以下为经授权的原生集成环境中的 Bash 示例。

```sh
export VOIPGW_CONFIG="path/to/private-config.toml"
export VOIPGW_MIGRATIONS="core/migrations"
node core/dist/cli.js migrate
node core/dist/cli.js admin:create --username demo-admin
node core/dist/main.js
```

PowerShell uses `$env:VOIPGW_CONFIG` and `$env:VOIPGW_MIGRATIONS`. Review [staging instructions](partial-core-web-deployment.md) for the optional Core/Web staging archive and its registry and native dependency requirements. For authorized reconciliation, the Core CLI provides `command-id:inventory` as a read-only PostgreSQL report. An Android command inventory needs quiescent, consistent, authorized SQLite copies. Protect the output and check the report’s completion before comparing identities. [Core inventory command](../core/src/cli/command-id-inventory.ts) · [SQLite inventory](../tools/COMMAND-INVENTORY.md)

PowerShell 使用 `$env:VOIPGW_CONFIG` 和 `$env:VOIPGW_MIGRATIONS`。可选的 Core/Web 打包涉及注册表与原生依赖，见 [隔离部署记录](partial-core-web-deployment.md)。经授权对账时，Core CLI 的 `command-id:inventory` 从 PostgreSQL 只读生成盘点报告。Android 命令盘点要求经授权的静止一致 SQLite 副本。保护输出并核对报告完成状态后再比较身份。[Core 盘点命令](../core/src/cli/command-id-inventory.ts) · [SQLite 盘点](../tools/COMMAND-INVENTORY.md)
