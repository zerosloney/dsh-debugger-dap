# dsh-debugger-dap 使用文档（29 个动作）

`debug` 工具通过一个判别式参数 `action` 覆盖整套调试流程：启动/附加、各类断点、单步、栈/作用域/变量检视、求值、运行时改值、异常信息、输出与收尾。

- **每个响应都带会话快照**，模型始终知道 `Session/Adapter/Status/Stop reason/Location/Exit code`。
- **恢复类动作（continue/step_*）等待下一次停机**，超时返回 `running` 状态并提示用 `pause`，调用永不悬挂。
- **owner 作用域**：每个 agent 的最近一次 launch/attach 即其活跃会话；传 `session_id` 可寻址同一 agent 的其它会话；跨 agent 访问被拒绝。
- 下面每个动作都可选传 `session_id`（除 `launch`/`attach`/`sessions`/`disconnect` 的语义见各自说明）。

---

## 通用参数与约定

| 参数 | 类型 | 说明 |
|---|---|---|
| `session_id` | string | 显式指定会话；缺省用当前 agent 的活跃会话 |
| `adapter` | string | 适配器 id：`debugpy`/`dlv`/`netcoredbg`/自定义；launch 缺省按扩展名猜（`.py`→debugpy、`.go`→dlv、`.dll`/`.exe`→netcoredbg），attach 必填 |

内置适配器（无需额外配置，只需调试器在 PATH）：
- `debugpy`（Python）：`pip install debugpy`
- `dlv`（Go）：`go install github.com/go-delve/delve/cmd/dlv@latest`
- `netcoredbg`（.NET）：从 https://github.com/Samsung/netcoredbg/releases 下载并加入 PATH（插件已内置 `type: coreclr` 与 `stopAtEntry` 处理）

---

## 1. `launch` — 启动程序

| 参数 | 必填 | 说明 |
|---|---|---|
| `program` | ✅ | 被调试程序：Python 脚本 / Go 源码或二进制 / .NET dll（推荐 `.dll` 便于自动选适配器） |
| `adapter` | | 缺省按 `program` 扩展名自动选择 |
| `args` | | 传给程序的命令行参数（string[]） |
| `cwd` | | 工作目录 |
| `stop_on_entry` | | 是否停在入口（默认 `true`；netcoredbg 自动映射为 `stopAtEntry`） |

```json
{ "action": "launch", "program": "E:/Demo/dotnet/.../App.dll", "cwd": "E:/Demo/dotnet/...", "stop_on_entry": true }
```
返回携带快照，`Status: stopped` 表示已停在入口。

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
> 附：pid 附加是否可用取决于适配器与平台；Windows 下部分适配器需 pipe 传输（本插件 v1 为 stdio）。

---

## 3. `set_breakpoints` — 文件行断点（整体替换某文件的断点集）

| 参数 | 必填 | 说明 |
|---|---|---|
| `file` | ✅ | 源码文件路径 |
| `lines` | ✅ | 行号数组（空数组=清空该文件断点） |
| `condition` | | 条件表达式（命中该表达式为真才停） |
| `hit_condition` | | 命中次数条件，如 `">3"`、`"5"` |
| `log_message` | | Logpoint：不停顿，命中打印此消息，`{}` 占位符展开 |

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

```json
{ "action": "set_exception_breakpoints", "filters": ["all"] }
```

---

## 6. `continue` / `step_in` / `step_over` / `step_out` — 恢复执行 / 步进

公共参数：`session_id`（可选）。

```json
{ "action": "continue" }
{ "action": "step_over" }
```
返回 `state: stopped | running | terminated` 与 `timed_out`。超时返回 `running` 并提示用 `pause`。

---

## 7. `pause` — 中断正在运行的程序

```json
{ "action": "pause" }
```
配合超时的 continue/step 使用。

---

## 8. `threads` — 列出线程

```json
{ "action": "threads" }
```
返回 `[{ id, name }]`。

---

## 9. `stack_trace` — 栈帧

| 参数 | 说明 |
|---|---|
| `thread_id` | 默认停在线程 |
| `levels` | 最大帧数（默认受 `maxStackFrames` 限制，默认 20） |

```json
{ "action": "stack_trace", "levels": 12 }
```
返回帧列表（含 `path:line:column`）+ `frames_omitted`。帧用 `#id` 标注，后续 `scopes`/`evaluate`/`set_expression` 可传该 `frame_id`。

---

## 10. `scopes` — 作用域

| 参数 | 说明 |
|---|---|
| `frame_id` | 缺省用当前停止帧的顶层帧 |

```json
{ "action": "scopes" }
```
返回 `[{ name, variablesReference, expensive }]`。

---

## 11. `variables` — 变量

| 参数 | 必填 | 说明 |
|---|---|---|
| `variables_ref` | ✅ | 来自 scopes / variables / evaluate 的引用 |

```json
{ "action": "variables", "variables_ref": 1 }
```
返回变量列表 + `variables_omitted`；带 `[ref=N]` 的可继续下钻。

---

## 12. `evaluate` — 求值

| 参数 | 必填 | 说明 |
|---|---|---|
| `expression` | ✅ | 表达式 |
| `frame_id` | | 缺省当前帧 |
| `context` | | `watch`/`repl`/`hover`/`variables`/`clipboard`（默认 `repl`） |

```json
{ "action": "evaluate", "expression": "builder.Environment.EnvironmentName" }
```

---

## 13. `set_variable` — 写变量

| 参数 | 必填 | 说明 |
|---|---|---|
| `variables_ref` | ✅ | 所属作用域/对象引用 |
| `name` | ✅ | 变量名 |
| `value` | ✅ | 新值（字符串形式） |

```json
{ "action": "set_variable", "variables_ref": 2, "name": "_HResult", "value": "0" }
```
返回改写后的 `value`/`type`。> 只读属性（如 netcoredbg 的 `ErrorCode`）会被适配器拒绝，属正常语义；写可写字段/表达式即可。

---

## 14. `set_expression` — 写表达式

| 参数 | 必填 | 说明 |
|---|---|---|
| `expression` | ✅ | 要赋值的表达式 |
| `value` | ✅ | 新值 |
| `frame_id` | | 缺省当前帧 |
| `context` | | 同上 |

```json
{ "action": "set_expression", "expression": "$exception.HResult", "value": "77777" }
```

---

## 15. `exception_info` — 异常详情

| 参数 | 说明 |
|---|---|
| `thread_id` | 缺省停在线程 |

在 `stop reason: exception` 时调用，返回异常 id / 描述 / message / type / breakMode / stack：

```json
{ "action": "exception_info" }
```

---

## 16. `output` — 读取捕获的程序输出

| 参数 | 说明 |
|---|---|
| `offset` | 起始字符偏移（用于翻页） |
| `max_chars` | 返回上限（默认 4000） |

```json
{ "action": "output" }
```
返回 `{ text, offset, total_chars, truncated }`。

---

## 17. `disconnect` — 结束会话

| 参数 | 说明 |
|---|---|
| `terminate_debuggee` | 是否终止被调试进程（默认 `true`） |
| `session_id` | 可指定其它会话 |

```json
{ "action": "disconnect" }
```

---

## 18. `sessions` — 列出当前 agent 的会话

```json
{ "action": "sessions" }
```

---

## 19. `restart` — 按原始 launch 配置重启

```json
{ "action": "restart" }
```
需适配器支持 `restart` 能力（`supportsRestartRequest`）；不支持时报 `not_supported` 并提示重新 launch。

---

## 20. `source` — 读取当前停止位置的源码

```json
{ "action": "source" }
```
返回 `{ content, mime_type }`（当前停止帧对应的源码内容）。

---

## 21. `loaded_sources` — 列出 debuggee 已加载的源文件

```json
{ "action": "loaded_sources" }
```
返回 `[{ path, name }]`。

---

## 22. `modules` — 列出 debuggee 已加载的模块

```json
{ "action": "modules" }
```
返回 `[{ id, name, path, version, loaded }]`。

---

## 23. `set_data_breakpoints` — 数据断点（watchpoint）

| 参数 | 说明 |
|---|---|
| `data_breakpoints` | `{ address?, name?, access_type? }[]`；`access_type` ∈ `read`/`write`/`readWrite` |
| `address` / `watch_name` / `access_type` | 单条速记形式（未传 `data_breakpoints` 时生效） |

```json
{ "action": "set_data_breakpoints", "watch_name": "count", "access_type": "readWrite" }
```
需适配器支持数据断点；返回每条 `{ id, verified, message }`。

---

## 24. `goto_targets` / `goto` — 非顺序跳转

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

## 25. `restart_frame` — 重跑当前栈帧

| 参数 | 说明 |
|---|---|
| `restart_frame_id` | 缺省当前帧；可传 `stack_trace` 返回的帧 id |

```json
{ "action": "restart_frame" }
```
需适配器支持 `supportsRestartFrame`。

---

## 端到端示例

### .NET（netcoredbg）
```json
{ "action": "launch", "program": ".../App.dll", "cwd": "...",
  "stop_on_entry": true }                 // 自动选 netcoredbg，停入口
{ "action": "set_function_breakpoints",
  "functions": ["MyNs.Service.DoWork"] }   // verified
{ "action": "set_exception_breakpoints", "filters": ["all"] }
{ "action": "continue" }                  // 停在断点或异常
{ "action": "stack_trace" }
{ "action": "scopes" } → { "action": "variables", "variables_ref": 1 }
{ "action": "evaluate", "expression": "count * 2" }
{ "action": "set_variable", "variables_ref": 1, "name": "count", "value": "10" }
{ "action": "set_expression", "expression": "result", "value": "0" }
{ "action": "output" }
{ "action": "disconnect" }
```

### Python（debugpy）
```json
{ "action": "launch", "program": "C:/work/app.py", "args": ["--port", "8080"],
  "cwd": "C:/work", "stop_on_entry": false }
{ "action": "set_breakpoints", "file": "C:/work/app.py", "lines": [42], "hit_condition": ">1" }
{ "action": "continue" }
{ "action": "stack_trace" }
{ "action": "scopes" } → { "action": "variables", "variables_ref": 1 }
{ "action": "evaluate", "expression": "total / n" }
{ "action": "disconnect" }
```

---

## 配置速查（profile 的 cordis.patch.yml）

内置配方默认即可用。自定义/覆盖适配器：

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
      js-debug:
        command: node
        args: ['/opt/js-debug/src/dapDebugServer.js']
        launchArgs: { sourceMaps: true }
```
