# 平台登录：接线、恢复与证据边界

登录和登出的接口保持不变。提交步骤仍用原路由，但请求必须带 `challengeId`；管理 WebSocket 的 `channel.login.step` 和步骤读回均提供该字段。接口需 Bearer 管理员鉴权并返回 `Cache-Control: no-store`。Core 与 Web 请协调升级；旧客户端缺少标识时提交被拒绝，不能回退到只按步骤名匹配。

| 路径（前缀 `/api/channels/:platform`，平台为 `qq` / `telegram`） | 返回 / 请求 |
|---|---|
| GET `/login/step` | `{data: {challengeId, step, qrPngBase64, hint}}` 或 `{data:null}`。只读当前有效挑战：本地操作或持久操作阻断、等待期间挑战变更、未就绪均不返回挑战。返回挑战前复核原管理员会话；发现撤权或过期时返回 401 `UNAUTHORIZED`。数据库读失败返回 503 `INTERNAL`。空返回不等于成功或失败。 |
| POST `/login/submit` | 请求严格为 `{challengeId, step, value}`。缺失或不合法的标识返回 400 `BAD_REQUEST`；格式正确但与当前挑战不匹配时返回 400 `BAD_MESSAGE`，且不向适配器发送；其他既有操作阻断规则保持。 |
| GET `/login/operation` | `{data: {status, operationId, outcome}}`；status 为 idle/pending/unknown/terminal；operationId 为 UUID 或 null；只有 terminal 有 ack/offline/invalid 证据。|
| POST `/login/operation/release` | 请求 `{operationId, outcome}`，仅匹配本平台的已持久 terminal 方可释放并原子写审计。成功 `{data:{}}`；同一次已有匹配审计可返回成功，不重复写。没有匹配证据返回 409 CONFLICT；写入结果不明返回 504 TIMEOUT_UNKNOWN。|
| GET `/login/operation/recovery/:operationId` | `{data: {operationId, platform, outcome, terminalAt, actor, recoveredAt}}` 或 `{data:null}`；只读同平台的精确审计记录。|

- `hello → capabilities → 初始 account.state` 均接受后才可提交登录。准备的发送绑定当前 IPC 连接与本地观察修订号；等待数据库后复核，不切换到新连接。生产继续禁用平台消息、配对启用和语音；适配器配置启用监听不代表真实账号在线。现有 QQ 无可用登录后端；Telegram 启用方式及内存 session 未改。 初始能力报告仅在内存暂存；首条账号状态在同一数据库事务保存账号观察、有效登录能力和适用告警。管理通知不参与最终回执。
- Core 使用既有 0011/0013/0014 表：先占位、再发送；当前连接匹配的正 ACK 或可证明未发送的本地拒绝才是终态。正常终态自动原子释放并记 actor=core；超时后同连接最多短暂接纳精确迟到的正 ACK，仅存证，交由管理员释放。NACK 保留当次 HTTP 错误语义，但不证明没有副作用，因此阻断后续写。等候、超时、断开、重启都不自动重送。审计不保存手机号、验证码、密码、二维码或 IPC 原文。
- 未知行不得按 TTL、账号状态、提示变化或重新握手自动清除。真正跨重启不明结果的解除需要适配器可持久对账的命令身份、已验证桥账号和代次协议；当前没有这种证据或强制清除入口。审计为空只表示读取时未见该行。步骤读回不是重新触发挑战。
- Core 为每条新接纳的 `login.step` 生成小写 UUID v4；去重窗口内重传相同 IPC 帧只回原 ACK，不重建挑战。新提示、连接代次变化或开始下发账号操作时会使旧挑战不可用。准备下发前及取得操作占位后都复核绑定，拒绝时不向替换连接发送。请求体中的标识不会通过 IPC，IPC 仍只发送 `{ step, value }`。
- Web 的「读取当前登录步骤」只发送 GET。只有当前管理员会话、实时连接和平台观测仍有效时才接受结果；不会复用旧输入或重发请求。读取空值或出错时停在只读核对。

## Handshake and recovery boundary

The initial capability ACK confirms staging, not a completed database write. The first account-state ACK follows a confirmed transaction containing the account observation, effective login capability, and applicable alert. Admin notifications may be coalesced or missed and never settle an account operation. The authenticated, no-store step endpoint returns only the exact current challenge while no operation blocks the read. Before returning a challenge, Core rechecks the original administrator session and refuses a session found expired or revoked. Use Read current login step after a missed hint; this only sends GET and does not request a new challenge, retry login, or clear an uncertain operation. POST `/login/submit` now requires the step’s lowercase UUID v4 `challengeId`. A stale or mismatched ID is rejected before adapter I/O. The ID is not forwarded on adapter IPC. Upgrade Core and Web together; older management clients are not accepted without the ID.
