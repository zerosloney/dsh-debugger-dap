# dsh-debugger-dap 使用文档（41 个动作）

`debug` 工具通过一个判别式参数 `action` 覆盖整套调试流程：启动/附加、各类断点（源码/函数/异常/数据/观察点）、步进与反向步进、非顺序跳转、栈/作用域/变量检视（分页/十六进制/过滤）、内存读取与反汇编、代码补全、求值与运行时改值、异常信息、输出捕获与审计台账。

- **每个响应都带会话快照**，模型始终知道 `Session/Adapter/Status/Stop reason/Location/Exit code/Capabilities`。
- **恢复类动作（continue/step_*）等待下一次停机**，超时返回 `running` 状态并提示用 `pause`，调用永不悬挂；恢复类动作返回同时携带自上次读取以来的**增量输出**。
- **owner 作用域**：每个 agent 的最近一次 launch/attach 即其活跃会话；传 `session_id` 可寻址同一 agent 的其它会话；跨 agent 访问被拒绝。
- 下面每个动作都可选传 `session_id`（除 `launch`/`attach`/`sessions`/`disconnect` 的语义见各自说明）。

---

## 通用参数与约定

| 参数 | 类型 | 说明 |
|---|---|---|
| `session_id` | string | 显式指定会话；缺省用当前 agent 的活跃会话 |
| `adapter` | string | 适配器 id：`debugpy`/`dlv`/`netcoredbg`/`lldb-dap`/`codelldb`/自定义；launch 缺省按扩展名猜（`.py`→debugpy、`.go`→dlv、`.dll`/`.exe`→netcoredbg），attach 必填 |

内置适配器（无需额外配置，只需调试器在 PATH）：
- `debugpy`（Python）：`pip install debugpy`
- `dlv`（Go）：`go install github.com/go-delve/delve/cmd/dlv@latest`
- `netcoredbg`（.NET）：从 https://github.com/Samsung/netcoredbg/releases 下载并加入 PATH（插件已内置 `type: coreclr` 与 `stopAtEntry` 处理）
- `lldb-dap`（C/C++/Rust）：LLVM 工具链自带的 DAP 二进制（兼容 `lldb-dap` / `lldb-vscode` / `llvm-dap`）
- `codelldb`（C/C++/Rust）：CodeLLDB 独立 DAP 服务器（自动探测 TCP 端口）

---

## 1. `launch` — 启动程序

| 参数 | 必填 | 说明 |
|---|---|---|
| `program` | 条件选填 | 被调试程序：Python 脚本 / Go 源码或二进制 / .NET dll。若存在 `.vscode/launch.json` 可省略 |
| `launch_config` | | 指定 `.vscode/launch.json` 中的配置名称（如 `"Python: Current File"`、`"Debug App"`） |
| `adapter` | | 缺省按 `program` 扩展名或 `launch.json` 中的 `type` 自动选择 |
| `args` | | 传给程序的命令行参数（string[]） |
| `cwd` | | 工作目录（默认为进程 cwd） |
| `stop_on_entry` | | 是否停在入口（默认 `true`；netcoredbg 自动映射为 `stopAtEntry`） |

> **🔥 VS Code 联动与零配置启动**：
> 1. **零参数启动**：直接下发 `{ "action": "launch" }` 时，若未传 `program`，插件会自动读取当前工作区根目录下的 `.vscode/launch.json`，自动解析 `${workspaceFolder}`、`${env:VAR}` 等宏变量并按首项配置发起调试。
> 2. **按名启动**：`{ "action": "launch", "launch_config": "Node: Server" }` 自动匹配对应配置并提取参数与环境变量。
> 3. **构建任务联动 (`preLaunchTask`)**：若 `launch.json` 中配置了 `"preLaunchTask": "build"`，插件会在连接 DAP 调试前自动解析 `.vscode/tasks.json` 并执行编译/构建任务；若构建失败会立即返回详细的编译器 stderr 报错。

```json
{ "action": "launch", "launch_config": "Python: Main App" }
```
返回携带快照，`Status: stopped` 表示已停在入口。若触发异常停机，快照顶栏会直接显示 `💥 Exception: ...` 诊断横幅；若有多线程还会自动附带 `Threads (N):` 列表与聚焦高亮。

---

## 2. `attach` — 附加到已运行进程

| 参数 | 必填 | 说明 |
|---|---|---|
| `adapter` | ✅ | 必须显式（无法从 pid 猜适配器） |
| `process_id` | ✅ | 目标进程 pid |
| `program` | | 展示用的程序名（可选） |
| `cwd` | | 工作目录 |
| `stop_on_entry` | | 附加后是否停（默认 `false`） |

```json
{ "action": "attach", "adapter": "netcoredbg", "process_id": 4242 }
```
> 附：pid 附加是否可用取决于适配器与平台；Windows 下部分适配器需 pipe 传输（本插件为 stdio 或 tcp）。

---

## 3. `set_breakpoints` — 文件行断点（整体替换某文件的断点集）

| 参数 | 必填 | 说明 |
|---|---|---|
| `file` | ✅ | 源码文件路径 |
| `lines` | ✅ | 行号数组（空数组=清空该文件断点）。支持纯数字 `[42, 88]` 或对象数组 `[{ "line": 42, "condition": "x > 0", "hit_condition": ">1", "log_message": "x is {x}" }]` |
| `condition` | | 全局条件表达式（命中该表达式为真才停） |
| `hit_condition` | | 全局命中次数条件，如 `">3"`、`"5"` |
| `log_message` | | 全局 Logpoint：不停顿，命中打印此消息，`{}` 占位符展开 |

```json
{ "action": "set_breakpoints", "file": "C:/work/src/app.py", "lines": [42, 88], "hit_condition": ">1" }
```
返回每条断点的 `verified: true/false`（及可能的 `moved to line`）。

---

## 4. `set_function_breakpoints` — 函数断点

| 参数 | 必填 | 说明 |
|---|---|---|
| `functions` | ✅ | 函数/方法名数组（空数组=清空） |
| `condition` | | 条件表达式 |
| `hit_condition` | | 命中次数条件 |

```json
{ "action": "set_function_breakpoints", "functions": ["ConfigCenter.AppConfigService.GetAppConfig", "DoWork"] }
```
返回每条 `verified`。不依赖源码路径（netcoredbg 实测 `GetAppConfig` verified）。

---

## 5. `set_exception_breakpoints` — 异常断点

| 参数 | 说明 |
|---|---|
| `filters` | 过滤器数组，如 `["all"]`、`["uncaught"]`、`["userUnhandled"]` |
| `filter_options` | 结构化异常过滤选项（适配器支持 `supportsExceptionOptions` 时使用） |

> 过滤器映射：内置 debugpy 配方会把标准 DAP 的 `'all'` 映射为 debugpy 实际支持的 `'raised'`（debugpy 的过滤器是 `raised`/`uncaught`/`userUnhandled`，没有 `all`——直接下发 `['all']` 会被静默接受但不起作用）。自定义适配器可用 `adapters.<id>.exceptionFilterMap`（如 `{ all: 'raised' }`）声明自己的映射；未映射的过滤器原样透传。

```json
{ "action": "set_exception_breakpoints", "filters": ["all"] }
```

---

## 6. `continue` / `step_in` / `step_over` / `step_out` — 恢复执行 / 步进

| 参数 | 说明 |
|---|---|
| `single_thread` | 可选 boolean；为 `true` 时仅恢复当前焦点线程（需适配器支持单线程步进） |
| `thread_id` | 可选 number；指定单步的目标线程 |

```json
{ "action": "continue" }
{ "action": "step_over", "single_thread": true }
```
返回 `state: stopped | running | terminated` 与 `timed_out`。超时返回 `running` 并提示用 `pause`。恢复类动作同时附带自上次读取以来的增量输出。

---

## 7. `step_back` / `reverse_continue` — 反向步进 / 反向继续

| 参数 | 说明 |
|---|---|
| `single_thread` | 可选 boolean；指定是否单线程反向步进 |
| `thread_id` | 可选 number；指定目标线程 |

```json
{ "action": "step_back" }
{ "action": "reverse_continue" }
```
需适配器声明 `supportsStepBack`（如基于 rr 回放的调试器后端）；不支持时返回 `not_supported`。

---

## 8. `pause` — 中断正在运行的程序

```json
{ "action": "pause" }
```
配合超时的 continue/step 使用。

---

## 9. `threads` — 列出线程

```json
{ "action": "threads" }
```
返回 `[{ id, name }]`。

---

## 10. `select_thread` — 切换焦点线程

| 参数 | 说明 |
|---|---|
| `thread_id` | 必填；来自 `threads` 返回值 |

```json
{ "action": "select_thread", "thread_id": 2 }
```
多线程停机时切换后续 step / stack_trace / exception_info 使用的焦点线程；快照携带 `allThreadsStopped` 标识。

---

## 11. `stack_trace` — 栈帧

| 参数 | 说明 |
|---|---|
| `thread_id` | 默认停在线程 |
| `levels` | 最大帧数（默认受 `maxStackFrames` 限制，默认 20） |

```json
{ "action": "stack_trace", "levels": 12 }
```
返回帧列表（含 `path:line:column`）+ `frames_omitted`。帧用 `#id` 标注，后续 `scopes`/`evaluate`/`set_expression` 可传该 `frame_id`。

---

## 12. `scopes` — 作用域

| 参数 | 说明 |
|---|---|
| `frame_id` | 缺省用当前停止帧的顶层帧 |

```json
{ "action": "scopes" }
```
返回 `[{ name, variablesReference, expensive }]`。

---

## 13. `variables` — 变量列表与结构展开

| 参数 | 必填 | 说明 |
|---|---|---|
| `variables_ref` | ✅ | 来自 scopes / variables / evaluate 的引用 |
| `start` | | 起始索引（0-based 分页） |
| `count` | | 请求条目数（分页） |
| `filter` | | `"indexed"` 仅获取数组索引元素，`"named"` 仅获取命名属性 |
| `hex` | | `true` 请求适配器以十六进制格式化数值 |

```json
{ "action": "variables", "variables_ref": 1, "filter": "named", "hex": true }
```
返回变量列表 + `variables_omitted`；带 `[ref=N]` 的可继续下钻。

---

## 14. `evaluate` — 表达式求值

| 参数 | 必填 | 说明 |
|---|---|---|
| `expression` | ✅ | 表达式 |
| `frame_id` | | 缺省当前帧 |
| `context` | | `watch`/`repl`/`hover`/`variables`/`clipboard`（默认 `repl`） |
| `hex` | | `true` 请求以十六进制格式化求值结果 |

```json
{ "action": "evaluate", "expression": "builder.Environment.EnvironmentName", "hex": false }
```

---

## 15. `set_variable` — 写变量

| 参数 | 必填 | 说明 |
|---|---|---|
| `variables_ref` | ✅ | 所属作用域/对象引用 |
| `name` | ✅ | 变量名 |
| `value` | ✅ | 新值（字符串形式） |

```json
{ "action": "set_variable", "variables_ref": 2, "name": "_HResult", "value": "0" }
```
返回改写后的 `value`/`type`。

---

## 16. `set_expression` — 写表达式

| 参数 | 必填 | 说明 |
|---|---|---|
| `expression` | ✅ | 要赋值的表达式 |
| `value` | ✅ | 新值 |
| `frame_id` | | 缺省当前帧 |
| `context` | | 赋值上下文（默认 `repl`） |

```json
{ "action": "set_expression", "expression": "$exception.HResult", "value": "77777" }
```

---

## 17. `exception_info` — 异常详情

| 参数 | 说明 |
|---|---|
| `thread_id` | 缺省停在线程 |

在 `stop reason: exception` 时调用，返回异常 id / 描述 / message / type / breakMode / stack：

```json
{ "action": "exception_info" }
```

---

## 18. `data_breakpoint_info` — 查询数据断点（Watchpoint）能力

| 参数 | 必填 | 说明 |
|---|---|---|
| `name` | ✅ | 要观察的变量名或表达式 |
| `variables_ref` | | 变量所属的 variablesReference |
| `frame_id` | | 栈帧 id |

```json
{ "action": "data_breakpoint_info", "name": "counter" }
```
返回 `data_id`、描述和支持的访问类型（`read`/`write`/`readWrite`），用于后续 `set_data_breakpoints`。

---

## 19. `set_data_breakpoints` — 设置数据断点（Watchpoint / 内存断点）

| 参数 | 说明 |
|---|---|
| `data_breakpoints` | 结构化数组：`{ data_id?, address?, name?, variables_reference?, frame_id?, access_type?, condition?, hit_condition? }[]` |
| `name` / `watch_name` | **一步直达**：直接传入变量名，插件内部自动查询 `dataId` 并下发断点 |
| `data_id` | 从 `data_breakpoint_info` 获取的数据标识符（可选） |
| `address` / `access_type` | 内存地址与访问类型（`read` / `write` / `readWrite`） |
| `condition` / `hit_condition` | 条件断点与命中次数条件 |

```json
// 方式一：一步直达（自动查询 dataId）
{ "action": "set_data_breakpoints", "name": "counter", "access_type": "write" }

// 方式二：显式 data_id
{ "action": "set_data_breakpoints", "data_id": "var_ptr_1", "access_type": "write" }
```
需适配器支持数据断点（`supportsDataBreakpoints`）。

---

## 20. `disassemble` — 反汇编指令读取

| 参数 | 必填 | 说明 |
|---|---|---|
| `memory_reference` | ✅ | 内存引用或十六进制地址（如 `"0x7fff5fbff800"`） |
| `instruction_count` | | 反汇编指令数（默认 20） |
| `offset` | | 字节偏移 |
| `instruction_offset` | | 指令偏移 |
| `resolve_symbols` | | 是否解析符号名（默认 `true`） |

```json
{ "action": "disassemble", "memory_reference": "0x1000", "instruction_count": 10 }
```
需适配器支持 `supportsDisassembleRequest`。

---

## 21. `read_memory` — 读取原始内存数据（标准 Hexdump 渲染）

| 参数 | 必填 | 说明 |
|---|---|---|
| `memory_reference` | ✅ | 内存引用或十六进制地址 |
| `count` | | 要读取的字节数（默认 64） |
| `offset` | | 字节偏移（默认 0） |

```json
{ "action": "read_memory", "memory_reference": "0x7fffffffe000", "count": 32 }
```
自动将内存字节流排版为标准 `hexdump -C` 格式（起始地址 + 16字节Hex + ASCII 对照），便于模型直观分析内存结构：
```text
Memory at 0x7fffffffe000 (32 bytes):
  0x00007fffffffe000  48 65 6c 6c 6f 20 57 6f  72 6c 64 21 00 00 00 00  |Hello World!....|
  0x00007fffffffe010  ef be ad de 00 00 00 00  01 00 00 00 00 00 00 00  |................|
```

---

## 22. `completions` — REPL 上下文代码补全

| 参数 | 必填 | 说明 |
|---|---|---|
| `text` | ✅ | 要补全的前缀文本 |
| `column` | | 光标列位置（1-based，默认文本末尾） |
| `frame_id` | | 栈帧 id（默认当前帧） |
| `line` | | 行号 |

```json
{ "action": "completions", "text": "myObj." }
```
需适配器支持 `supportsCompletionsRequest`，返回候选补全项列表及类型、详情。

---

## 23. `goto_targets` / `goto` — 非顺序跳转

| 参数 | 说明 |
|---|---|
| `target_line` | `goto_targets` 的查询行（缺省当前帧所在行） |
| `target_id` | `goto` 必填，来自 `goto_targets` 返回值 |

```json
{ "action": "goto_targets", "target_line": 42 }
{ "action": "goto", "target_id": 1 }
```
需适配器支持 `supportsGotoTargetsRequest`。

---

## 24. `restart_frame` — 重跑栈帧（函数重新进入）

| 参数 | 说明 |
|---|---|
| `restart_frame_id` / `frame_id` | 缺省当前帧；可传 `stack_trace` 返回的帧 id |

```json
{ "action": "restart_frame" }
```
需适配器支持 `supportsRestartFrame`。

---

## 25. `add_watch` / `remove_watch` / `list_watches` — 观察表达式

| 参数 | 说明 |
|---|---|
| `expression` | `add_watch` 必填 |
| `watch_id` | `remove_watch` 必填；来自 `add_watch` 返回值 |

```json
{ "action": "add_watch", "expression": "count * 2" }
{ "action": "list_watches" }
{ "action": "remove_watch", "watch_id": "w1" }
```
登记后立即求值一次并返回 watch_id；此后每次停机自动重估全部观察表达式，结果随会话快照的 `watches` 字段返回。

---

## 26. `source` — 读取源码内容

| 参数 | 说明 |
|---|---|
| `source_reference` | 缺省当前帧；可传 `loaded_sources` 返回的数字引用（针对内存中/REPL 生成的无实体文件源码） |

```json
{ "action": "source" }
```
返回 `{ content, mime_type }`。

---

## 27. `loaded_sources` — 列出已加载源文件

```json
{ "action": "loaded_sources" }
```
返回 `[{ path, name, source_reference }]`。

---

## 28. `modules` — 列出已加载模块

| 参数 | 说明 |
|---|---|
| `start` | 分页起始索引 |
| `count` | 返回模块数量 |

```json
{ "action": "modules" }
```
返回 `[{ id, name, path, version, loaded }]`。

---

## 29. `output` — 读取捕获的程序输出

| 参数 | 说明 |
|---|---|
| `offset` | 起始字符偏移（用于翻页） |
| `max_chars` | 返回上限（默认 4000） |

```json
{ "action": "output" }
```
返回 `{ text, offset, total_chars, truncated }`。

---

## 30. `ledger` — 查询会话审计台账

返回关键调试事件（跨会话、跨重启可回溯），供问题排查与模型自我反思。

| 参数 | 说明 |
|---|---|
| `session_id` | 只查某会话（缺省全部） |
| `ledger_kinds` | 逗号分隔的事件种类：`session_start, session_end, breakpoints_set, breakpoint_hit, exception, stop, request_error` |
| `ledger_since` | 只查该 ISO-8601 时间戳之后的条目 |
| `ledger_limit` | 最多返回条数（默认 50，最大 500，取最新） |

```json
{ "action": "ledger", "ledger_kinds": "breakpoint_hit,exception", "ledger_limit": 20 }
```

---

## 31. `restart` — 按原始 launch 配置重启

```json
{ "action": "restart" }
```
需适配器支持 `supportsRestartRequest`。

---

## 32. `terminate` — 优雅终止被调试程序

```json
{ "action": "terminate" }
```
需适配器支持 `supportsTerminateRequest`；若不支持则自动降级为断开连接并杀死子进程。

---

## 33. `disconnect` — 结束会话

| 参数 | 说明 |
|---|---|
| `terminate_debuggee` | 是否终止被调试进程（默认 `true`） |
| `session_id` | 可指定其它会话 |

```json
{ "action": "disconnect" }
```

---

## 34. `sessions` — 列出当前 agent 的会话

```json
{ "action": "sessions" }
```

---

## 端到端典型场景示例

### Python（debugpy）
```json
{ "action": "launch", "program": "C:/work/app.py", "args": ["--port", "8080"], "cwd": "C:/work", "stop_on_entry": false }
{ "action": "set_breakpoints", "file": "C:/work/app.py", "lines": [42], "hit_condition": ">1" }
{ "action": "continue" }
{ "action": "stack_trace" }
{ "action": "scopes" }
{ "action": "variables", "variables_ref": 1, "hex": true }
{ "action": "evaluate", "expression": "total / n" }
{ "action": "disconnect" }
```

### .NET（netcoredbg）
```json
{ "action": "launch", "program": ".../App.dll", "cwd": "...", "stop_on_entry": true }
{ "action": "set_function_breakpoints", "functions": ["MyNs.Service.DoWork"] }
{ "action": "set_exception_breakpoints", "filters": ["all"] }
{ "action": "continue" }
{ "action": "stack_trace" }
{ "action": "scopes" }
{ "action": "variables", "variables_ref": 1 }
{ "action": "evaluate", "expression": "count * 2" }
{ "action": "set_variable", "variables_ref": 1, "name": "count", "value": "10" }
{ "action": "output" }
{ "action": "disconnect" }
```

### C/C++/Rust（lldb-dap / codelldb）底层调试
```json
{ "action": "launch", "program": "./target/debug/app", "stop_on_entry": true }
{ "action": "stack_trace" }
{ "action": "disassemble", "memory_reference": "0x555555555140", "instruction_count": 15 }
{ "action": "read_memory", "memory_reference": "0x7fffffffe000", "count": 64 }
{ "action": "data_breakpoint_info", "name": "global_state" }
{ "action": "set_data_breakpoints", "data_id": "global_state", "access_type": "write" }
{ "action": "continue" }
```

---

## 配置速查（profile 的 cordis.patch.yml）

内置配方默认即可用（支持自动扫描 VS Code 安装的 `ms-vscode.js-debug` 和 `vadimcn.vscode-lldb` 适配器）。
自定义/覆盖适配器时，支持使用 `~`、`%USERPROFILE%`、`$HOME` 跨平台路径宏：

```yaml
- id: debugger-dap
  config:
    requestTimeoutMs: 30000
    stepTimeoutMs: 10000
    maxOutputChars: 40000
    maxStackFrames: 20
    maxVariables: 100
    maxResultChars: 16000
    adapters:
      # 支持使用 '~'、'%USERPROFILE%'、'$HOME' 跨平台解析不同用户的家目录与动态版本
      js-debug:
        command: node
        args: ['~/.vscode/extensions/ms-vscode.js-debug/dist/src/dapDebugServer.js']
        transport: tcp        # 缺省 stdio；js-debug 是 TCP server
        launchArgs: { sourceMaps: true }
        # announceStream: stderr  # 端口播报流：stdout/stderr/both（默认 both）
      codelldb:
        command: '~/.vscode/extensions/vadimcn.vscode-lldb/adapter/codelldb'
        args: ['--port', '0']
        transport: tcp
```
