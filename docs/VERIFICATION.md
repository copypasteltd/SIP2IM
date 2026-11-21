# Verification record / 验证记录

[中文](#简体中文) · [English](#english)

## 简体中文

本轮在[运维告警基线](https://github.com/copypasteltd/SIP2IM/blob/291548b6af0f27229518b59a12472145928ff972/docs/VERIFICATION.md)上，使用原生 Windows 离线验证设备配置对账、模拟器心跳调度和短信权限判定。没有连接生产 PostgreSQL、Android 真机、SIM、运营商或平台账号。

| 范围 | 实测结果 | 证据边界 |
|---|---|---|
| Core | Node 22.23.5 类型检查、ESM 构建及 882 项离线测试通过；6 项跳过。 | 新增覆盖配置丢 ACK、重复下发、新旧连接隔离、掉线后的轮转、关停排空和权限观测。跳过 5 项 PostgreSQL 用例及 1 项 Windows 上不适用的 IPC 用例。 |
| Web | 174 项离线测试、类型检查、ESLint、三语键检查及构建通过。 | 本轮没有修改 Web 源码。测试使用合成接口，仪表盘生产统计由 Core 夹具单独覆盖。 |
| Android | 上一版基线：JDK 17、Gradle 8.11.1 和 SDK Platform 35：app 39 项、protocol 34 项 JVM 单测通过；lint 0 错误、7 警告；调试 APK 构建通过。 | 不证明安装、权限、后台保活、运营商回执或蜂窝音频。本轮未修改 Android，沿用上版记录。生成的 APK 不入库。 |
| 适配器与模拟器 | 本轮软件模拟器 26 项 Node 测试和 2 项 Python 测试通过。QQ 25 项、Telegram 29 项为未变更适配器的历史记录。 | 模拟器使用内存传输和假时钟，不证明真机节拍、真实账号或蜂窝能力。 |
| 桌面 SQLite 和 Python | 上一版基线：83 项模型与源码测试、7 项绑定夹具和 3 项短信发送证据夹具通过。 | 桌面 SQLite 覆盖原申领核对与事务回滚，原生 Android 存储迁移需要真机验证。 |
| 合成演示 | 9 项冒烟测试通过；已复验 MP4 与 GIF 完整解码。 | 演示使用内存接口。Web 页面与已录制流程不变，复用上一版实录；它不展示本轮的实际设备配置对账。 |

保留的合成实录覆盖仪表盘、渠道告警确认（设备离线告警仍未处理）、取消未使用的绑定记录和模拟短信发送。[仪表盘](media/dashboard.png) · [设备告警](media/alerts.png) · [绑定取消](media/bindings.png) · [模拟发送](media/sms.png) · [MP4](media/walkthrough.mp4) · [GIF](media/walkthrough.gif)。四张截图为 1440×900。静音 H.264 MP4 为 1440×900、129 帧、12.9 秒。GIF 为 800×500、90 帧、约 12.85 秒。两种格式均已完整解码，页面使用合成记录。

## English

This update verifies device configuration reconciliation, simulator heartbeat scheduling, and SMS permission evidence on native Windows using offline fixtures. No production PostgreSQL, physical Android device, SIM, carrier or live account was connected. [Previous operational-alert verification](https://github.com/copypasteltd/SIP2IM/blob/291548b6af0f27229518b59a12472145928ff972/docs/VERIFICATION.md)

| Scope | Observed result | Evidence boundary |
|---|---|---|
| Core | Node 22.23.5 type check, ESM build and 882 offline tests passed; six tests skipped. | New coverage includes lost ACKs, config retries, replacement connections, rotation after a disconnect, shutdown drain and permission evidence. Five PostgreSQL cases and one IPC case that does not run on Windows were skipped. |
| Web | 174 offline tests passed, along with type checking, ESLint, locale-key parity and the build. | The Web source was unchanged. Tests use synthetic APIs; Core fixtures independently cover the dashboard calculation. |
| Android | Previous baseline: JDK 17, Gradle 8.11.1 and SDK Platform 35: 39 app and 34 protocol JVM tests passed; lint reported 0 errors and 7 warnings; the debug APK built successfully. | This does not establish physical installation, permissions, background behavior, carrier receipts or cellular call audio. Android was unchanged in this update. The generated APK is not tracked. |
| Adapters and simulator | 26 Node and two Python simulator tests passed in this round. The 25 QQ and 29 Telegram tests are historical results for unchanged adapters. | In-memory transport and fake clocks do not establish physical-device timing, live-account behavior or cellular capability. |
| Desktop SQLite and Python | Previous baseline: 83 model and source checks, 7 binding fixtures and 3 SMS send-evidence fixtures passed. | Desktop SQLite covers original-claim matching and rollback. Physical Android storage migration requires on-device verification. |
| Synthetic demo | Nine smoke tests passed. The retained MP4 and GIF decoded end to end. | In-memory APIs only. The Web pages and recorded flows did not change, so the prior Chrome walkthrough is retained. It does not show this round’s device configuration reconciliation. |

The retained synthetic walkthrough covers Dashboard, channel acknowledgement alongside an open device warning, cancellation of an unused binding record, and a simulated SMS send. [Dashboard](media/dashboard.png) · [Device alerts](media/alerts.png) · [Binding cancellation](media/bindings.png) · [Simulated SMS](media/sms.png) · [MP4](media/walkthrough.mp4) · [GIF](media/walkthrough.gif). The four screenshots are 1440×900. The silent H.264 MP4 is 1440×900 with 129 frames and runs for 12.9 seconds. The GIF is 800×500 with 90 frames and runs for about 12.85 seconds. Both files decoded end to end. The UI uses synthetic records.

## Reproduce / 复现

Prepare the locked dependencies and native tools using the [usage guide](USAGE.md#native-builds-and-checks). Run the [documentation and capture checks](RELEASE-CHECKLIST.md) before publication. Run Core and Web Vitest after type checking, with database opt-ins unset unless a dedicated database has been separately authorized. The build and test commands are reproducible; publication deliberately excludes local tool paths, caches, logs, APKs and credentials. A subsequent update must keep both languages of the [changelog](../CHANGELOG.md), the affected instructions, and the demo assets in sync.

先按[使用手册](USAGE.md#native-builds-and-checks)准备锁定依赖与原生工具。发布前按[检查清单](RELEASE-CHECKLIST.md)复验文档与录制。从类型检查后运行 Core/Web Vitest；未单独授权隔离库时，不启用数据库测试。仓库不发布本机工具绝对路径、缓存、日志、APK 或凭据。后续更新同步[双语变更记录](../CHANGELOG.md)及受影响的说明和演示素材。

Run the configuration and permission regressions from the repository root / 从仓库根目录运行配置与权限回归：

```sh
npm --prefix core run test -- --maxWorkers=1 test/device-config-sync.test.ts test/dashboard.test.ts test/device-health-alerts.test.ts test/main-critical-cleanup.test.ts
node --test tools/device-simulator/*.test.mjs
python -B -m unittest discover -s tools/device-simulator -p test_simulator.py
node --test tools/demo/demo.test.mjs
```

The demo smoke tests require a built Web bundle / 演示冒烟测试需要先构建 Web。
