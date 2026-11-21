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
- Core 从接管 `/ws/device` 起计固定 5 秒，以单调时钟在消息接纳、排队处理、令牌核验、配置读取及设备串行接管时复核。同一窗口内需要开始本地发送 `hello.ok`；超时使用 `4001`，不依赖计时器先执行。已观察到的关闭优先；能确定设备身份时，记录的撤权或较新鉴权代次优先于普通超时。候选若在进入接管前已过期或正在关闭，不动仍有效的旧连接。已有关闭动作不能撤销；同步回调后仍会检查候选是否可发出应答。
- 命令目标和配置下发资格在 Core 向仍打开且当前的 socket 本地提交 `hello.ok` 后才登记。这不是设备收到应答或已写入配置的证明。及时通过鉴权的较新候选即使后来超时，仍约束更早的候选；不回退到旧代次。关停停止新接纳，但不放宽时限，仍等待已接纳的查询及队列排空。Android 独立的应答窗口不变。[设备会话](../core/src/ws-device/session.ts)
- WebSocket 的 `onOpen` 为当前连接启动独立的 10 秒握手时限；按 `elapsedRealtime` 判断接纳 `hello.ok` 的时机，过期应答在应用配置前拒绝。定时回调仍服从系统调度，不保证设备休眠时唤醒；提前运行只安排剩余等待时间。超时时服务主动退出并取消旧连接，不等待旧连接回调。确认持久代次释放才进入原有重连退避；已观察到终止原因或释放不明时停止，待人工核对。不改变待发事件、设备 ACK 或后续回执对账。[握手时限](../android/app/src/main/kotlin/io/voipgw/gateway/core/HelloDeadline.kt)
- 事件队列仅等待当前连接的一个在途队头。10 秒 ACK 看门狗是系统调度的检查，不是拒绝迟到 ACK 的绝对时限；只要 ACK 先获准、连接仍有效、`ok` 为布尔真且 `error` 为显式空值，就可在确认正好删除原绑定的原事件之后推进。匹配确认或关闭会撤销对应回调。重复的同队头超时按原绑定 ID 和原事件 ID 在服务内累计，跨连接与握手保留；重连等待取该记忆队头的退避与普通连接退避中较长者（最长 30 秒）。确认删除、成功读到不同或空队头，或改用新绑定即不再继承旧队头退避。读取或删除不明不当作进展。看门狗只退出当前连接，仍受终止原因和持久释放结果约束；不更改短信发送命令、防重、队列顺序或托管规则。服务重建后重新计数。[队头退避](../android/app/src/main/kotlin/io/voipgw/gateway/core/OutboxReconnectBackoff.kt)

### 设备配置同步

Core 在握手时提供当前心跳周期和语言。设置变更会唤醒独立的配置对账任务；任务每次读取数据库已提交值，不转发请求值。不确定提交会使在途读取失效，随后再次以权威读回为准。已提交设置的 HTTP 结果不是设备 ACK。每轮最多并发核对 8 台完成握手的设备，按设备轮转。仅当前连接对本次命令 ID 的正向确认可结束重试；不确认或负向应答有 30 秒退避，新值或新连接可立即重新纳入批次。关停先禁止新写入并排空在途工作。此重试仅用于幂等配置，不发送短信，也不重新拨号。[配置对账](../core/src/settings/device-config.ts) · [设备命令](../core/src/ws-device/commands.ts)

短信就绪统计和短信权限告警统一使用限时的三态观测。只有发送和接收权限均已明确授予才计入就绪。明确缺少任一权限可触发权限告警，同项记录矛盾或格式不明则不作该项结论。统计不能证明短信实际发送或送达。[权限证据](../core/src/devices/sms-permissions.ts)

### 短信调度和 ACK

Core 在准许发送并开始调用本地 socket 发送时开启 10 秒单调窗口，不把申领或发送前的检查计入这段时间。按原设备、原连接及命令 ID 匹配，以 **Core 处理 ACK 时** 为准：已经排队但处理时达到截止的正向和负向 ACK 都不结算该命令。回调迟到不能延长截止；较早触发只等待剩余时间。计时器、替换连接和发送错误只清理各自的在途记录，不以超时代替拒绝 ACK，也不关闭仍健康的连接。生产短信沿用这一条传输时限；不确定的发送按原申领记录为 `unknown`，不重放。独立的短信或通话结果事件仍按各自规则对账。[设备命令](../core/src/ws-device/commands.ts) · [短信派发](../core/src/sms/dispatch.ts)

| 边界 | 可下结论 | 恢复依据 |
| --- | --- | --- |
| 管理端提交 | `POST /api/sms` 使用 `Idempotency-Key`。匹配的响应确认 Core 已记录请求。 | Web 在发送前保存原始待确认意图。`GET /api/sms/idempotency` 读取已提交结果。空结果可能与另一个尚未结束的提交并存。 [HTTP 接口](../core/src/http/server.ts) [Web 短信用例](../web/src/features/sms/send-sms.tsx) |
| 任务调度 | Core 从 `queued` 原子申领并记录调度尝试，确认申领后才下发。考虑设备可用性、SIM 状态、每 SIM 顺序、限速与过期。 | 当申领、发送或 ACK 持久化结果不确定时，保留同一次尝试的身份和证据，按原任务核对。确认无法安全下发的过期或退役排队任务进入失败。 [调度器](../core/src/sms/dispatch.ts) [尝试仓库](../core/src/sms/attempt-repo.ts) [队列仓库](../core/src/sms/queue-repo.ts) |
| 设备命令 ACK | 正向 ACK 表示 Android 已接受任务入队。Core 状态可变为 `accepted`。 | 从待提交到确认结果要看独立的设备事件。超时、进程停止或迟到/矛盾事件可能产生 `unknown`。 [短信状态](../core/src/sms/state.ts) [结果协调](../core/src/sms/results.ts) |
| 设备事件 ACK | Core 在持久化或认可精确重放后，按当前连接返回对应正向 ACK。Android 以同一事件 ID 的正向 ACK 推进本地 outbox。 | 持久化未知时保留原有事件。隔离模式可能阻止队头前进。 [设备连接](../core/src/ws-device/session.ts) [事件投影](../core/src/devices/event-producer.ts) [Android outbox 节流](../android/protocol/src/main/kotlin/io/voipgw/protocol/OutboxPacer.kt) |
| 系统或运营商结果 | `sent`、`failed`、`unknown` 是独立的设备结果。`delivered` 需要独立且可靠的投递证据。 | 当前 Android 回调路径不从系统发送回执推断运营商投递。真实短信、送达和通话需要独立验收。 [Android 回调](../android/app/src/main/kotlin/io/voipgw/gateway/sms/SmsCallbackReceiver.kt) [结果协调](../core/src/sms/results.ts) |

Android 将发送回执绑定到原设备绑定、连接代次、任务和短信分段。全部分段都有一致结果时，才报告 `sent` 或 `failed`。成功与失败分段并存会保留 `unknown/SMS_PARTIAL_SEND`。同一分段的相矛盾回执会报告 `unknown/SMS_CALLBACK_CONFLICT`。Core 保留原始事件，并将已确认的矛盾投影为 `unknown/SMS_RESULT_CONFLICT`，后续普通回执无法覆盖它。迟到回执须与原申领匹配。旧版未携带申领标识的回执留待对账。所有未知结果沿用原任务且不自动重发。[Android 回执判定](../android/app/src/main/kotlin/io/voipgw/gateway/sms/SmsSendEvidence.kt) · [Core 结果对账](../core/src/sms/results.ts)

Core 在启动核对和周期维护中处理遗留状态、队列过期、退役 SIM 和管理员更新信号。队列发现与命令 ACK 分开执行。Core 为每张活跃 SIM 读取独立的有序批次，根据各 SIM 的限速等待时间安排设备唤醒。已确认的速率变更唤醒受影响设备。提交成功但读取不到新值时，暂停下发直到取得当前值。提交本身不明确时，暂停下发直到在独占所有权下完成核对并重启。WebSocket 广播与清理持久化标记之间发生故障可能产生重复通知。管理端将通知用于触发读回。 [启动入口](../core/src/main.ts) [速率运行逻辑](../core/src/sms/rate-runtime.ts) [队列仓库](../core/src/sms/queue-repo.ts) [维护通知](../core/src/sms/maintenance-invalidation.ts)

入站短信的历史和通知标记同事务写入；精确重放不生成第二条历史或恢复已清理的标记。独占所有权下的单个 Core 读取已提交的标记及短信历史后先归还连接，再进行管理员鉴权及广播。广播调用返回后仅清理相同事件 ID 与数据库原始微秒时间的标记；找不到原标记时留给下一次发现。清理回执不明时保留不确定性，之后依据数据库读回，可能重复广播。即使没有客户端，广播尝试也可以完成；不代表浏览器收到消息。Web 仅使短信查询失效并通过 REST 读回。停止或启动失败时冻结新尝试，正常停机排空已开始的工作；观察到所有权丢失时不再提交新的发送或清理，不能撤销已经发出的操作。设备持久化 ACK、SIM 归属与平台转发范围不变。[入站通知队列](../core/src/sms/incoming-outbox.ts) · [通知消费](../web/src/realtime/admin-socket.ts)

周期发现每次返回最多 32 台设备，用设备 ID 游标续扫；多读一条作为是否续扫的依据，见底后下一轮回到开头。确认速率前最多暂存 256 个去重的直接唤醒。派发最多并行处理 4 台设备，普通待处理唤醒最多 256 个，溢出的唤醒由后续持久队列扫描或设备事件补回，短信任务本身不被丢弃。已有设备等候且当前轮达到 2 秒时，完成在途步骤后让位，后续轮次按 SIM 游标继续；2 秒不是对认领或 ACK 的硬超时。暂停或停止不再接纳新的普通工作。已接纳的发送及其结果写入需要排空；持久化失败只处理已有尝试，不重发。当前已认证连接插入并提交新的 SIM 快照后，可提前请求队列重新检查；只写入历史的快照也可能发出提示，鉴权、设备在线状态、SIM、速率和原任务仍在派发时重新检查。

通话控制在外部下发前复核管理员会话、设备连线和会话状态。挂断与同一通话的进展协调。Web 通话还受明确的设备验收名单限制，Android 对通话命令返回不支持。 [通话状态机](../core/src/calls/web-calls.ts) [启动与能力设置](../core/src/main.ts) [Android 通话命令](../android/protocol/src/main/kotlin/io/voipgw/protocol/UnsupportedCallCommand.kt)

Core 在获取独占所有权后、监听前，以每事务最多 64 条会话进行重启对账。按不可变 ID 续扫并保留已确认批次，遇到未确认提交则停止启动，不自动重拨或挂断。仅靠 `awaiting_browser` 不足以认定没有拨号：还需原始预约与身份事件、两条未使用的腿、无尝试及无操作证据。缺少证明时保留 `unknown`；未知 Web 会话仍阻止同设备新外拨。浏览器认领在取得锁之后按数据库时钟核验 30 秒有效期。后台任务每次最多检查 16 条过期预约，锁冲突跳过，后续轮转复核；状态、两条腿及事件原子更新，确认提交后才尽力通知。此清理不会发送任何设备或媒体命令。[启动对账](../core/src/calls/reconcile.ts) · [预约回收](../core/src/calls/web-reservations.ts)

自动化测试可显式注入按通话代次运行的内存设备夹具，覆盖过期连接、挂断匹配和媒体开启失败。普通设备模拟器的 Shizuku 状态保持不明。真实 Web 通话仍需要验收名单、实际设备控制和有效的双向音频。[内存通话夹具](../tools/device-simulator/README.md)

### 浏览器通话控制与音频

- 挂断与本地音频分开。只有发起通话的同一管理员会话能在拨号页操作原通话。此页须读回匹配的会话、设备、SIM 与浏览器腿，再确认挂断；读回超过 5 秒、失效或状态不允许时不发送。DTMF 仍要求处于桥接状态且本地音频可用。Core 继续复核所有者、设备连接与信令状态。[拨号界面](../web/src/features/calls/browser-dialer.tsx) · [Core 控制](../core/src/calls/web-calls.ts)
- 挂断受理或结果未知时，在当前页面运行期间以管理员会话和原通话为范围保留防重记录；同会话切页返回不会补发。超时或离开页面后，迟到的回复不能覆盖本地未知结果。按“刷新通话状态”单独读回；只有持久通话记录才能说明最终状态。本地关闭时不主动发挂断，不把结果写入持久存储；硬刷新或重新登录不会从浏览器恢复控制权。
- 音频鉴权文本先发，之后按每个 652 字节 PCM 消息检查 WebSocket 的 `bufferedAmount`，含仍排队的鉴权数据。加上本帧会超过 4 KiB 时直接丢弃，但推进 uint32 序号；无重放或自动重连。这是浏览器 API 可见的应用字节限制，不含底层缓冲或端到端时延。发出鉴权消息不等于 Core 已确认认证，更不等于双向音频已建立。[音频传输](../web/src/audio/media-transport.ts)

### 媒体接收与断流

Core 按接收端单调时钟计算帧到达后的年龄；待鉴权和待播放的帧超过 300 ms 即丢弃，这不是端到端延迟承诺。5 秒鉴权截止在处理认证结果或消息时直接检查，不依赖超时回调先执行。抖动缓冲最多保留 15 个序号槽，丢弃的样本不会因为重复发送而重新计时。长间隔后用向前推进的序号重新缓冲。已认证且仍获授权的每条通话腿独立检查：接入或最近一次新帧入队满 2 秒后，可记录一次 `media_stalled`，直至下一帧成功入队。日志包含会话 ID、腿 ID 和诊断名，不写媒体内容或凭据。缺帧补静音；断流本身不触发挂断，也不证明通话已经结束或真机双向音频已经验收。[传输](../core/src/media/transport.ts) · [缓冲](../core/src/media/jitter.ts) · [协调](../core/src/calls/web-calls.ts)

### 设备健康与运维告警

Core 在现有单实例定时任务中扫描四类设备告警。只有曾联系过且已经超时的设备会触发离线告警。Shizuku 不可用和 SIM 锁定或缺失需要持续 60 秒的有效采样。缺少权限告警需要明确的短信权限拒绝。SIM 清单不可观测时，Android 仍可上报独立的短信权限，空清单保持非权威。过期或不明证据保留既有告警状态。确认告警保留历史，同一次故障期间继续抑制重复提示。观察到恢复后，新的故障才会再次提示。Core 在事务确认后推送变化，Web 告警列表每 30 秒回读当前页。[健康告警](../core/src/devices/health-alerts.ts) · [Web 告警列表](../web/src/features/records/records.tsx)

| 运维告警 | 触发与恢复 |
| --- | --- |
| 渠道不可用 | 先前确认登录的渠道，经当前适配器报告离线、退出或封禁，或检测到意外断开。当上次 Core 异常中止而仍留下已登录状态时，启动核对也可打开告警。新连接初始化和正常关闭本身不视为掉线。后续核验登录后关闭故障。 [渠道状态](../core/src/channels/repo.ts) |
| 通话失败或结果未知 | 定时单独读取已提交的通话结果，每个会话最多一条。接受明确失败或未知状态、以网络错误终止，以及实际蜂窝腿证据支持的未知结束。正常挂断、不接听和未执行的重启补偿不触发。确认后保持历史。 [通话告警](../core/src/calls/failure-alerts.ts) |
| 协议不兼容 | 只记录可识别的版本不兼容握手，并复核启用设备和原凭据。有界诊断不参与连接准入。后续在当前连接发送兼容应答后才可解除；该应答是本机发送证据，不是远端回执。 [协议告警](../core/src/devices/protocol-alerts.ts) |
| 自启失败 | 受信回环上报经设备映射和型号复核后，累计三次合格的失败。储存窗口 30 秒，短于 5 秒的失败间隔视为疑似重复；新序列或过期会重置计数。明确启动或已运行会解除，不改变 APK Binder 或媒体能力。因报文没有观察 ID 和源时间，无法排除延迟重放。 [自启上报](../core/src/devices/shizuku-report.ts) |

告警页每次只读取和刷新当前页（默认 50 条），仪表盘只读最新 5 条开放告警。游标使用数据库的微秒时间和记录 ID，并绑定所选状态。游标不提供历史快照；回到最新页可查看游标之前出现的新告警。旧客户端未传 `limit` 和 `cursor` 时仍读取全部匹配告警。升级时先部署支持分页的 Core，再切换 Web；新 Web 不会退回整表读取。分页限制返回记录数，不代表已对大表查询计划做过实库验收。确认操作在一个事务内复核原管理员会话、将开放告警改为已确认并记录审计。确认不等于恢复；收到 `TIMEOUT_UNKNOWN` 时先读回告警和操作日志。 [告警仓库](../core/src/alerts/admin-repo.ts)

当前发布范围是管理端告警读回与最佳努力的实时通知。配对用户的 QQ/Telegram 告警转发和定期重推尚未接通。生产 PostgreSQL 和真实设备验收仍需独立完成。

### 管理端连接恢复

Core 从接管 `/ws/admin` 的 WebSocket 起，在单调时钟上确定固定 5 秒首条鉴权窗口；新消息接纳、出队、发起令牌核验前和查询返回均复核截止。达到截止仍未通过首条鉴权就按 `4401` 分离并请求关闭，不注册管理订阅，也不处理之后的排队心跳。截止前凭据或鉴权帧校验未通过仍是 `4403`，内部或解析异常走 `1011`；先观察到的撤权或断线不会被迟到的查询结果覆盖。关停立即冻结新接入和新消息，截止仍生效，但不会取消已经接纳的查询，仍须排空；及时通过首条鉴权后，已接纳的 `ping` 仍重新验证会话。5 秒不是关停用时上限，也不是令牌有效期。[Core 管理会话](../core/src/ws-admin/session.ts)

当前管理员会话为每次连接分别等待 WebSocket 打开和首个 `pong`，各 10 秒；打开后先发鉴权帧，再发 `ping`。首个及时应答前不显示已连接，也不消费业务提示。就绪后每 25 秒检查是否可以发心跳，最多一个 `ping` 等待应答。只有存在未应答的 `ping` 时接纳的 `pong` 才续期 60 秒有效窗口。打开和消息处理也按单调时钟复核截止，不依赖计时器准时执行。超时、错误或发送失败先注销本地连接、清理计时器，再尝试关闭底层连接；不等待 `close` 回调才重连。重连受会话版本和连接身份约束，等待 1、2、4、8、16、30 秒（封顶），及时收到首个应答才清零。恢复只请求一次查询缓存失效；刷新失败不代表连接断开，连接成功也不保证数据已刷新。不自动重新发起写入。旧连接的登录提示作废；在途或结果未知的操作保留原身份，按原操作核对。浏览器冻结期间不保证计时回调准时执行或唤醒系统。[管理连接](../web/src/realtime/admin-socket.ts)

### 平台适配器握手和通知

- 当前 IPC 连接依次处理 `adapter.hello`、`capabilities`、`account.state`。初始能力仅暂存在 Core；首条账号状态与有效登录能力、既有登录观察标记及适用的渠道告警在同一行锁事务中写入，确认提交后才给最终状态正向 ACK。随后能力更新只保留有效登录位，平台收发消息、语音和并发通话能力均关闭。启动、替换和断开仍按原规则区分重置与已观测掉线。Core 的 IPC 就绪不代表已登录或账号身份已验证。[渠道存储](../core/src/channels/repo.ts) · [连接管理](../core/src/channels/adapter-manager.ts)
- 写入复核进程所有权和当前连接，提交命令发出前再检查一次。检查不能撤销已经发出的数据库提交；结果不明或清理失败仍作为失败或未知交由原有逻辑处理，不自动重发账号控制请求。
- 管理广播独立于报告处理：每平台一个在途通知任务，频道、告警、登录步骤各一个最新提示槽。提示可能合并或丢失，旧连接或已失效的挑战不会在发送前仍通过校验。关停冻结新通知并等待已开始的任务。通过管理接口重新读取状态和操作记录；错过的步骤可手动只读恢复。[运行时](../core/src/channels/adapter-runtime.ts) · [恢复边界](platform-login-recovery.md)

- 错过提示时，Web 提供明确的只读操作。Core 只在没有本地操作与读回重叠、没有持久阻断记录、原管理员会话复核通过且挑战仍一致时返回当前步骤。空值不表示登录结果。Web 在当前管理会话、连接与平台观测仍有效时采用结果，读回和提示更换均清空输入。提交必须带 Core 生成的原挑战 ID；同名新提示、连接更换或已有发送会让旧标识失效。此标识只在 Core 与管理端内存传递，不进入适配器 IPC，不是账号控制命令的幂等键或管理员凭据。
- 账号命令从获准的本地 IPC 写入开始计时：10 秒截止前接纳正常 ACK；达到截止后最多再保留 30 秒存证窗口，起点包含、终点不包含。两段共用单调时钟；回调提前只安排剩余时间，延迟也不移后截止。断开或换代丢弃尚未接纳的证据，已接纳的存证写入仍会排空。匹配的迟到正 ACK 只绑定原平台与持久操作，不改变原 HTTP 504，也不自动释放；首个匹配的迟到负 ACK 消耗机会但不存证。 [适配器会话](../core/src/channels/adapter-manager.ts) · [恢复边界](platform-login-recovery.md)

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
- Core applies one fixed five-second monotonic window from accepting `/ws/device`, checking it at message admission, queued processing, token verification, configuration read, and serialized takeover. Core must begin submitting `hello.ok` locally within that window; expiry uses `4001` even if the timer callback has not run. A previously observed close wins; for an identified device, recorded revocation or a higher authenticated admission takes precedence over generic expiry. If the candidate is already expired or closing before takeover, the current socket is left alone. An old close already issued cannot be undone, and eligibility is checked again after that synchronous callback.
- Commands and config delivery become eligible only after local submission of `hello.ok` to a current, open socket. This does not prove delivery or device-side configuration. A newer timely authentication still fences an older candidate if subsequent work times out; Core does not fall back to the older admission. Shutdown freezes new admission without relaxing the deadline or abandoning already-admitted lookup and lane work. Android’s separate reply timeout is unchanged. [Device sessions](../core/src/ws-device/session.ts)
- WebSocket `onOpen` arms a separate ten-second handshake deadline for the current connection. `hello.ok` admission uses `elapsedRealtime` and rejects replies at or past the deadline before applying configuration. Timer callbacks are still subject to OS scheduling and do not wake a sleeping device; an early callback only schedules the remaining time. On expiry the service retires and cancels the old socket without waiting for its callback. Only confirmed durable generation release permits normal reconnect backoff. A previously observed terminal reason or unconfirmed release still stops the service for reconciliation. Pending events, device ACKs, and result reconciliation are unchanged. [Hello deadline](../android/app/src/main/kotlin/io/voipgw/gateway/core/HelloDeadline.kt)
- The outbox waits on one in-flight head for the current connection. The ten-second ACK watchdog is a scheduled check, not a hard reply cutoff: a valid ACK admitted first can still advance. Advancement requires a matching ACK with boolean `ok: true`, explicit `error: null`, and confirmed deletion of exactly one row for the original binding and event. Completion or closure cancels that watchdog. A service-local streak tracks repeated timeouts for the same binding ID and event ID across reconnects and successful hellos. Reconnect uses the longer of transport backoff and the remembered head delay, capped at 30 seconds. Confirmed deletion or a successful different/empty head read clears it; another binding does not inherit it. Failed or uncertain reads/deletions do not prove progress. The watchdog can only retire the current connection, with terminal and unconfirmed release rules unchanged. It does not change SMS commands, deduplication, queue order, or custody policy. A new service instance starts fresh. [Queue-head backoff](../android/app/src/main/kotlin/io/voipgw/gateway/core/OutboxReconnectBackoff.kt)

### Device configuration sync

Core supplies the current heartbeat interval and locale during hello. A settings change wakes the independent configuration reconciler, which reads committed database values rather than forwarding the request payload. An uncertain commit invalidates in-flight reads; subsequent passes use authoritative readback. A successful HTTP save is not a device ACK. Each pass reconciles up to eight post-hello attachments in rotation. Only a positive ACK for that command on the current connection confirms application. Missing or negative ACKs back off for 30 seconds; a new value or attachment is eligible on the next pass. Shutdown fences new sends and drains work. This retry policy applies only to idempotent configuration, never SMS or calls. [Reconciler](../core/src/settings/device-config.ts) · [Command transport](../core/src/ws-device/commands.ts)

SMS readiness counts and permission alerts share the same time-bounded, three-way interpretation. Both send and receive grants must be unambiguous to count as ready. An independent explicit denial can raise an alert; contradictory or malformed evidence is inconclusive for that permission. Readiness does not prove SMS submission or delivery. [Permission evidence](../core/src/devices/sms-permissions.ts)

### SMS scheduling and ACKs

Core starts a ten-second monotonic window when it admits and begins the local socket send, not during a durable claim or pre-send checks. It matches the original device, attachment, and command ID when **processing** the ACK. Either ACK polarity at or after the deadline is ineligible, even if the message was queued earlier or the watchdog has not run. Early wakeups use only the remaining time. Timeout, replacement, and send cleanup retire only their exact pending attempt. A timeout is not a NACK and does not close an otherwise healthy connection. Production SMS uses this transport deadline and records unresolved claims as `unknown` under their original identity without replay. Separate SMS or call result events still follow their own reconciliation rules. [Device commands](../core/src/ws-device/commands.ts) · [SMS dispatch](../core/src/sms/dispatch.ts)

| Boundary | What it establishes | Recovery evidence |
| --- | --- | --- |
| Admin request | `POST /api/sms` uses an `Idempotency-Key`. A matching response confirms that Core recorded the request. | Web saves the original pending intent before sending. `GET /api/sms/idempotency` observes committed state. An absent result can coexist with an in-flight transaction. [HTTP API](../core/src/http/server.ts) [Web SMS form](../web/src/features/sms/send-sms.tsx) |
| Dispatch | Core atomically claims a `queued` task and records an attempt. It sends only after the claim is confirmed, subject to device and SIM readiness, per-SIM order, rate and expiry. | Preserve the attempt identity and evidence when claim, send or ACK persistence is uncertain. Expired or retired work that is still queued can transition to failure. [Dispatcher](../core/src/sms/dispatch.ts) [Attempt repository](../core/src/sms/attempt-repo.ts) [Queue repository](../core/src/sms/queue-repo.ts) |
| Device command ACK | A positive ACK reports that Android accepted the task into its queue. Core may move the task to `accepted`. | Check the separate device result. A timeout, process stop, or late/conflicting observation can produce an `unknown` outcome. [SMS state](../core/src/sms/state.ts) [Result reconciliation](../core/src/sms/results.ts) |
| Device event ACK | Core can return a matching positive ACK on the current connection after persistence or recognition of exact replay. Android advances the local outbox on a positive ACK for the same event ID. | Keep the original event when persistence is uncertain. Quarantine mode can determine whether the queue head advances. [Device socket](../core/src/ws-device/session.ts) [Event projection](../core/src/devices/event-producer.ts) [Android outbox pacing](../android/protocol/src/main/kotlin/io/voipgw/protocol/OutboxPacer.kt) |
| Android or carrier result | `sent`, `failed` and `unknown` are separate device results. `delivered` requires independent delivery evidence. | The current Android callback does not infer carrier delivery from the platform send result. Actual SMS, delivery and calls need separate acceptance. [Android callback](../android/app/src/main/kotlin/io/voipgw/gateway/sms/SmsCallbackReceiver.kt) [Result reconciliation](../core/src/sms/results.ts) |

Android scopes each send callback to the original binding, connection generation, task and SMS part. It reports `sent` or `failed` when every part has a matching result. A mix of successful and failed parts stays `unknown/SMS_PARTIAL_SEND`. Contradictory callbacks on one part produce `unknown/SMS_CALLBACK_CONFLICT`. Core preserves the source event and projects confirmed contradiction as `unknown/SMS_RESULT_CONFLICT`, which subsequent ordinary callbacks cannot overwrite. Late callbacks must match the original claim. Legacy unscoped callbacks require reconciliation. Unknown work retains the original task and never triggers automatic resend. [Android send evidence](../android/app/src/main/kotlin/io/voipgw/gateway/sms/SmsSendEvidence.kt) · [Core reconciliation](../core/src/sms/results.ts)

Core runs startup reconciliation and periodic maintenance for earlier state, queue expiry, retired SIMs and administrator notifications. Queue discovery runs independently of command ACKs. Core reads a bounded FIFO batch for each active SIM and schedules device wakeups using each SIM’s rate-limit delay. A confirmed rate change wakes affected devices. When a rate write committed without returning the new value, dispatch waits for a fresh read. When the commit itself is uncertain, dispatch stays suspended until reconciliation and restart under exclusive ownership. If Core fails between WebSocket fanout and clearing the durable marker, it can publish a duplicate. The admin console refetches authoritative state on notification. [Startup](../core/src/main.ts) [Rate runtime](../core/src/sms/rate-runtime.ts) [Queue repository](../core/src/sms/queue-repo.ts) [Maintenance notifications](../core/src/sms/maintenance-invalidation.ts)

Incoming SMS history and its notification marker commit together. Exact event replay does not create a second history entry or restore a consumed marker. Under exclusive ownership, one Core reads the committed marker and history and releases its checkout before subscriber authorization and fanout. After the broadcast call resolves, cleanup matches both the event ID and original microsecond timestamp; a mismatch is left for later discovery. An uncertain cleanup response can repeat a hint on a later database read. A completed attempt can have no subscribers and never proves browser receipt. Web invalidates SMS queries and reads REST rather than appending the event payload. Stop or startup failure freezes new attempts, while graceful shutdown drains admitted work. Observed ownership loss fences new sends and cleanup but cannot undo work already issued. Device persistence ACKs, SIM attribution, and platform forwarding are unchanged. [Incoming outbox](../core/src/sms/incoming-outbox.ts) · [Notification consumer](../web/src/realtime/admin-socket.ts)

Periodic discovery returns at most 32 devices at a time and uses a device-ID cursor. It reads one extra candidate for lookahead and wraps on a later pass. Before the rate is confirmed, it retains up to 256 distinct direct wake hints. Dispatch permits four active device turns and up to 256 waiting ordinary wakes. If a wake is dropped, durable queued work can be rediscovered by a later scan or device event. With another device waiting, a turn that reaches two seconds yields after its current step, and the next turn resumes SIM rotation. This is not a hard deadline for database claims or ACKs. Pause and shutdown close ordinary admission. Admitted work drains; persistence recovery applies only to the original attempt and does not send it again. A newly inserted, committed SIM snapshot from the current authenticated attachment can request an earlier eligibility recheck. History-only snapshots can also wake that check; device, SIM, rate and task authority still come from the normal admission path.

Call controls recheck the administrator session, device connection and call state before sending. A hangup is serialized with progress on the same call. Web calling requires an explicit list of verified devices. Android reports call commands as unsupported. [Call state machine](../core/src/calls/web-calls.ts) [Startup and capability settings](../core/src/main.ts) [Android call commands](../android/protocol/src/main/kotlin/io/voipgw/protocol/UnsupportedCallCommand.kt)

After acquiring exclusive ownership and before listening, Core reconciles at most 64 locked call sessions per transaction. It advances by immutable ID after a confirmed commit. An unconfirmed commit stops startup rather than redialling or sending hangup. An awaiting-browser state alone is not proof of no dial: the original reservation and identity events, two unused legs, and the absence of attempts and action evidence are required. Missing proof leaves the outcome unknown, and an unknown Web call continues to block a new dial on that device. Browser arming checks the 30-second cutoff against the database clock after locking. A background pass checks up to 16 expired reservations, skips contended locks, and revisits after wrapping. Session, legs and event change in one transaction; best-effort notification follows confirmed commit. The sweep has no device or media command path. [Startup reconciliation](../core/src/calls/reconcile.ts) · [Reservation sweep](../core/src/calls/web-reservations.ts)

Offline tests can inject a generation-aware in-memory device fixture to exercise replaced connections, exact hangup matching and failed media setup. The ordinary simulator reports Shizuku as unknown. Real Web calling still requires a verified allowlist, physical device control and working two-way audio. [In-memory call fixture](../tools/device-simulator/README.md)

### Browser call control and audio

- Hangup is independent of local audio. Only the administrator session that opened the call can request hangup from its dialer. It must read back the matching session, device, SIM and browser leg and explicitly confirm. A read older than five seconds, invalidated, or in an ineligible state does not authorize the request. DTMF still needs a bridged call and usable local audio. Core continues to recheck ownership, the device attachment, and signalling state. [Dialer](../web/src/features/calls/browser-dialer.tsx) · [Core control](../core/src/calls/web-calls.ts)
- An accepted or uncertain hangup retains an in-memory lock for the original call and administrator session across route changes. A late reply cannot overwrite an uncertain result after timeout or navigation. Use Refresh call status to read back the stored outcome separately. Closing local audio does not send hangup. The browser does not restore controls after a full reload or a new login.
- The authentication text is sent first. Each 652-byte PCM message then checks WebSocket `bufferedAmount`, including any queued authentication bytes. A chunk that would exceed 4 KiB is dropped while advancing the uint32 sequence. Drops are not replayed and the transport does not reconnect. The bound covers application bytes visible to the browser API, not lower-layer buffers or end-to-end latency. Sending auth does not prove that Core accepted the attachment or that two-way audio works. [Audio transport](../web/src/audio/media-transport.ts)

### Media receive timing and stalls

Core uses a monotonic receiver clock for both the queue awaiting authentication and playout. Frames older than 300 ms are dropped, not replayed; this is not an end-to-end latency guarantee. The five-second authentication deadline is checked directly and does not rely on the timeout callback running first. The jitter buffer keeps at most 15 sequence slots and does not re-age discarded samples when a duplicate arrives. After a gap, a forward sequence re-primes playout. Each authorized attached call leg is checked separately: two seconds since attachment or its last newly accepted frame can log one `media_stalled` until a new frame is accepted. The diagnostic contains the session ID, leg ID, and event name, not audio or credentials. Missing frames produce silence. A stall alone neither triggers a hangup nor establishes a terminal call or verified two-way cellular audio. [Transport](../core/src/media/transport.ts) · [Buffer](../core/src/media/jitter.ts) · [Coordinator](../core/src/calls/web-calls.ts)

### Device health and operational alerts

The single Core process periodically reconciles four device health alerts. An offline alert requires a previously observed device and a confirmed timeout. Shizuku unavailability and a locked or absent SIM require 60 seconds of fresh unhealthy samples. A missing SMS permission requires an explicit denial. Android can still report SMS permissions when its SIM inventory is unknown, using an empty non-authoritative inventory. Stale or inconclusive evidence leaves the existing alert state in place. Acknowledgement preserves history and suppresses repeat warnings within the same incident. Confirmed recovery allows a later incident to raise a fresh alert. Core emits changes after commit and the Web alert list refetches the current page every 30 seconds. [Health alert reconciliation](../core/src/devices/health-alerts.ts) · [Web alert list](../web/src/features/records/records.tsx)

| Operational alert | Trigger and recovery |
| --- | --- |
| Channel unavailable | A previously confirmed login changes to offline, logged out, banned, or unexpectedly disconnected. Startup also reconciles a logged-in state left by an interrupted Core. An attachment reset or graceful shutdown alone does not prove loss. A confirmed subsequent login closes the incident. [Channel state](../core/src/channels/repo.ts) |
| Failed or uncertain call | An independent periodic job reads committed call outcomes and inserts at most one warning per session. It accepts an explicit failed or unknown state, termination with a network error, or an unknown termination backed by a projected cellular leg. Normal hangup, no answer and an unarmed restart compensation do not qualify. Acknowledgement retains history. [Call alerts](../core/src/calls/failure-alerts.ts) |
| Incompatible protocol | An identifiable incompatible hello is eligible only after verifying the enabled device and its original credential. Bounded diagnostics do not participate in admission. Recovery requires a compatible response sent on the current attachment; this is local send evidence, not a remote receipt. [Protocol alerts](../core/src/devices/protocol-alerts.ts) |
| Shizuku autostart failed | Three qualifying failures from the authorized loopback reporter, with the device mapping and model checked. The observation window is 30 seconds. Failures less than five seconds apart are suppressed as likely duplicates. A serial change or expired observation resets the streak. Confirmed started or already running closes the incident without implying Android Binder or media readiness. The report lacks an observation ID or source timestamp, so delayed replay cannot be ruled out. [Host reports](../core/src/devices/shizuku-report.ts) |

The Alerts page reads and refreshes only its current page (50 records); the dashboard requests the five newest open alerts. Cursors preserve database microseconds and record IDs, and are bound to the selected state. They do not provide a cross-request snapshot: return to Latest to see records added before the cursor. The legacy request without `limit` and `cursor` continues to read all matching records. Upgrade Core before serving the new Web bundle; the new Web does not fall back to an unpaged read. The page size bounds returned rows, not database work; large production queries still need plan verification. Acknowledgement rechecks the original administrator session, updates an open alert, and writes the audit record in one transaction. Acknowledged does not mean recovered. After `TIMEOUT_UNKNOWN`, read the alert and audit log separately before any further action. [Alert repository](../core/src/alerts/admin-repo.ts)

This release provides administrator readback and best-effort realtime events. Forwarding and periodic redelivery to paired QQ or Telegram users are not connected. Production PostgreSQL and physical-device acceptance remain separate.

### Admin connection recovery

Core gives each `/ws/admin` WebSocket a fixed five-second monotonic window for first authentication. It checks the boundary at message admission, queue processing, before the token lookup, and on settlement. If first authentication has not completed at the deadline, Core detaches the socket and requests `4401` without attaching a subscriber or handling queued pings. Before expiry, a refused credential or auth frame remains `4403`, and a parse or internal failure remains `1011`. A previously observed revocation or disconnect wins over late results. Shutdown stops admitting new sockets and messages without dropping the deadline or cancelling lookups already admitted. Timely first auth still lets an admitted ping recheck the session. Five seconds is neither a shutdown duration bound nor a token lifetime. [Core admin sessions](../core/src/ws-admin/session.ts)

Each attempt has separate ten-second windows for WebSocket open and the first `pong`. The client sends authentication before the first `ping` and neither reports readiness nor consumes business hints before the first timely response. Once ready, the 25-second heartbeat tick sends at most one unanswered `ping`; only a `pong` accepted while a ping is pending renews the 60-second freshness window. Open and message handling also check monotonic deadlines, so a delayed timer cannot admit a late response. Timeout, error, or send failure retires the local attempt and clears timers before best-effort socket close. Reconnect does not wait for `close` and is fenced by session version and socket identity. Delays are 1, 2, 4, 8, 16, then 30 seconds, capped; only a timely first response resets them. Recovery requests one query invalidation, not a confirmed readback or a replay of writes. Retired hints are discarded; the original identity of pending or uncertain operations is retained for reconciliation. A suspended browser may defer timers; this does not wake the system. [Admin socket](../web/src/realtime/admin-socket.ts)

### Adapter handshake and notifications

- The current IPC attachment reports `adapter.hello`, `capabilities`, and `account.state` in order. Core stages the initial capability report in memory. The first state report writes the account state, effective login capability, prior-login marker, and applicable channel alert in one row-locked transaction. The final positive ACK follows confirmed persistence. Later capability writes retain only the effective login bit; platform messaging, audio, and calling stay disabled. Startup, replacement, and disconnect still distinguish a reset from an observed outage. Core IPC readiness is not proof of login or verified account identity. [Channel repository](../core/src/channels/repo.ts) · [Connection manager](../core/src/channels/adapter-manager.ts)
- Writes recheck process ownership and the current attachment, including just before issuing COMMIT. This fence cannot cancel a commit already in flight. Unconfirmed outcomes and cleanup failures retain their existing uncertainty; Core does not replay account commands.
- Admin broadcasts run separately: one in-flight notification per platform and a latest slot each for channel, alert, and login-step hints. Hints can be coalesced or missed. Stale generations or retired prompts are filtered at send time. Shutdown freezes notification admission and drains work already started. Read back state and operations separately; a missed prompt can be read back explicitly. [Runtime](../core/src/channels/adapter-runtime.ts) · [Recovery boundaries](platform-login-recovery.md)

- Web offers an explicit read-only action for missed prompts. Core returns a step only if it still matches the challenge observed before the durable read, no local operation overlaps the read or the authorization recheck, no durable operation blocks it, and the original administrator session still authorizes the request. Null does not settle the sign-in outcome. Web discards results that outlive the current admin session, socket, or platform observation and clears typed values on readback and prompt replacement. A submit must carry the original Core-issued challenge ID. It stays in the management layer, not the adapter IPC payload, and is neither an idempotency key nor an administrator credential.
- A ten-second monotonic ACK window starts at the admitted local IPC write. The evidence window begins at that cutoff and ends 30 seconds later, exclusive. Early timers rearm for the remainder; delayed timers do not move either cutoff. Disconnect or replacement discards evidence not yet admitted, but admitted writes still drain. A late positive ACK binds to the original platform and durable operation; it neither changes the original HTTP 504 nor releases the operation automatically. The first matching late NACK consumes the opportunity without recording evidence. [Adapter sessions](../core/src/channels/adapter-manager.ts) · [Recovery boundaries](platform-login-recovery.md)

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
