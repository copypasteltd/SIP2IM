# Verification record / 验证记录

[中文](#简体中文) · [English](#english)

## 简体中文

这是源码首次发布的记录。实际测试在原生 Windows 环境进行，未启动 Docker、WSL 或 Android 模拟器，未连接真实 SIM、平台账号、生产服务器或业务数据库。通过的是本地构建、离线用例和合成演示，不是生产验收。

| 范围 | 实测结果 | 证据边界 |
|---|---|---|
| Core | Node 22.23.5：TypeScript 检查通过；782 项测试通过、6 项跳过；ESM 构建通过。 | 离线覆盖设备与管理员会话、绑定重放撤销、每 SIM 调度、提交不明、通知、通话代次、媒体接线和关停。PostgreSQL 与平台相关的选配用例未启用，测试数据和帧均为合成。 |
| Web | Node 22.23.5：类型检查、173 项离线 Web 测试、ESLint 和三语键检查通过。 | Vitest/JSDOM 使用合成接口。浏览器证据见下。 |
| Android | JDK 17、Gradle 8.11.1 和 SDK Platform 35：app 31 项、protocol 34 项 JVM 单测通过；lint 0 错误、6 警告；调试 APK 构建通过。 | 不证明安装、权限、后台保活、运营商回执或蜂窝音频。生成的 APK 不入库。 |
| 协议与平台夹具 | TypeScript 协议、QQ 12 项和 Telegram 24 项检查通过。 | QQ/TG 使用合成 IPC 和客户端夹具，不涉及真实账号或平台能力。 |
| Python | 模型和源码探针 83 项、Android 绑定 SQLite 夹具 7 项通过。 | SQLite 用的是桌面夹具，不能替代原生 Android 数据升级。 |
| 合成演示 | 8 项原生冒烟测试通过。Chrome 从真实 Web 构建完成登录、仪表盘、核对并取消一条未使用的演示绑定记录、发送一条模拟短信。 | 没有连接 Android、PostgreSQL、QQ/Telegram 或运营商。不演示真实外拨与双向音频。 |

保留的证据：[仪表盘](media/dashboard.png) · [绑定取消](media/bindings.png) · [模拟发送](media/sms.png) · [MP4](media/walkthrough.mp4) · [GIF](media/walkthrough.gif)。三张截图为 1440×900。静音 MP4 为 H.264、1440×900、124 帧、12.4 秒；GIF 为 800×500、约 12.43 秒。两者均完整解码。画面中的号码、记录、消息与账号为合成数据。

## English

This is the first source publication's verification record. The checks ran on native Windows, without Docker, WSL, or an Android emulator. No real SIM, platform account, production server, or business database was connected. Build, offline test, and synthetic demonstration evidence are not production acceptance.

| Scope | Observed result | Evidence boundary |
|---|---|---|
| Core | Node 22.23.5: TypeScript check passed; 782 tests passed and 6 skipped; ESM build passed. | The offline suite covers device and admin sessions, binding replay and cancellation, per-SIM scheduling, uncertain commits, notifications, call generations, media wiring and shutdown. Opt-in database and platform cases were not enabled. Records and frames were synthetic. |
| Web | Node 22.23.5: TypeScript, 173 offline Web tests, ESLint and locale-key parity passed. | Vitest/JSDOM uses synthetic API responses. See below for the actual browser recording. |
| Android | JDK 17, Gradle 8.11.1 and SDK Platform 35: 31 app and 34 protocol JVM tests passed; lint reported 0 errors and 6 warnings; the debug APK built successfully. | This does not establish physical installation, permissions, background behavior, carrier receipts or cellular call audio. The generated APK is not tracked. |
| Protocol and adapters | TypeScript protocol checks, 12 QQ tests and 24 Telegram tests passed. | The adapter tests use synthetic IPC/client fixtures and do not verify actual accounts or platforms. |
| Python | 83 model/source probes and 7 Android binding SQLite fixtures passed. | Desktop SQLite fixtures do not replace on-device Android migration tests. |
| Synthetic demo | 8 native smoke tests passed. Native Chrome rendered the actual Web build and verified sign-in, Dashboard, review and cancellation of one unused fixture binding, and a simulated SMS send. | The fixture has no backend connection to Android, PostgreSQL, QQ/Telegram or carriers. It does not demonstrate a real call or two-way audio. |

Recorded evidence: [Dashboard](media/dashboard.png) · [Binding cancellation](media/bindings.png) · [Simulated SMS](media/sms.png) · [MP4](media/walkthrough.mp4) · [GIF](media/walkthrough.gif). The screenshots are 1440×900. Silent H.264 MP4: 1440×900, 124 frames, 12.4 seconds. GIF: 800×500, about 12.43 seconds. Both files were decoded end-to-end. All numbers, records, messages and account data shown are synthetic.

## Reproduce / 复现

Prepare the locked dependencies and native tools using the [usage guide](USAGE.md#native-builds-and-checks). Run the [documentation and capture checks](RELEASE-CHECKLIST.md) before publication. Run Core and Web Vitest after type checking, with database opt-ins unset unless a dedicated database has been separately authorized. The build and test commands are reproducible; publication deliberately excludes local tool paths, caches, logs, APKs and credentials. A subsequent update must keep both languages of the [changelog](../CHANGELOG.md), the affected instructions, and the demo assets in sync.

先按[使用手册](USAGE.md#native-builds-and-checks)准备锁定依赖与原生工具。发布前按[检查清单](RELEASE-CHECKLIST.md)复验文档与录制。从类型检查后运行 Core/Web Vitest；未单独授权隔离库时，不启用数据库测试。仓库不发布本机工具绝对路径、缓存、日志、APK 或凭据。后续更新同步[双语变更记录](../CHANGELOG.md)及受影响的说明和演示素材。
