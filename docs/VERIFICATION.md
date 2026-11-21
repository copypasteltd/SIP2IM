# Verification record / 验证记录

[中文](#简体中文) · [English](#english)

## 简体中文

本轮在[短信跨设备调度基线](https://github.com/copypasteltd/SIP2IM/blob/9e69883fbc04f1d04c2c56e7f600910b52e4724f/docs/VERIFICATION.md)上，使用原生 Windows 离线验证通话启动对账、浏览器预约回收和拨号准入。未连接 PostgreSQL 实库、Android 真机、SIM、运营商或真实平台账号。

| 范围 | 实测结果 | 证据边界 |
|---|---|---|
| Core | Node 22.23.5 类型检查、ESM 构建和 949 项离线测试通过，6 项跳过。 | 覆盖启动分页、独占所有权丢失、未确定的提交、过期预约、未拨号证据、锁冲突、拒绝后清理和未知通话隔离。跳过 5 项 PostgreSQL 用例和 1 项 Windows 上不适用的 IPC 用例。 |
| Web | 182 项离线测试通过；类型检查、ESLint、三语键比对和构建均通过。 | Web 源码未变。此结果不验证实际通话或媒体链路。 |
| Android | 上一版基线：JDK 17、Gradle 8.11.1 和 SDK Platform 35：app 39 项、protocol 34 项 JVM 单测通过；lint 0 错误、7 警告；调试 APK 构建通过。 | 不证明安装、权限、后台保活、运营商回执或蜂窝音频。本轮未修改 Android，沿用上版记录。生成的 APK 不入库。 |
| 适配器与模拟器 | 上一版软件模拟器 26 项 Node 测试和 2 项 Python 测试通过。QQ 25 项、Telegram 29 项为未变更适配器的历史记录。 | 模拟器使用内存传输和假时钟，不证明真机节拍、真实账号或蜂窝能力。 |
| 桌面 SQLite 和 Python | 上一版基线：83 项模型与源码测试、7 项绑定夹具和 3 项短信发送证据夹具通过。 | 桌面 SQLite 覆盖原申领核对与事务回滚，原生 Android 存储迁移需要真机验证。 |
| 合成演示 | 12 项 Node 冒烟测试通过；保留的 MP4 和 GIF 已复验完整解码。 | Web、演示和媒体文件未改动。原生录屏使用内存接口，不验证本轮的通话恢复、实库提交或蜂窝音频。 |

保留的原生 Chrome 合成实录：[仪表盘](media/dashboard.png) · [告警历史](media/alerts-history.png) · [告警确认](media/alerts.png) · [绑定取消](media/bindings.png) · [模拟发送](media/sms.png) · [MP4](media/walkthrough.mp4) · [GIF](media/walkthrough.gif)。五张截图均为 1440×900。静音 H.264 MP4 为 1440×900、165 帧、16.5 秒；GIF 为 800×500、116 帧、16.57 秒。原始录制在确认后从操作日志核对了对应的一条合成 `alert.ack`。

## English

This update verifies bounded call restart recovery, browser reservation expiry, and durable dial admission on native Windows using offline fixtures. No real PostgreSQL instance, physical device, SIM, carrier, or live account was used. [Previous SMS scheduling verification](https://github.com/copypasteltd/SIP2IM/blob/9e69883fbc04f1d04c2c56e7f600910b52e4724f/docs/VERIFICATION.md)

| Scope | Observed result | Evidence boundary |
|---|---|---|
| Core | Node 22.23.5 type check, ESM build, and 949 offline tests passed; six tests skipped. | Coverage includes restart paging, ownership loss, uncertain commits, expired reservations, proof of no dial, lock contention, cleanup after denied arming and unknown-call isolation. Five PostgreSQL cases and one IPC case that does not run on Windows were skipped. |
| Web | 182 offline tests passed, along with type checking, ESLint, locale-key parity, and the build. | Web source was unchanged. These results do not establish real calling or media. |
| Android | Previous baseline: JDK 17, Gradle 8.11.1 and SDK Platform 35: 39 app and 34 protocol JVM tests passed; lint reported 0 errors and 7 warnings; the debug APK built successfully. | This does not establish physical installation, permissions, background behavior, carrier receipts or cellular call audio. Android was unchanged in this update. The generated APK is not tracked. |
| Adapters and simulator | 26 Node and two Python simulator tests passed in the previous baseline. The 25 QQ and 29 Telegram tests are historical results for unchanged adapters. | In-memory transport and fake clocks do not establish physical-device timing, live-account behavior or cellular capability. |
| Desktop SQLite and Python | Previous baseline: 83 model and source checks, 7 binding fixtures and 3 SMS send-evidence fixtures passed. | Desktop SQLite covers original-claim matching and rollback. Physical Android storage migration requires on-device verification. |
| Synthetic demo | Twelve Node smoke tests passed, and both retained motion assets decoded end to end. | Web, the demo, and media files were unchanged. The original in-memory recording does not verify this round’s call recovery, PostgreSQL commits, or cellular audio. |

Retained native Chrome evidence: [Dashboard](media/dashboard.png) · [Alert history](media/alerts-history.png) · [Alert acknowledgement](media/alerts.png) · [Binding cancellation](media/bindings.png) · [Simulated SMS](media/sms.png) · [MP4](media/walkthrough.mp4) · [GIF](media/walkthrough.gif). All five screenshots are 1440×900. The silent H.264 MP4 is 1440×900, 165 frames, and 16.5 seconds. The GIF is 800×500, 116 frames, and 16.57 seconds. The original walkthrough verified one synthetic `alert.ack` by reading the audit log after acknowledgement.

## Reproduce / 复现

Prepare the locked dependencies and native tools using the [usage guide](USAGE.md#native-builds-and-checks). Run the [documentation and capture checks](RELEASE-CHECKLIST.md) before publication. Run Core and Web Vitest after type checking, with database opt-ins unset unless a dedicated database has been separately authorized. The build and test commands are reproducible; publication deliberately excludes local tool paths, caches, logs, APKs and credentials. A subsequent update must keep both languages of the [changelog](../CHANGELOG.md), the affected instructions, and the demo assets in sync.

先按[使用手册](USAGE.md#native-builds-and-checks)准备锁定依赖与原生工具。发布前按[检查清单](RELEASE-CHECKLIST.md)复验文档与录制。从类型检查后运行 Core/Web Vitest；未单独授权隔离库时，不启用数据库测试。仓库不发布本机工具绝对路径、缓存、日志、APK 或凭据。后续更新同步[双语变更记录](../CHANGELOG.md)及受影响的说明和演示素材。

Run the call recovery and reservation regressions from the repository root / 从仓库根目录运行通话恢复与预约回归：

```sh
npm --prefix core run test -- --maxWorkers=1 test/call-reconcile.test.ts test/call-outbound-ack.test.ts test/web-reservations.test.ts
npm --prefix core run test -- --maxWorkers=1 test/web-calls.test.ts test/call-device-events.test.ts test/main-critical-cleanup.test.ts
node --test tools/demo/demo.test.mjs
```

The demo smoke tests require a built Web bundle / 演示冒烟测试需要先构建 Web。
