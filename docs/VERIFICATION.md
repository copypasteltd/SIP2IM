# Verification record / 验证记录

[中文](#简体中文) · [English](#english)

## 简体中文

本轮在 [首次源码发布](https://github.com/copypasteltd/SIP2IM/blob/250a9bc129a6d19016330ff97cec69c03df47a14/docs/VERIFICATION.md) 的基础上，验证了短信回执、设备健康告警、适配器 IPC 和内存通话夹具。测试使用原生 Windows、离线夹具及仅回环的合成 Web 演示。生产 PostgreSQL、Android 真机、真实 SIM、运营商回执和平台账号的验收待执行。

| 范围 | 实测结果 | 证据边界 |
|---|---|---|
| Core | Node 22.23.5 类型检查、ESM 构建及 807 项离线测试通过。6 项跳过。 | 健康告警、持久化短信结果、绑定、调度和关停通过离线夹具。跳过 5 个 PostgreSQL 用例及 1 个 Windows 上不适用的 IPC 用例。 |
| Web | Node 22.23.5：类型检查、174 项离线 Web 测试、ESLint 和三语键检查通过。 | Vitest/JSDOM 使用合成接口。告警回读及浏览器演示已验证。 |
| Android | JDK 17、Gradle 8.11.1 和 SDK Platform 35：app 39 项、protocol 34 项 JVM 单测通过；lint 0 错误、7 警告；调试 APK 构建通过。 | 不证明安装、权限、后台保活、运营商回执或蜂窝音频。生成的 APK 不入库。 |
| 适配器与模拟器 | QQ 25 项、Telegram 29 项、软件模拟器 20 项 Node 测试与 2 项 Python 测试通过。 | 内存传输覆盖共享 ACK 和时间戳、替换连接与通话代次。真实账号、平台消息和蜂窝音频需要独立验收。 |
| 桌面 SQLite 和 Python | 83 项模型与源码测试、7 项绑定夹具和 3 项短信发送证据夹具通过。 | 桌面 SQLite 覆盖原申领核对与事务回滚，原生 Android 存储迁移需要真机验证。 |
| 合成演示 | 8 项原生冒烟测试通过。Chrome 从真实 Web 构建完成登录、仪表盘、查看设备离线告警、核对并取消一条未使用的演示绑定记录、发送一条模拟短信。 | 没有连接 Android、PostgreSQL、QQ/Telegram 或运营商。不演示真实外拨与双向音频。 |

本轮实录覆盖仪表盘、设备离线告警、取消未使用的绑定记录和模拟短信发送。[仪表盘](media/dashboard.png) · [设备告警](media/alerts.png) · [绑定取消](media/bindings.png) · [模拟发送](media/sms.png) · [MP4](media/walkthrough.mp4) · [GIF](media/walkthrough.gif)。四张截图为 1440×900。静音 H.264 MP4 为 1440×900、133 帧、13.3 秒。GIF 为 800×500、93 帧、约 13.28 秒。两种格式均已完整解码，页面使用合成记录。

## English

This update validates SMS result handling, device health alerts, adapter IPC and the in-memory call fixture. Tests ran on native Windows with offline fixtures and a loopback-only synthetic Web demo. Production PostgreSQL, physical Android devices, SIMs, carrier receipts and live platform accounts still require separate acceptance. [Initial source publication](https://github.com/copypasteltd/SIP2IM/blob/250a9bc129a6d19016330ff97cec69c03df47a14/docs/VERIFICATION.md)

| Scope | Observed result | Evidence boundary |
|---|---|---|
| Core | Node 22.23.5 type check, ESM build and 807 offline tests passed. Six tests skipped. | Fixture coverage includes health alerts, durable SMS results, binding, scheduling and shutdown. The skips cover five PostgreSQL tests and one IPC case that requires a different OS. |
| Web | Node 22.23.5: TypeScript, 174 offline Web tests, ESLint and locale-key parity passed. | Vitest/JSDOM uses synthetic API responses. Coverage includes alert polling and recovery. |
| Android | JDK 17, Gradle 8.11.1 and SDK Platform 35: 39 app and 34 protocol JVM tests passed; lint reported 0 errors and 7 warnings; the debug APK built successfully. | This does not establish physical installation, permissions, background behavior, carrier receipts or cellular call audio. The generated APK is not tracked. |
| Adapters and simulator | 25 QQ, 29 Telegram, 20 Node simulator and 2 Python simulator tests passed. | In-memory transports verify shared ACK and timestamps, replaced connections and call generations. Live accounts, platform messaging and cellular audio require separate acceptance. |
| Desktop SQLite and Python | 83 model and source checks, 7 binding fixtures and 3 SMS send-evidence fixtures passed. | Desktop SQLite covers original-claim matching and rollback. Physical Android storage migration requires on-device verification. |
| Synthetic demo | 8 native smoke tests passed. Native Chrome rendered the actual Web build and verified sign-in, Dashboard, the offline warning, review and cancellation of one unused fixture binding, and a simulated SMS send. | The fixture has no backend connection to Android, PostgreSQL, QQ/Telegram or carriers. It does not demonstrate a real call or two-way audio. |

The walkthrough covers Dashboard, a device offline warning, cancellation of an unused binding record, and a simulated SMS send. [Dashboard](media/dashboard.png) · [Device alerts](media/alerts.png) · [Binding cancellation](media/bindings.png) · [Simulated SMS](media/sms.png) · [MP4](media/walkthrough.mp4) · [GIF](media/walkthrough.gif). The four screenshots are 1440×900. The silent H.264 MP4 is 1440×900 with 133 frames and runs for 13.3 seconds. The GIF is 800×500 with 93 frames and runs for about 13.28 seconds. Both files decoded end to end. The UI uses synthetic records.

## Reproduce / 复现

Prepare the locked dependencies and native tools using the [usage guide](USAGE.md#native-builds-and-checks). Run the [documentation and capture checks](RELEASE-CHECKLIST.md) before publication. Run Core and Web Vitest after type checking, with database opt-ins unset unless a dedicated database has been separately authorized. The build and test commands are reproducible; publication deliberately excludes local tool paths, caches, logs, APKs and credentials. A subsequent update must keep both languages of the [changelog](../CHANGELOG.md), the affected instructions, and the demo assets in sync.

先按[使用手册](USAGE.md#native-builds-and-checks)准备锁定依赖与原生工具。发布前按[检查清单](RELEASE-CHECKLIST.md)复验文档与录制。从类型检查后运行 Core/Web Vitest；未单独授权隔离库时，不启用数据库测试。仓库不发布本机工具绝对路径、缓存、日志、APK 或凭据。后续更新同步[双语变更记录](../CHANGELOG.md)及受影响的说明和演示素材。
