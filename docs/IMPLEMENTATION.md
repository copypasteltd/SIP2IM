# Implementation / 实现说明

[简体中文](#简体中文) · [English](#english)

## 简体中文

### 组件与数据流

| 组件 | 职责和传输边界 |
| --- | --- |
| Android `app` 和 `protocol` | SQLite 保存绑定、命令、短信任务和事件。前台服务通过 `/ws/device` 发送状态、心跳和事件。 [绑定与 outbox](../android/app/src/main/kotlin/io/voipgw/gateway/core/Outbox.kt) |
| Core | Fastify 管理与设备 API、WebSocket、PostgreSQL 持久化、设备与短信调度、通话协调、适配器 IPC。`/ws/admin` 推送更新信号。 [启动入口](../core/src/main.ts) |
| Web | React 管理后台，含仪表盘、设备、短信、通话、通道、设置和操作记录。UI 以 API 读回为准。 [后台路由](../web/src/app/router.tsx) |
| QQ / Telegram | 适配器通过本地 IPC 连接 Core。QQ 提供入口和测试替身，Telegram 提供可选文本后端。Core 当前开放账号控制，平台消息和语音保持禁用。 [QQ](../adapters/qq/README.md) · [Telegram](../adapters/telegram/README.md) · [Core 能力边界](../core/src/channels/adapter-runtime.ts) |
| 共享协议与工具 | TypeScript 与 Kotlin 协议模块、共享测试夹具、合成设备工具。运行中的设备模拟器是协议测试客户端，无需 Android 模拟器。 [TS 协议](../packages/protocol/package.json) [Kotlin 构建](../android/build.gradle.kts) [设备模拟器](../tools/device-simulator/README.md) |

### v2 绑定与设备所有权

- 管理端可以用 `POST /api/devices/binding-codes/v2` 生成有效期十分钟的六位码、过期时间、二维码内容及独立的 `recordId`。受认证的 `GET /api/devices/binding-codes` 提供可分页的管理记录。使用 `POST /api/devices/binding-codes/:id/cancel` 按记录 ID 取消。`recordId` 用于选择记录，操作权限来自管理员会话。Web 在设备页提供 v2 签发和绑定记录入口。取消前核对选中的记录及关联设备。结果未知时保留记录 ID 并重新读取。 [绑定路由](../core/src/http/binding-routes.ts) [Web 绑定界面](../web/src/features/devices/binding.tsx) [Web 绑定 API](../web/src/features/devices/binding-api.ts)
- Android 在发送 `POST /api/device/bind-v2` 前，把原始请求、客户端生成的尝试 ID 和随机认证凭据持久化为待确认记录。Core 同一事务写入设备、凭据哈希、使用状态与重放证据。客户端收到同一尝试的 `protocolVersion`、`attemptId` 和 `deviceId` 后，通过持久化比较更新提升为活动绑定。凭据由客户端保存，v2 响应不包含凭据。 [绑定仓库](../core/src/devices/binding.ts) [Android 绑定客户端](../android/app/src/main/kotlin/io/voipgw/gateway/core/BindingClient.kt) [绑定状态](../android/app/src/main/kotlin/io/voipgw/gateway/core/BindingFence.kt)
- 重放窗口截止于码过期后 24 小时，原始尝试在窗口内可返回同一设备 ID。重放要求凭据、请求内容和尝试 ID 完全匹配，并检查撤销和取消状态。兼容的 v1 绑定仍可使用，已消费的 v1 码没有 v2 重放证据，v2 客户端没有自动降级。 [绑定仓库](../core/src/devices/binding.ts)
- 取消与绑定争用同一绑定码记录锁。已使用的码被取消时，撤销设备及凭据与写入取消记录同一事务完成。会话和媒体清理由事务提交后执行。清理待确认时保留服务器记录并针对同一 `recordId` 重试核对。 [绑定仓库](../core/src/devices/binding.ts) [启动入口](../core/src/main.ts)
- 前台服务要求持久化的活动绑定和当前连接代次，且 `hello.ok` 的 `deviceId` 必须匹配。观察到终止性关闭、或进程重启后仍有无人持有的打开记录时，进入人工核对。队列和命令检查绑定及代次。旧记录保留以便核对，已经提交给 Android 的副作用可能继续。 [Android 服务](../android/app/src/main/kotlin/io/voipgw/gateway/core/GatewayService.kt) [绑定状态](../android/app/src/main/kotlin/io/voipgw/gateway/core/BindingFence.kt)

### 短信调度和 ACK

| 边界 | 可下结论 | 恢复依据 |
| --- | --- | --- |
| 管理端提交 | `POST /api/sms` 使用 `Idempotency-Key`。匹配的响应确认 Core 已记录请求。 | Web 在发送前保存原始待确认意图。`GET /api/sms/idempotency` 读取已提交结果。空结果可能与另一个尚未结束的提交并存。 [HTTP 接口](../core/src/http/server.ts) [Web 短信用例](../web/src/features/sms/send-sms.tsx) |
| 任务调度 | Core 从 `queued` 原子申领并记录调度尝试，确认申领后才下发。考虑设备可用性、SIM 状态、每 SIM 顺序、限速与过期。 | 当申领、发送或 ACK 持久化结果不确定时，保留同一次尝试的身份和证据，按原任务核对。确认无法安全下发的过期或退役排队任务进入失败。 [调度器](../core/src/sms/dispatch.ts) [尝试仓库](../core/src/sms/attempt-repo.ts) [队列仓库](../core/src/sms/queue-repo.ts) |
| 设备命令 ACK | 正向 ACK 表示 Android 已接受任务入队。Core 状态可变为 `accepted`。 | 从待提交到确认结果要看独立的设备事件。超时、进程停止或迟到/矛盾事件可能产生 `unknown`。 [短信状态](../core/src/sms/state.ts) [结果协调](../core/src/sms/results.ts) |
| 设备事件 ACK | Core 在持久化或认可精确重放后，按当前连接返回对应正向 ACK。Android 以同一事件 ID 的正向 ACK 推进本地 outbox。 | 持久化未知时保留原有事件。隔离模式可能阻止队头前进。 [设备连接](../core/src/ws-device/session.ts) [事件投影](../core/src/devices/event-producer.ts) [Android outbox 节流](../android/protocol/src/main/kotlin/io/voipgw/protocol/OutboxPacer.kt) |
| 系统或运营商结果 | `sent`、`failed`、`unknown` 是独立的设备结果。`delivered` 需要独立且可靠的投递证据。 | 当前 Android 回调路径不从系统发送回执推断运营商投递。真实短信、送达和通话需要独立验收。 [Android 回调](../android/app/src/main/kotlin/io/voipgw/gateway/sms/SmsCallbackReceiver.kt) [结果协调](../core/src/sms/results.ts) |

Android 将发送回执绑定到原设备绑定、连接代次、任务和短信分段。全部分段都有一致结果时，才报告 `sent` 或 `failed`。成功与失败分段并存会保留 `unknown/SMS_PARTIAL_SEND`。同一分段的相矛盾回执会报告 `unknown/SMS_CALLBACK_CONFLICT`。Core 保留原始事件，并将已确认的矛盾投影为 `unknown/SMS_RESULT_CONFLICT`，后续普通回执无法覆盖它。迟到回执须与原申领匹配。旧版未携带申领标识的回执留待对账。所有未知结果沿用原任务且不自动重发。[Android 回执判定](../android/app/src/main/kotlin/io/voipgw/gateway/sms/SmsSendEvidence.kt) · [Core 结果对账](../core/src/sms/results.ts)

Core 在启动核对和周期维护中处理遗留状态、队列过期、退役 SIM 和管理员更新信号。队列发现与命令 ACK 分开执行。Core 为每张活跃 SIM 读取独立的有序批次，根据各 SIM 的限速等待时间安排设备唤醒。已确认的速率变更唤醒受影响设备。提交成功但读取不到新值时，暂停下发直到取得当前值。提交本身不明确时，暂停下发直到在独占所有权下完成核对并重启。WebSocket 广播与清理持久化标记之间发生故障可能产生重复通知。管理端将通知用于触发读回。 [启动入口](../core/src/main.ts) [速率运行逻辑](../core/src/sms/rate-runtime.ts) [队列仓库](../core/src/sms/queue-repo.ts) [维护通知](../core/src/sms/maintenance-invalidation.ts)

通话控制在外部下发前复核管理员会话、设备连线和会话状态。挂断与同一通话的进展协调。Web 通话还受明确的设备验收名单限制，Android 对通话命令返回不支持。 [通话状态机](../core/src/calls/web-calls.ts) [启动与能力设置](../core/src/main.ts) [Android 通话命令](../android/protocol/src/main/kotlin/io/voipgw/protocol/UnsupportedCallCommand.kt)

自动化测试可显式注入按通话代次运行的内存设备夹具，覆盖过期连接、挂断匹配和媒体开启失败。普通设备模拟器的 Shizuku 状态保持不明。真实 Web 通话仍需要验收名单、实际设备控制和有效的双向音频。[内存通话夹具](../tools/device-simulator/README.md)

### 设备健康与运维告警

Core 在现有单实例定时任务中扫描四类设备告警。只有曾联系过且已经超时的设备会触发离线告警。Shizuku 不可用和 SIM 锁定或缺失需要持续 60 秒的有效采样。缺少权限告警需要明确的短信权限拒绝。SIM 清单不可观测时，Android 仍可上报独立的短信权限，空清单保持非权威。过期或不明证据保留既有告警状态。确认告警保留历史，同一次故障期间继续抑制重复提示。观察到恢复后，新的故障才会再次提示。Core 在事务确认后推送变化，Web 告警列表每 30 秒回读。[健康告警](../core/src/devices/health-alerts.ts) · [Web 告警列表](../web/src/features/records/records.tsx)

| 运维告警 | 触发与恢复 |
| --- | --- |
| 渠道不可用 | 先前确认登录的渠道，经当前适配器报告离线、退出或封禁，或检测到意外断开。当上次 Core 异常中止而仍留下已登录状态时，启动核对也可打开告警。新连接初始化和正常关闭本身不视为掉线。后续核验登录后关闭故障。 [渠道状态](../core/src/channels/repo.ts) |
| 通话失败或结果未知 | 定时单独读取已提交的通话结果，每个会话最多一条。接受明确失败或未知状态、以网络错误终止，以及实际蜂窝腿证据支持的未知结束。正常挂断、不接听和未执行的重启补偿不触发。确认后保持历史。 [通话告警](../core/src/calls/failure-alerts.ts) |
| 协议不兼容 | 只记录可识别的版本不兼容握手，并复核启用设备和原凭据。有界诊断不参与连接准入。后续在当前连接发送兼容应答后才可解除；该应答是本机发送证据，不是远端回执。 [协议告警](../core/src/devices/protocol-alerts.ts) |
| 自启失败 | 受信回环上报经设备映射和型号复核后，累计三次合格的失败。储存窗口 30 秒，短于 5 秒的失败间隔视为疑似重复；新序列或过期会重置计数。明确启动或已运行会解除，不改变 APK Binder 或媒体能力。因报文没有观察 ID 和源时间，无法排除延迟重放。 [自启上报](../core/src/devices/shizuku-report.ts) |

当前发布范围是管理端告警读回与最佳努力的实时通知。配对用户的 QQ/Telegram 告警转发和定期重推尚未接通。生产 PostgreSQL 和真实设备验收仍需独立完成。

### 异常短信托管

`VOIPGW_SMS_CUSTODY_MODE` 默认 `disabled`。在任何托管模式下，正常短信仍走正常入库路径。下表只描述可被识别和保留的异常事件。

| 模式 | Core 处理异常事件 | 设备队头 |
| --- | --- | --- |
| `disabled` | 记录阻塞，保留正常数据边界。 | 无正向事件 ACK，保持待处理。 |
| `retain` | 持久化隔离记录、关联事件标记和告警。 | 无正向事件 ACK，继续保有原始事件。 |
| `acknowledge` | 托管相关证据完整且提交确认后，可正向确认该隔离事件及其精确重放。 | 匹配 ACK 可推进队头。数据仍在隔离区。 |

`retain` / `acknowledge` 需要配置现有 `VOIPGW_SMS_CUSTODY_ADMIN_ID`，启动时检查主库、数据库持久化配置、迁移、表和权限。托管事务显式请求同步提交。托管运维接口配置管理员 ID 后启用。仅指定管理员可用 `GET /api/admin/sms-quarantine` 读取元数据，或用 `GET /api/admin/sms-quarantine/:id/export` 审计并导出单条记录。完整性错误保留待核对状态。消息、识别符和导出文件需要受控存储。 [入站短信](../core/src/devices/inbound-sms.ts) [托管写入](../core/src/db/sms-quarantine-custody.ts) [托管访问](../core/src/http/sms-quarantine-inventory.ts)

### 迁移和运行拓扑

- Core 启动先通过一条独立、直连 PostgreSQL 会话获取独占 advisory lock，然后运行迁移和协调，最后监听。每个数据库运行一个 Core。不使用事务池代理、多副本 Core 或自动故障接管。锁丢失会启动停止流程。换进程前核对源进程与数据库会话已停止，尤其在失败退出或提交不明确时。 [所有权](../core/src/db/ownership.ts) [启动入口](../core/src/main.ts)
- SQL 文档和脚本使用四位版本号。迁移器按名字排序，用 `schema_migration` 记录已应用版本。每个 SQL 文件和它的版本记录一起提交。与本文相关的有 `0015` 正负 ACK 证据、`0016` 短信管理员 outbox、`0019` 调度尝试、`0021` 维护失效通知、`0023` 入站短信托管和 `0024` 绑定重放与撤销控制。 [迁移器](../core/src/db/migrate.ts) [迁移目录](../core/migrations/)
- Android 的 SQLite v4 保存身份和队列围栏。v5 加入 v2 待确认字段。旧凭据、旧的未归属事件、损坏或未能安全恢复的绑定保留以供核对。按真实升级来源验证迁移与读回。 [绑定与 outbox](../android/app/src/main/kotlin/io/voipgw/gateway/core/Outbox.kt) [SQLite 迁移夹具](../android/app/src/test/test_binding_fence_sqlite.py)

合成演示运行本机内存 API 和实际 Web 构建。录屏展示管理界面和模拟结果。 [演示](../README.md#快速演示)

## English

### Components and data flow

| Component | Responsibility and transport boundary |
| --- | --- |
| Android `app` and `protocol` | SQLite stores binding, command, SMS task and event data. The foreground service sends status, heartbeats and events over `/ws/device`. [Binding and outbox](../android/app/src/main/kotlin/io/voipgw/gateway/core/Outbox.kt) |
| Core | Fastify management/device APIs, WebSockets, PostgreSQL persistence, device and SMS scheduling, call coordination and adapter IPC. `/ws/admin` sends update notifications. [Startup](../core/src/main.ts) |
| Web | React administration console with dashboard, devices, SMS, calls, channels, settings and operations records. The UI reads authoritative state through the API. [Web routes](../web/src/app/router.tsx) |
| QQ / Telegram | Adapters connect to Core through local IPC. QQ provides an entry point and test doubles. Telegram provides an optional text backend. Core currently permits account control and keeps platform messaging and voice disabled. [QQ](../adapters/qq/README.md) · [Telegram](../adapters/telegram/README.md) · [Core capability gate](../core/src/channels/adapter-runtime.ts) |
| Protocol and tools | TypeScript and Kotlin protocol modules, shared fixtures and synthetic device tooling. The device simulator is a protocol test client and runs without an Android emulator. [TS protocol](../packages/protocol/package.json) [Kotlin build](../android/build.gradle.kts) [Device simulator](../tools/device-simulator/README.md) |

### v2 binding and device ownership

- The administrator can issue a six-digit code valid for ten minutes, its expiry, a QR payload and a separate `recordId` through `POST /api/devices/binding-codes/v2`. The authenticated `GET /api/devices/binding-codes` lists paginated management records. `POST /api/devices/binding-codes/:id/cancel` cancels by record ID. The `recordId` selects the record. The administrator session authorizes the operation. The Devices page supports v2 issuance and inventory. Review the selected record and linked device before cancelling. Keep the record ID and refresh the inventory if the result is unknown. [Binding routes](../core/src/http/binding-routes.ts) [Web binding UI](../web/src/features/devices/binding.tsx) [Web binding API](../web/src/features/devices/binding-api.ts)
- Android persists the original request, client-generated attempt ID and random bearer credential before it calls `POST /api/device/bind-v2`. Core commits the device, credential hash, usage state and replay evidence in one transaction. Android promotes the binding with a persistent compare-and-set after verifying protocol version 2, the original `attemptId`, and a valid returned `deviceId`. The credential stays with the client and is omitted from the v2 response. [Binding repository](../core/src/devices/binding.ts) [Android bind client](../android/app/src/main/kotlin/io/voipgw/gateway/core/BindingClient.kt) [Binding state](../android/app/src/main/kotlin/io/voipgw/gateway/core/BindingFence.kt)
- The same attempt can return the same device ID until 24 hours after code expiry. Replay requires the matching credential, request and attempt ID and checks cancellation and revocation. v1 binding remains available for compatibility. A used v1 code has no v2 replay evidence. The v2 client has no fallback to v1. [Binding repository](../core/src/devices/binding.ts)
- Binding and cancellation serialize on the same code record. Cancellation of a consumed code records the cancellation and revokes the device and credentials in the same transaction. Session and media teardown runs after commit. If teardown is pending, preserve the server record and retry reconciliation using the same `recordId`. [Binding repository](../core/src/devices/binding.ts) [Startup](../core/src/main.ts)
- The foreground service requires a durable active binding, the current connection generation, and a `hello.ok` with a matching `deviceId`. An observed terminal close or an open record without a live owner after process restart requires reconciliation. Queue and command gates check identity and generation. Old records remain available for investigation, and work already submitted to Android can continue. [Android service](../android/app/src/main/kotlin/io/voipgw/gateway/core/GatewayService.kt) [Binding state](../android/app/src/main/kotlin/io/voipgw/gateway/core/BindingFence.kt)

### SMS scheduling and ACKs

| Boundary | What it establishes | Recovery evidence |
| --- | --- | --- |
| Admin request | `POST /api/sms` uses an `Idempotency-Key`. A matching response confirms that Core recorded the request. | Web saves the original pending intent before sending. `GET /api/sms/idempotency` observes committed state. An absent result can coexist with an in-flight transaction. [HTTP API](../core/src/http/server.ts) [Web SMS form](../web/src/features/sms/send-sms.tsx) |
| Dispatch | Core atomically claims a `queued` task and records an attempt. It sends only after the claim is confirmed, subject to device and SIM readiness, per-SIM order, rate and expiry. | Preserve the attempt identity and evidence when claim, send or ACK persistence is uncertain. Expired or retired work that is still queued can transition to failure. [Dispatcher](../core/src/sms/dispatch.ts) [Attempt repository](../core/src/sms/attempt-repo.ts) [Queue repository](../core/src/sms/queue-repo.ts) |
| Device command ACK | A positive ACK reports that Android accepted the task into its queue. Core may move the task to `accepted`. | Check the separate device result. A timeout, process stop, or late/conflicting observation can produce an `unknown` outcome. [SMS state](../core/src/sms/state.ts) [Result reconciliation](../core/src/sms/results.ts) |
| Device event ACK | Core can return a matching positive ACK on the current connection after persistence or recognition of exact replay. Android advances the local outbox on a positive ACK for the same event ID. | Keep the original event when persistence is uncertain. Quarantine mode can determine whether the queue head advances. [Device socket](../core/src/ws-device/session.ts) [Event projection](../core/src/devices/event-producer.ts) [Android outbox pacing](../android/protocol/src/main/kotlin/io/voipgw/protocol/OutboxPacer.kt) |
| Android or carrier result | `sent`, `failed` and `unknown` are separate device results. `delivered` requires independent delivery evidence. | The current Android callback does not infer carrier delivery from the platform send result. Actual SMS, delivery and calls need separate acceptance. [Android callback](../android/app/src/main/kotlin/io/voipgw/gateway/sms/SmsCallbackReceiver.kt) [Result reconciliation](../core/src/sms/results.ts) |

Android scopes each send callback to the original binding, connection generation, task and SMS part. It reports `sent` or `failed` when every part has a matching result. A mix of successful and failed parts stays `unknown/SMS_PARTIAL_SEND`. Contradictory callbacks on one part produce `unknown/SMS_CALLBACK_CONFLICT`. Core preserves the source event and projects confirmed contradiction as `unknown/SMS_RESULT_CONFLICT`, which subsequent ordinary callbacks cannot overwrite. Late callbacks must match the original claim. Legacy unscoped callbacks require reconciliation. Unknown work retains the original task and never triggers automatic resend. [Android send evidence](../android/app/src/main/kotlin/io/voipgw/gateway/sms/SmsSendEvidence.kt) · [Core reconciliation](../core/src/sms/results.ts)

Core runs startup reconciliation and periodic maintenance for earlier state, queue expiry, retired SIMs and administrator notifications. Queue discovery runs independently of command ACKs. Core reads a bounded FIFO batch for each active SIM and schedules device wakeups using each SIM’s rate-limit delay. A confirmed rate change wakes affected devices. When a rate write committed without returning the new value, dispatch waits for a fresh read. When the commit itself is uncertain, dispatch stays suspended until reconciliation and restart under exclusive ownership. If Core fails between WebSocket fanout and clearing the durable marker, it can publish a duplicate. The admin console refetches authoritative state on notification. [Startup](../core/src/main.ts) [Rate runtime](../core/src/sms/rate-runtime.ts) [Queue repository](../core/src/sms/queue-repo.ts) [Maintenance notifications](../core/src/sms/maintenance-invalidation.ts)

Call controls recheck the administrator session, device connection and call state before sending. A hangup is serialized with progress on the same call. Web calling requires an explicit list of verified devices. Android reports call commands as unsupported. [Call state machine](../core/src/calls/web-calls.ts) [Startup and capability settings](../core/src/main.ts) [Android call commands](../android/protocol/src/main/kotlin/io/voipgw/protocol/UnsupportedCallCommand.kt)

Offline tests can inject a generation-aware in-memory device fixture to exercise replaced connections, exact hangup matching and failed media setup. The ordinary simulator reports Shizuku as unknown. Real Web calling still requires a verified allowlist, physical device control and working two-way audio. [In-memory call fixture](../tools/device-simulator/README.md)

### Device health and operational alerts

The single Core process periodically reconciles four device health alerts. An offline alert requires a previously observed device and a confirmed timeout. Shizuku unavailability and a locked or absent SIM require 60 seconds of fresh unhealthy samples. A missing SMS permission requires an explicit denial. Android can still report SMS permissions when its SIM inventory is unknown, using an empty non-authoritative inventory. Stale or inconclusive evidence leaves the existing alert state in place. Acknowledgement preserves history and suppresses repeat warnings within the same incident. Confirmed recovery allows a later incident to raise a fresh alert. Core emits changes after commit and the Web alert list refetches every 30 seconds. [Health alert reconciliation](../core/src/devices/health-alerts.ts) · [Web alert list](../web/src/features/records/records.tsx)

| Operational alert | Trigger and recovery |
| --- | --- |
| Channel unavailable | A previously confirmed login changes to offline, logged out, banned, or unexpectedly disconnected. Startup also reconciles a logged-in state left by an interrupted Core. An attachment reset or graceful shutdown alone does not prove loss. A confirmed subsequent login closes the incident. [Channel state](../core/src/channels/repo.ts) |
| Failed or uncertain call | An independent periodic job reads committed call outcomes and inserts at most one warning per session. It accepts an explicit failed or unknown state, termination with a network error, or an unknown termination backed by a projected cellular leg. Normal hangup, no answer and an unarmed restart compensation do not qualify. Acknowledgement retains history. [Call alerts](../core/src/calls/failure-alerts.ts) |
| Incompatible protocol | An identifiable incompatible hello is eligible only after verifying the enabled device and its original credential. Bounded diagnostics do not participate in admission. Recovery requires a compatible response sent on the current attachment; this is local send evidence, not a remote receipt. [Protocol alerts](../core/src/devices/protocol-alerts.ts) |
| Shizuku autostart failed | Three qualifying failures from the authorized loopback reporter, with the device mapping and model checked. The observation window is 30 seconds. Failures less than five seconds apart are suppressed as likely duplicates. A serial change or expired observation resets the streak. Confirmed started or already running closes the incident without implying Android Binder or media readiness. The report lacks an observation ID or source timestamp, so delayed replay cannot be ruled out. [Host reports](../core/src/devices/shizuku-report.ts) |

This release provides administrator readback and best-effort realtime events. Forwarding and periodic redelivery to paired QQ or Telegram users are not connected. Production PostgreSQL and physical-device acceptance remain separate.

### Exceptional SMS custody

`VOIPGW_SMS_CUSTODY_MODE` defaults to `disabled`. Normal SMS continues through normal ingestion in every mode. The table covers exceptional events eligible for custody.

| Mode | Exceptional event handling in Core | Device queue head |
| --- | --- | --- |
| `disabled` | Record the ingestion block and preserve the normal data boundary. | Keep pending without a positive event ACK. |
| `retain` | Persist the quarantine row, linked event marker and alert. | Keep the original event without a positive event ACK. |
| `acknowledge` | Eligible custody and exact replay may receive a positive ACK after complete evidence and confirmed commit. | A matching ACK can advance the head. The event remains in quarantine. |

`retain` / `acknowledge` require an existing `VOIPGW_SMS_CUSTODY_ADMIN_ID`. Startup checks primary-database durability settings, migrations, tables and privileges. Custody transactions explicitly request synchronous commit. The custody read routes are enabled when the operator ID is configured. The designated administrator can read metadata with `GET /api/admin/sms-quarantine` and request an audited single-row export with `GET /api/admin/sms-quarantine/:id/export`. Integrity errors need investigation. Protect messages, identifiers and exported files. [Inbound SMS](../core/src/devices/inbound-sms.ts) [Custody writes](../core/src/db/sms-quarantine-custody.ts) [Custody access](../core/src/http/sms-quarantine-inventory.ts)

### Migrations and runtime topology

- Core acquires an exclusive advisory lock through a dedicated direct PostgreSQL session, then migrates and reconciles before it listens. Run one Core per database. Transaction-pooling proxies, multiple Core replicas and automatic failover are unsupported. Lock loss initiates shutdown. When restarting after a failed exit or uncertain commit, confirm the old process and its database session have stopped. [Ownership](../core/src/db/ownership.ts) [Startup](../core/src/main.ts)
- SQL filenames have four-digit versions. The runner orders files by name and records applied versions in `schema_migration`. It commits each SQL file with its version record. Relevant versions include `0015` for ACK provenance, `0016` for the SMS admin outbox, `0019` for dispatch attempts, `0021` for maintenance invalidation, `0023` for inbound SMS custody, and `0024` for binding replay and cancellation. [Migration runner](../core/src/db/migrate.ts) [Migrations](../core/migrations/)
- Android SQLite v4 persists binding and queue fences. v5 adds fields for pending v2 requests. Legacy credentials, unscoped events, and damaged or otherwise unreconciled bindings need investigation. Verify migration and readback from the actual installed source version. [Binding and outbox](../android/app/src/main/kotlin/io/voipgw/gateway/core/Outbox.kt) [SQLite fixtures](../android/app/src/test/test_binding_fence_sqlite.py)

The synthetic demo serves the built Web application from a local in-memory API. Its captures show administration flows with fixture results. [Demo](../README.md#quick-demo)

For fresh installation, recovery steps and native checks, see [Usage](USAGE.md). Check production gates in the [release checklist](RELEASE-CHECKLIST.md). The earlier [binding design](16-android-retry-safe-device-binding.md) and [dispatch uncertainty note](17-sms-dispatch-uncertainty.md) record historical proposals and gaps from their source snapshots.
