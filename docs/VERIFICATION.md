# Verification record / 验证记录

[中文](#简体中文) · [English](#english)

## 简体中文

本轮在 [短信回执与设备告警基线](https://github.com/copypasteltd/SIP2IM/blob/f5fc23fb6ddf3e8edfc0ae924009058d3b69365e/docs/VERIFICATION.md) 上完成运维告警的离线回归。测试使用原生 Windows、离线夹具和仅回环的合成 Web 演示。未连接真实 PostgreSQL、Android、SIM、运营商或平台账号。

| 范围 | 实测结果 | 证据边界 |
|---|---|---|
| Core | Node 22.23.5 类型检查、ESM 构建及 856 项离线测试通过；6 项跳过。 | 模拟事务覆盖八类运维告警中的新增规则、去重与恢复，以及短信、绑定、调度与关停。跳过 5 个 PostgreSQL 用例及 1 个 Windows 上不适用的 IPC 用例。 |
| Web | Node 22.23.5：类型检查、174 项离线 Web 测试、ESLint 和三语键检查通过。 | Vitest/JSDOM 使用合成接口。覆盖告警确认后的接口读回与状态显示；原生演示见下。 |
| Android | 上一版基线：JDK 17、Gradle 8.11.1 和 SDK Platform 35：app 39 项、protocol 34 项 JVM 单测通过；lint 0 错误、7 警告；调试 APK 构建通过。 | 不证明安装、权限、后台保活、运营商回执或蜂窝音频。本轮未修改 Android，沿用上版记录。生成的 APK 不入库。 |
| 适配器与模拟器 | 上一版基线：QQ 25 项、Telegram 29 项、软件模拟器 20 项 Node 测试与 2 项 Python 测试通过。 | 内存传输覆盖共享 ACK 和时间戳、替换连接与通话代次。真实账号、平台消息和蜂窝音频需要独立验收。 |
| 桌面 SQLite 和 Python | 上一版基线：83 项模型与源码测试、7 项绑定夹具和 3 项短信发送证据夹具通过。 | 桌面 SQLite 覆盖原申领核对与事务回滚，原生 Android 存储迁移需要真机验证。 |
| 合成演示 | 9 项原生冒烟测试通过。Chrome 从实际 Web 构建验证渠道告警确认为已确认而非已解除、设备告警仍未处理，以及绑定取消和模拟短信。 | 仅使用内存数据；录制不是实际渠道故障、真实通话或生产恢复的证据。 |

本轮实录覆盖仪表盘、渠道告警确认（设备离线告警仍未处理）、取消未使用的绑定记录和模拟短信发送。[仪表盘](media/dashboard.png) · [设备告警](media/alerts.png) · [绑定取消](media/bindings.png) · [模拟发送](media/sms.png) · [MP4](media/walkthrough.mp4) · [GIF](media/walkthrough.gif)。四张截图为 1440×900。静音 H.264 MP4 为 1440×900、129 帧、12.9 秒。GIF 为 800×500、90 帧、约 12.85 秒。两种格式均已完整解码，页面使用合成记录。

## English

This update verifies operational alerts on native Windows with offline fixtures and a loopback-only synthetic Web demo. It did not connect to production PostgreSQL, physical Android devices, SIMs, carriers or platform accounts. [Previous SMS and device-health verification](https://github.com/copypasteltd/SIP2IM/blob/f5fc23fb6ddf3e8edfc0ae924009058d3b69365e/docs/VERIFICATION.md)

| Scope | Observed result | Evidence boundary |
|---|---|---|
| Core | Node 22.23.5 type check, ESM build and 856 offline tests passed; six tests skipped. | Transaction fixtures cover the newly added operational alert rules and their deduplication and recovery, alongside SMS, binding, scheduling and shutdown. Five PostgreSQL cases and one IPC case that does not run on Windows were skipped. |
| Web | Node 22.23.5: TypeScript, 174 offline Web tests, ESLint and locale-key parity passed. | Vitest/JSDOM uses synthetic API responses. Coverage includes reading back and displaying acknowledged alerts. |
| Android | Previous baseline: JDK 17, Gradle 8.11.1 and SDK Platform 35: 39 app and 34 protocol JVM tests passed; lint reported 0 errors and 7 warnings; the debug APK built successfully. | This does not establish physical installation, permissions, background behavior, carrier receipts or cellular call audio. Android was unchanged in this update. The generated APK is not tracked. |
| Adapters and simulator | Previous baseline: 25 QQ, 29 Telegram, 20 Node simulator and 2 Python simulator tests passed. | In-memory transports verify shared ACK and timestamps, replaced connections and call generations. Live accounts, platform messaging and cellular audio require separate acceptance. |
| Desktop SQLite and Python | Previous baseline: 83 model and source checks, 7 binding fixtures and 3 SMS send-evidence fixtures passed. | Desktop SQLite covers original-claim matching and rollback. Physical Android storage migration requires on-device verification. |
| Synthetic demo | Nine native smoke tests passed. Actual Web in Chrome showed an acknowledged, not resolved, channel warning alongside an open device warning, followed by binding cancellation and a simulated SMS send. | In-memory records only. The footage does not establish real channel loss, calls or production recovery. |

The walkthrough covers Dashboard, channel acknowledgement alongside an open device warning, cancellation of an unused binding record, and a simulated SMS send. [Dashboard](media/dashboard.png) · [Device alerts](media/alerts.png) · [Binding cancellation](media/bindings.png) · [Simulated SMS](media/sms.png) · [MP4](media/walkthrough.mp4) · [GIF](media/walkthrough.gif). The four screenshots are 1440×900. The silent H.264 MP4 is 1440×900 with 129 frames and runs for 12.9 seconds. The GIF is 800×500 with 90 frames and runs for about 12.85 seconds. Both files decoded end to end. The UI uses synthetic records.

## Reproduce / 复现

Prepare the locked dependencies and native tools using the [usage guide](USAGE.md#native-builds-and-checks). Run the [documentation and capture checks](RELEASE-CHECKLIST.md) before publication. Run Core and Web Vitest after type checking, with database opt-ins unset unless a dedicated database has been separately authorized. The build and test commands are reproducible; publication deliberately excludes local tool paths, caches, logs, APKs and credentials. A subsequent update must keep both languages of the [changelog](../CHANGELOG.md), the affected instructions, and the demo assets in sync.

先按[使用手册](USAGE.md#native-builds-and-checks)准备锁定依赖与原生工具。发布前按[检查清单](RELEASE-CHECKLIST.md)复验文档与录制。从类型检查后运行 Core/Web Vitest；未单独授权隔离库时，不启用数据库测试。仓库不发布本机工具绝对路径、缓存、日志、APK 或凭据。后续更新同步[双语变更记录](../CHANGELOG.md)及受影响的说明和演示素材。
