# Repository intake / 仓库接入

## 简体中文

- 接手前先读当前实现说明和中文开发入口，随后打开负责路径及相关测试。历史路径、环境和验证记录仅供参考。以当前工作区和实际代码为准，区分设计、实现和验证结论。[实现说明](docs/IMPLEMENTATION.md) · [原中文开发入口](docs/开发约束文档/00-入口与阅读指南.md)
- 使用原生工具和合成数据，不使用 SIP、Docker、WSL 或 Android 模拟器。访问网络、浏览器、账号、SIM、真实短信或电话、服务器、部署与发布时，遵循本次任务的授权范围。禁止私有客户端注入。没有自动调度任务的默认授权。
- 读取后再修改，尊重文件责任。遇到冲突先沟通和复核，不回退他人改动，不清理或覆盖业务记录。运行聚焦测试，报告精确路径、命令、结果及限制。[贡献指南](CONTRIBUTING.md)
- 相关变更应同步代码、双语变更记录及受影响的文档、演示和素材。只有获得授权的维护者将已经审核的变更推送到已配置的远端。[变更记录](CHANGELOG.md) · [发布检查清单](docs/RELEASE-CHECKLIST.md)

## English

- Start with the current implementation guide and original Chinese intake, then read the scoped code and related tests. Historical paths, environments and validation records provide context. Use the current workspace and source to distinguish plans, implementation and verified behavior. [Implementation](docs/IMPLEMENTATION.md) · [Original Chinese intake](docs/开发约束文档/00-入口与阅读指南.md)
- Use native tools and synthetic data. SIP, Docker, WSL and Android emulators are outside the project constraints. Network and browser access, real accounts or SIMs, real SMS or calls, servers, deployment and publication follow the task’s authorization. Private client injection is prohibited. Scheduling requires explicit authorization.
- Read files before editing them and respect ownership. Coordinate conflicting edits, preserve collaborators’ work and leave business records intact. Run focused tests and state exact paths, commands, results, and limits. [Contributing](CONTRIBUTING.md)
- Keep code, both languages of release notes, and affected documentation, demos and media in sync. An authorized maintainer pushes reviewed changes to the configured remote. [Changelog](CHANGELOG.md) · [Release checklist](docs/RELEASE-CHECKLIST.md)
