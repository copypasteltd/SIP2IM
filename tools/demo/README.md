# Local Web demo / 本地 Web 演示

[English](#english) · [简体中文](#简体中文)

## English

From the repository root, with project dependencies already installed and a supported Node version, build and run the demo. Leave `VITE_API_BASE` unset or empty for a same-origin build.

```sh
npm run build --workspace @voipgw/web
node tools/demo/server.mjs
```

Open [127.0.0.1:41730](http://127.0.0.1:41730/) and enter the public demo username `demo` and password `demo`. For a different port, run `node tools/demo/server.mjs --port 41731` and open that port on `127.0.0.1`. Press Ctrl+C to stop. Restart after rebuilding the Web bundle or to reset the fixture state.

- **Dashboard and Devices.** Three synthetic handsets cover online, offline and paused states. Use the device list filters and open the Studio handset to inspect its two SIMs.
- **Alerts.** Open Next to view the older resolved warnings, then use Latest to return and acknowledge the synthetic channel warning. Verify it stays visible as Acknowledged, not Resolved, while the offline device warning stays Open. The audit log shows one synthetic acknowledgement entry. [History screenshot](../../docs/media/alerts-history.png) · [Walkthrough](../../docs/media/walkthrough.mp4)
- **Binding v2.** In Devices, choose **Bind new device** to issue a sample code and QR for the demo address. Use the QR as a visual example. Close the dialog and open **Binding records**. Select an unused record, choose **Review cancellation**, then choose **Confirm cancellation**. The inventory also includes a seeded used v2 record for Field spare. Cancelling that record removes the synthetic handset from the Devices list. [Web binding controls](../../web/src/features/devices/binding.tsx)
- **SMS.** Open the thread for `+12025550111`. Replies to fictional numbers `+12025550100` through `+12025550199` update the in-memory thread and its simulated send status. Search also covers a fixture message with no SIM assignment. Use fictional text in demos and captures.
- **Calls, Channels and Settings.** Browse ended sample calls and their event timelines. The dialer has no available devices, and the demo does not exercise hangup or use microphone audio. QQ and Telegram are offline fixtures with login disabled. Login-step readback returns no challenge; the demo does not send account commands. Change the synthetic inbound selection or save a setting such as the bot language to see it update on the next read.

The runner serves the checked-out Web application's built pages and theme. It adds the bilingual warning when serving the HTML. Everything is synthetic and held in process memory. Browser storage follows the standard Web app's session, theme and language behavior for the demo origin. The runner has no real account, database, adapter, device or external SMS/call connection. The admin socket uses the existing local `ws` package when installed. Without it the UI shows its normal disconnected and unknown indicators. Binding records and SMS writes are capped and the server also bounds write rate, concurrent connections and request body size.

Native smoke test (built Web files must exist):

```sh
node --test tools/demo/demo.test.mjs
```

The test drives the HTTP handler with in-process streams and checks the WebSocket message handler with local events. Browser rendering and real HTTP or WebSocket handshakes require a separate authorized run.

## 简体中文

使用项目支持的 Node 版本，确认依赖已安装后，在仓库根目录构建并启动。将 `VITE_API_BASE` 保持未设置或为空，使用同源 API。

```sh
npm run build --workspace @voipgw/web
node tools/demo/server.mjs
```

打开 [127.0.0.1:41730](http://127.0.0.1:41730/)，用公开演示用户名 `demo` 和密码 `demo` 登录。如需更换端口，可运行 `node tools/demo/server.mjs --port 41731`，再打开 `127.0.0.1` 上对应的端口。按 Ctrl+C 停止。重新构建 Web 或要重置合成数据时，重启演示进程。

- **仪表盘和设备。** 三部合成设备覆盖在线、离线和暂停状态。可按状态筛选，并点开「演示主机」查看两张 SIM。
- **告警。** 点击下一页查看已解除的旧告警，再回到最新确认合成渠道告警。渠道告警为已确认而非已解除，设备离线告警仍未处理；操作日志可查看对应的一条合成确认。[历史截图](../../docs/media/alerts-history.png) · [演示实录](../../docs/media/walkthrough.mp4)
- **绑定 v2。** 在设备页点击 **绑定新设备**，查看指向本地演示地址的样例绑定码和二维码。二维码仅用于展示。关闭弹窗，打开 **绑定记录**，选择未使用的记录，点击 **核对取消操作**，再点击 **确认取消绑定码**。初始清单也有一条关联「离线备用」的已使用 v2 记录。取消该记录后，对应的合成设备会从设备列表中移除。[Web 绑定界面](../../web/src/features/devices/binding.tsx)
- **短信。** 打开 `+12025550111` 的会话。向 `+12025550100` 至 `+12025550199` 的虚构号码回复，会更新内存中的会话及模拟发送状态。历史搜索还可以看到一条未分配 SIM 的样例短信。演示和录制时请使用虚构文本。
- **通话、渠道和设置。** 可查看已结束的样例通话及事件时间线。拨号界面没有可用设备；演示不执行挂断，也不使用麦克风。QQ 和 Telegram 为离线合成数据，禁用登录。步骤读回不返回挑战，演示不发送账号命令。可切换模拟入站渠道，或保存机器人语言等设置并查看更新。

演示直接使用仓库构建的 Web 页面及主题，并在提供 HTML 时加上双语提示。合成数据存放在进程内存中。该演示地址上的会话、主题和语言沿用 Web 应用的浏览器存储机制。演示不连接账号、数据库、适配器、设备或外部短信与通话服务。管理 WebSocket 复用已安装的本地 `ws` 包。缺少该包时，界面显示正常的断开与未知状态。绑定记录和短信写入设有数量上限，服务还限制写入频率、连接数及请求体大小。

原生冒烟测试需要先有 Web 构建产物。

```sh
node --test tools/demo/demo.test.mjs
```

测试通过进程内数据流调用 HTTP 处理器，并用本地事件验证 WebSocket 消息处理。浏览器渲染和真实 HTTP 或 WebSocket 握手需要另外授权运行。
