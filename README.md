# dsh-debugger-dap

[![npm](https://img.shields.io/npm/v/dsh-debugger-dap)](https://www.npmjs.com/package/dsh-debugger-dap)

DAP 交互式调试器，作为 [DeepSeek Harness](https://www.npmjs.com/package/@deepseek-ai/dsh-tools) 的独立插件：通过一个面向模型的 `debug` 工具完成启动调试适配器、断点、单步、栈/变量检视、表达式求值与程序输出捕获。零宿主源码改动，旁挂即用。

> 📖 完整动作与参数示例见 **[USAGE.md](./USAGE.md)**（29 个动作：launch/attach、函数/异常/内存断点、步进、跳转、检视、源码/模块读取、运行时改值、异常信息等）。


## 工具面

单个 `debug` 工具，`action` 参数判别，共 35 个动作：

| 动作 | 说明 | 分层 |
|---|---|---|
| `launch` | 启动适配器并运行被调试程序（默认停在入口） | 执行 |
| `attach` | 按 `process_id` 附加到已运行进程（需显式 `adapter`） | 执行 |
| `set_breakpoints` | 整体替换一个文件的断点集（行号 + `condition`/`hit_condition`/`log_message`） | 执行 |
| `set_function_breakpoints` | 按函数名下断点（`functions` + `condition`/`hit_condition`） | 执行 |
| `set_exception_breakpoints` | 配置哪些异常中断（`filters` 如 `['all']`，或 `filter_options`） | 执行 |
| `continue` / `step_in` / `step_over` / `step_out` / `pause` | 恢复执行；等待下一次停机，结果附带自上次读取以来的增量输出 | 执行 |
| `step_back` | 反向步进（需适配器声明 supportsStepBack）；等待下一次停机 | 执行 |
| `evaluate` | 在当前帧上下文求值 | 执行 |
| `set_variable` / `set_expression` | 在 `variables_ref`/当前帧写入新值 | 执行 |
| `disconnect` | 结束会话（默认终止被调试进程） | 执行 |
| `ledger` | 查询调试会话台账（启动/断点/异常/终止等关键事件；支持 `session_id`/`ledger_kinds`/`ledger_since`/`ledger_limit` 过滤） | 只读 |
| `threads` / `stack_trace` / `scopes` / `variables` / `exception_info` / `output` / `sessions` | 检视与读取 | 只读 |
| `select_thread` | 切换焦点线程（后续 step/stack_trace 使用该线程） | 执行 |
| `add_watch` / `remove_watch` / `list_watches` | 观察表达式：登记后每次停机自动求值并随快照返回；按 watch_id 移除/列出 | 执行 |
| `restart` | 按原始 launch 配置重启 debuggee | 执行 |
| `source` | 读取当前停止位置的源码内容（支持 `source_reference` 取内存源） | 只读 |
| `loaded_sources` | 列出 debuggee 已加载的所有源文件 | 只读 |
| `modules` | 列出 debuggee 已加载的模块（支持 `start`/`count` 分页） | 只读 |
| `set_data_breakpoints` | 设置内存断点（watchpoint）：地址或变量名 + 读写类型 | 执行 |
| `goto_targets` / `goto` | 查询可跳转行并执行非顺序跳转 | 执行 |
| `restart_frame` | 重跑当前栈帧（重新进入当前函数） | 执行 |

## 会话台账（Ledger）

每次调试会话的关键事件都会追加到 JSONL 台账，便于问题回溯：

| 事件 | 时机 | 关键字段 |
| --- | --- | --- |
| `session_start` | 会话创建（launch/attach） | mode/adapter/program/cwd |
| `breakpoints_set` | 设置断点 | file/lines/verified |
| `breakpoint_hit` | 断点命中 | file/line/function（尽力补全） |
| `exception` | 异常停机 | reason/description/file/line |
| `stop` | 其它停机（entry/step/pause） | reason/threadId |
| `session_end` | 会话结束（disconnect/适配器关闭/debuggee 退出） | endReason/durationMs/exitCode |
| `request_error` | 模型动作失败 | code/message |

配置（`cordis.patch.yml`）：`ledgerPath`（默认 `~/.dsh-debugger-dap/ledger.jsonl`）、`ledgerMaxBytes`（默认 5MB，超限轮转到 `<path>.1`）。台账写入为尽力而为（best-effort），写入失败不影响调试主流程。

查询：`debug` 动作 `ledger`（参数 `session_id`/`ledger_kinds`/`ledger_since`/`ledger_limit`），或直接查看台账文件。

> 异常断点过滤器：内置 debugpy 配方会把标准 DAP 的 `'all'` 映射为 debugpy 实际支持的 `'raised'`（debugpy 没有 `all` 过滤器，直接下发会静默失效）；其余过滤器（`uncaught`/`userUnhandled`）原样透传。自定义适配器可用 `adapters.<id>.exceptionFilterMap` 声明自己的映射。

设计要点（借鉴 oh-my-pi 的 DAP 实现并按 dsh 习惯重塑）：

- **每个响应都携带会话快照**（Session/Adapter/Status/Stop reason/Location/Exit code/Adapter capabilities），模型永远知道自己在哪里、适配器支持什么。
- **恢复类动作等待下一次停机**，超时返回 `running` 状态与 `pause` 提示，工具调用永不悬挂；被调试会话保持存活。resume 结果附带自上次读取以来的**增量输出**，无需额外调 `output`。
- **每个 agent 的最近一次 launch 即其活跃会话**；传 `session_id` 可寻址其他会话；跨 agent 访问被拒绝（owner 作用域）。多线程调试用 `select_thread` 切换焦点线程，快照含 `allThreadsStopped` 标识。
- **会话台账（ledger）**：每次会话的关键事件（启动时间、断点设置/命中、异常、停止、终止、请求错误）追加写入 JSONL 文件（默认 `~/.dsh-debugger-dap/ledger.jsonl`，超限自动轮转到 `.1`），`ledger` 动作可查，跨重启可回溯。
- **错误统一归一化**：适配器错误/超时/断连分别映射为稳定错误码（`adapter_error`/`timeout`/`disconnected`），模型自愈提示一致。
- **适配器是配置行，内置配方可省配置**：内置 `debugpy`（Python）、`dlv`（Go）、`netcoredbg`（.NET）配方，按程序扩展名自动选择（`.py`→debugpy、`.go`→dlv、`.dll`/`.exe`→netcoredbg），缺装时给出可操作的安装提示；任意其他 stdio DAP 适配器通过 `adapters` 配置声明。
- **内置配方自带适配器差异处理**：例如 netcoredbg 的 launch 需要 `type: coreclr`、入口停止字段是 `stopAtEntry` 而非标准的 `stopOnEntry` —— 插件已按配方自动处理，模型侧照常传 `stop_on_entry` 即可。
- 适配器进程死亡时，launch 失败信息携带适配器 **stderr 尾部**（如 `ModuleNotFoundError`）。

## 安装与挂载

插件已发布到 npm registry（`dsh-debugger-dap`，随 `v*` tag 由 CI 自动发布）。在 DeepSeek Harness 中通过 npm 包路径安装——`dsh plugin add` 会安装依赖并自动把包名追加到 profile 的 `dsh.profile.bundles`：

```sh
dsh plugin init debugger                       # 或跳过：add 时会自动创建 profile
dsh plugin add --profile debugger dsh-debugger-dap
dsh --profile debugger --dump-config          # 确认 debugger-dap 行已组合
```

等价的手工方式：编辑 profile 的 `package.json`，在 `dependencies` 与 `dsh.profile.bundles` 各加一行，然后 `pnpm install`：

```json
{
  "dependencies": {
    "dsh-debugger-dap": "^0.1.1"
  },
  "dsh": {
    "profile": {
      "bundles": ["@deepseek-ai/dsh-base", "dsh-debugger-dap"]
    }
  }
}
```

`dsh plugin add` 支持任意 npm 包路径（`name`、`name@version`、git URL、tarball、本地目录）。升级到新版本：

```sh
dsh plugin add --profile debugger dsh-debugger-dap@latest
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
| `sessionIdleTimeoutMs` | 1800000 (30min) | 会话空闲自动断开；0 禁用回收 |
| `maxSessionsPerOwner` | 5 | 每 agent 存活会话上限，超出后淘汰最久空闲者（活跃会话保留） |
| `adapters` | `{}` | 追加自定义适配器配方 / 覆盖内置配方，见下 |

内置配方无需配置即可用（前提是相应调试器在 PATH）：`debugpy`（pip install debugpy）、`dlv`（go install），以及 `.NET`：

```sh
# netcoredbg 一键示意：下载对应平台 release 解压后把目录加入 PATH 即可
# https://github.com/Samsung/netcoredbg/releases
debug launch adapter=netcoredbg program=<构建出的>.dll cwd=<项目目录>
```

覆盖内置配方或声明其他 stdio 适配器（`launchArgs` 会并入 DAP `launch` 请求体，用于适配器特有的启动参数，如 `sourceMaps`、`justMyCode`；覆盖内置配方时缺省的 `launchArgs`/入口停止字段会继承自带默认）。TCP 适配器若不带 `connectPort`，端口从子进程 stdout/stderr 播报中发现——默认同时扫描两条流并匹配 `Listening on port <N>`，可用 `portPattern` 声明自定义格式（正则字符串，一个捕获组为端口），用 `announceStream` 固定到 `stdout`/`stderr`（适配 `node --inspect` 这类把播报写到 stderr 的调试器）：

```yaml
- id: debugger-dap
  name: 'dsh-debugger-dap'
  config:
    adapters:
      js-debug:
        command: node
        args: ['/opt/js-debug/src/dapDebugServer.js']
        transport: tcp
        portPattern: 'DAP_PORT=(\d+)'
        launchArgs:
          sourceMaps: true
```

## 测试

```sh
npm test   # 构建 + node --test：framing、DAP 握手、状态机、owner 作用域、工具层全流程、适配器解析
npm run lint   # oxlint：src/test/helpers
```

测试通过内存中的伪 DAP 适配器（真实线协议帧格式）驱动，不需要安装任何真实调试器。

## 已知限制

- **传输层**：stdio（默认）与 TCP 均支持；内置 `codelldb` 配方声明 TCP，spawn 后从 stdout 的 "Listening on port &lt;N&gt;" 自动发现监听端口并连接，其余内置配方走 stdio。js-debug 官方发行以 TCP server 为主，可经 `adapters` 配置声明其命令与 `transport: 'tcp'`/`connectPort`——配置的命令会被实际 spawn，连接会重试直到子进程在 `connectPort` 上开始监听（显式端口优先于 stdout 发现）。
- **js-debug 无内置配方**：它随 VS Code 发行（`extensions/ms-vscode.js-debug/dist/src/dapDebugServer.js`），**从不发布到 npm**，无法作为 PATH 命令自动解析。未配置时对 `.js/.ts` 程序的 launch 会立即失败并给出可操作的 `adapters` 配置指引（不再空转到请求超时）；配置后即可用。
- **attach 按 pid、依赖适配器支持**：已支持 `process_id` 附加（debugpy/netcoredbg 等）；port/pipe 附加与 Windows 下部分适配器的 attach 受其本身能力限制。暂无指令断点、汇编、内存读写。
- **权限策略不在工具内**：按 dsh 惯例，审批/沙箱策略应通过宿主 `tools/pre-execute` 扩展点组合，而非内建于工具；launch 会以普通子进程 spawn（未走 `ctx.subprocess` 执行世界）。
- **会话不跨进程持久**：会话注册表在插件卸载时全部拆除；agent 释放后其遗留会话在插件卸载前保持存活（v1 无逐 agent 生命周期钩子）。
- **进程终止语义**：disconnect 优先发 DAP `disconnect {terminateDebuggee}`（由适配器负责终止被调试进程），随后 `kill()` 级联终止整个适配器进程树——POSIX 用进程组（SIGTERM → 宽限期后 SIGKILL），Windows 用 `taskkill /T /F`，所以即使适配器不理会 terminateDebuggee，其派生的 debuggee 也不会成为孤儿。attach 会话永不终止被附加的进程（那是用户自己的进程）；插件卸载（disposeAll）时 launch 会话会终止 debuggee，attach 会话仅断开。
