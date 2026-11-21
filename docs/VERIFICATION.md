# Verification record / 验证记录

[中文](#简体中文) · [English](#english)

## 简体中文

本轮在[Core 适配器账号命令回执基线](https://github.com/copypasteltd/SIP2IM/blob/ace8893b12f4925003a96cd98f740978da93ec90/docs/VERIFICATION.md)上，用原生 Windows 和内存连接验证 QQ、Telegram 上报的独立回执截止、旧连接隔离和 Telegram 的写入背压。未使用 PostgreSQL 实库、实际部署链路、真机、SIM 或平台账号。

| 范围 | 实测结果 | 证据边界 |
|---|---|---|
| Core | Node 22.23.5 类型检查及 ESM 构建通过；1089 项离线测试通过、6 项跳过。 | 源码未变；跳过 5 项 PostgreSQL 实库用例和 1 项 Windows 不适用的 IPC 用例。 |
| Web | 231 项离线测试通过；类型检查、ESLint、三语键比对和构建通过。 | Web 源码未变。 |
| Android | JDK 17、Gradle 8.11.1、SDK Platform 35 原生离线复验：app 62 项、protocol 34 项 JVM 测试通过，无失败或跳过；lint 0 错误、6 警告；调试构建任务通过。 | Android 源码未改；调试 APK 产物为已有最新构建，未安装或发布。不验证真机权限、休眠、断网恢复或蜂窝能力。 |
| 适配器与模拟器 | QQ 33 项、Telegram 35 项离线测试通过；QQ 入口语法检查通过。模拟器 26 项 Node 和 2 项 Python 测试为历史记录。 | 假连接覆盖精确匹配、两个方向的 ACK 结果、截止、关闭、取消和 Telegram 背压；不证明真实登录或平台业务。 |
| 桌面 SQLite 和 Python | Python 3.13.1：绑定保护模型 7 项、绑定存储模型 7 项、短信意图模型 10 项，合计 24 项通过。 | 桌面 SQLite 不代替真机 SQLite 迁移。 |
| 合成演示 | 现有 12 项进程内 Node 冒烟测试通过；保留的 MP4 和 GIF 均完整解码。 | 未修改演示、截图和录屏，不展示本轮 IPC 截止或真实平台登录。 |

保留的原生 Chrome 合成实录：[仪表盘](media/dashboard.png) · [告警历史](media/alerts-history.png) · [告警确认](media/alerts.png) · [绑定取消](media/bindings.png) · [模拟发送](media/sms.png) · [MP4](media/walkthrough.mp4) · [GIF](media/walkthrough.gif)。五张截图均为 1440×900。静音 H.264 MP4 为 1440×900、165 帧、16.5 秒；GIF 为 800×500、116 帧、16.57 秒。原始录制在确认后从操作日志核对了对应的一条合成 `alert.ack`。 [录制来源](https://github.com/copypasteltd/SIP2IM/blob/96d6c026e9366316bdcf7ac289de1c8f91a61784/docs/VERIFICATION.md)。

### 交付范围与未完成门槛

- 当前交付是源码仓库、双语说明、可复现的原生离线检查，以及保留的合成演示实录。五张 PNG 已读回核对；两段动态素材已全程解码；七份素材与原录制提交中的字节一致。未重新录制，演示不覆盖本轮 IPC 截止。
- **仍需实现：** Android 蜂窝通话控制及端到端双向媒体、Core 平台消息与配对启用、向配对用户转发告警。QQ 仍无真实后端；Telegram 的可选登录/文本后端尚未通过实账号验收，不能视为已可用。
- **仍需单独授权验收：** 隔离 PostgreSQL 的迁移、所有权与恢复；真机上的权限、SIM、断网/休眠恢复及运营商真实回执；真实平台账号、部署链路和人工听测的双向音频。G0–G4 不由离线夹具、APK 构建或实录替代。部署前另行核对认证传输、来源限制、凭据、备份和日志。 [验收计划](08-测试与验收计划.md) · [推进看板](开发约束文档/15-推进看板.md) · [发布检查清单](RELEASE-CHECKLIST.md)

## English

This update uses native Windows and memory transports to verify QQ and Telegram report ACK deadlines, retired-link isolation, and Telegram write backpressure. No live PostgreSQL, deployed link, handset, SIM, or platform account was used. [Previous Core account command verification](https://github.com/copypasteltd/SIP2IM/blob/ace8893b12f4925003a96cd98f740978da93ec90/docs/VERIFICATION.md)

| Scope | Observed result | Evidence boundary |
|---|---|---|
| Core | Node 22.23.5 type check and ESM build passed; 1089 offline tests passed, with six skips. | Core source is unchanged. Five PostgreSQL cases and one IPC case not applicable to Windows were skipped. |
| Web | 231 offline tests passed, along with type checking, ESLint, locale-key parity, and the build. | Web source is unchanged. |
| Android | Native offline recheck with JDK 17, Gradle 8.11.1 and SDK Platform 35: 62 app and 34 protocol JVM tests passed without failures or skips; lint reported zero errors and six warnings; the debug build task passed. | Android source is unchanged. The APK was up to date; it was neither installed nor published. This does not verify permissions, sleep, offline recovery or cellular behavior. |
| Adapters and simulator | QQ passed 33 offline tests and entry syntax checking; Telegram passed 35 offline tests. The 26 Node and two Python simulator tests are historical evidence. | Memory transports cover exact matching, positive and negative ACKs, expiry, closure, cancellation and Telegram backpressure, not live sign-in or platform operations. |
| Desktop SQLite and Python | All 24 Python 3.13.1 tests passed: seven binding guards, seven binding storage fixtures, and ten SMS intent cases. | Desktop SQLite is not on-device migration evidence. |
| Synthetic demo | All 12 in-process Node smoke tests passed; both retained motion assets decoded end to end. | Demo fixtures, screenshots and recordings are unchanged. They do not show this round’s IPC deadline or live sign-in. |

Retained native Chrome evidence: [Dashboard](media/dashboard.png) · [Alert history](media/alerts-history.png) · [Alert acknowledgement](media/alerts.png) · [Binding cancellation](media/bindings.png) · [Simulated SMS](media/sms.png) · [MP4](media/walkthrough.mp4) · [GIF](media/walkthrough.gif). All five screenshots are 1440×900. The silent H.264 MP4 is 1440×900, 165 frames, and 16.5 seconds. The GIF is 800×500, 116 frames, and 16.57 seconds. The original walkthrough verified one synthetic `alert.ack` by reading the audit log after acknowledgement. [Capture provenance](https://github.com/copypasteltd/SIP2IM/blob/96d6c026e9366316bdcf7ac289de1c8f91a61784/docs/VERIFICATION.md).

### Delivery scope and open gates

- This is a source-repository delivery with bilingual documentation, reproducible native offline checks, and the retained synthetic walkthrough. All five PNGs were read and reviewed; the two motion assets decoded end to end. All seven match the original capture commit byte for byte. No new recording was made, and the demo does not exercise the IPC deadline changes.
- **Not yet implemented:** Android cellular call control and end-to-end bidirectional media, Core platform messaging and new pairing, and alert forwarding to paired users. QQ lacks a live backend. Telegram’s optional sign-in and text backend has not been accepted with a live account.
- **Separate authorization and acceptance required:** isolated PostgreSQL migration, ownership and recovery; on-device permissions, SIM behavior, sleep/network recovery and carrier receipts; live platform accounts, the deployment path, and human listening checks for two-way audio. Offline fixtures, the APK build and demo recording do not satisfy G0–G4. Review authenticated transport, origin restrictions, credentials, backups and logs before deployment. [Acceptance plan](08-测试与验收计划.md) · [Project board](开发约束文档/15-推进看板.md) · [Release checklist](RELEASE-CHECKLIST.md)

## Reproduce / 复现

Prepare the locked dependencies and native tools using the [usage guide](USAGE.md#native-builds-and-checks). Run the [documentation and capture checks](RELEASE-CHECKLIST.md) before publication. Run Core and Web Vitest after type checking, with database opt-ins unset unless a dedicated database has been separately authorized. The build and test commands are reproducible; publication deliberately excludes local tool paths, caches, logs, APKs and credentials. A subsequent update must keep both languages of the [changelog](../CHANGELOG.md), the affected instructions, and the demo assets in sync.

先按[使用手册](USAGE.md#native-builds-and-checks)准备锁定依赖与原生工具。发布前按[检查清单](RELEASE-CHECKLIST.md)复验文档与录制。从类型检查后运行 Core/Web Vitest；未单独授权隔离库时，不启用数据库测试。仓库不发布本机工具绝对路径、缓存、日志、APK 或凭据。后续更新同步[双语变更记录](../CHANGELOG.md)及受影响的说明和演示素材。

Run the adapter fixtures from the repository root with pre-provisioned Node 22 and native Python / 使用预置 Node 22 和原生 Python，从仓库根目录运行适配器夹具：

```sh
node --check adapters/qq/src/main.mjs
node --test adapters/qq/test/client.test.mjs adapters/qq/test/shared-fixtures.test.mjs adapters/qq/test/ipc.test.ts
env -u TELEGRAM_API_ID -u TELEGRAM_API_HASH PYTHONPATH=adapters/telegram/src python -B -m unittest discover -s adapters/telegram/tests -v
npm --prefix core run typecheck && npm --prefix core run test -- --maxWorkers=1
npm --prefix web run typecheck && npm --prefix web run test -- --maxWorkers=1
npm --prefix web run i18n:check && npm --prefix web run build
node --test tools/demo/demo.test.mjs
```

The demo smoke tests require a built Web bundle / 演示冒烟测试需要先构建 Web。 Follow the [native build and check instructions](USAGE.md#native-builds-and-checks) for Android, and the [desktop fixture instructions](RELEASE-CHECKLIST.md#focused-offline-verification--聚焦离线验证) for Python and SQLite. / Android 和桌面夹具的命令见[使用手册](USAGE.md#native-builds-and-checks)和[发布检查清单](RELEASE-CHECKLIST.md)。
