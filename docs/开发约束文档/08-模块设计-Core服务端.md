# 08 模块设计 · Core 服务端

> 版本 1.1 · 2026-11-20 · Node 20/22 · Fastify · ws · pg · 协议见 [05](05-接口契约实现细则.md)，表结构见 [06](06-数据库与迁移规范.md)

## 1. 模块依赖图（单向，禁止反向依赖）

```text
config → db → (auth, settings, audit, i18n)
                    ↓
devices ← sims        notify ← channels ← pairing
   ↓        ↓            ↑         ↑
  sms ──────┘            │         │
   ↓                     │         │
calls(coordinator) ── media ───────┘
   ↓
commands（消息外呼与短信命令）→ calls, sms, notify
alerts → devices, channels, notify
ws-device → devices, sims, sms, calls
ws-admin → 订阅事件总线
http → 各模块 routes
```

模块间通知统一走进程内事件总线 `util/event-bus.ts`（类型安全），事件名与 /ws/admin 推送事件一致。审计：`audit.record(action, target, detail)` 由 http 层的写路由钩子统一调用，各写路由只需声明 action 名。

## 2. 模块清单

| 模块 | 主要文件 | 职责 |
|---|---|---|
| config | load.ts, schema.ts | 读取并校验 config.toml |
| db | pool.ts, migrate.ts, tx.ts, case.ts | 连接池、迁移、事务、snake/camel 转换 |
| http | server.ts, cors.ts, errors.ts, auth-hook.ts, audit-hook.ts, spa.ts, log-redact.ts | Fastify、CORS 全开、错误转换、鉴权、审计、前端回退、日志脱敏令牌 |
| auth | service.ts, repo.ts, routes.ts, password.ts | 登录、会话、锁定、改密、语言 |
| devices | service.ts, repo.ts, routes.ts, binding.ts, presence.ts | 绑定、设备 CRUD、在线判定、状态存储、暂停/禁用判定 |
| sims | service.ts, repo.ts, routes.ts, matcher.ts | SIM 同步、号码登记、复核、按号码匹配 |
| sms | service.ts, repo.ts, routes.ts, rate.ts | 入站去重、出站任务、限速 |
| ws-device | gateway.ts, session.ts, dispatcher.ts, command.ts | 设备 WebSocket、hello、ack、命令超时 |
| media | router.ts, leg.ts, resample.ts, jitter.ts, prompt-player.ts, early-media.ts, ws-media.ts, adapter-audio.ts | 腿管理、帧交叉、重采样、提示语音、早期媒体判定、/ws/media、适配器音频 |
| calls | coordinator.ts, machines/web-out.ts, machines/platform-in.ts, machines/platform-out.ts, locks.ts, timers.ts, repo.ts, routes.ts, reconcile.ts | 会话状态机、锁、计时、对账 |
| channels | manager.ts, ipc-server.ts, repo.ts, routes.ts | 两个适配器 socket、能力、登录、voice_verified |
| pairing | service.ts, repo.ts | 配对码、校验、锁定、替换 |
| commands | parser.ts, service.ts | 配对用户消息处理管道 |
| notify | service.ts, templates.ts | 发给配对用户的消息 |
| alerts | service.ts, rules.ts, repo.ts, routes.ts | 告警规则、去重、推送 |
| settings | service.ts, repo.ts, routes.ts | 设置读写、缓存、下发 config.update |
| audit | service.ts, repo.ts, routes.ts | 操作日志 |
| i18n | catalog/zh-CN.ts, zh-HK.ts, en.ts, render.ts | 机器人消息与 errors.<CODE> 文案 |
| ws-admin | hub.ts | Admin 实时推送 |
| cli | index.ts（入口 cli.js）, admin-create.ts, migrate.ts | 命令行工具 |
| util | ulid.ts, phone.ts, clock.ts, event-bus.ts, timeout.ts | 公共工具 |

构建入口：`src/main.ts` → `dist/main.js`（服务）；`src/cli/index.ts` → `dist/cli.js`（命令：`admin:create`、`migrate`）。

## 3. 关键实现细则

### 3.1 auth

- Argon2id：memoryCost 19456 KiB、timeCost 2、parallelism 1。
- 会话令牌 32 字节随机 Base64url，库中存 SHA-256，有效 7 天；改密后作废全部旧会话。
- 连续 10 次失败锁 15 分钟；成功登录清零。
- `node dist/cli.js admin:create --username <u>`：交互式两次输入密码；已存在同名管理员则拒绝（单管理员，C-06）。

### 3.2 devices

- 绑定码：6 位数字（000000–999999，显示保留前导 0），10 分钟，单次；生成新码不作废旧码。
- `POST /api/device/bind` 见 05 §2；同一 IP 每分钟 > 10 次失败返回 429。
- 在线判定：每 10 秒扫描；`last_seen_at` 超过 offline_after_sec 置离线。
- device_status 按字段存储并带 TTL：heartbeat 各字段 90 秒，snapshot 各字段 24 小时，probes 7 天；DTO 中 `stale = now > observed_at + ttl`。
- **可执行命令判定** `canCommand(device)`：online ∧ enabled ∧ ¬paused；否则 DEVICE_OFFLINE / DEVICE_DISABLED。
- **可通话判定** `canCall(device, sim)`：canCommand ∧ callEnabled ∧ capabilityLevel ≥ L3（外拨）/ ≥ L4（接听+音频）∧ shizuku = running（L4+）∧ probes.downlink/uplink = ok ∧ sim.state = ready。

### 3.3 sims

- snapshot 按 (device_id, slot) 对齐；subId、carrier、mcc/mnc 任一变化 → 旧记录 retired_at、新建记录、needs_review = true，号码不继承。
- 设备上报号码写入 sim_number（source = reported），管理员登记覆盖（source = manual）；manual 不被后续上报覆盖。
- `matchByNumber(raw)`：phone.ts 规范化后在 sim_number 精确匹配未 retired 的 SIM，返回 0 / 1 / 多个。

### 3.4 sms

- 入站：sms.received → 以 envelope id 作 event_id 唯一插入 → 回 ack → 事件 sms.new → 若 sms_forward 则 notify 两平台。
- 出站状态机（sms_task.state）：

| 状态 | 进入条件 | 下一步 |
|---|---|---|
| queued | 创建；或限速令牌不足；或设备离线 | 令牌可用且设备 canCommand → dispatched |
| dispatched | 已发送 sms.send | ack ok → accepted；ack ok:false → failed（errorCode = ack.error）；10 秒无 ack → unknown |
| accepted | 设备已接收 | sms.result sent → sent；failed → failed；unknown → unknown |
| sent | — | sms.result delivered → delivered |
| delivered / failed | 已有确定结果 | 不重发；若同设备报告相互矛盾的 sent/delivered 与 failed，改为 unknown |
| unknown | 结果未确定 | 不重发；同设备的后续确证 sent/failed 可更新状态 |

- 设备离线时任务保持 queued，设备上线后按创建顺序下发；queued 超过 24 小时转 failed（errorCode = DEVICE_OFFLINE）。
- 限速 rate.ts：按 SIM 令牌桶，速率 sms_rate_per_min（null 不限）；**是唯一限速点**；短信命令（FR-SMS-08）同样受此限速，外呼不受任何限速（C-11）。
- 跨设备积压每轮最多发现 32 台，按 ID 续扫。派发最多同时处理 4 台设备，每张 SIM 继续使用独立 FIFO 与限速。有等待设备时，耗时轮次在完成当前步骤后让位，下一轮继续轮转 SIM。提交的新快照只请求重查，不视为发送资格。

### 3.5 media

- 内部统一 16 kHz PCM16；进出 8 kHz（设备降级）、48 kHz（适配器）时用 `resample.ts`（线性插值 + 一阶低通，自写，带频响测试）。
- 每条腿的格式在首个有效帧确定。抖动缓冲最多 15 个序号槽，按 Core 收帧时钟丢弃超过 300 ms 的样本；被拒绝的重复或迟到帧不刷新断流计时。
- 路由器每 20 ms 从每条腿取一帧（缺帧补静音）写给对端腿。 通话协调器独立检查每条已认证且仍获授权的腿，满 2 秒没有新帧入队时记录一次诊断，不自动挂断。
- 适配器音频：adapter-audio.ts 把 IPC 0x02 帧按 audioChannel 路由到对应平台腿；audioChannel 在 call.dial 时分配（每个适配器 0–255 循环，跳过占用中的值）。
- **早期媒体判定（early-media.ts）：** 以 20 ms 为步长，计算最近 50 帧（1 秒）中带 bit0 的蜂窝下行帧的**平均 RMS**；≥ early_media_threshold_dbfs 视为“有早期媒体”。
- **提示语音（prompt-player.ts）：** 加载 `assets/prompts/connecting.<bot_locale>.pcm`（16 kHz），循环输出，帧 flags bit1；每次切换都在帧边界进行。

### 3.6 calls：锁与计时

- `deviceLock(deviceId)`、`channelLock(platform)`：内存 Map，记录 sessionId 与过期时间（4 小时）；会话进入 ended 必定释放。
- timers.ts 使用可注入时钟；所有计时器在会话结束时清除。
- 每次状态转换写 call_event（event = `state:<新状态>`，payload 含触发原因）。

### 3.7 状态机（canonical 状态名，与 06 §4 一致）

**通用：** 任何状态在“结果无法确认”时可进入 `unknown`，随后执行 ending 的清理动作；`ending` 负责结束仍存活的腿；`ended` 释放锁并推送 call.updated。会话 end_cause 取 CallCause。

#### platform_in（来电转接）

| 状态 | 进入动作 | 事件 → 下一状态 |
|---|---|---|
| cell_ringing | 取设备锁；创建蜂窝腿 | 设备 paused/禁用/未开通话、来电平台不可用（未登录、未配对、语音未验证、通道忙） → rejecting（end_cause 对应）；否则 → notifying |
| notifying | notify 两平台“来电” | 发送完成（不等待平台 ack）→ platform_dialing |
| platform_dialing | 取通道锁；分配 audioChannel；adapter call.dial；**启动振铃计时 inbound_ring_timeout_sec（从发出 call.dial 起算）** | 适配器 connected → answering；ended/failed → rejecting；计时到期 → rejecting（timeout）；设备 call.state disconnected（主叫挂断）→ ending（cancelled）；设备 local_answered → ending（local_answered） |
| answering | 复核蜂窝腿仍 ringing；发 call.answer（含 MediaLeg） | 设备 active → bridged；ack ok:false 或 10 秒无 active → ending |
| bridged | 媒体路由连接蜂窝腿与平台腿 | 任一腿结束 → ending |
| rejecting | 设备 call.reject；若平台腿存在则 call.hangup；notify 两平台“未接来电” | 完成 → ended |
| ending | 结束另一腿（call.hangup / adapter call.hangup） | 两腿均结束或 10 秒 → ended |

**G0 测试模式：** 配置 `[test] probe_answer_inbound = true` 时，来电不路由到平台，改为等待 audio-probe 以浏览器腿接管（answering 由 probe 触发）；生产环境必须为 false。

**不变式（必须属性测试）：** 在平台腿进入 connected 之前，core 不得向设备发送 call.answer。

#### platform_out（消息外呼）

| 状态 | 进入动作 | 事件 → 下一状态 |
|---|---|---|
| reserving | 取设备锁与来源平台通道锁；任一失败 → 回复拒绝原因并 ended（不拨号） | 成功 → cell_dialing |
| cell_dialing | 设备 call.dial（含 MediaLeg，开始早期媒体）；回复 notify.dialing | ack ok → platform_dialing；ack ok:false → ending（回复原因） |
| platform_dialing | 分配 audioChannel；adapter call.dial(消息发送者)；**启动回拨振铃计时 outbound_callback_ring_timeout_sec**；蜂窝腿同时在振铃 | 见下表 |
| waiting_user | 被叫已接、用户未接；启动 outbound_user_answer_timeout_sec；回复 notify.callee_answered | 用户 connected → bridged；用户拒接/ended/超时 → ending（回复 notify.callback_missed） |
| waiting_callee | 用户已接、被叫未接；启动 outbound_callee_answer_timeout_sec；媒体：有早期媒体则转发，否则循环提示语音 | 被叫 active → bridged；被叫 disconnected（busy/rejected/no_answer/unreachable）→ ending（回复原因）；超时 → ending（notify.callee_no_answer） |
| bridged | 停止提示语音；双向路由 | 任一腿结束 → ending |
| ending | 结束存活的腿；回复 notify.call_ended（含时长，若曾接通） | → ended |

platform_dialing 的事件：

| 事件 | 下一状态 |
|---|---|
| 用户 connected（被叫未接） | waiting_callee |
| 被叫 active（用户未接） | waiting_user |
| 两者都已接通 | bridged |
| 用户拒接 / failed / 回拨振铃超时 | ending（回复 notify.callback_missed） |
| 被叫 disconnected | ending（回复原因） |

#### web_out（浏览器外拨）

| 状态 | 进入动作 | 事件 → 下一状态 |
|---|---|---|
| reserving | 取设备锁；创建浏览器腿与蜂窝腿；返回 mediaToken | 成功 → awaiting_browser |
| awaiting_browser | 等待浏览器媒体认证；Core 认领须在数据库保存的 30 秒截止前通过 | 证明原预约和设备/SIM 等仍有效才进入 cell_dialing。过期关闭需要未拨号的持久证据；证据缺失保留 unknown。 |
| cell_dialing | 设备 call.dial；早期媒体转发给浏览器（**web_out 不播放提示语音**） | 被叫 active → bridged；被叫 disconnected → ending；浏览器挂断 → ending |
| bridged | 双向路由 | 任一腿结束 → ending |
| ending | 结束存活的腿 | → ended |

### 3.8 重启对账（reconcile.ts）

启动对账在取得数据库独占所有权后、对外监听前执行。每批按会话 ID 选择并锁定最多 64 条未结会话或未结证据。仅当浏览器预约有原始身份及创建记录、两条未使用的腿且无操作证据时，才直接结束。其余未结会话记为 `unknown`，未结意图与 ACK 单独对账；已经确认的证据保留。提交不明或所有权丢失停止启动，先前已提交的批次保留。不会自动挂断或重拨。短信的独立启动对账不重发已派发任务。

### 3.9 channels

- [适配器监听器](../../core/src/adapters/ipc-listener.ts) 对启用的平台监听各自的本地 IPC。新连接先重置频道读回，再依次接收 hello、能力和账号状态；初始状态、有效登录能力和适用告警同事务提交。断开时清理对应代次并记录离线，根据已观测登录与停机原因决定是否开启告警。
- 生产仅接通账号控制，平台消息、配对启用和语音仍关闭；不能由监听状态或能力报告推断已登录。管理广播在单独的有界队列运行，可能合并提示且不改变已提交报告的 ACK。发送前复核当前代次、提示和管理员会话。
- 登录挑战标识由 Core 生成。管理端步骤 GET 在操作读回后再次复核同一挑战；POST 复核平台、连接和挑战，取得占位后再检查。标识不进入 IPC；运行时不会重发未知操作。
- 来电平台由 setting inbound_platform 决定；**不提供改转另一平台的选项**（需求 12 S01 已采用“不改转”）。

### 3.10 pairing 与 commands

**配对码：** 8 位数字，5 分钟，单次；生成新码时作废该平台未使用的旧码。

**消息处理管道（commands/service.ts，按顺序）：**

1. chatType ≠ private 或 forwarded = true → 丢弃（不回复）。
2. 按 (platform, platformMessageId) 去重，重复直接结束。
3. 写 platform_message（direction = in）。
4. 判断发送者是否为该平台当前配对用户（paired）。
5. **未配对发送者：** 文本整体匹配 `^\s*(?:绑定\s*)?(\d{8})\s*$` → 配对校验：
   - 该 sender 10 分钟内失败 ≥ 5 次 → 回复 notify.pair_locked，结束；
   - 码有效 → 撤销旧配对（通知旧用户 notify.pair_replaced）→ 写入新配对 → 回复 notify.pair_ok；
   - 码无效/过期 → 记失败 → 回复 notify.pair_invalid。
   - 不匹配配对格式 → **不回复**，结束。
   - isContact = false 时仍允许配对，但在 pair_ok 回复中附加“请先互加好友，否则无法接听/回拨”的提示（FR-PAIR-04 的好友要求由用户自行完成，core 不强制）。
6. **已配对发送者：** 去除首尾空白后：
   - 匹配 `^绑定\s*(\d{8})$` → 配对流程（同第 5 步）；
   - 匹配 `^(?:短信|sms|SMS)\s+(\S+)\s+([\s\S]+)$` → 短信命令；第 1 组为号码表达式（**不得含空格**），第 2 组为短信正文；
   - 匹配号码表达式 `^([+\d()\-－（）]+)(?:\s*[/／]\s*([+\d()\-－（）]+))?$` → 外呼；有第 2 组时第 1 组为拨出号码、第 2 组为目标号码；
   - 其他 → 回复 notify.usage。
7. 号码规范化：先去掉空格、短横线、括号，再按 util/phone.ts（需求 01 §5）解析；纯 8 位以 2–9 开头 → +852。

### 3.11 notify 模板（i18n 键，三语）

notify.incoming、notify.missed、notify.busy_rejected、notify.sms_forward、notify.dialing、notify.callee_answered、notify.callback_missed、notify.callee_no_answer、notify.call_ended、notify.reject.<CODE>、notify.sms_queued、notify.sms_sent、notify.sms_failed、notify.pair_ok、notify.pair_ok_add_friend、notify.pair_replaced、notify.pair_invalid、notify.pair_locked、notify.usage、notify.alert.<type>。模板变量用 `{number}`、`{device}`、`{slot}`、`{time}`、`{duration}`、`{reason}`，测试校验三语变量集合一致。

### 3.12 alerts

| type | subject | 触发 | 自动解除 |
|---|---|---|---|
| device_offline | device | 已观测设备的在线状态超时并判为离线 | 恢复在线 |
| shizuku_stopped | device | `callEnabled` 且新鲜证据确认 Shizuku 不可用，持续采样 60 秒 | 确认运行，或结束对该设备的相应监控 |
| sim_not_ready | sim | 当前 SIM 锁定或缺失，持续有效采样 60 秒 | 确认就绪或 SIM 退役 |
| sms_permission_missing | device | 快照明确显示缺少发送或接收短信权限 | 快照确认两项权限均已授予 |
| channel_down | channel | 确认登录后观察到离线、封禁、登出或异常断开；启动时也核对异常退出遗留的已登录状态 | 确认登录 |
| call_failed | call_session | 已持久化的明确失败、未知状态或有技术故障证据的结束，每个会话最多一条 | 否（确认即关闭） |
| protocol_mismatch | device | 有效设备及凭据的可识别不兼容握手，`4005` 不延迟 | 当前兼容连接发出 `hello.ok` |
| shizuku_autostart_failed | device | 经授权映射的回环上报累计三次合格失败，短间隔抑制；观测过期重新计数 | `started` 或 `already_running` |

同一 `(type, subject_id)` 最多保留一条开放告警。可恢复规则把已确认记录保留在同一故障内，直到收到有效恢复；通话告警确认后不重开。确认不会改变业务状态。Core 提交后向管理连接尽力通知变化，Web 每 30 秒仅读回当前页。按数据库原始时间和 ID 分页，筛选变化回到最新页。确认状态和审计在同一事务，未知响应单独读回。原设计中的配对用户推送与定期重试仍待接入。

### 3.13 settings

设置写入成功后推送 `settings.updated`。`heartbeat_sec` 或 `bot_locale` 变化会立即唤醒配置对账，定时轮转读取已提交值并向完成握手的当前连接发送 `config.update`。提交不明确时只读回数据库状态，不转发原请求。当前连接对本次命令的正向 ACK 才能结束该配置的重试。

## 4. 日志脱敏

log-redact.ts：请求日志剔除 Authorization 头、`token` 查询参数、请求体中的 password / value（登录提交）字段；业务正文（短信、号码）只在 debug 级输出（C-09 不要求数据库脱敏，但日志不是业务数据）。

## 5. dashboard 统计对象

```json
{ "devices": { "total": 0, "online": 0, "offline": 0, "paused": 0, "byLevel": { "L1": 0, "L2": 0, "L3": 0, "L4": 0, "L5": 0 } },
  "sims": { "total": 0, "ready": 0, "numberKnown": 0, "needsReview": 0 },
  "capability": { "smsReady": 0, "callReady": 0, "inCall": 0 },
  "channels": [ { "platform": "qq", "state": "logged_in", "paired": true, "voiceVerified": false, "busy": false, "isInbound": true } ],
  "alerts": { "open": 0, "critical": 0 } }
```

smsReady = canCommand ∧ 短信权限齐全的设备数；callReady = 满足 canCall 的 SIM 数。

## 6. 检查命令

`npm run -w core check`；集成测试读取环境变量 `VOIPGW_TEST_DATABASE_URL`（见 12 §4）。
