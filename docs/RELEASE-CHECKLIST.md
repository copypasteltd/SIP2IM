# Release checklist / 发布检查清单

[简体中文](#简体中文) · [English](#english)

## 简体中文

### 仓库与演示

- [ ] 双语变更说明、受影响的文档、演示和媒体对应同一份源码。核对中英文入口、相对链接和界面词汇。[接入](../AGENTS.md) · [变更记录](../CHANGELOG.md)
- [ ] 在原生本机通过正式演示入口检验登录、仪表盘、绑定码状态和短信。核对截图、MP4 和 GIF 的实际路径、可读性、操作结果及合成数据标识。记录捕获时的代码版本与生成步骤。[演示](../README.md#快速演示)
- [ ] 审核源文件、历史资料、产物、截图和媒体中的私有标识、凭据、二维码、号码、对话内容与机器路径。审核依赖、打包文件与许可证告知。[贡献指南](../CONTRIBUTING.md)
- [ ] 记录各项测试的命令、退出码或用例数、使用的工具版本、夹具边界、跳过项和限制。经审核的变更由获授权的维护者推送。[构建与测试](USAGE.md#native-builds-and-checks)

### 升级与生产验收

- [ ] 在专用原生 PostgreSQL 空库执行首次安装，核对所有迁移版本和应用启动。使用合成备份分别验证受支持的历史版本升级与恢复。模拟提交回复丢失、事务回滚和清理故障，核对权威主库及 `schema_migration`。验证同时启动另一 Core 时只有原实例可继续工作，演练停止与锁释放。[实现说明](IMPLEMENTATION.md#迁移和运行拓扑)
- [ ] 验证 Android SQLite v4/v5 及受支持的旧版本迁移，核对待确认字段、身份与队列归属。验证 v1 兼容、v2 响应丢失后同请求恢复、取消与重放并发、撤销后的晚到结果，以及 Android 进程重启边界。[绑定实现](IMPLEMENTATION.md#v2-绑定与设备所有权)
- [ ] 在使用托管前确认 PostgreSQL 的持久化前提、隔离与访问审计。验证精确重放、跨设备冲突和导出完整性，并验证保留模式继续阻塞队头、托管 ACK 模式按预期推进。演练原始证据的授权恢复。[托管模式](IMPLEMENTATION.md#异常短信托管)
- [ ] 在接入敏感数据前验证经过认证的传输、来源限制、凭据处理、最小权限、备份与恢复、以及清理后的日志。当前 Android 绑定地址使用 HTTP。未经目标部署评审的版本只用于隔离、合成场景。[配置与恢复](USAGE.md)
- [ ] 在分别授权的原生真机、SIM 和账号上验收权限、SIM 切换、后台恢复、短信回执及平台能力。电话桥接需要实际双向音频和项目人工听测证据。发布材料准确标注已完成门槛及仍待验收的能力。[G0 验收计划](08-测试与验收计划.md) · [历史交接](18-开发部署与交接现状-2026-11-21.md)

## English

### Repository and demo

- [ ] Match both languages of the release notes, affected docs, demo and media to the same source revision. Check both language entry points, relative links and UI terminology. [Intake](../AGENTS.md) · [Changelog](../CHANGELOG.md)
- [ ] Use the native demo entry point to verify login, dashboard, binding-code status and SMS. Check that the screenshots, MP4 and GIF exist, are readable, show the observed flow, and identify synthetic data. Record the source revision and capture procedure. [Demo](../README.md#quick-demo)
- [ ] Review source, historical material, artifacts, screenshots and media for private identifiers, credentials, QR codes, phone numbers, message content and machine paths. Review dependencies, archive contents and license notices. [Contributing](../CONTRIBUTING.md)
- [ ] Record exact commands, exit status or test counts, tool versions, fixture coverage, skips and limits. An authorized maintainer pushes reviewed changes. [Build and test commands](USAGE.md#native-builds-and-checks)

### Upgrade and production acceptance

- [ ] Install on a dedicated, empty native PostgreSQL database. Verify migrations and startup. Rehearse upgrade and restore from synthetic snapshots of supported older versions. Simulate lost commit replies, rollback and cleanup failure, then read back `schema_migration` and authoritative records. Verify contention between two Core processes and rehearse shutdown and lock release. [Topology and migrations](IMPLEMENTATION.md#migrations-and-runtime-topology)
- [ ] Verify Android SQLite v4/v5 and upgrades from supported older versions. Check pending fields, identity and queue ownership. Exercise v1 compatibility, exact v2 replay after response loss, cancellation races, late events after revocation and Android process restart. [Binding implementation](IMPLEMENTATION.md#v2-binding-and-device-ownership)
- [ ] Before using custody, check durable PostgreSQL settings, isolation and access auditing. Verify exact replay, cross-device conflicts and export integrity. Confirm that retain holds the original event and custody ACK can advance it. Rehearse authorized recovery of the original evidence. [Custody modes](IMPLEMENTATION.md#exceptional-sms-custody)
- [ ] Before introducing sensitive data, verify authenticated transport, origin restrictions, credential handling, least privilege, backup and restore, and log redaction. Current Android binding URLs use HTTP. Use isolated synthetic scenarios until the target setup passes review. [Configuration and recovery](USAGE.md)
- [ ] Obtain separate authorization and acceptance on native devices, SIMs, and accounts for permissions, SIM changes, background restoration, SMS receipts and platform capabilities. A call bridge requires actual two-way audio and the project’s human listening gate. Report each accepted and outstanding capability accurately. [G0 verification plan](08-测试与验收计划.md) · [Historical handoff](18-开发部署与交接现状-2026-11-21.md)

## Focused offline verification / 聚焦离线验证

From the repository root, using pre-provisioned Node.js and package dependencies, run the focused Core and Web groups in the usage guide. Run the following model and SQLite fixtures on native Python. They cover source wiring, uncertain pending intents and migration predicates with synthetic data. The SQLite fixture creates temporary databases in the current directory and removes them after the run.

从仓库根目录使用预置的 Node.js 及包依赖，按使用手册运行 Core 与 Web 聚焦测试。以下原生 Python 夹具覆盖源码接线、待确认意图和 SQLite 迁移查询，使用合成数据。SQLite 夹具在当前目录建立临时数据库并在完成后清理。

```sh
python -B -m unittest discover -s tools -p test_binding_guard_model.py -v
python -B android/app/src/test/test_binding_fence_sqlite.py -v
python -B -m unittest discover -s tools -p test_sms_intent_model.py -v
```

[Native checks](USAGE.md#native-builds-and-checks) · [Binding model](../tools/test_binding_guard_model.py) · [SQLite fixtures](../android/app/src/test/test_binding_fence_sqlite.py) · [SMS intent model](../tools/test_sms_intent_model.py)

### Demo capture / 演示录制

For an authorized capture, use a fresh synthetic demo on port `41730`, a same-origin Web build, the installed local `ws` package, native Chrome and FFmpeg. Run the capture from the repository root with the Chrome executable and a new project-relative directory. Compare the captured states with the expected dashboard, channel acknowledgement, open device alert, binding cancellation and simulated send before replacing published files. [Capture script](../tools/demo/capture.mjs) · [Demo commands](../README.md#quick-demo)

经授权录制时，使用 `41730` 端口上新启动的合成演示、同源 Web 构建、本地 `ws` 包、原生 Chrome 和 FFmpeg。在仓库根目录向录制脚本传入 Chrome 程序路径和新的仓库相对目录。检查仪表盘、渠道告警已确认、设备告警仍未处理、绑定取消和模拟发送的结果后，再更新发布素材。[录制脚本](../tools/demo/capture.mjs) · [演示命令](../README.md#快速演示)

```sh
node tools/demo/capture.mjs "path/to/chrome" docs/media-review
```

### Documentation check / 文档检查

From the repository root, run `python -B -m doctest docs/RELEASE-CHECKLIST.md`. This checks both language headings, plain relative Markdown links, heading fragments and embedded NUL bytes in the eight primary documents, plus the six demo media links in each README language. Media playback and external URLs are separate checks.

在仓库根目录运行 `python -B -m doctest docs/RELEASE-CHECKLIST.md`，检查八份主要文档的双语标题、相对链接、标题锚点与 NUL 字符，并核对首页每种语言所列的六个演示素材。媒体播放和外部 URL 单独核验。

```pycon
>>> import re
>>> from pathlib import Path
>>> from urllib.parse import unquote, urlsplit
>>> root = Path.cwd().resolve()
>>> docs = ("README.md", "AGENTS.md", "CONTRIBUTING.md", "CHANGELOG.md",
...         "docs/IMPLEMENTATION.md", "docs/USAGE.md", "docs/VERIFICATION.md", "docs/RELEASE-CHECKLIST.md")
>>> link_pattern = re.compile(r"\[[^]\n]+\]\(([^()\n]+)\)")
>>> heading_pattern = re.compile(r"^#{1,6} (.+)$", re.M)
>>> def slug(heading):
...     return re.sub(r"[^\w -]", "", heading.lower()).replace(" ", "-")
>>> issues = []
>>> for name in docs:
...     source = root / name
...     text = source.read_text(encoding="utf-8")
...     if "\x00" in text or not {"## English", "## 简体中文"}.issubset(text.splitlines()):
...         issues.append((name, "language headings or encoding"))
...     for relative in link_pattern.findall(text):
...         link = urlsplit(relative.strip("<>"))
...         if link.scheme or link.netloc:
...             continue
...         target = (source.parent / unquote(link.path)).resolve() if link.path else source
...         if not target.is_relative_to(root) or not target.exists():
...             issues.append((name, relative))
...             continue
...         if link.fragment and target.suffix == ".md":
...             headings = heading_pattern.findall(target.read_text(encoding="utf-8"))
...             if unquote(link.fragment) not in {slug(heading) for heading in headings}:
...                 issues.append((name, relative))
>>> issues
[]
>>> readme = (root / "README.md").read_text(encoding="utf-8")
>>> chinese, english = readme.split("\n## English\n", 1)
>>> media = {"docs/media/" + name for name in
...          ("dashboard.png", "alerts.png", "bindings.png", "sms.png", "walkthrough.mp4", "walkthrough.gif")}
>>> all(media.issubset(link_pattern.findall(section)) for section in (chinese, english))
True

```
