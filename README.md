# dsh-debugger-dap

DAP 交互式调试器，作为 [DeepSeek Harness](https://www.npmjs.com/package/@deepseek-ai/dsh-tools) 的独立插件：通过一个面向模型的 `debug` 工具完成启动调试适配器、断点、单步、栈/变量检视、表达式求值与程序输出捕获。零宿主源码改动，旁挂即用。

> 📖 完整动作与参数示例见 **[USAGE.md](./USAGE.md)**（21 个动作：launch/attach、函数/异常断点、步进、检视、运行时改值、异常信息等）。


## 工具面

单个 `debug` 工具，`action` 参数判别，共 21 个动作：

| 动作 | 说明 | 分层 |
|---|---|---|
| `launch` | 启动适配器并运行被调试程序（默认停在入口） | 执行 |
| `attach` | 按 `process_id` 附加到已运行进程（需显式 `adapter`） | 执行 |
| `set_breakpoints` | 整体替换一个文件的断点集（行号 + `condition`/`hit_condition`/`log_message`） | 执行 |
| `set_function_breakpoints` | 按函数名下断点（`functions` + `condition`/`hit_condition`） | 执行 |
| `set_exception_breakpoints` | 配置哪些异常中断（`filters` 如 `['all']`，或 `filter_options`） | 执行 |
| `continue` / `step_in` / `step_over` / `step_out` / `pause` | 恢复执行；等待下一次停机 | 执行 |
| `evaluate` | 在当前帧上下文求值 | 执行 |
| `set_variable` / `set_expression` | 在 `variables_ref`/当前帧写入新值 | 执行 |
| `disconnect` | 结束会话（默认终止被调试进程） | 执行 |
| `threads` / `stack_trace` / `scopes` / `variables` / `exception_info` / `output` / `sessions` | 检视与读取 | 只读 |

设计要点（借鉴 oh-my-pi 的 DAP 实现并按 dsh 习惯重塑）：

- **每个响应都携带会话快照**（Session/Adapter/Status/Stop reason/Location/Exit code），模型永远知道自己在哪里。
- **恢复类动作等待下一次停机**，超时返回 `running` 状态与 `pause` 提示，工具调用永不悬挂；被调试会话保持存活。
- **每个 agent 的最近一次 launch 即其活跃会话**；传 `session_id` 可寻址其他会话；跨 agent 访问被拒绝（owner 作用域）。
- **适配器是配置行，内置配方可省配置**：内置 `debugpy`（Python）、`dlv`（Go）、`netcoredbg`（.NET）配方，按程序扩展名自动选择（`.py`→debugpy、`.go`→dlv、`.dll`/`.exe`→netcoredbg），缺装时给出可操作的安装提示；任意其他 stdio DAP 适配器通过 `adapters` 配置声明。
- **内置配方自带适配器差异处理**：例如 netcoredbg 的 launch 需要 `type: coreclr`、入口停止字段是 `stopAtEntry` 而非标准的 `stopOnEntry` —— 插件已按配方自动处理，模型侧照常传 `stop_on_entry` 即可。
- 适配器进程死亡时，launch 失败信息携带适配器 **stderr 尾部**（如 `ModuleNotFoundError`）。

## 安装与挂载

profile 的 `package.json` `dependencies` 加入本包，并在 `dsh.profile.bundles` 中列出（本包自带 bundle 声明）：

```sh
dsh plugin init debugger   # 或手工创建 $DSH_HOME/profiles/debugger
cd ~/.dsh/profiles/debugger
npm install dsh-debugger-dap
# package.json 中声明: "dsh": { "profile": { "bundles": ["@deepseek-ai/dsh-bundle-base", "dsh-debugger-dap"] } }
dsh --profile debugger --dump-config   # 确认 debugger-dap 行已组合
```

也可只作为普通插件行挂载（不走 bundle）：

```yaml
- id: debugger-dap
  name: 'dsh-debugger-dap'
  config: {}
```

## 配置

| 字段 | 默认 | 含义 |
|---|---|---|
| `requestTimeoutMs` | 30000 | 单个 DAP 请求超时 |
| `stepTimeoutMs` | 10000 | continue/step 等待下一次停机的超时 |
| `maxOutputChars` | 40000 | 每会话输出环形缓冲上限（字符） |
| `maxStackFrames` | 20 | stack_trace 单次最大帧数 |
| `maxVariables` | 100 | variables 单次最大条目数 |
| `maxResultChars` | 16000 | 模型可见文本结果上限 |
| `adapters` | `{}` | 追加自定义适配器配方 / 覆盖内置配方，见下 |

内置配方无需配置即可用（前提是相应调试器在 PATH）：`debugpy`（pip install debugpy）、`dlv`（go install），以及 `.NET`：

```sh
# netcoredbg 一键示意：下载对应平台 release 解压后把目录加入 PATH 即可
# https://github.com/Samsung/netcoredbg/releases
debug launch adapter=netcoredbg program=<构建出的>.dll cwd=<项目目录>
```

覆盖内置配方或声明其他 stdio 适配器（`launchArgs` 会并入 DAP `launch` 请求体，用于适配器特有的启动参数，如 `sourceMaps`、`justMyCode`；覆盖内置配方时缺省的 `launchArgs`/入口停止字段会继承自带默认）：

```yaml
- id: debugger-dap
  name: 'dsh-debugger-dap'
  config:
    adapters:
      js-debug:
        command: node
        args: ['/opt/js-debug/src/dapDebugServer.js']
        launchArgs:
          sourceMaps: true
```

## 测试

```sh
npm test   # 构建 + node --test：framing、DAP 握手、状态机、owner 作用域、工具层全流程、适配器解析
```

测试通过内存中的伪 DAP 适配器（真实线协议帧格式）驱动，不需要安装任何真实调试器。

## 已知限制

- **stdio 传输 only**：v1 只支持 stdio DAP 适配器；js-debug 官方发行以 TCP server 为主，需自备 stdio 包装或等 v2 的 server 传输。
- **attach 按 pid、依赖适配器支持**：已支持 `process_id` 附加（debugpy/netcoredbg 等）；port/pipe 附加与 Windows 下部分适配器的 attach 受其本身能力限制。暂无数据断点、指令断点、汇编、内存读写、restart。
- **权限策略不在工具内**：按 dsh 惯例，审批/沙箱策略应通过宿主 `tools/pre-execute` 扩展点组合，而非内建于工具；launch 会以普通子进程 spawn（未走 `ctx.subprocess` 执行世界）。
- **会话不跨进程持久**：会话注册表在插件卸载时全部拆除；agent 释放后其遗留会话在插件卸载前保持存活（v1 无逐 agent 生命周期钩子）。
- **进程终止语义**：disconnect 优先发 DAP `disconnect {terminateDebuggee}`（由适配器负责终止被调试进程），随后 `child.kill()` 杀适配器本身；未做进程组级联强杀。
