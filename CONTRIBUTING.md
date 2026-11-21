# Contributing / 贡献指南

[简体中文](#简体中文) · [English](#english)

## 简体中文

1. 从仓库根目录核对当前代码、测试、迁移和文档，先读接入约束。并行协作时约定文件责任，保留他人的在途变更。[仓库接入](AGENTS.md) · [中文开发约束](docs/开发约束文档/00-入口与阅读指南.md)
2. 用原生本地工具和合成夹具验证，覆盖受影响的状态及失败路径。提交说明记录执行命令、退出码或用例数、跳过项、模拟边界和未验证的环境。数据库与设备测试使用各自独立的授权环境。[运行命令](docs/USAGE.md#native-builds-and-checks) · [验收证据](docs/RELEASE-CHECKLIST.md)
3. 修改协议、绑定、任务状态、调度、上线步骤或可见行为时，同步简体中文和英文版本说明，更新受影响的文档、演示场景及其媒体。核对语言键和真实文件链接。保留历史中文需求和决策记录。[变更记录](CHANGELOG.md) · [实现说明](docs/IMPLEMENTATION.md)
4. SQL 迁移使用唯一的递增编号。对全新安装和已部署版本分别验证保留数据、迁移失败恢复和读回结果。对 Android 本地存储迁移保留待处理记录、旧身份和队列归属。[迁移规范](docs/开发约束文档/06-数据库与迁移规范.md)
5. 提交前检查媒体和产物是否含真实号码、账号、令牌、二维码、配置、业务内容和机器路径。核对依赖许可与告知。变更通过验收后，由获得授权的维护者向项目已配置的远端推送。发布和部署按各自授权执行。[开源许可](LICENSE) · [第三方告知](THIRD_PARTY_NOTICES.md)

## English

1. Work from the repository root. Read the current implementation, tests, migrations and contributor constraints. Coordinate file ownership with collaborators and preserve their in-progress edits. [Repository intake](AGENTS.md) · [Original Chinese engineering constraints](docs/开发约束文档/00-入口与阅读指南.md)
2. Use native local tools and synthetic fixtures. Cover the affected states and failure paths. Record commands, exit status or counts, skips, and what the fakes and test environments cover. Database and device tests need their own authorized environments. [Commands](docs/USAGE.md#native-builds-and-checks) · [Acceptance evidence](docs/RELEASE-CHECKLIST.md)
3. Update the Simplified Chinese and English release notes, affected docs, demo scenarios, and media when changing the protocol, binding, task states, scheduling, operational steps, or visible behavior. Validate locale keys and file links. Keep the historical Chinese requirements and decisions. [Changelog](CHANGELOG.md) · [Implementation](docs/IMPLEMENTATION.md)
4. Give SQL migrations unique, increasing versions. Verify data retention, recovery and readback for both clean installation and an upgrade from the deployed version. Preserve pending records, prior binding identity and queue ownership when migrating Android storage. [Migration rules](docs/开发约束文档/06-数据库与迁移规范.md)
5. Review assets and artifacts for real numbers, account names, tokens, QR codes, private configuration, business content and machine paths. Check licenses and notices. Once the change passes review and verification, an authorized maintainer pushes it to the configured remote. Publication and deployment follow their respective authorizations. [License](LICENSE) · [Notices](THIRD_PARTY_NOTICES.md)
