# Device simulator / 软件设备模拟器

## English

The protocol simulator's CLI connects to an authorized test Core and keeps SMS and event state in memory. It reports capability level L1, untested probes and unknown Shizuku state. Start it with a project-local binding-code file using the existing options.

```sh
node tools/device-simulator/cli.mjs --count 25 --server ws://127.0.0.1:47860 --bind-codes codes.txt
```

Offline tests inject the [browser call fixture](browser-call-driver.fixture.mjs) through [the session runner](runner.mjs). They exercise negotiated generations, exact hangup matching, stale connections and media errors. The fixture uses an in-memory transport and an explicit simulated media outcome. Real voice acceptance requires a physical device, verified capability and working audio in both directions.

```sh
node --test tools/device-simulator/*.test.mjs
python -B -m unittest discover -s tools/device-simulator -p test_simulator.py
```

## 简体中文

协议模拟器的 CLI 连接授权的测试 Core，在内存中保留短信和事件状态。能力等级为 L1，探针状态未测试，Shizuku 状态未知。以上命令使用仓库内绑定码文件。

离线测试通过[会话运行器](runner.mjs)注入[浏览器通话夹具](browser-call-driver.fixture.mjs)，覆盖协商代次、精确挂断、被替换的连接和媒体故障。该夹具使用内存传输和显式的合成媒体结果。真实语音验收需要真机、已验证能力和双向音频。
