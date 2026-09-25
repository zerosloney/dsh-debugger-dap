# dsh-debugger-dap

[![npm](https://img.shields.io/npm/v/dsh-debugger-dap)](https://www.npmjs.com/package/dsh-debugger-dap)

给 [DeepSeek Harness](https://www.npmjs.com/package/@deepseek-ai/dsh-tools) 的 AI agent 用的交互式调试器插件。挂载后 agent 多一个 `debug` 工具：启动被调试程序、打断点、单步执行、查看调用栈与变量、求值表达式、捕获程序输出——像人在 IDE 里调试一样，整个过程就是一次次普通的工具调用。零宿主源码改动，旁挂即用。

底层基于 VS Code 同款的 Debug Adapter Protocol（DAP）标准协议，与具体语言解耦，凡是 VS Code 生态里的调试器基本都能接。

> 📖 全部 42 个动作的参数说明与调用示例见 **[USAGE.md](./USAGE.md)**；版本历史见 [CHANGELOG.md](./CHANGELOG.md)。

## 支持的语言

| 语言 | 调试器 | 一键安装 |
|---|---|---|
| Python | debugpy | ✅ pip 安装 |
| Go | dlv (Delve) | ✅ go install |
| .NET | netcoredbg | ✅ 下载 release |
| C / C++ | lldb-dap（LLVM 自带） | 需自行安装 LLVM 工具链 |
| Rust | codelldb | 需 CodeLLDB 扩展 |

launch 时按程序扩展名自动选择调试器（`.py`→debugpy、`.go`→dlv、`.dll`/`.exe`→netcoredbg、`.c`/`.cpp`→lldb-dap、`.rs`→codelldb）。VS Code 的 js-debug（JS/TS）及任何其它 DAP 调试器可通过配置接入（见[下文](#配置)）。

## 安装

已发布到 npm，在 DeepSeek Harness 里一条命令挂载：

```sh
dsh plugin init debugger                        # 可跳过：add 时会自动创建 profile
dsh plugin add --profile debugger dsh-debugger-dap
dsh --profile debugger --dump-config           # 确认已挂载
```

升级：`dsh plugin add --profile debugger dsh-debugger-dap@latest`。也可以手工编辑 profile 的 `package.json`，把包名同时加进 `dependencies` 和 `dsh.profile.bundles` 后安装依赖，效果相同。

## 怎么用

装好后 agent 的工具面多出一个 `debug` 工具，用 `action` 参数区分要做的事。一次典型的调试往返长这样：

```json
{ "action": "launch", "program": "app.py" }            // 启动并停在入口
{ "action": "set_breakpoints", "file": "app.py", "lines": [42, 88] }
{ "action": "continue" }                                // 跑到断点停下，顺带带回这段时间的增量输出
{ "action": "stack_trace" }                             // 看调用栈
{ "action": "variables", "variables_ref": 1000 }        // 看变量（引用来自 scopes/上一级变量）
{ "action": "evaluate", "expression": "total * 2" }     // 在当前栈帧求值
{ "action": "disconnect" }                              // 结束会话
```

42 个动作按用途分组一览：

| 类别 | 能干什么 |
|---|---|
| 启动与结束 | 启动（launch）、按进程号附加（attach）、重启、优雅终止、断开 |
| 断点 | 行断点（条件 / 命中次数 / 日志点）、函数断点、异常断点、数据断点（watchpoint）、观察表达式 |
| 执行控制 | 继续、单步进入 / 跳过 / 跳出、反向步进与反向继续、暂停、跳到指定行、重跑当前栈帧 |
| 状态检视 | 线程列表与焦点切换、调用栈、作用域、变量（分页 / 十六进制 / 过滤）、异常信息、源码与已加载模块、程序输出 |
| 高级操作 | 表达式求值、运行时改值、读内存（自动按 hexdump 呈现）、反汇编、REPL 补全 |
| 会话与审计 | 多会话并存与切换、调试台账（ledger）查询 |

几个顺手的设计：

- **每次响应都带会话快照**：状态、停机原因、当前位置、调试器能力一目了然，模型不用靠记忆拼上下文。
- **continue / step 会等下一次停机**：结果直接带回位置与新增输出，工具调用永不悬挂。
- **异常停机带诊断横幅**：未捕获异常时快照直接给出异常类型与顶层调用栈；多线程停机时自动附线程概览。
- **调试台账**：每次会话的关键事件（启动、断点命中、异常、终止、报错）记入本地 JSONL 文件，可随时回查。

### 调试器没装？

```json
{ "action": "install_adapter", "adapter": "debugpy" }
```

一键安装缺失的调试器（debugpy→pip、dlv→go install、netcoredbg→下载 release），装到 `~/.dsh-debugger-dap/adapters/` 并自动生效，不用改系统 PATH。也可以在配置里打开 `autoInstallAdapters`，launch 时自动补装。

### VS Code 工程零配置联动

工作区里有 `.vscode/launch.json` 时，launch 可以更省事：

- 不传 `program` 直接 `{ "action": "launch" }`：自动读取 launch.json 首项配置启动（`${workspaceFolder}`、`${env:VAR}` 等变量自动展开）；
- 传 `launch_config` 按配置名启动，如 `{ "action": "launch", "launch_config": "Debug App" }`；
- 配置了 `preLaunchTask` 的工程，launch 前会自动执行 `.vscode/tasks.json` 里的构建任务，编译失败直接返回编译器报错。

## 配置

都有合理默认，不配也能用；按需调整：

| 字段 | 默认 | 含义 |
|---|---|---|
| `autoInstallAdapters` | `false` | 调试器缺失时 launch 自动补装 |
| `requestTimeoutMs` | 30000 | 单个调试请求超时（毫秒） |
| `stepTimeoutMs` | 10000 | continue / step 等待停机的超时 |
| `sessionIdleTimeoutMs` | 30 分钟 | 空闲会话自动回收；0 关闭 |
| `maxSessionsPerOwner` | 5 | 单个 agent 并存会话上限 |
| `adapters` | `{}` | 接入 / 覆盖调试器，见下 |

接入内置列表之外的调试器（以 VS Code 的 js-debug 为例）：

```yaml
- id: debugger-dap
  name: 'dsh-debugger-dap'
  config:
    adapters:
      js-debug:
        command: node
        args: ['/opt/js-debug/src/dapDebugServer.js']
        transport: tcp
```

## 已知限制

- js-debug 随 VS Code 发行、不发布到 npm，需按上面的方式配置后使用；未配置时对 `.js`/`.ts` 的 launch 会直接给出配置指引，不会空转超时。
- attach 按进程号附加，是否可用取决于所用调试器与平台；暂不支持指令断点。
- 调试会话随插件卸载拆除，不跨宿主进程持久。

## 开发与发布

```sh
npm run check      # lint + typecheck + test（与 CI 相同的本机检查）
npm run test:real  # 真实调试器集成测试（未安装自动跳过）
npm run release    # 本机发布：递增版本 → 检查 → npm publish → 提交并打 tag
```

单元测试用内存中的伪 DAP 适配器跑真实线协议，不需要安装任何真实调试器。
