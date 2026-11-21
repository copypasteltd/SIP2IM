# 14 TODO 总表

> 版本 1.1 · 2026-11-20 · **本表是全部开发任务的唯一清单**（取代需求文档 09 第 3 节）
> **领取规则：** 状态 `READY` 且“依赖”列全部 `DONE`（或 `REVIEW`，见下）才可领取。依赖列中写“X 或 Y”时，任一为 DONE 即满足。
> 对于“需要真机/真实账号才能最终验证”的任务，其下游任务可在其处于 `REVIEW` 时领取，但下游任务也只能到 `REVIEW`。
> 列说明：**依赖**＝TODO 编号；**需求**＝覆盖的 FR-/C-/NFR- 编号；**参考**＝应读章节（K＝开发约束文档，R＝需求文档）；**验收**＝完成判据。
> **全局验收规则：** 任何新增写接口必须经 audit 钩子记录操作日志；任何用户可见文本三语齐全；任何新依赖已登记许可证。

## 编号前缀

| 前缀 | 模块 | 里程碑 |
|---|---|---|
| DEC | 需用户决定的事项（阻塞项） | — |
| ENV | 环境与仓库骨架 | M0 |
| P | packages/protocol 协议包 | M0–M2 |
| C | core 服务端 | M2–M5 |
| A | Android APK | M1–M5 |
| W | web 前端 | M2–M5 |
| T | Telegram 适配器 | M4b |
| Q | QQ 适配器 | M4a |
| TL | 工具（设备模拟器、音频探针、Shizuku 自启、提示语音） | M1–M5 |
| D | 部署 | M0–M5 |
| G | 门槛验收 | 各里程碑 |
| BUG | 缺陷修复（随时追加） | — |

## 需用户决定（DEC）

| 编号 | 任务 | 依赖 | 需求 | 参考 | 验收 | 状态 |
|---|---|---|---|---|---|---|
| DEC-V01 | 用户选定前端视觉方向（10 套原型之一或混搭） | — | — | R13 §5、K10 | 用户回复写入 R12 与日志；theme.css 来源确定 | BLOCKED（等待用户） |

## M0 环境与骨架（ENV）

| 编号 | 任务 | 依赖 | 需求 | 参考 | 验收 | 状态 |
|---|---|---|---|---|---|---|
| ENV-01 | 本机安装 Node 22、JDK 17、Android SDK 命令行工具到 VOIP/.toolchain（不装 emulator 与 system-images） | — | C-07 | K13 §1 | `node -v`、`java -version`、`sdkmanager --list_installed` 输出写入日志；系统 PATH 未改 | READY |
| ENV-02 | 在 VOIP/ 根目录初始化 git（发布名 voip-gateway）、LICENSE(MIT)、根 README、.gitignore、.editorconfig；docs/ 与 prototypes/ 一并入库 | — | C-02 | K03 §1–2、§6 | 首个提交含 docs/；.gitignore 覆盖 .toolchain/、evidence/、config.toml、密钥、session、build、dist、node_modules | READY |
| ENV-03 | npm workspaces 根配置、tsconfig.base、eslint、prettier、根脚本 check/lint/typecheck/test | ENV-01, ENV-02 | — | K03 §2.1、§4、K12 §2 | `npm run check` 在空工作区通过 | TODO |
| ENV-04 | 建立全部目录骨架与各工作区 package.json（名称见 K03 §2.1）、pyproject、gradle 占位 | ENV-03 | — | K03 §2 | 目录与 K03 §2 一致；`npm run check` 通过 | TODO |
| ENV-05 | THIRD_PARTY_NOTICES.md 与 `npm run license:check` | ENV-04 | C-02 | K02 §7、R11 | 依赖含 GPL 时脚本失败（临时样例验证后移除） | TODO |
| ENV-06 | `npm run i18n:check`：比对 web、core、android 三处三语键集合 | ENV-04 | C-15 | K12 §2 | 缺键时失败 | TODO |
| ENV-07 | Android 工程：gradle wrapper、protocol 与 app 两模块、minSdk 19 断言、multidex | ENV-01, ENV-04 | C-04 | K07 §1、§5 | `assembleDebug` 产出空 APK；断言 minSdk=19 | TODO |
| ENV-08 | 核实并锁定 Android 依赖对 API 19 的支持：OkHttp 3.12.x、AndroidX 各库、并发方案、Shizuku api/provider；核实 FOREGROUND_SERVICE_PHONE_CALL 与 API 23–25 InCallService 行为（结论写入 K07） | ENV-07 | C-04 | K02 §4、K07 §2、§4 | 日志列出每个依赖版本与 minSdk 来源；版本目录锁定 | TODO |
| ENV-09 | Telegram 适配器 Python 工程骨架（ruff、mypy、pytest） | ENV-04 | — | K09 §2 | 三项检查通过 | TODO |
| ENV-10 | 服务器只读复核：端口、pg_lsclusters、node -v、systemctl --failed | — | C-07 | K13 §0、§9 | 日志含四项输出；无任何修改 | READY |
| ENV-11 | 集成测试数据库：方案 A（D-02 后建立 SSH 隧道脚本 scripts/dev-db-tunnel，凭据不落盘）或方案 B（经用户同意，本机 .toolchain/pgsql 原生 PostgreSQL 14）；统一提供 `VOIPGW_TEST_DATABASE_URL` | D-02（方案 A） | — | K12 §4、K13 §0 | 测试可连 voip_test；脚本与日志无密码 | TODO |

## 协议包（P）

| 编号 | 任务 | 依赖 | 需求 | 参考 | 验收 | 状态 |
|---|---|---|---|---|---|---|
| P-01 | 设备协议 zod 模型：信封、K05 §3.3–3.4 全部消息、Sim、Probes、Perm、MediaLeg、CallCause | ENV-04 | E-05 | K05 §3 | 全部导出；单元测试 | TODO |
| P-02 | 媒体帧编解码（三格式、flags、seq 回绕、静音帧） | ENV-04 | E-05 | K05 §4.2 | 往返测试；非法帧拒绝 | TODO |
| P-03 | 适配器 IPC：长度前缀帧（L 含类型字节）、控制信封、ack、音频帧 audioChannel | ENV-04 | E-05 | K05 §5 | 往返测试；半包/粘包测试 | TODO |
| P-04 | Admin API：请求/响应、DTO（K05 §6.3）、/ws/admin 事件、错误码枚举（K05 §7） | ENV-04 | E-05 | K05 §6–7 | 错误码与 K05 §7 一致（测试比对） | TODO |
| P-05 | fixtures：device/、ipc/、admin/、media/*.bin；每类型合法 + 非法样例 | P-01, P-02, P-03, P-04 | E-05 | K05 §8 | TS 契约测试通过 | TODO |
| P-06 | Kotlin 协议模块 + 读取 fixtures 的 JUnit 契约测试 | P-05, ENV-07 | E-05 | K07 §1、K05 §8 | `:protocol:test` 通过 | TODO |
| P-07 | Python 协议实现（IPC）+ pytest 契约测试 | P-05, ENV-09 | E-05 | K05 §5、§8 | pytest 通过 | TODO |

## Core 服务端（C）

| 编号 | 任务 | 依赖 | 需求 | 参考 | 验收 | 状态 |
|---|---|---|---|---|---|---|
| C-CFG-01 | config 加载与校验、VOIPGW_CONFIG 覆盖、[test] 段 | ENV-04 | — | K08 §2、K13 §5 | 缺项打印字段并退出（测试） | TODO |
| C-UTIL-01 | ulid（带前缀）、clock（可注入）、timeout、event-bus | ENV-04 | E-02 | K08 §1 | 单元测试 | TODO |
| C-UTIL-02 | 号码解析 phone.ts（+86/+852、短号、紧急号码、全角） | C-UTIL-01 | C-14 | R01 §5、K08 §3.10 | 表驱动测试覆盖每一行 | TODO |
| C-DB-01 | 连接池、事务、迁移执行器、snake/camel 转换 | C-CFG-01 | C-16 | K06 §1 | 空库迁移成功；重复启动不重复执行 | TODO |
| C-DB-02 | 迁移 0001_init.sql 与设置默认值 | C-DB-01, ENV-11 | C-16 | K06 §2–3 | voip_test 中执行成功 | TODO |
| C-HTTP-01 | Fastify、CORS 全开、错误转换、日志脱敏、/api/health、静态托管与前端路由回退（用测试用 index.html） | C-CFG-01 | C-08 | K05 §6.1、K08 §4 | 任意 Origin 预检 204；日志无 token；未知路径返回 index.html | TODO |
| C-AUDIT-01 | audit 钩子与 /api/audit-logs | C-DB-02, C-HTTP-01 | FR-ADM-04 | K08 §1 | 带 action 声明的测试路由调用后存在日志 | TODO |
| C-AUTH-01 | 管理员登录/登出/改密/语言、会话、锁定、鉴权钩子 | C-DB-02, C-HTTP-01, C-AUDIT-01 | FR-ADM-01 | K08 §3.1、K05 §6.2 | TC-ADM-01 集成测试 | TODO |
| C-AUTH-02 | CLI：dist/cli.js admin:create（交互读密码、单管理员）与 migrate | C-AUTH-01 | FR-ADM-01, C-06 | K08 §2、§3.1 | 密码不出现在参数与日志；第二个管理员被拒 | TODO |
| C-I18N-01 | core 文案目录：notify 模板与 errors.<CODE> 三语、模板变量校验 | C-UTIL-01 | C-15 | K08 §3.11、K05 §7 | 三语变量集合一致测试 | TODO |
| C-SET-01 | settings 读写、缓存、/api/settings、settings.updated | C-AUTH-01 | — | K06 §3、K08 §3.13 | 改设置后缓存与推送生效 | TODO |
| C-WSA-01 | /ws/admin：首条消息认证、ping/pong、事件转发 | C-AUTH-01, C-UTIL-01 | NFR-03 | K05 §6.4 | 集成测试 | TODO |
| C-DEV-01 | 绑定码生成与 POST /api/device/bind（原子、限流、过期） | C-AUTH-01 | FR-DEV-01 | K05 §2、K08 §3.2 | TC-DEV-01/02；并发同码只成功一次 | TODO |
| C-DEV-02 | ws-device：hello、关闭码、版本协商、旧连接替换、ack 与命令超时（05 §3.5） | C-DEV-01, P-01 | FR-DEV-01/02 | K05 §3 | 假设备测试覆盖全部关闭码与 ack 分支 | TODO |
| C-DEV-03 | 心跳、在线判定、device_status TTL、online/offline 事件 | C-DEV-02 | FR-DEV-03 | K08 §3.2 | TC-DEV-04（假时钟） | TODO |
| C-DEV-04 | 设备 CRUD：列表、详情 DTO、改名、启停、通话开关、默认 SIM、解绑吊销、probe 触发 | C-DEV-02 | FR-DEV-02/06/07 | K05 §6.2–6.3 | TC-DEV-03、TC-DEV-08 | TODO |
| C-DEV-05 | canCommand / canCall 判定；暂停与禁用处理（命令前拦截、来电直接 reject） | C-DEV-03 | FR-DEV-09 | K08 §3.2、K05 §3.4 | TC-DEV-09（假设备） | TODO |
| C-SET-02 | 设置变更后向在线设备下发 config.update | C-SET-01, C-DEV-02 | — | K08 §3.13 | Core/模拟器回归覆盖变更、丢 ACK 和重连；待 Android 真机验证 | REVIEW |
| C-SIM-01 | snapshot 同步 SIM、换卡 retired 与 needs_review、号码登记与复核接口、matchByNumber | C-DEV-02, C-UTIL-02 | FR-DEV-05 | K08 §3.3 | TC-DEV-06；匹配 0/1/多 | TODO |
| C-SMS-01 | 入站短信：以信封 id 去重入库、ack、sms.new | C-SIM-01 | FR-SMS-01/02 | K08 §3.4 | TC-SMS-01/03 | TODO |
| C-SMS-02 | 出站任务状态机、sms.send、ack 分支、unknown 不重发、离线排队、Idempotency-Key 必填 | C-SMS-01, C-DEV-05 | FR-SMS-03/04 | K08 §3.4 | TC-SMS-04/05；跨设备限流、SIM FIFO 和迟到确认已有离线回归，待实库与真机验收 | REVIEW |
| C-SMS-03 | 短信令牌桶（唯一限速点，可关闭） | C-SMS-02, C-SET-01 | FR-SMS-06 | K08 §3.4 | TC-SMS-07 | TODO |
| C-SMS-04 | 短信查询与会话线程接口 | C-SMS-01 | FR-ADM-03 | K05 §6.2 | 分页与过滤测试 | TODO |
| C-MED-01 | 媒体路由器：腿、首帧锁定格式、20 ms 交叉、缺帧静音、抖动缓冲 | P-02, C-UTIL-01 | NFR-02 | K08 §3.5 | 两腿交叉、积压丢帧测试 | TODO |
| C-MED-02 | 重采样 8k/16k/48k（自写） | C-MED-01 | — | K08 §3.5 | 1 kHz 正弦往返误差在阈值内 | TODO |
| C-MED-03 | /ws/media：设备头认证、浏览器首条消息认证、关闭码、media_stalled | C-MED-01, C-DEV-02 | — | K05 §4 | 假设备 + 假浏览器帧往返 | TODO |
| C-MED-04 | 早期媒体判定（50 帧平均 RMS）与提示语音播放器 | C-MED-01, TL-PROMPT-01 | C-13, FR-OUT-07 | K08 §3.5 | 有/无早期媒体、被叫接听后停止提示 | TODO |
| C-CH-01 | channels：两个 IPC socket 服务端、adapter.hello、capabilities、account.state、断线 | P-03, C-DB-02 | C-12, FR-PAIR-01 | K08 §3.9、K05 §5 | 假适配器连接/断开测试 | TODO |
| C-CH-02 | 通道登录接口与 login.step 推送、voice-verified 接口、来电平台设置 | C-CH-01, C-SET-01, C-WSA-01 | FR-PAIR-01/02 | K05 §6.2 | 接口测试 | TODO |
| C-MED-05 | 适配器音频腿：audioChannel 分配与回收、0x02 帧路由、48k 重采样 | C-MED-02, C-CH-01 | — | K05 §5.1、K08 §3.5 | 假适配器音频往返 | TODO |
| C-NOT-01 | notify：按 i18n 渲染、发给单个/两个配对用户、platform_message 记录 | C-CH-01, C-I18N-01 | C-15 | K08 §3.11 | 发送与记录测试 | TODO |
| C-PAIR-01 | 配对码生成、校验、错误锁定、替换并通知、解除配对接口 | C-CH-01, C-NOT-01 | FR-PAIR-03/04/05/06 | K08 §3.10 | TC-PAIR-02～05；并发同码只成功一次 | TODO |
| C-CMD-01 | 消息处理管道（K08 §3.10 第 1–7 步，含配对码与 +852 区分） | C-PAIR-01, C-UTIL-02 | FR-PAIR-05 | K08 §3.10 | 表驱动测试覆盖每一分支 | TODO |
| C-CALL-01 | 设备锁、通道锁 | C-UTIL-01 | — | K08 §3.6 | 并发获取与释放测试 | TODO |
| C-CALL-02 | 状态机框架：转换写 call_event、计时器、unknown 处理 | C-CALL-01, C-DB-02 | — | K08 §3.6–3.7 | 框架单元测试 | TODO |
| C-CALL-03 | web_out 会话与 /api/calls 系列（含 Idempotency-Key 存储） | C-CALL-02, C-MED-03, C-DEV-05 | FR-WEB-01/02/03 | K08 §3.7 | TC-WEB-01/03/04（假设备 + 假浏览器） | TODO |
| C-CALL-04 | 重启对账 | C-CALL-02 | NFR-04 | K08 §3.8 | TC-SCALE-03（集成模拟） | TODO |
| C-CALL-05 | platform_in 会话 | C-CALL-02, C-MED-03, C-MED-05, C-NOT-01, C-PAIR-01, C-SET-01, C-DEV-05 | FR-IN-01～06, C-12 | K08 §3.7 | TC-IN-01～07（假设备 + 假适配器）；属性测试：平台未 connected 绝不发 call.answer | TODO |
| C-CALL-06 | platform_out 会话（先拨蜂窝、回拨来源平台、三种计时、进度回复、早期媒体/提示语音） | C-CALL-05, C-CMD-01, C-MED-04, C-SIM-01 | FR-OUT-01～08 | K08 §3.7 | TC-OUT-01～10（假设备 + 假适配器） | TODO |
| C-SMS-05 | 短信转发两平台（可关闭） | C-SMS-01, C-NOT-01 | FR-SMS-07 | K08 §3.4 | TC-SMS-08 | TODO |
| C-SMS-06 | 短信命令（P1，受短信限速） | C-SMS-02, C-CMD-01 | FR-SMS-08 | K08 §3.10 | TC-SMS-09 | TODO |
| C-ALR-01 | 告警规则（K08 §3.12 全部类型）、去重、推送、/api/alerts 与确认 | C-DEV-03, C-CH-01, C-NOT-01 | FR-OPS-01 | K08 §3.12 | TC-OPS-01（八类告警、管理端分页、确认与原子审计已接入；待 PostgreSQL 验收与配对用户推送） | DOING |
| C-DASH-01 | /api/dashboard | C-DEV-05, C-SIM-01, C-CH-01, C-ALR-01 | FR-ADM-02 | K08 §5 | 统计数值测试 | TODO |
| C-CMDQ-01 | /api/commands | C-CALL-06 | FR-ADM-03 | K05 §6.2 | 分页测试 | TODO |
| C-INT-01 | 内部接口：/internal/shizuku-autostart（来源校验、serial 关联）与 G0 测试模式 /internal/probe/call、probe_answer_inbound | C-DEV-03, C-CALL-03 | FR-DEV-10 | K05 §6.5 | 非 127.0.0.1 请求被拒；probe_api=false 时接口 404 | TODO |

## Android APK（A）

| 编号 | 任务 | 依赖 | 需求 | 参考 | 验收 | 状态 |
|---|---|---|---|---|---|---|
| A-01 | 应用骨架：App、前台服务、通知渠道兼容、开机自启、崩溃日志 | ENV-08 | C-04 | K07 §2、§3.1 | API 19 与 API 29 编译通过；Z20 上服务常驻 | TODO |
| A-02 | Connection：OkHttp 3.12 WebSocket、hello、重连退避、关闭码处理 | A-01, P-06 | FR-DEV-01 | K07 §3.1、K05 §3.1 | 对接 core 连接成功；断网重连 | TODO |
| A-03 | Outbox：固定信封 id、只收 K05 §3.3 指定事件、call.* TTL 60 秒、ack 删除 | A-02 | FR-SMS-02 | K07 §3.1 | JVM 单元测试；真机断网补传 | TODO |
| A-04 | CommandRouter：按 K05 §3.4 表校验并回 ack、重复 cmd id 回上次 ack | A-02 | E-02 | K07 §3.1 | 单元测试覆盖每条命令的 ok/ok:false | TODO |
| A-05 | 绑定：手动输入与 voipgw://bind 深链接、POST /api/device/bind、Credentials、解绑处理 | A-02 | FR-DEV-01 | K05 §2、K07 §3.7 | 真机绑定成功；解绑后清除凭据 | TODO |
| A-06 | SimInfoProvider（API 19 / 22）、status.snapshot、heartbeat（不入 Outbox） | A-04 | FR-DEV-04 | K07 §2 | Z20 上报双卡信息 | TODO |
| A-07 | 短信接收与分段合并 | A-03, A-06 | FR-SMS-01 | K07 §3.2 | 真机收普通/长短信 | TODO |
| A-08 | 短信发送任务与回执（设备端不限速） | A-04, A-06 | FR-SMS-03 | K07 §3.2 | 真机按卡槽发送并回报（真实短信需授权） | TODO |
| A-09 | CallStateMonitor、来电上报、本机人工接听识别、EmergencyGuard；核实 API 23–25 来电监听方式 | A-04 | FR-IN-01、FR-IN-06 | K07 §3.3 | 真机来电上报；APK 绝不自行接听 | TODO |
| A-10 | CallController：外拨指定 SIM、接听、拒接、挂断（API 23/26/28 实现） | A-09, A-11 | FR-WEB-01、FR-IN-02/03 | K07 §2、§3.3 | Z20 上按命令执行 | TODO |
| A-11 | ShizukuBridge 与 PrivilegedService（UserService、AIDL、socketpair） | A-01 | C-03 | K07 §3.4 | Z20 上 shell 身份服务启动并回报 uid=2000 | TODO |
| A-12 | LegacyCallAudio（L4）：VOICE_DOWNLINK 采集、TELEPHONY_TX 上行尝试、本机静音 | A-11 | C-03 | K07 §3.4 | G0 TC-G0-03/04 的设备侧能力 | TODO |
| A-13 | RedirectCallAudio（L5，API 33+） | A-11 | C-03 | K07 §3.4 | 编译通过；无 13+ 真机时标 REVIEW | TODO |
| A-14 | CapabilityProber 与 probe.run | A-10, A-11 | FR-DEV-04 | K07 §3.5 | 上报 L 等级与全部探测项 | TODO |
| A-15 | MediaSession：按 MediaLeg 连接、格式降级、早期媒体标记、JitterBuffer | A-12, P-06 | FR-OUT-07 | K07 §3.6、K05 §4 | 与 core /ws/media 往返；flags 正确 | TODO |
| A-16 | 主界面、引导向导、暂停开关（暂停语义按 K05 §3.4）、三语资源 | A-05, A-14 | FR-DEV-09, C-15 | K07 §3.7、K10 §10 | 三语切换；暂停时命令回 DEVICE_DISABLED | TODO |
| A-17 | 发布签名（从密码库读取到临时文件，用后删除）与 release 构建 | A-16 | — | K13 §8 | 签名 APK 可覆盖升级 | TODO |
| A-18 | DTMF（API 26+ InCallService；23–25 尽力） | A-10 | FR-WEB-03 | K07 §2 | 真机通话中发送按键对方可识别（G1） | TODO |

## Web 前端（W）

| 编号 | 任务 | 依赖 | 需求 | 参考 | 验收 | 状态 |
|---|---|---|---|---|---|---|
| W-01 | 脚手架：Vite、React、TS、Tailwind 4、theme.css（暂用原型 01 令牌）与 theme-decor.css | ENV-04 | — | K11 §1、K10 §2 | `npm run -w web build` 成功；组件中无硬编码颜色 | TODO |
| W-02 | UI 基础组件（K10 §7 全部）与 status-map | W-01 | — | K10 §3、§7 | 每个组件渲染与键盘交互测试 | TODO |
| W-03 | i18n：三语命名空间、语言切换并保存到服务端 | W-01 | C-15 | K11 §8 | i18n:check 通过 | TODO |
| W-04 | API 客户端、错误码映射、Bearer、401 跳转、登录页 | W-02, W-03, P-04 | FR-ADM-01 | K11 §3、§5 | 对接 core：登录、锁定提示 | TODO |
| W-05 | AppShell：顶部状态条、NavRail（侧边/顶部/导轨三布局）、主题浅深切换 | W-04 | — | K10 §4 | 断点行为符合 K10 §4 | TODO |
| W-06 | 实时连接（首条消息认证）与 cache-sync | W-05, C-WSA-01 | NFR-03 | K11 §4–5 | 断线提示与重连全量刷新 | TODO |
| W-07 | 仪表盘 | W-06, C-DASH-01, TL-SIM-01 | FR-ADM-02 | K10 §5 | 对接设备模拟器数值正确 | TODO |
| W-08 | 设备列表与详情、绑定弹窗（码 + 二维码 + 倒计时）、号码登记与复核 | W-06, C-DEV-04, C-SIM-01, TL-SIM-01 | FR-DEV-* | K10 §5 | 对接设备模拟器；过期显示未知 | TODO |
| W-09 | 短信页 | W-06, C-SMS-04 | FR-SMS-03 | K10 §5 | 对接设备模拟器收发；状态胶囊含“设备已接收” | TODO |
| W-10 | 平台通道页：两卡片、来电平台、登录分步、配对码弹窗、解除配对、语音已验证 | W-06, C-CH-02, C-PAIR-01 | FR-PAIR-* | K10 §5 | 对接假适配器完成登录与配对 | TODO |
| W-11 | 设置页 | W-06, C-SET-01 | — | K10 §5 | 保存与字段错误显示 | TODO |
| W-12 | 告警、指令、日志页 | W-06, C-ALR-01, C-CMDQ-01, C-AUDIT-01 | FR-OPS-01, FR-ADM-03/04 | K10 §5 | 分页与筛选 | TODO |
| W-13 | 通话页：记录、事件时间线、PatchView | W-06, C-CALL-03 | — | K10 §5–6 | 跳线图状态与读屏文本正确 | TODO |
| W-14 | 浏览器通话：安全上下文检测、AudioWorklet（通用重采样）、拨号面板、DTMF | W-13, C-MED-03 | FR-WEB-01/03 | K11 §7 | 对接设备模拟器正弦波往返；真机在 G1 | TODO |
| W-15 | 应用选定主题（替换 theme.css / theme-decor.css）与无障碍走查（K10 §11） | W-14, DEC-V01 | — | K10 §2、§11 | 清单全部勾选；替换主题后无异常 | TODO |
| W-16 | Playwright 端到端：登录、仪表盘、设备、发短信、配对码、设置 | W-15, TL-SIM-01 | — | K11 §10 | e2e 全部通过 | TODO |

## Telegram 适配器（T）

| 编号 | 任务 | 依赖 | 需求 | 参考 | 验收 | 状态 |
|---|---|---|---|---|---|---|
| T-SPIKE | 预研：x86_64 上 Telethon + 通话库主动一对一呼叫与双向 PCM；核实通话库许可证 | ENV-09 | C-12 | K09 §2 | 预研报告（K16 §5）；真实账号测试先获授权 | TODO |
| T-01 | IPC 客户端、重连、adapter.hello、capabilities、ack | P-07 | — | K09 §1、K05 §5 | 对接 core 假环境 | TODO |
| T-02 | 读取 config.toml [adapters.telegram]；登录状态机与 session 存储 | T-01 | FR-PAIR-01 | K09 §1–2 | fake 平台测试；真实登录需授权 | TODO |
| T-03 | 私聊收发、过滤群聊/转发、联系人判断、来电自动拒接上报 | T-02 | FR-PAIR-04/05 | K09 §2 | fake 平台测试 | TODO |
| T-04 | 一对一呼叫、状态与 CallCause 映射、挂断 | T-03, T-SPIKE | FR-IN-01、FR-OUT-03 | K09 §2、K05 §3.6 | fake 测试；真实在 G2 | TODO |
| T-05 | 通话音频 PCM（48 kHz 20 ms，audioChannel） | T-04 | — | K09 §2、K05 §5.1 | fake 测试；真实在 G2 | TODO |
| T-06 | systemd 单元与 venv 安装脚本 | T-05 | — | K13 §4、§6 | 服务器上可启动并连接 core | TODO |

## QQ 适配器（Q）

| 编号 | 任务 | 依赖 | 需求 | 参考 | 验收 | 状态 |
|---|---|---|---|---|---|---|
| Q-SPIKE-A | 预研 Q-A：x86_64 上 Linux QQ（--no-sandbox）+ 协议端；自研方式发起私聊语音与读写通话音频；PulseAudio root 运行方式核实 | ENV-10 | C-12 | K09 §3 | 预研报告；安装前列命令并说明 pulse 账户问题 | TODO |
| Q-SPIKE-B | 预研 Q-B：Xvfb + AT-SPI 识别通话界面与状态 | Q-SPIKE-A | C-12 | K09 §3 | 仅当 Q-A 不可行时执行 | TODO |
| Q-SPIKE-C | 预研 Q-C：安卓 QQ + 无障碍 + Shizuku 音频 | Q-SPIKE-B | C-12 | K09 §3 | 仅当 Q-A、Q-B 均不可行；需用户确认占用手机 | TODO |
| Q-01 | IPC 客户端、QqBackend 接口、fake-backend | P-03 | — | K09 §3 | fake 测试 | TODO |
| Q-02 | PulseAudio 虚拟设备读写 | Q-01, D-03 | — | K09 §3 | 服务器 null-sink 回环测试 | TODO |
| Q-03 | 选定路线 backend：登录、消息、呼叫、音频、来电自动拒接 | Q-02, Q-SPIKE-A | FR-PAIR-*, FR-IN-*, FR-OUT-* | K09 §3 | fake 测试；真实在 G3 | TODO |
| Q-04 | systemd 单元（Xvfb、PulseAudio、--no-sandbox） | Q-03 | — | K13 §6 | 服务器上可启动并连接 core | TODO |

## 工具（TL）

| 编号 | 任务 | 依赖 | 需求 | 参考 | 验收 | 状态 |
|---|---|---|---|---|---|---|
| TL-PROMPT-01 | “接通中”提示语音三语 PCM（espeak-ng 生成，16 kHz，CC0） | ENV-04 | C-13 | K09 §7 | 三个文件存在，时长 1.5～2.5 秒；登记 NOTICES | TODO |
| TL-SIM-01 | 设备模拟器（纯软件，N 台：hello、心跳、snapshot、短信、来电/外拨、正弦波音频、ack 分支） | P-05 | NFR-01 | K09 §4 | 25 台稳定运行 30 分钟 | TODO |
| TL-PROBE-01 | 音频探针（经 /internal/probe/call 外拨与来电接管、录 WAV、放测试音、报告） | C-INT-01, C-MED-03 | — | K09 §5 | 对接设备模拟器生成报告 | TODO |
| TL-ADB-01 | Shizuku 自启工具（adb 轮询、启动、上报） | C-INT-01 | FR-DEV-10 | K09 §6 | Z20 重启后自动恢复（需授权连接手机） | TODO |

## 部署（D）

| 编号 | 任务 | 依赖 | 需求 | 参考 | 验收 | 状态 |
|---|---|---|---|---|---|---|
| D-01 | 发布打包脚本 release:pack（不含 node_modules） | C-HTTP-01, W-01 | — | K13 §2–3 | tar.gz 结构正确 | TODO |
| D-02 | 服务器：PG 14 集群 voip、库 voip / voip_test、角色 voip（列命令→确认→执行，**M0 期间**） | ENV-10 | C-16 | K13 §4 | pg_lsclusters 新增 voip；其他集群不变 | TODO |
| D-03 | 服务器：安装 adb、PulseAudio、Xvfb 依赖（列命令→确认→执行；说明软件包可能自动创建的系统账户） | ENV-10 | — | K13 §4、K09 §3 | 命令可用；无其他服务变化 | TODO |
| D-04 | 首次部署 core + web + systemd、创建管理员 | D-01, D-02, C-AUTH-02 | — | K13 §4、§6 | /api/health 正常；Admin 可登录 | TODO |
| D-05 | 部署 Telegram 适配器（venv） | D-04, T-06 | — | K13 §4 | 适配器连接 core | TODO |
| D-06 | 部署 QQ 适配器（含客户端） | D-04, D-03, Q-04 | — | K13 §6 | 适配器连接 core | TODO |
| D-07 | 部署 Shizuku 自启并连接 Z20 | D-04, D-03, TL-ADB-01 | FR-DEV-10 | K13 §6 | TC-DEV-10 | TODO |

## 门槛验收（G）

| 编号 | 任务 | 依赖 | 需求 | 参考 | 验收 | 状态 |
|---|---|---|---|---|---|---|
| G-0 | 门槛 G0：Z20 设备能力（TC-G0-01～08） | A-14, A-15, A-16, C-MED-03, C-INT-01, TL-PROBE-01, D-04, D-07 | — | R08 §2 | 证据汇总（K16 §4）；结论写入 15 | TODO |
| G-1 | 门槛 G1：浏览器外拨真机 | G-0, W-14, C-CALL-03, A-18 | FR-WEB-* | R08 | 证据汇总 | TODO |
| G-2 | 门槛 G2：Telegram 真实账号（TC-TG-01～04） | T-05, D-05 | C-12 | K12 §7 | 证据汇总；通过后置 voice_verified | TODO |
| G-3 | 门槛 G3：QQ 真实账号（TC-QQ-01～04） | Q-03, D-06 | C-12 | K12 §7 | 证据汇总；不通过按 Q-A→Q-B→Q-C 切换 | TODO |
| G-4 | 门槛 G4：规模（设备模拟器 25 台 + 真机） | TL-SIM-01, D-04 | C-05, NFR-01 | R08 §4 | TC-SCALE-01～03 | TODO |
| G-IN-QQ | 来电转接真机验收（QQ 为来电平台，TC-IN-01～07） | G-0, G-3, C-CALL-05 | FR-IN-* | R08 | 证据汇总 | TODO |
| G-IN-TG | 来电转接真机验收（Telegram 为来电平台） | G-0, G-2, C-CALL-05 | FR-IN-* | R08 | 证据汇总 | TODO |
| G-OUT-QQ | 消息外呼真机验收（QQ，TC-OUT-01～10） | G-0, G-3, C-CALL-06 | FR-OUT-* | R08 | 证据汇总 | TODO |
| G-OUT-TG | 消息外呼真机验收（Telegram） | G-0, G-2, C-CALL-06 | FR-OUT-* | R08 | 证据汇总 | TODO |

## 缺陷（BUG）

| 编号 | 问题 | 依赖 | 需求 | 参考 | 验收 | 状态 |
|---|---|---|---|---|---|---|
| — | （暂无） | | | | | |

## 统计（随状态更新）

| 模块 | 总数 | READY | BLOCKED | DOING | REVIEW | DONE |
|---|---|---|---|---|---|---|
| DEC | 1 | 0 | 1 | 0 | 0 | 0 |
| ENV | 11 | 3 | 0 | 0 | 0 | 0 |
| P | 7 | 0 | 0 | 0 | 0 | 0 |
| C | 45 | 0 | 0 | 1 | 2 | 0 |
| A | 18 | 0 | 0 | 0 | 0 | 0 |
| W | 16 | 0 | 0 | 0 | 0 | 0 |
| T | 7 | 0 | 0 | 0 | 0 | 0 |
| Q | 7 | 0 | 0 | 0 | 0 | 0 |
| TL | 4 | 0 | 0 | 0 | 0 | 0 |
| D | 7 | 0 | 0 | 0 | 0 | 0 |
| G | 9 | 0 | 0 | 0 | 0 | 0 |
| 合计 | 132 | 3 | 1 | 1 | 2 | 0 |
