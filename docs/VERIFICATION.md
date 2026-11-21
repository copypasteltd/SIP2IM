# Verification record / 验证记录

[中文](#简体中文) · [English](#english)

## 简体中文

本轮在[设备命令回执截止基线](https://github.com/copypasteltd/SIP2IM/blob/7ff9726ff2a45572fe65ccce9da2014335fab85b/docs/VERIFICATION.md)上，用原生 Windows 和离线夹具验证 Core 的适配器账号命令正常回执与迟到存证窗口，以及超时后的持久操作恢复。未使用 PostgreSQL 实库、实际部署链路、真机、SIM 或平台账号。

| 范围 | 实测结果 | 证据边界 |
|---|---|---|
| Core | Node 22.23.5 类型检查与 ESM 构建通过；1089 项离线测试通过、6 项跳过。118 项聚焦回归通过，适配器管理与持久登录套件各 27 项。 | 覆盖两个精确截止、延迟与提前计时、旧连接隔离、同步写入回调、存证排空以及 504 后仅按原操作显式释放。全量跳过 5 项 PostgreSQL 实库用例和 1 项 Windows 不适用的 IPC 用例。 |
| Web | 231 项离线测试通过；类型检查、ESLint、三语键比对和构建通过。 | Web 源码未变。 |
| Android | 既有基线：JDK 17.0.21、Gradle 8.11.1、SDK Platform 35；app 62 项、protocol 34 项 JVM 单测通过，lint 0 错误、6 警告，调试 APK 构建成功。 | 本轮未改动 Android，未重跑或安装 APK。以往结果不验证真机、休眠或断网恢复。 |
| 适配器与模拟器 | QQ 22 项、Telegram 29 项、设备模拟器 26 项 Node 和 2 项 Python 测试为历史记录。 | 本轮未改动适配器或设备模拟器；假连接不证明真实账号或蜂窝能力。 |
| 桌面 SQLite 和 Python | 7 项绑定存储模型、83 项模型与源码检查和 3 项发送证据夹具为历史记录。 | 本轮未重跑；桌面 SQLite 不代替真机 SQLite 迁移。 |
| 合成演示 | 现有 12 项进程内 Node 冒烟测试通过；保留的 MP4 和 GIF 均完整解码。 | 演示、截图和录屏未改动；不展示真实平台登录或迟到回执的恢复。 |

保留的原生 Chrome 合成实录：[仪表盘](media/dashboard.png) · [告警历史](media/alerts-history.png) · [告警确认](media/alerts.png) · [绑定取消](media/bindings.png) · [模拟发送](media/sms.png) · [MP4](media/walkthrough.mp4) · [GIF](media/walkthrough.gif)。五张截图均为 1440×900。静音 H.264 MP4 为 1440×900、165 帧、16.5 秒；GIF 为 800×500、116 帧、16.57 秒。原始录制在确认后从操作日志核对了对应的一条合成 `alert.ack`。 [录制来源](https://github.com/copypasteltd/SIP2IM/blob/96d6c026e9366316bdcf7ac289de1c8f91a61784/docs/VERIFICATION.md)。

## English

This update uses native Windows and offline fixtures to verify Core’s normal and late adapter account ACK windows and durable recovery after timeout. No live PostgreSQL, deployed link, handset, SIM, or platform account was used. [Previous device command verification](https://github.com/copypasteltd/SIP2IM/blob/7ff9726ff2a45572fe65ccce9da2014335fab85b/docs/VERIFICATION.md)

| Scope | Observed result | Evidence boundary |
|---|---|---|
| Core | Node 22.23.5 type check and ESM build passed. 1089 offline tests passed and six skipped. The 118 focused tests include 27 adapter-manager and 27 persistent-login cases. | Coverage includes both exact cutoffs, early and delayed timers, retired connections, reentrant writes, draining accepted evidence, and explicit release of only the original operation after HTTP 504. Five PostgreSQL cases and one non-Windows IPC case were skipped. |
| Web | 231 offline tests passed, along with type checking, ESLint, locale-key parity, and the build. | Web source is unchanged. |
| Android | Earlier baseline: JDK 17.0.21, Gradle 8.11.1, and SDK Platform 35; 62 app and 34 protocol tests, lint with zero errors and six warnings, and a successful debug build. | Android did not change. Those checks were not rerun and no APK was installed. They do not verify handset, sleep, or network-loss recovery. |
| Adapters and simulator | The 22 QQ, 29 Telegram, 26 Node simulator, and two Python simulator tests are historical evidence. | Adapter and simulator sources were unchanged. Fake connections do not verify live accounts or cellular capability. |
| Desktop SQLite and Python | Seven binding storage fixtures, 83 model/source checks, and three SMS send-evidence fixtures are historical evidence. | Not rerun this round; desktop SQLite is not on-device migration evidence. |
| Synthetic demo | All 12 in-process Node smoke tests passed. Both retained motion files decoded end to end. | Demo fixtures, screenshots, and recordings are unchanged and do not show live platform sign-in or late-ACK recovery. |

Retained native Chrome evidence: [Dashboard](media/dashboard.png) · [Alert history](media/alerts-history.png) · [Alert acknowledgement](media/alerts.png) · [Binding cancellation](media/bindings.png) · [Simulated SMS](media/sms.png) · [MP4](media/walkthrough.mp4) · [GIF](media/walkthrough.gif). All five screenshots are 1440×900. The silent H.264 MP4 is 1440×900, 165 frames, and 16.5 seconds. The GIF is 800×500, 116 frames, and 16.57 seconds. The original walkthrough verified one synthetic `alert.ack` by reading the audit log after acknowledgement. [Capture provenance](https://github.com/copypasteltd/SIP2IM/blob/96d6c026e9366316bdcf7ac289de1c8f91a61784/docs/VERIFICATION.md).

## Reproduce / 复现

Prepare the locked dependencies and native tools using the [usage guide](USAGE.md#native-builds-and-checks). Run the [documentation and capture checks](RELEASE-CHECKLIST.md) before publication. Run Core and Web Vitest after type checking, with database opt-ins unset unless a dedicated database has been separately authorized. The build and test commands are reproducible; publication deliberately excludes local tool paths, caches, logs, APKs and credentials. A subsequent update must keep both languages of the [changelog](../CHANGELOG.md), the affected instructions, and the demo assets in sync.

先按[使用手册](USAGE.md#native-builds-and-checks)准备锁定依赖与原生工具。发布前按[检查清单](RELEASE-CHECKLIST.md)复验文档与录制。从类型检查后运行 Core/Web Vitest；未单独授权隔离库时，不启用数据库测试。仓库不发布本机工具绝对路径、缓存、日志、APK 或凭据。后续更新同步[双语变更记录](../CHANGELOG.md)及受影响的说明和演示素材。

Run the Core adapter ACK deadlines and persistent login fixtures from the repository root / 从仓库根目录运行 Core 适配器回执截止和持久登录回归：

```sh
npm --prefix core run test -- --maxWorkers=1 test/adapter-manager.test.ts test/adapter-runtime.test.ts test/login-persistent.test.ts test/login-operations.test.ts test/channel-control.test.ts test/channel-alerts.test.ts
npm --prefix web run test -- --maxWorkers=1 src/realtime/admin-socket.test.ts src/app/session-boundary.test.tsx src/features/channels/channel-actions.test.tsx
npm --prefix web run i18n:check && npm --prefix web run build
node --test tools/demo/demo.test.mjs
```

The demo smoke tests require a built Web bundle / 演示冒烟测试需要先构建 Web。
