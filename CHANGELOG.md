# Changelog / 变更记录

[简体中文](#简体中文) · [English](#english)

## 简体中文

### 2026-11-21 · 短信跨设备调度

- Core 每次发现最多 32 台有排队任务的设备，按设备 ID 续扫和回环；设备派发最多并发 4 轮，重复唤醒合并。关停取消尚未开始的普通唤醒，已开始的发送和结果对账仍排空。[扫描](core/src/sms/queue-repo.ts) · [派发](core/src/sms/dispatch.ts)
- 有其他设备等待时，慢 ACK 结束本次处理后会让位。下一轮继续轮转 SIM，保持各 SIM 自身 FIFO。结果不确定时仍不重发，持久化重试只核对原尝试。[调度回归](core/test/sms-device-admission.test.ts)
- 当前连接的新 SIM 快照提交后可以提前唤醒重新检查，心跳和周期扫描仍为兜底。快照不授予发送资格。[事件投影](core/src/devices/event-producer.ts)
- 本轮未改动 Web、演示和已发布的合成素材；复验了现有流程。[本轮验证](docs/VERIFICATION.md)

### 2026-11-21 · 告警分页与确认审计

- 告警页分批读取，支持上一页、下一页和返回最新；自动刷新只请求当前页。游标保留数据库微秒时间并绑定筛选状态。旧客户端未传分页参数时行为不变。[告警接口](core/src/http/operations.ts)
- 确认仅修改开放告警。写入前复核管理员会话，状态和审计一并提交；响应不确定时读回，不自动补发确认。[告警仓库](core/src/alerts/admin-repo.ts)
- 合成演示增加告警历史第二页，回到最新后确认渠道告警并核对操作日志。[历史截图](docs/media/alerts-history.png) · [本轮验证](https://github.com/copypasteltd/SIP2IM/blob/96d6c026e9366316bdcf7ac289de1c8f91a61784/docs/VERIFICATION.md)

### 2026-11-21 · 设备配置对账与权限证据

- Core 按数据库已提交设置对账设备的心跳周期和语言。丢失 ACK 后只重试当前设置；旧连接的回执不结算新连接。限量轮转和关停排空不影响短信与通话的禁止自动重试规则。[配置任务](core/src/settings/device-config.ts)
- 仪表盘和短信权限告警采用同一套时效与判定规则。冲突观测不计入短信就绪。软件模拟器按握手和配置命令更新当前连接的心跳周期。[权限证据](core/src/devices/sms-permissions.ts) · [模拟器](tools/device-simulator/README.md)
- 本轮未改变录屏所展示的操作。保留此前合成实录，并复验演示接口。[本轮验证](https://github.com/copypasteltd/SIP2IM/blob/64940ec7edab5d06387571e0ff836ad68009a2b2/docs/VERIFICATION.md)

### 2026-11-21 · 运维告警闭环

- 补齐渠道掉线、通话失败或结果未知、设备协议不兼容及 Shizuku 自启失败告警。告警来自已有的状态证据；已确认的记录不会在同一故障内反复打开。[告警规则](docs/IMPLEMENTATION.md#设备健康与运维告警)
- 通话告警单独扫描，不阻塞命令发送或 ACK。协议告警核验设备及原凭据，不改变连接准入。[通话投影](core/src/calls/failure-alerts.ts) · [协议观察](core/src/devices/protocol-alerts.ts)
- Web 三语显示告警原因与状态。合成演示录制渠道告警确认，并保留独立的设备离线告警。[确认截图](docs/media/alerts.png) · [本轮验证](https://github.com/copypasteltd/SIP2IM/blob/291548b6af0f27229518b59a12472145928ff972/docs/VERIFICATION.md)

### 2026-11-21 · 短信回执与设备告警

- Android 以原申领的绑定、连接代次、任务和分段匹配发送回执。部分成功保留为未知，同一分段的矛盾回执由 Core 保留为冲突。精确事件重放可以补回旧投影。[Android 回执](android/app/src/main/kotlin/io/voipgw/gateway/sms/SmsSendEvidence.kt) · [Core 对账](core/src/sms/results.ts)
- 接通设备离线、SIM 未就绪、Shizuku 不可用和短信权限告警。Web 支持三语显示和定期回读。确认保留历史，恢复后可记录下一次故障。[告警规则](core/src/devices/health-alerts.ts) · [合成告警实录](docs/media/alerts.png)
- QQ 与 Telegram IPC 对齐共享 ACK、时间戳和 UTF-8 校验。内存通话夹具可以核对通话代次、精确挂断和媒体失败。真实平台业务和蜂窝音频仍待实现及验收。[QQ 适配器](adapters/qq/README.md) · [Telegram 适配器](adapters/telegram/README.md) · [测试夹具](tools/device-simulator/README.md)
- 更新中英说明、四张合成截图、MP4 和 GIF。[本轮验证](https://github.com/copypasteltd/SIP2IM/blob/f5fc23fb6ddf3e8edfc0ae924009058d3b69365e/docs/VERIFICATION.md) · [演示](README.md#快速演示)

### 2026-11-21 · 首次源码发布

- Android 将 v2 绑定请求和凭据保存在 SQLite v5 中。用户可恢复原尝试。Core 提供关联尝试的绑定结果、绑定码清单和按记录 ID 取消的管理接口。设备页新增 v2 签发、绑定记录和逐条复核取消。[Android 绑定](android/app/src/main/kotlin/io/voipgw/gateway/core/BindingReplay.kt) · [Core 绑定接口](core/src/http/binding-routes.ts) · [Web 绑定界面](web/src/features/devices/binding.tsx)
- 短信任务使用持久化调度尝试、ACK 证据、结果对账和管理员失效通知。队列按各 SIM 的可用速率重新唤醒。已确认的速率设置即时生效，提交未知时停止新的下发，直到核对并重启。短信页面支持检查待确认请求和读取已提交结果。异常入站短信提供关闭、保留和托管确认三种模式。[调度](core/src/sms/dispatch.ts) · [待确认短信](web/src/features/sms/send-sms.tsx) · [托管](core/src/devices/inbound-sms.ts)
- 管理员修改密码时，错误的原密码以 `403 OLD_PASSWORD_INVALID` 返回并保留当前会话。成功修改会使旧会话失效。通话控制在发送前复核操作会话，挂断按会话串行化。[账户接口](core/src/http/server.ts) · [通话控制](core/src/calls/web-calls.ts)
- 增加双语接入、实现说明、使用与恢复手册及发布检查。合成演示使用同一个 Web 后台构建和内存夹具，并首次提供仪表盘、绑定取消和模拟短信的合成实录。[接入](AGENTS.md) · [演示](README.md#快速演示) · [发布检查](docs/RELEASE-CHECKLIST.md)

### 验证范围

发布记录以本次构建和测试证据为准。跨版本迁移、真机、真实平台与电话音频分别验收。[本版实测记录](docs/VERIFICATION.md) · [验收清单](docs/RELEASE-CHECKLIST.md)

## English

### 2026-11-21 · SMS scheduling across devices

- Core discovers up to 32 devices with queued work per scan, advancing and wrapping by device ID. It allows four active device turns and coalesces repeated wakes. Shutdown cancels unstarted ordinary wakes and drains admitted sends and result writes. [Discovery](core/src/sms/queue-repo.ts) · [Dispatcher](core/src/sms/dispatch.ts)
- After a slow ACK settles, another waiting device can take the slot. A later turn resumes SIM rotation without changing each SIM's FIFO. An uncertain action is never resent; a persistence retry reconciles only the original attempt. [Scheduling regressions](core/test/sms-device-admission.test.ts)
- A newly committed SIM snapshot on the current attachment can wake an eligibility recheck. Heartbeats and periodic scans remain fallbacks. A snapshot does not authorize a send. [Event producer](core/src/devices/event-producer.ts)
- Web, the demo, and the published synthetic media are unchanged; the existing workflow was rechecked. [Verification](docs/VERIFICATION.md)

### 2026-11-21 · Alert history and acknowledgement audit

- Alerts support Previous, Next and Latest. Polling fetches only the displayed page. The cursor preserves database microseconds and is bound to the state filter. Existing unpaged requests behave as before. [Alert API](core/src/http/operations.ts)
- Acknowledgement only changes open alerts. Core rechecks the administrator session and commits the transition and audit together. An uncertain response requires readback, not an automatic retry. [Alert repository](core/src/alerts/admin-repo.ts)
- The synthetic walkthrough opens the second history page, then returns to the latest page to acknowledge a channel alert and confirm its audit entry. [History screenshot](docs/media/alerts-history.png) · [Verification](https://github.com/copypasteltd/SIP2IM/blob/96d6c026e9366316bdcf7ac289de1c8f91a61784/docs/VERIFICATION.md)

### 2026-11-21 · Device configuration and permission evidence

- Core reconciles the heartbeat interval and locale against committed settings. After a missing ACK it retries only the current configuration; previous connections cannot settle a new attachment. Bounded rotation and shutdown drain leave the no-automatic-retry policy for SMS and calls unchanged. [Configuration reconciler](core/src/settings/device-config.ts)
- Dashboard and SMS permission alerts now use the same evidence and freshness rules. Contradictory grants no longer count as ready. The simulator applies hello and configuration changes to its current heartbeat schedule. [Permission evidence](core/src/devices/sms-permissions.ts) · [Simulator](tools/device-simulator/README.md)
- The demonstrated Web flows were unchanged. The existing synthetic recording remains applicable and its fixture was retested. [Verification](https://github.com/copypasteltd/SIP2IM/blob/64940ec7edab5d06387571e0ff836ad68009a2b2/docs/VERIFICATION.md)

### 2026-11-21 · Operational alert lifecycle

- Added alerts for channel loss, failed or uncertain calls, incompatible device protocols, and repeated Shizuku autostart failure. Alerts use existing state evidence, and acknowledgement suppresses duplicates within the same incident. [Alert rules](docs/IMPLEMENTATION.md#device-health-and-operational-alerts)
- Call alert scanning runs separately from command sends and ACKs. Protocol diagnostics verify the device and its original credential without changing connection admission. [Call projection](core/src/calls/failure-alerts.ts) · [Protocol observations](core/src/devices/protocol-alerts.ts)
- Web shows alert types and states in all three languages. The synthetic walkthrough acknowledges a channel warning while leaving the independent device warning open. [Acknowledgement screenshot](docs/media/alerts.png) · [Verification](https://github.com/copypasteltd/SIP2IM/blob/291548b6af0f27229518b59a12472145928ff972/docs/VERIFICATION.md)

### 2026-11-21 · SMS results and device health alerts

- Android matches each send callback to the original claim's binding, connection generation, task and part. Partial success remains unknown. Core preserves contradictory callbacks for the same part as a conflict. Exact event replay can repair an older projection. [Android send evidence](android/app/src/main/kotlin/io/voipgw/gateway/sms/SmsSendEvidence.kt) · [Core reconciliation](core/src/sms/results.ts)
- Added alerts for device timeout, SIM unavailability, Shizuku unavailability and missing SMS permission. The Web console localizes their labels and periodically refetches. Acknowledgement preserves history and observed recovery allows a future warning. [Alert rules](core/src/devices/health-alerts.ts) · [Recorded synthetic alert](docs/media/alerts.png)
- QQ and Telegram IPC now share ACK, timestamp and UTF-8 validation. An in-memory call fixture exercises call generation, exact hangup matching and failed media setup. Actual platform workflows and cellular audio still need implementation and acceptance. [QQ adapter](adapters/qq/README.md) · [Telegram adapter](adapters/telegram/README.md) · [Call fixture](tools/device-simulator/README.md)
- Updated both languages of the documentation, four synthetic screenshots, the MP4 and the GIF. [Verification](https://github.com/copypasteltd/SIP2IM/blob/f5fc23fb6ddf3e8edfc0ae924009058d3b69365e/docs/VERIFICATION.md) · [Demo](README.md#quick-demo)

### 2026-11-21 · Initial source publication

- Android stores v2 binding requests and credentials in SQLite v5 and supports explicit resume of the original attempt. Core exposes correlated binding results, an admin binding-code inventory, and cancellation by record ID. The Devices page adds v2 issuance, inventory, and cancellation with a record review step. [Android binding](android/app/src/main/kotlin/io/voipgw/gateway/core/BindingReplay.kt) · [Core binding routes](core/src/http/binding-routes.ts) · [Web binding UI](web/src/features/devices/binding.tsx)
- SMS tasks use durable dispatch attempts, ACK evidence, result reconciliation, and admin invalidation. Queue wakeups follow each SIM’s available rate. Confirmed rate changes take effect immediately. An unknown commit suspends new dispatch until reconciliation and restart. The SMS page can check a pending intent against committed state. Exceptional inbound SMS supports disabled, retain, and acknowledge custody modes. [Dispatch](core/src/sms/dispatch.ts) · [Pending SMS](web/src/features/sms/send-sms.tsx) · [Custody](core/src/devices/inbound-sms.ts)
- A wrong current administrator password returns `403 OLD_PASSWORD_INVALID` and leaves the active session in place. A successful update invalidates the old sessions. Call controls recheck session ownership before sending, and hangups serialize per call session. [Account API](core/src/http/server.ts) · [Call controls](core/src/calls/web-calls.ts)
- Added bilingual intake, implementation, usage and recovery guides, and release checks. The synthetic demo uses the Web console build with in-memory fixtures. This revision introduced the first synthetic dashboard, binding cancellation and simulated SMS walkthrough. [Intake](AGENTS.md) · [Demo](README.md#quick-demo) · [Release checks](docs/RELEASE-CHECKLIST.md)

### Verification scope

Record the evidence for each release build and test run. Cross-version migrations, physical devices, real platforms and call audio have separate acceptance criteria. [Observed verification](docs/VERIFICATION.md) · [Acceptance checklist](docs/RELEASE-CHECKLIST.md)
