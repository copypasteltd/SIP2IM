# 07 模块设计 · Android 网关

> 版本 1.0 · 2026-11-20 · 关联：需求文档 [03](../03-Android网关设计.md)、本目录 [05](05-接口契约实现细则.md)
> applicationId：`io.voipgw.gateway` · minSdk 19 · targetSdk 34 · compileSdk 35

## 1. 工程结构

```text
android/
├─ protocol/                         纯 Kotlin/JVM 模块
│  └─ src/main/kotlin/io/voipgw/protocol/
│     ├─ Envelope.kt · DeviceMessages.kt · MediaFrame.kt · Codec.kt
│  └─ src/test/kotlin/…/FixtureTest.kt     读取 ../../packages/protocol/fixtures
└─ app/src/main/
   ├─ AndroidManifest.xml
   ├─ kotlin/io/voipgw/gateway/
   │  ├─ App.kt                       Application：初始化、崩溃日志
   │  ├─ platform/                    按 API 级别的适配层
   │  │  ├─ ApiLevel.kt               能力等级计算 L1–L5
   │  │  ├─ SimInfoProvider.kt        接口 + Api19/Api22 实现
   │  │  ├─ SmsSender.kt              接口 + Api19/Api22 实现
   │  │  ├─ CallController.kt         接口 + Api23/Api26/Api28 实现
   │  │  └─ ForegroundCompat.kt       通知渠道与前台服务类型
   │  ├─ core/
   │  │  ├─ GatewayService.kt         前台服务：生命周期总控
   │  │  ├─ Connection.kt             OkHttp WebSocket、重连、心跳
   │  │  ├─ Outbox.kt                 SQLiteOpenHelper 本地事件队列
   │  │  ├─ CommandRouter.kt          命令分发与 ack
   │  │  ├─ Credentials.kt            令牌存储（SharedPreferences 私有模式）
   │  │  └─ StatusReporter.kt         heartbeat、status.snapshot
   │  ├─ sms/
   │  │  ├─ SmsReceiver.kt            SMS_RECEIVED 广播接收
   │  │  ├─ SmsAssembler.kt           多段合并
   │  │  └─ SmsTaskRunner.kt          发送任务、回执 PendingIntent
   │  ├─ telephony/
   │  │  ├─ CallStateMonitor.kt       来电/去电状态（PhoneStateListener / InCallService）
   │  │  ├─ GatewayInCallService.kt   API 23+：companion InCallService
   │  │  └─ EmergencyGuard.kt         紧急号码拒绝
   │  ├─ privileged/
   │  │  ├─ ShizukuBridge.kt          Shizuku 绑定、权限、UserService 生命周期
   │  │  ├─ IPrivileged.aidl          特权服务接口
   │  │  ├─ PrivilegedService.kt      运行于 shell 身份的 UserService
   │  │  ├─ audio/LegacyCallAudio.kt  L4：VOICE_DOWNLINK 采集 + TELEPHONY_TX 路由尝试
   │  │  ├─ audio/RedirectCallAudio.kt L5：通话音频重定向接口
   │  │  └─ CapabilityProber.kt       各项探测
   │  ├─ media/
   │  │  ├─ MediaSession.kt           一通电话的媒体连接
   │  │  ├─ FrameCodec.kt             20 ms 切帧
   │  │  └─ JitterBuffer.kt
   │  └─ ui/
   │     ├─ MainActivity.kt           状态总览、暂停开关
   │     ├─ SetupWizardActivity.kt    首次引导
   │     └─ BindActivity.kt           输入服务器地址与绑定码
   └─ res/values/ · values-zh-rHK/ · values-en/
```

## 2. API 级别适配规则

每个随版本变化的能力都定义接口，按 `Build.VERSION.SDK_INT` 在 `platform/` 选择实现；业务代码只调用接口。

| 能力 | API 19–21 | API 22 | API 23–25 | API 26–27 | API 28–32 | API 33+ |
|---|---|---|---|---|---|---|
| SIM 列表 | TelephonyManager 主卡；双卡反射尽力 | SubscriptionManager | 同 22 | 同 22 | 同 22 | 同 22 |
| 发短信 | SmsManager.getDefault | getSmsManagerForSubscriptionId | 同 22 | 同 22 | 同 22 | 同 22 |
| 来电状态 | PhoneStateListener | 同 | PhoneStateListener（API 23–25 非默认拨号器的 InCallService 不会被系统绑定，**A-09 中核实**） | + InCallService（companion，需 Shizuku 设置） | 同 26 | 同 26 |
| 接听 | 不支持 | 不支持 | Shizuku shell：`input keyevent` 或隐藏接口（尽力） | TelecomManager.acceptRingingCall | 同 26 | 同 26 |
| 挂断/拒接 | 不支持 | 不支持 | Shizuku 隐藏接口（尽力） | 同 23 | TelecomManager.endCall | 同 28 |
| 外拨指定 SIM | ACTION_CALL（默认卡） | 同 19 | TelecomManager.placeCall + PhoneAccountHandle | 同 | 同 | 同 |
| DTMF | 不支持 | 不支持 | Shizuku 尽力 | InCallService Call.playDtmfTone | 同 26 | 同 26 |
| 下行音频 | 不支持 | 不支持 | 尽力探测 | Shizuku：AudioRecord(VOICE_DOWNLINK) | 同 26 | RedirectCallAudio |
| 上行音频 | 不支持 | 不支持 | 不支持 | Shizuku：AudioTrack 路由 TELEPHONY_TX（尽力） | 同 26 | RedirectCallAudio |
| 前台服务 | startService | 同 | 同 | startForegroundService + 渠道 | 同 | API 34 声明 foregroundServiceType |
| 运行时权限 | 安装时 | 同 | 运行时申请 | 同 | 同 | + POST_NOTIFICATIONS（33+） |

“尽力”项：实现 + 探测 + 如实上报，不作为验收必过项。

## 3. 模块职责与关键规则

### 3.1 core

- **GatewayService**：开机/进程启动后运行；持有 Connection、Outbox、CommandRouter。**暂停**（只能在手机本机切换）期间：照常心跳（paused=true）与上传短信、照常上报来电；对 sms.send / call.dial / call.answer 回 ack ok:false DEVICE_DISABLED（见 05 §3.4）。
- **Connection**：OkHttp 3.12 WebSocket。当前连接的 `onOpen` 发 hello，启动 10 秒单调时钟握手时限；在接纳 `hello.ok` 前复核截止时间。匹配的应答应用配置并发送 `status.snapshot` 后才启动正常心跳和 Outbox 发送。超时主动退出原连接，在确认释放持久代次后按现有 1、2、4、8、16、30 秒退避重连；终止性关闭与释放结果不明仍需核对。定时回调不唤醒休眠设备。
- **Outbox**：表 `outbox(id text primary key, type, payload, created_at, expires_at, attempts)`；id 即信封 id（evt_），**入表时生成并固定**，重发不变；收到 ack 删除。只有 05 §3.3 标为“进入 Outbox”的事件入表：heartbeat 与 status.snapshot 不入表；call.incoming / call.state 带 60 秒 TTL，过期删除不发；sms.received / sms.result 无 TTL、永不丢弃。
- **CommandRouter**：按 type 分发；按 05 §3.4 的表在“前置校验 + 提交”后回 ack（ok 或 ok:false + 错误码），执行结果另发事件；重复的命令 id 直接回上次的 ack，不重复执行（保留最近 500 个 id）。

### 3.2 sms

- 接收：解析 PDU → 按 originating address + 时间窗口 10 秒合并分段 → eventId = ULID → Outbox。
- 发送：持久化任务（表 `sms_task_local`）→ divideMessage → sendMultipartTextMessage，sentIntent/deliveryIntent 回报 → sms.result。
- 速率：**设备端不限速**，速率限制只在 core（08 §3.4）执行，避免两处重复限制。

### 3.3 telephony

- 来电：状态变为 RINGING → 生成 callId → call.incoming → 等待命令。**绝不自行接听**。
- 本机人工接听（未收到 call.answer 即进入 OFFHOOK/ACTIVE）：上报 call.state active + cause `local_answered`。
- 外拨：校验 EmergencyGuard → 按等级选择实现 → 上报 dialing / alerting / active / disconnected。
- 拨号开始时通知 media 模块开启早期下行采集（earlyMedia=true）。

### 3.4 privileged（API 23+，需 Shizuku）

- ShizukuBridge：检测 Shizuku 安装、运行、授权；绑定 UserService；状态变化上报。
- PrivilegedService（shell 身份）：通过 AIDL 暴露 `startDownlink(fd)`、`startUplink(fd)`、`stop()`、`answer()`、`endCall()`、`probe()`；音频数据经 `ParcelFileDescriptor.createSocketPair` 传回应用进程。
- 归属上下文：创建 AudioRecord/AudioTrack 时使用 shell 包名的 attribution，否则被音频策略拒绝。
- 本机静音：桥接期间将通话音量路由的本机输出静音、麦克风静音，结束后恢复。
- **独立实现**：只依据 AOSP 公开源码与文档编写，不参考 GPL 项目代码（C-02）。

### 3.5 CapabilityProber

| 探测项 | 方法 | 结果 |
|---|---|---|
| smsSend / smsReceive | 权限与 SmsManager 可用性 | ok / fail |
| dial | 权限 + PhoneAccount 可用 | ok / fail |
| answer | API ≥ 26 且权限；或 Shizuku 可用 | ok / fail / unsupported |
| downlink | 非通话时能否构造对应 AudioRecord（不读数据） | ok / fail / unsupported |
| uplink | 能否构造路由到 TELEPHONY_TX 的 AudioTrack（L4）或重定向对象（L5） | ok / fail / unsupported |
| earlyMedia | 仅在真实外拨中测得，默认 untested | — |

**探测 ok ≠ 通话可用**；通话可用以 G0 真人听测为准。

### 3.6 media

- 每通电话一个 MediaSession：收到 `call.dial` / `call.answer` 时按其中的 `mediaPath` 连接 /ws/media（设备令牌认证），下行帧上传，上行帧写入特权进程；通话结束关闭。
- 采样率：优先 16 kHz，构造失败降 8 kHz，帧头标明格式。
- 早期媒体：拨号到 active 之间的下行帧 flags bit0 = 1。

### 3.7 ui

- 三个界面：主界面（连接状态、各能力状态、暂停开关、Shizuku 状态与指引）、引导向导、绑定页。
- **绑定方式：** ① 手动输入服务器地址与 6 位码；② 用手机系统相机/扫码应用扫描 Admin 上的二维码，二维码内容为 `voipgw://bind?...` 深链接，APK 声明对应 intent-filter 接收并自动填入。**不引入扫码库、不申请 CAMERA 权限。** 绑定请求见 05 §2。
- 所有文案 `res/values*` 三语；界面适配 API 19（不用仅高版本可用的控件属性）。

## 4. Manifest 要点

- 权限：INTERNET、ACCESS_NETWORK_STATE、RECEIVE_SMS、SEND_SMS、READ_PHONE_STATE、READ_PHONE_NUMBERS（26+）、CALL_PHONE、ANSWER_PHONE_CALLS（26+）、FOREGROUND_SERVICE、FOREGROUND_SERVICE_PHONE_CALL（34，按核实结果）、POST_NOTIFICATIONS、RECEIVE_BOOT_COMPLETED、WAKE_LOCK、REQUEST_IGNORE_BATTERY_OPTIMIZATIONS。
- `usesCleartextTraffic="true"`（C-08 内网 HTTP）。
- Shizuku provider 声明；`tools:overrideLibrary="rikka.shizuku.api,rikka.shizuku.provider"`。

## 5. 构建与检查

- `./gradlew :protocol:test :app:testDebugUnitTest :app:lintDebug :app:assembleDebug`
- 发布：`:app:assembleRelease`，签名配置从 `~/.gradle/gradle.properties` 读取（不入库）。
- 每次构建检查 `minSdk=19` 未被依赖抬高（构建脚本中断言）。

## 6. 开发顺序（对应 14 中 A-xx）

以 [14 TODO 总表](14-TODO总表.md) 的 A- 编号为准（ENV-07、ENV-08、P-06 之后依次 A-01～A-18）。
