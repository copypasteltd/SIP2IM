# Verification record / 验证记录

[中文](#简体中文) · [English](#english)

## 简体中文

本轮在[Android 握手时限基线](https://github.com/copypasteltd/SIP2IM/blob/c5c96f31a4eb4252c006032f1d61a3845585b707/docs/VERIFICATION.md)上，使用原生 Windows 工具和离线夹具，验证同一队头无 ACK 的退避、确认删除与连接代次隔离。未连接 Android 真机、SIM、运营商、平台账号或 PostgreSQL 实库。

| 范围 | 实测结果 | 证据边界 |
|---|---|---|
| Core | Node 22.23.5 类型检查、ESM 构建和 1023 项离线测试通过，6 项跳过。 | Core 未改动；入站托管和事件投影各 14 项通过。全量跳过 5 项 PostgreSQL 实库用例与 1 项 Windows 不适用的 IPC 用例。 |
| Web | 214 项离线测试通过；类型检查、ESLint、三语键比对和构建均通过。 | Web 源码未变。 |
| Android | JDK 17.0.21、Gradle 8.11.1、SDK Platform 35；app 62 项、protocol 34 项 JVM 单测通过，无失败或跳过；lint 0 错误、6 警告；调试 APK 构建通过。 | 新增 13 项回归：同队头逐级退避、传输退避独立、精确 ACK 与删除失败、旧计时回调、终止关闭和不同绑定隔离。不验证真机安装、休眠和断网恢复。APK 不入库。 |
| 适配器与模拟器 | QQ 22 项、Telegram 29 项、设备模拟器 26 项 Node 和 2 项 Python 测试为历史记录。 | 本轮未改动适配器或设备模拟器；假连接不证明真实账号或蜂窝能力。 |
| 桌面 SQLite 和 Python | 本轮重新运行 7 项绑定存储模型夹具，全部通过。其他 83 项模型与源码检查、3 项发送证据夹具为历史记录。 | 桌面 SQLite 验证模型中的回滚、绑定范围与旧记录保留，不代替真机 SQLite 迁移。 |
| 合成演示 | 未更改的 Web 产物通过 12 项 Node 冒烟测试；原 MP4 和 GIF 均完整解码。 | 演示和截图未改动，不展示 Android 的队头确认或重连。 |

保留的原生 Chrome 合成实录：[仪表盘](media/dashboard.png) · [告警历史](media/alerts-history.png) · [告警确认](media/alerts.png) · [绑定取消](media/bindings.png) · [模拟发送](media/sms.png) · [MP4](media/walkthrough.mp4) · [GIF](media/walkthrough.gif)。五张截图均为 1440×900。静音 H.264 MP4 为 1440×900、165 帧、16.5 秒；GIF 为 800×500、116 帧、16.57 秒。原始录制在确认后从操作日志核对了对应的一条合成 `alert.ack`。 [录制来源](https://github.com/copypasteltd/SIP2IM/blob/96d6c026e9366316bdcf7ac289de1c8f91a61784/docs/VERIFICATION.md)。

## English

This update verifies reconnect backoff for unacknowledged outbox heads, confirmed deletion, and connection generation fencing with native Windows tools and offline fixtures. No physical handset, SIM, carrier, platform account, or live PostgreSQL was used. [Previous Android handshake verification](https://github.com/copypasteltd/SIP2IM/blob/c5c96f31a4eb4252c006032f1d61a3845585b707/docs/VERIFICATION.md)

| Scope | Observed result | Evidence boundary |
|---|---|---|
| Core | Node 22.23.5 type check, ESM build, and 1023 offline tests passed; six skipped. | Core is unchanged. The inbound custody and event projection suites each passed 14 tests. Five PostgreSQL cases and one non-Windows IPC case were skipped. |
| Web | 214 offline tests passed, along with type checking, ESLint, locale-key parity, and the build. | Web source is unchanged. |
| Android | JDK 17.0.21, Gradle 8.11.1, and SDK Platform 35: 62 app and 34 protocol JVM tests passed, with no failures or skips. Lint reported 0 errors and 6 warnings; the debug APK built successfully. | Thirteen new tests cover repeated head stalls, independent transport backoff, exact ACKs and failed deletion, stale callbacks, terminal closure, and binding isolation. These checks do not verify handset installation, sleep behavior, or network-loss recovery. The APK is not tracked. |
| Adapters and simulator | The 22 QQ, 29 Telegram, 26 Node simulator, and two Python simulator tests are historical evidence. | Adapter and simulator sources were unchanged. Fake connections do not verify live accounts or cellular capability. |
| Desktop SQLite and Python | All seven binding storage fixtures passed in this round. The other 83 model/source checks and three SMS send-evidence fixtures are historical evidence. | Desktop SQLite covers the modeled rollback and binding scopes, not physical Android storage migration. |
| Synthetic demo | The unchanged Web build passed all 12 Node smoke tests. Both retained motion assets decoded end to end. | The demo and screenshots are unchanged and do not show Android outbox ACKs or reconnect backoff. |

Retained native Chrome evidence: [Dashboard](media/dashboard.png) · [Alert history](media/alerts-history.png) · [Alert acknowledgement](media/alerts.png) · [Binding cancellation](media/bindings.png) · [Simulated SMS](media/sms.png) · [MP4](media/walkthrough.mp4) · [GIF](media/walkthrough.gif). All five screenshots are 1440×900. The silent H.264 MP4 is 1440×900, 165 frames, and 16.5 seconds. The GIF is 800×500, 116 frames, and 16.57 seconds. The original walkthrough verified one synthetic `alert.ack` by reading the audit log after acknowledgement. [Capture provenance](https://github.com/copypasteltd/SIP2IM/blob/96d6c026e9366316bdcf7ac289de1c8f91a61784/docs/VERIFICATION.md).

## Reproduce / 复现

Prepare the locked dependencies and native tools using the [usage guide](USAGE.md#native-builds-and-checks). Run the [documentation and capture checks](RELEASE-CHECKLIST.md) before publication. Run Core and Web Vitest after type checking, with database opt-ins unset unless a dedicated database has been separately authorized. The build and test commands are reproducible; publication deliberately excludes local tool paths, caches, logs, APKs and credentials. A subsequent update must keep both languages of the [changelog](../CHANGELOG.md), the affected instructions, and the demo assets in sync.

先按[使用手册](USAGE.md#native-builds-and-checks)准备锁定依赖与原生工具。发布前按[检查清单](RELEASE-CHECKLIST.md)复验文档与录制。从类型检查后运行 Core/Web Vitest；未单独授权隔离库时，不启用数据库测试。仓库不发布本机工具绝对路径、缓存、日志、APK 或凭据。后续更新同步[双语变更记录](../CHANGELOG.md)及受影响的说明和演示素材。

Run the Android fixtures from the repository root using the installed native SDK and a populated Gradle cache / 使用已安装的原生 SDK 与预先填充的 Gradle 缓存，从仓库根目录运行 Android 测试：

```sh
gradle --offline -p android -Pandroid.builder.sdkDownload=false -Porg.gradle.java.installations.auto-download=false :app:testDebugUnitTest --tests "*.OutboxReconnectBackoffTest" --tests "*.BindingFenceTest"
gradle --offline -p android -Pandroid.builder.sdkDownload=false -Porg.gradle.java.installations.auto-download=false :app:testDebugUnitTest --rerun :protocol:test --rerun :app:lintDebug :app:assembleDebug
python -B -m unittest discover -s android/app/src/test -p test_binding_fence_sqlite.py -v
node --test tools/demo/demo.test.mjs
```

The demo smoke tests require a built Web bundle / 演示冒烟测试需要先构建 Web。
