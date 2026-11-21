# Verification record / 验证记录

[中文](#简体中文) · [English](#english)

## 简体中文

本轮在[设备配置对账基线](https://github.com/copypasteltd/SIP2IM/blob/64940ec7edab5d06387571e0ff836ad68009a2b2/docs/VERIFICATION.md)上验证管理端告警分页、确认和原子审计。测试使用原生 Windows、离线夹具和隔离的回环 Web 演示，未连接 PostgreSQL 实库、真机、SIM、运营商或真实平台账号。

| 范围 | 实测结果 | 证据边界 |
|---|---|---|
| Core | Node 22.23.5 类型检查、ESM 构建和 892 项离线测试通过，6 项跳过。 | 覆盖微秒游标、筛选隔离、新记录插入、管理员会话复核、重复确认、审计回滚和未知提交回执。跳过 5 项 PostgreSQL 用例和 1 项 Windows 上不适用的 IPC 用例。 |
| Web | 182 项离线测试通过；类型检查、ESLint、三语键比对和构建均通过。 | 覆盖当前页读回、翻页失败时保留记录、分页响应边界和确认不自动重试。 |
| Android | 上一版基线：JDK 17、Gradle 8.11.1 和 SDK Platform 35：app 39 项、protocol 34 项 JVM 单测通过；lint 0 错误、7 警告；调试 APK 构建通过。 | 不证明安装、权限、后台保活、运营商回执或蜂窝音频。本轮未修改 Android，沿用上版记录。生成的 APK 不入库。 |
| 适配器与模拟器 | 上一版软件模拟器 26 项 Node 测试和 2 项 Python 测试通过。QQ 25 项、Telegram 29 项为未变更适配器的历史记录。 | 模拟器使用内存传输和假时钟，不证明真机节拍、真实账号或蜂窝能力。 |
| 桌面 SQLite 和 Python | 上一版基线：83 项模型与源码测试、7 项绑定夹具和 3 项短信发送证据夹具通过。 | 桌面 SQLite 覆盖原申领核对与事务回滚，原生 Android 存储迁移需要真机验证。 |
| 合成演示 | 12 项 Node 冒烟测试通过；原生 Chrome 实录和两种媒体完整解码均通过。 | 使用内存数据核对第二页、返回最新、确认渠道告警、唯一审计记录、绑定取消和模拟短信。不证明真实告警、数据库提交或渠道恢复。 |

本轮原生 Chrome 录制：[仪表盘](media/dashboard.png) · [告警历史](media/alerts-history.png) · [告警确认](media/alerts.png) · [绑定取消](media/bindings.png) · [模拟发送](media/sms.png) · [MP4](media/walkthrough.mp4) · [GIF](media/walkthrough.gif)。五张截图均为 1440×900。静音 H.264 MP4 为 1440×900、165 帧、16.5 秒；GIF 为 800×500、116 帧、16.57 秒。确认后自动化从操作日志核对了对应的一条合成 `alert.ack`。

## English

This update verifies paged administrator alerts, acknowledgement, and transactional auditing on native Windows with offline fixtures and an isolated loopback demo. No live database, device, SIM, carrier, or platform account was used. [Previous configuration and permission verification](https://github.com/copypasteltd/SIP2IM/blob/64940ec7edab5d06387571e0ff836ad68009a2b2/docs/VERIFICATION.md)

| Scope | Observed result | Evidence boundary |
|---|---|---|
| Core | Node 22.23.5 type check, ESM build, and 892 offline tests passed; six tests skipped. | Coverage includes exact cursor precision, filter scope, newly inserted records, current administrator authority, duplicate acknowledgement, audit rollback, and uncertain commit responses. Five PostgreSQL cases and one IPC case that does not run on Windows were skipped. |
| Web | 182 offline tests passed, along with type checking, ESLint, locale-key parity, and the build. | Covers current-page readback, retaining records after failed navigation, bounded page responses, and no automatic acknowledgement retry. |
| Android | Previous baseline: JDK 17, Gradle 8.11.1 and SDK Platform 35: 39 app and 34 protocol JVM tests passed; lint reported 0 errors and 7 warnings; the debug APK built successfully. | This does not establish physical installation, permissions, background behavior, carrier receipts or cellular call audio. Android was unchanged in this update. The generated APK is not tracked. |
| Adapters and simulator | 26 Node and two Python simulator tests passed in the previous baseline. The 25 QQ and 29 Telegram tests are historical results for unchanged adapters. | In-memory transport and fake clocks do not establish physical-device timing, live-account behavior or cellular capability. |
| Desktop SQLite and Python | Previous baseline: 83 model and source checks, 7 binding fixtures and 3 SMS send-evidence fixtures passed. | Desktop SQLite covers original-claim matching and rollback. Physical Android storage migration requires on-device verification. |
| Synthetic demo | Twelve Node smoke tests passed; native Chrome capture and end-to-end decoding of both formats passed. | In-memory data verifies page two, return to Latest, channel acknowledgement, one audit entry, binding cancellation and simulated SMS. It does not establish real incidents, database commits or channel recovery. |

Native Chrome evidence: [Dashboard](media/dashboard.png) · [Alert history](media/alerts-history.png) · [Alert acknowledgement](media/alerts.png) · [Binding cancellation](media/bindings.png) · [Simulated SMS](media/sms.png) · [MP4](media/walkthrough.mp4) · [GIF](media/walkthrough.gif). All five screenshots are 1440×900. The silent H.264 MP4 is 1440×900, 165 frames, and 16.5 seconds. The GIF is 800×500, 116 frames, and 16.57 seconds. The walkthrough verifies one synthetic `alert.ack` by reading the audit log after acknowledgement.

## Reproduce / 复现

Prepare the locked dependencies and native tools using the [usage guide](USAGE.md#native-builds-and-checks). Run the [documentation and capture checks](RELEASE-CHECKLIST.md) before publication. Run Core and Web Vitest after type checking, with database opt-ins unset unless a dedicated database has been separately authorized. The build and test commands are reproducible; publication deliberately excludes local tool paths, caches, logs, APKs and credentials. A subsequent update must keep both languages of the [changelog](../CHANGELOG.md), the affected instructions, and the demo assets in sync.

先按[使用手册](USAGE.md#native-builds-and-checks)准备锁定依赖与原生工具。发布前按[检查清单](RELEASE-CHECKLIST.md)复验文档与录制。从类型检查后运行 Core/Web Vitest；未单独授权隔离库时，不启用数据库测试。仓库不发布本机工具绝对路径、缓存、日志、APK 或凭据。后续更新同步[双语变更记录](../CHANGELOG.md)及受影响的说明和演示素材。

Run the alert and audit regressions from the repository root / 从仓库根目录运行告警与审计回归：

```sh
npm --prefix core run test -- --maxWorkers=1 test/alerts-http.test.ts test/operations.test.ts test/audit.test.ts test/audit-list.test.ts
npm --prefix web run test -- --maxWorkers=1 src/features/records/records.test.tsx src/features/dashboard/dashboard-activity.test.tsx
node --test tools/demo/demo.test.mjs
```

The demo smoke tests require a built Web bundle / 演示冒烟测试需要先构建 Web。
