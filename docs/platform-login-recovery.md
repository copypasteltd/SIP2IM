# 平台登录：接线、恢复与证据边界

保留已有登录、提交步骤和登出的 POST 路径、请求体、成功响应，以及 `channel.login.step` 的 WS 载荷。所有新增接口和原有三项操作都按现有 Bearer 管理员鉴权并返回 `Cache-Control: no-store`。

| 路径（前缀 `/api/channels/:platform`，平台为 `qq` / `telegram`） | 返回 / 请求 |
|---|---|
| GET `/login/step` | `{data: {step, qrPngBase64, hint}}` 或 `{data:null}`；仅当前已就绪适配器代次的挑战。Web 重连应重新读取；null 不说明登录结果。|
| GET `/login/operation` | `{data: {status, operationId, outcome}}`；status 为 idle/pending/unknown/terminal；operationId 为 UUID 或 null；只有 terminal 有 ack/offline/invalid 证据。|
| POST `/login/operation/release` | 请求 `{operationId, outcome}`，仅匹配本平台的已持久 terminal 方可释放并原子写审计。成功 `{data:{}}`；同一次已有匹配审计可返回成功，不重复写。没有匹配证据返回 409 CONFLICT；写入结果不明返回 504 TIMEOUT_UNKNOWN。|
| GET `/login/operation/recovery/:operationId` | `{data: {operationId, platform, outcome, terminalAt, actor, recoveredAt}}` 或 `{data:null}`；只读同平台的精确审计记录。|

- `hello → capabilities → 初始 account.state` 均接受后才可提交登录。准备的发送绑定当前 IPC 连接与本地观察修订号；等待数据库后复核，不切换到新连接。生产继续禁用平台消息、配对启用和语音；适配器配置启用监听不代表真实账号在线。现有 QQ 无可用登录后端；Telegram 启用方式及内存 session 未改。
- Core 使用既有 0011/0013/0014 表：先占位、再发送；当前连接匹配的正 ACK 或可证明未发送的本地拒绝才是终态。正常终态自动原子释放并记 actor=core；超时后同连接最多短暂接纳精确迟到的正 ACK，仅存证，交由管理员释放。NACK 保留当次 HTTP 错误语义，但不证明没有副作用，因此阻断后续写。等候、超时、断开、重启都不自动重送。审计不保存手机号、验证码、密码、二维码或 IPC 原文。
- 未知行不得按 TTL、账号状态、提示变化或重新握手自动清除。真正跨重启不明结果的解除需要适配器可持久对账的命令身份、已验证桥账号和代次协议；当前没有这种证据或强制清除入口。审计为空只表示读取时未见该行。步骤读回不是重新触发挑战；同名挑战在浏览器请求发出前已被替换的区分需要新的公开 challenge ID 协议（本轮不变更）。
