# VOIP Gateway / 安卓短信与电话网关

[简体中文](#简体中文) · [English](#english)

## 简体中文

VOIP Gateway 把 Android 设备及其 SIM 接入一个管理后台，提供设备绑定与状态、短信任务和历史，以及通话记录和平台适配器接口。仓库远端名称 `SIP2IM` 是历史命名。项目通过 HTTP、WebSocket 和本地进程间通信实现协议，**不使用 SIP**。

### 当前状态

- **Android** 已有 v2 绑定和待确认恢复、前台连接、SIM 状态观察及短信收发代码。以测试夹具和本机构建为验证范围，真机、SIM、厂商限制、系统权限和运营商回执仍需独立验收。
- **Core 与 Web** 提供管理接口、设备与短信页面、任务反馈和异常记录。标准运行方式为一个 Core 进程独占一个 PostgreSQL 数据库。绑定和短信的 HTTP 响应、队列 ACK、持久化 ACK 各有独立的含义。 在线设备的心跳和语言设置按已提交值对账，HTTP 保存不等于设备已确认。 短信以设备为单位限量派发，同一 SIM 保持排队顺序。
- **通话与平台** 目前包括协议、状态协调、媒体基础和测试替身。Android 的通话命令返回不支持。完整双向电话桥接、真实 QQ/Telegram 接入及生产运行仍待完成实现或验收。演示使用合成数据。 Core 分批对账未结会话，定时回收可证明未拨号的过期预约。 Core 不播放超龄媒体帧；断流诊断不会自动结束通话。 管理员可在读回原通话后确认挂断，不必保持本地音频连接。

### 快速演示

准备好本地 Web 依赖，从仓库根目录构建并启动。演示使用同源 API，构建环境和 Web 本地配置中的 `VITE_API_BASE` 应留空。

```sh
npm --prefix web run build --workspaces=false
node tools/demo/server.mjs
```

访问 [127.0.0.1:41730](http://127.0.0.1:41730/)，使用公开演示凭据 `demo / demo`。在仪表盘查看合成设备状态，在告警页浏览历史，再返回最新页，查看设备离线记录并确认一条合成渠道告警，在设备页查看绑定记录并取消一条未使用的演示绑定码，在短信页查阅历史或向虚构号码 `+1 202 555 0111` 提交模拟短信。记录保存在内存中，重启恢复初始数据。Ctrl+C 停止。需要更换回环端口时添加 `--port 41731`。界面上的演示标识对应模拟结果。[演示入口](tools/demo/server.mjs) · [演示操作说明](tools/demo/README.md)

**演示录屏** · 使用本机 Chrome 捕获仪表盘、告警翻页、渠道告警确认与审计核对、设备离线告警、取消未使用的绑定码和发送模拟短信的过程。画面中的设备、号码和状态均为合成数据。

[仪表盘截图](docs/media/dashboard.png) · [告警历史截图](docs/media/alerts-history.png) · [告警确认截图](docs/media/alerts.png) · [绑定取消截图](docs/media/bindings.png) · [模拟短信截图](docs/media/sms.png) · [MP4 视频](docs/media/walkthrough.mp4) · [GIF 动图](docs/media/walkthrough.gif)

![合成演示动图，依次展示仪表盘、告警翻页与确认、绑定码取消和发送模拟短信](docs/media/walkthrough.gif)

### 架构概览

Android 通过设备 WebSocket 连接 Core。Core 将状态和任务保存到 PostgreSQL。Web 通过管理 API 查询和操作，并通过管理 WebSocket 接收更新。平台适配器通过本地 IPC 连接 Core。合成演示使用同一个 Web 后台及内存 API。[实现说明](docs/IMPLEMENTATION.md)

### 本机构建与验证

从仓库根目录操作。Core、Web 和协议使用各自的 npm 锁文件。推荐 Node.js 22。首先按使用手册准备依赖，再使用下列命令。Android 使用系统安装的 JDK 17、Android SDK Platform 35 和兼容 AGP 8.7.3 的 Gradle 8.x（至少 8.9）。

```sh
npm --prefix packages/protocol run build --workspaces=false
npm --prefix core run check --workspaces=false
npm --prefix web run check --workspaces=false
npm --prefix web run i18n:check --workspaces=false
```

```sh
gradle --offline -p android :protocol:test :app:testDebugUnitTest :app:lintDebug :app:assembleDebug
python -B -m unittest discover -s tools -p test_sms_intent_model.py -v
```

Windows 可使用 `gradle.bat`。离线构建依赖预置的工具和依赖缓存。详细构建、CLI、首次安装与恢复步骤见 [使用与运维手册](docs/USAGE.md)。发布前核验见 [发布检查清单](docs/RELEASE-CHECKLIST.md)。

### 从这里开始

| 读者 | 入口 |
| --- | --- |
| 第一次使用、管理员与运维 | [使用与运维手册](docs/USAGE.md) |
| 开发者与自动化工具 | [仓库接入](AGENTS.md) · [贡献指南](CONTRIBUTING.md) · [原中文开发入口](docs/开发约束文档/00-入口与阅读指南.md) |
| 架构、状态、ACK、迁移和故障边界 | [实现说明](docs/IMPLEMENTATION.md) |
| 版本同步、证据与发布 | [双语变更记录](CHANGELOG.md) · [实测验证记录](docs/VERIFICATION.md) · [发布检查清单](docs/RELEASE-CHECKLIST.md) |
| 原始需求、历史决定与曾经的验证范围 | [中文文档目录](docs/00-README.md) · [历史交接](docs/18-开发部署与交接现状-2026-11-21.md) · [历史看板](docs/开发约束文档/15-推进看板.md) · [早期草案归档](docs/archive/2026-11-20-草案/README.md) |

建议在受控环境以原生工具运行。涉及真实 SIM、账号、短信、电话、服务器或生产数据的操作需要独立授权。遇到绑定待确认、短信结果未知或数据库提交不确定时，保留原记录和凭据，在正确的主库和设备上对账。代码、文档、演示和双语变更记录应一起更新，由获得授权的维护者推送到项目已配置的远端。

## English

VOIP Gateway connects Android devices and their SIMs to an administration console. It covers device binding and status, SMS tasks and history, call records, and platform adapter interfaces. The remote name `SIP2IM` is historical. The implementation uses HTTP, WebSocket and local inter-process communication. **It uses no SIP.**

### Project status

- **Android** implements v2 binding and pending-attempt recovery, a foreground connection, SIM observations, and SMS send and receive code. Fixtures and native builds are the available verification scope. Physical devices, SIMs, manufacturer restrictions, OS permissions, and carrier receipts need separate acceptance.
- **Core and Web** provide management endpoints, device and SMS pages, task feedback, and exception records. The supported topology is a single Core process per PostgreSQL database. HTTP responses, queue ACKs, and persistence ACKs each have a specific meaning. Connected devices reconcile heartbeat and locale against committed settings; saving in the browser is not a device acknowledgement. SMS dispatch is bounded across devices and preserves each SIM’s queue order.
- **Calls and platforms** have protocol, state and media foundations and test doubles. Android reports call commands as unsupported. Bidirectional call bridging, live QQ/Telegram integration and production operation still require implementation or acceptance. The demo uses synthetic data. Core reconciles unfinished sessions in batches and only reclaims expired reservations that can be proved never to have been armed. Core drops over-age media frames; a stall diagnostic does not end the call. An administrator can confirm a hangup after reading back the original call, without a live local audio connection.

### Quick demo

Build and start from the repository root with local Web dependencies ready. The demo uses the same-origin API. Leave `VITE_API_BASE` unset in the build environment and local Web configuration.

```sh
npm --prefix web run build --workspaces=false
node tools/demo/server.mjs
```

Open [127.0.0.1:41730](http://127.0.0.1:41730/) and sign in with the public demo credentials `demo / demo`. Check the synthetic device status on Dashboard, browse alert history, then return to Latest and acknowledge a synthetic channel warning in Alerts, review and cancel an unused code under Devices → Binding records, and review history or submit a simulated message to fictional number `+1 202 555 0111` on Messages. Records live in memory and reset on restart. Stop with Ctrl+C. Use `--port 41731` to select a different loopback port. The banner identifies simulated results. [Demo entry point](tools/demo/server.mjs) · [Demo walkthrough](tools/demo/README.md)

**Recorded walkthrough.** Native Chrome captured the dashboard, alert history paging, acknowledgement of a channel warning alongside an open device warning, audit readback, cancellation of an unused binding code and a simulated SMS send. All displayed devices, numbers and states are synthetic.

[Dashboard screenshot](docs/media/dashboard.png) · [Alert history screenshot](docs/media/alerts-history.png) · [Alert acknowledgement screenshot](docs/media/alerts.png) · [Binding cancellation screenshot](docs/media/bindings.png) · [Simulated SMS screenshot](docs/media/sms.png) · [MP4 video](docs/media/walkthrough.mp4) · [Animated GIF](docs/media/walkthrough.gif)

![Synthetic walkthrough showing the dashboard, alert history paging and acknowledgement, binding-code cancellation and a simulated SMS send](docs/media/walkthrough.gif)

### Architecture at a glance

Android connects to Core through the device WebSocket. Core keeps state and tasks in PostgreSQL. Web reads and updates through the admin API and receives updates over the admin WebSocket. Platform adapters connect to Core through local IPC. The synthetic demo serves the same Web console with an in-memory API. [Implementation](docs/IMPLEMENTATION.md)

### Native builds and checks

Run the commands from the repository root. Core, Web and protocol each have their own npm lockfile. Node.js 22 is recommended. Prepare dependencies as described in the usage guide. Android needs a native JDK 17, Android SDK Platform 35, and Gradle 8.x compatible with AGP 8.7.3 (8.9 or newer).

```sh
npm --prefix packages/protocol run build --workspaces=false
npm --prefix core run check --workspaces=false
npm --prefix web run check --workspaces=false
npm --prefix web run i18n:check --workspaces=false
```

```sh
gradle --offline -p android :protocol:test :app:testDebugUnitTest :app:lintDebug :app:assembleDebug
python -B -m unittest discover -s tools -p test_sms_intent_model.py -v
```

Use `gradle.bat` on Windows if needed. Offline builds use pre-provisioned tools and dependency caches. Follow the [usage and operations guide](docs/USAGE.md) for builds, CLI commands, fresh installation and recovery. Review the [release checklist](docs/RELEASE-CHECKLIST.md) before release.

### Start here

| Reader | Guide |
| --- | --- |
| New users, administrators and operators | [Usage and operations](docs/USAGE.md) |
| Developers and automation | [Repository intake](AGENTS.md) · [Contributing](CONTRIBUTING.md) · [Original Chinese intake](docs/开发约束文档/00-入口与阅读指南.md) |
| Architecture, states, ACKs, migrations and recovery boundaries | [Implementation](docs/IMPLEMENTATION.md) |
| Release notes, evidence and publication | [Bilingual changelog](CHANGELOG.md) · [Verification record](docs/VERIFICATION.md) · [Release checklist](docs/RELEASE-CHECKLIST.md) |
| Original requirements, past decisions and historical validation | [Chinese documentation index](docs/00-README.md) · [Historical handoff](docs/18-开发部署与交接现状-2026-11-21.md) · [Historical board](docs/开发约束文档/15-推进看板.md) · [Archive of early drafts](docs/archive/2026-11-20-草案/README.md) |

Use native tools in a controlled environment. Obtain separate authorization for real SIMs, accounts, SMS, calls, servers, or production data. For pending binding, unknown SMS results or uncertain database commits, preserve the original records and reconcile on the responsible device and primary database. Keep code, documentation, the demo and the bilingual changelog in sync. An authorized maintainer pushes to the configured remote.

[MIT license](LICENSE) · [Third-party notices](THIRD_PARTY_NOTICES.md)
