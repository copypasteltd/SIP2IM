# Changelog / 变更记录

[简体中文](#简体中文) · [English](#english)

## 简体中文

### 2026-11-21 · 首次源码发布

- Android 将 v2 绑定请求和凭据保存在 SQLite v5 中。用户可恢复原尝试。Core 提供关联尝试的绑定结果、绑定码清单和按记录 ID 取消的管理接口。设备页新增 v2 签发、绑定记录和逐条复核取消。[Android 绑定](android/app/src/main/kotlin/io/voipgw/gateway/core/BindingReplay.kt) · [Core 绑定接口](core/src/http/binding-routes.ts) · [Web 绑定界面](web/src/features/devices/binding.tsx)
- 短信任务使用持久化调度尝试、ACK 证据、结果对账和管理员失效通知。队列按各 SIM 的可用速率重新唤醒。已确认的速率设置即时生效，提交未知时停止新的下发，直到核对并重启。短信页面支持检查待确认请求和读取已提交结果。异常入站短信提供关闭、保留和托管确认三种模式。[调度](core/src/sms/dispatch.ts) · [待确认短信](web/src/features/sms/send-sms.tsx) · [托管](core/src/devices/inbound-sms.ts)
- 管理员修改密码时，错误的原密码以 `403 OLD_PASSWORD_INVALID` 返回并保留当前会话。成功修改会使旧会话失效。通话控制在发送前复核操作会话，挂断按会话串行化。[账户接口](core/src/http/server.ts) · [通话控制](core/src/calls/web-calls.ts)
- 增加双语接入、实现说明、使用与恢复手册及发布检查。合成演示使用同一个 Web 后台构建和内存夹具，并提供仪表盘、绑定取消和模拟短信实录，包含截图、MP4 和 GIF。[接入](AGENTS.md) · [演示](README.md#快速演示) · [发布检查](docs/RELEASE-CHECKLIST.md)

### 验证范围

发布记录以本次构建和测试证据为准。跨版本迁移、真机、真实平台与电话音频分别验收。[本版实测记录](docs/VERIFICATION.md) · [验收清单](docs/RELEASE-CHECKLIST.md)

## English

### 2026-11-21 · Initial source publication

- Android stores v2 binding requests and credentials in SQLite v5 and supports explicit resume of the original attempt. Core exposes correlated binding results, an admin binding-code inventory, and cancellation by record ID. The Devices page adds v2 issuance, inventory, and cancellation with a record review step. [Android binding](android/app/src/main/kotlin/io/voipgw/gateway/core/BindingReplay.kt) · [Core binding routes](core/src/http/binding-routes.ts) · [Web binding UI](web/src/features/devices/binding.tsx)
- SMS tasks use durable dispatch attempts, ACK evidence, result reconciliation, and admin invalidation. Queue wakeups follow each SIM’s available rate. Confirmed rate changes take effect immediately. An unknown commit suspends new dispatch until reconciliation and restart. The SMS page can check a pending intent against committed state. Exceptional inbound SMS supports disabled, retain, and acknowledge custody modes. [Dispatch](core/src/sms/dispatch.ts) · [Pending SMS](web/src/features/sms/send-sms.tsx) · [Custody](core/src/devices/inbound-sms.ts)
- A wrong current administrator password returns `403 OLD_PASSWORD_INVALID` and leaves the active session in place. A successful update invalidates the old sessions. Call controls recheck session ownership before sending, and hangups serialize per call session. [Account API](core/src/http/server.ts) · [Call controls](core/src/calls/web-calls.ts)
- Added bilingual intake, implementation, usage and recovery guides, and release checks. The synthetic demo uses the Web console build with in-memory fixtures. Screenshots, an MP4 and an animated GIF show the dashboard, binding cancellation and a simulated SMS send. [Intake](AGENTS.md) · [Demo](README.md#quick-demo) · [Release checks](docs/RELEASE-CHECKLIST.md)

### Verification scope

Record the evidence for each release build and test run. Cross-version migrations, physical devices, real platforms and call audio have separate acceptance criteria. [Observed verification](docs/VERIFICATION.md) · [Acceptance checklist](docs/RELEASE-CHECKLIST.md)
