# Verification record / 验证记录

[中文](#简体中文) · [English](#english)

## 简体中文

本轮在[登录挑战基线](https://github.com/copypasteltd/SIP2IM/blob/98d480237c73b7ceaae97a492fc7f08b2eebea7c/docs/VERIFICATION.md)上，使用原生 Windows 和离线夹具验证入站短信通知的数据库连接隔离、精确清理及停机排空。未连接 PostgreSQL 实库、Android 真机、SIM、运营商或平台账号。

| 范围 | 实测结果 | 证据边界 |
|---|---|---|
| Core | Node 22.23.5 类型检查、ESM 构建和 1023 项离线测试通过，6 项跳过。 | 86 项聚焦回归覆盖单连接池中的订阅者鉴权、微秒标记匹配、清理提交不明、所有权丢失以及启动失败和正常停机。全量跳过 5 项 PostgreSQL 实库用例和 1 项不适用于 Windows 的 IPC 用例。 |
| Web | 214 项离线测试通过；类型检查、ESLint、三语键比对和构建均通过。 | Web 源码未变，继续将短信通知用作 REST 读回提示。 |
| Android | 上一版基线：JDK 17、Gradle 8.11.1 和 SDK Platform 35：app 39 项、protocol 34 项 JVM 单测通过；lint 0 错误、7 警告；调试 APK 构建通过。 | 不证明安装、权限、后台保活、运营商回执或蜂窝音频。本轮未修改 Android，沿用上版记录。生成的 APK 不入库。 |
| 适配器与模拟器 | QQ 22 项、Telegram 29 项、设备模拟器 26 项 Node 和 2 项 Python 测试为历史记录。 | 本轮未改动适配器或设备模拟器；假连接不证明真实账号或蜂窝能力。 |
| 桌面 SQLite 和 Python | 上一版基线：83 项模型与源码测试、7 项绑定夹具和 3 项短信发送证据夹具通过。 | 桌面 SQLite 覆盖原申领核对与事务回滚，原生 Android 存储迁移需要真机验证。 |
| 合成演示 | Web 构建通过现有 12 项 Node 冒烟测试；保留的 MP4 和 GIF 均已完整解码。 | 演示、录屏和截图未改动；内存接口与合成流程不测试入站通知工作器或实际短信。 |

保留的原生 Chrome 合成实录：[仪表盘](media/dashboard.png) · [告警历史](media/alerts-history.png) · [告警确认](media/alerts.png) · [绑定取消](media/bindings.png) · [模拟发送](media/sms.png) · [MP4](media/walkthrough.mp4) · [GIF](media/walkthrough.gif)。五张截图均为 1440×900。静音 H.264 MP4 为 1440×900、165 帧、16.5 秒；GIF 为 800×500、116 帧、16.57 秒。原始录制在确认后从操作日志核对了对应的一条合成 `alert.ack`。 [录制来源](https://github.com/copypasteltd/SIP2IM/blob/96d6c026e9366316bdcf7ac289de1c8f91a61784/docs/VERIFICATION.md)。

## English

This update verifies incoming SMS notification pool isolation, exact marker cleanup, and shutdown draining using native Windows offline fixtures. No live PostgreSQL, physical device, SIM, carrier, or platform account was used. [Previous login challenge verification](https://github.com/copypasteltd/SIP2IM/blob/98d480237c73b7ceaae97a492fc7f08b2eebea7c/docs/VERIFICATION.md)

| Scope | Observed result | Evidence boundary |
|---|---|---|
| Core | Node 22.23.5 type check, ESM build, and 1023 offline tests passed; six skipped. | The 86 focused tests cover subscriber authorization with a single-slot pool fixture, microsecond marker matching, uncertain cleanup commits, ownership loss, failed startup, and graceful shutdown. The full suite skipped five PostgreSQL cases and one IPC case that does not run on Windows. |
| Web | 214 offline tests passed, along with type checking, ESLint, locale-key parity, and the build. | Web source was unchanged and still treats SMS notifications as hints to read REST. |
| Android | Previous baseline: JDK 17, Gradle 8.11.1 and SDK Platform 35: 39 app and 34 protocol JVM tests passed; lint reported 0 errors and 7 warnings; the debug APK built successfully. | This does not establish physical installation, permissions, background behavior, carrier receipts or cellular call audio. Android was unchanged in this update. The generated APK is not tracked. |
| Adapters and simulator | The 22 QQ, 29 Telegram, 26 Node simulator, and two Python simulator tests are historical evidence. | Adapter and simulator sources were unchanged. Fake connections do not verify live accounts or cellular capability. |
| Desktop SQLite and Python | Previous baseline: 83 model and source checks, 7 binding fixtures and 3 SMS send-evidence fixtures passed. | Desktop SQLite covers original-claim matching and rollback. Physical Android storage migration requires on-device verification. |
| Synthetic demo | The Web bundle passed the 12 existing Node smoke tests; both retained motion assets decoded end to end. | Demo files, recordings, and screenshots were unchanged. The in-memory workflow does not exercise the incoming notification worker or live SMS. |

Retained native Chrome evidence: [Dashboard](media/dashboard.png) · [Alert history](media/alerts-history.png) · [Alert acknowledgement](media/alerts.png) · [Binding cancellation](media/bindings.png) · [Simulated SMS](media/sms.png) · [MP4](media/walkthrough.mp4) · [GIF](media/walkthrough.gif). All five screenshots are 1440×900. The silent H.264 MP4 is 1440×900, 165 frames, and 16.5 seconds. The GIF is 800×500, 116 frames, and 16.57 seconds. The original walkthrough verified one synthetic `alert.ack` by reading the audit log after acknowledgement. [Capture provenance](https://github.com/copypasteltd/SIP2IM/blob/96d6c026e9366316bdcf7ac289de1c8f91a61784/docs/VERIFICATION.md).

## Reproduce / 复现

Prepare the locked dependencies and native tools using the [usage guide](USAGE.md#native-builds-and-checks). Run the [documentation and capture checks](RELEASE-CHECKLIST.md) before publication. Run Core and Web Vitest after type checking, with database opt-ins unset unless a dedicated database has been separately authorized. The build and test commands are reproducible; publication deliberately excludes local tool paths, caches, logs, APKs and credentials. A subsequent update must keep both languages of the [changelog](../CHANGELOG.md), the affected instructions, and the demo assets in sync.

先按[使用手册](USAGE.md#native-builds-and-checks)准备锁定依赖与原生工具。发布前按[检查清单](RELEASE-CHECKLIST.md)复验文档与录制。从类型检查后运行 Core/Web Vitest；未单独授权隔离库时，不启用数据库测试。仓库不发布本机工具绝对路径、缓存、日志、APK 或凭据。后续更新同步[双语变更记录](../CHANGELOG.md)及受影响的说明和演示素材。

Run the incoming notification and shutdown regressions from the repository root / 从仓库根目录运行入站通知与关停回归：

```sh
npm --prefix core run test -- --maxWorkers=1 test/sms-incoming-outbox.test.ts test/sms-timestamp-projection.test.ts test/sms-inbound-custody.test.ts test/event-producer.test.ts
npm --prefix core run test -- --maxWorkers=1 test/sms-mark-notification.test.ts test/main-critical-cleanup.test.ts test/admin-hub.test.ts test/tracked-interval.test.ts test/signal-handling.test.ts
node --test tools/demo/demo.test.mjs
```

The demo smoke tests require a built Web bundle / 演示冒烟测试需要先构建 Web。
