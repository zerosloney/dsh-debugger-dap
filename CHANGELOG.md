# Changelog

All notable changes to this project are documented in this file. The format
follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this
project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.8] - 2026-08-25

### Added

- **Task & Build Integration (Direction B)**:
  - **`preLaunchTask` 与 `.vscode/tasks.json` 构建任务集成**：新增 `readTasksConfigurations`、`resolveTaskCommand` 与 `runPreLaunchTask`。当 `launch.json` 中配置了 `preLaunchTask`（如编译/构建脚本）时，`launch` 动作会在发起 DAP 连接前自动执行前置构建任务；若构建失败则立即返回编译器输出及退出码，实现一键编译并调试。
- **Exception & Multi-Thread Diagnostics (Direction A)**:
  - **异常诊断高亮 (Exception Diagnostics Highlight)**：当程序触发未捕获异常停机（`stopReason === 'exception'`）时，会话快照与渲染层自动提取异常类型、描述、消息及顶层调用栈信息，在快照中以醒目的 `💥 Exception:` 横幅直接呈现，并附带针对性诊断提示，省去额外的网络查询轮次。
  - **多线程停机全局概览 (Multi-thread Stop Overview)**：当多线程程序发生停机（`allThreadsStopped` 或检测到多个活跃线程）时，快照自动呈现线程列表与停机状态概览（`Threads (N):`），并以 `*` 明确高亮当前聚焦线程。
- **VS Code Ecosystem & Zero-config Launching**:
  - **工作区 `.vscode/launch.json` 自动解析与联动**：新增 `resolveLaunchConfig`、`readLaunchConfigurations` 与 JSONC 注释解析器。在 `launch` 动作中支持 `launch_config` 按名启动，或在省略 `program` 时自动读取工作区首项配置，自动展开 `${workspaceFolder}`、`${env:VAR}` 等变量并透传扩展参数。
  - **VS Code 扩展自动扫描与发现 (`findVsCodeExtensionEntry`)**：自动跨平台（Windows / macOS / Linux）检索 `~/.vscode/extensions`、`.vscode-insiders` 及 VS Code 安装目录，模糊匹配最新版本扩展（如 `ms-vscode.js-debug`、`vadimcn.vscode-lldb`），实现零配置复用 VS Code 调试器。
  - **跨平台路径宏展开 (`expandPath`)**：在适配器配置（`command`、`args`、`cwd`）中自动将 `~` 展开为用户家目录（`os.homedir()`），并解析 `%VAR%` / `${VAR}` 环境变量，解决不同机器用户名与路径硬编码问题。

## [0.1.7] - 2026-08-25

### Added

- **New DAP Actions (41 Actions Total)**:
  - `data_breakpoint_info`: Query data breakpoint capabilities and get `dataId` for setting watchpoints on variables/fields.
  - `set_data_breakpoints`: Enhanced to accept `data_id`, `condition`, and `hit_condition`. Supports **一步直达 (One-shot setup)** by automatically querying `data_breakpoint_info` behind the scenes when variable `name` is passed without `data_id`.
  - `disassemble`: Disassemble memory from a `memory_reference` with instruction bytes, symbol resolution, and source location mapping.
  - `read_memory`: Read raw memory bytes as base64 with offset and count, rendered automatically in standard **`hexdump -C` format** (address + hex bytes + ASCII column) for direct model analysis.
  - `completions`: REPL auto-completion support for expressions and symbols at a specific frame/cursor line and column.
  - `reverse_continue`: Reverse execution continuing backward until a breakpoint or start of program.
  - `terminate`: Graceful DAP termination request (recording `terminate` reason in ledger).
- **Inspection Enhancements**:
  - `formatHexDump`: Standard 16-byte aligned Hexdump formatter with 32-bit/64-bit address padding and printable ASCII preview.
  - `variables` and `evaluate` actions now support `hex: true` formatting for hex number representations.
  - `variables` action supports `filter: 'indexed' | 'named'` for filtering arrays vs object fields.
  - `goto_targets` now supports in-memory sources (`sourceReference`) in addition to file paths.
  - `restart_frame` now returns an updated `DebugSnapshot` with refreshed frame, thread, and watch evaluations.
- **Recipe & Transport Compatibility**:
  - `lldb-dap` recipe now automatically probes `lldb-dap`, `lldb-vscode`, and `llvm-dap` across different LLVM toolchains.
  - Windows `PATHEXT` handling in `defaultCommandExists` correctly parses case-insensitive executable extensions.
  - `spawnAdapter` defaults options to `{}` avoiding `TypeError` on optional parameter omission.

## [0.1.6] - 2026-08-24

### Added

- **TCP 端口发现支持 stderr 播报**：`spawnTcpAdapterWithDiscovery` 默认同时扫描子进程 stdout 与 stderr（新增 `announceStream: 'stdout' | 'stderr' | 'both'`，贯通 `adapters.<id>.announceStream` 配置），覆盖 `node --inspect` 等把 "Debugger listening on ws://…" 写到 stderr 的调试器。
- **CI real-adapters 工作流**（`.github/workflows/real-adapters.yml`）：ubuntu 上安装 debugpy（pip）、dlv（go install）、netcoredbg（release tarball），以 `DEBUG_DAP_INTEGRATION=1` 真实跑 integration + smoke，防止内置配方与真实适配器漂移。
- **真实 netcoredbg 冒烟脚本**（`scripts/selftest-netcoredbg.mjs`）：dotnet build 真实 dll 后跑通 launch/step/stack/evaluate/disconnect 闭环。
- **工具层全链路实测脚本**（`scripts/selftest-netcoredbg-tool.mjs`）：模型真实路径（动作分发 + 文本渲染 + 错误归一化）对真实 netcoredbg 跑 12 项断言，验证断点命中/变量/求值/写值/台账/断连；记录 pending 断点、variablesReference 单停机有效、循环断点多次命中三个真实适配器行为。
- **会话台账（ledger）**：每次调试会话的关键事件（`session_start`/`breakpoints_set`/`breakpoint_hit`/`exception`/`stop`/`session_end`/`request_error`）追加写入 JSONL（默认 `~/.dsh-debugger-dap/ledger.jsonl`，`ledgerPath`/`ledgerMaxBytes` 可配，超限轮转到 `.1`）；新增 `ledger` 动作（`session_id`/`ledger_kinds`/`ledger_since`/`ledger_limit` 过滤）。断点/异常命中尽力补全顶层帧位置（file/line/function）。
- **异常断点过滤器映射**：内置 debugpy 配方把标准 DAP 的 `'all'` 映射为 debugpy 实际支持的 `'raised'`（debugpy 无 `all` 过滤器，直接下发会静默失效）；自定义适配器可用 `adapters.<id>.exceptionFilterMap` 声明映射。
- **请求错误入账**：模型动作失败以 `request_error`（稳定错误码 + 消息）写入台账。
- **真实适配器测试修复**（首次安装 debugpy 后暴露的既有缺陷）：smoke 测试改用 `resolveAdapter`（此前手写 spec 缺 `launchArgs.program` 导致 debugpy 挂起）；断点改到可命中且 Locals 非空的行；smoke/integration 测试断言失败时用 `finally` 清理适配器进程（此前残留子进程让 `node --test` 挂起）。

### Changed

- `stack_trace` 台账位置补全使用独立轻量请求（2s 超时、尽力而为），不影响主调试流程。

- **`select_thread`** action: switch the session's focus thread; later
  step/stack_trace use it. Snapshot now carries `allThreadsStopped`.
- **`step_back`** action (reverse stepping, requires adapter `supportsStepBack`).
- **Watch expressions**: `add_watch` / `remove_watch` / `list_watches`;
  watches are evaluated on every stop and their values ride the snapshot.
- **Incremental output**: `continue`/`step_*`/`pause` results attach new
  output produced since the last read — no separate `output` call needed.
- **Per-line breakpoint settings**: `set_breakpoints` accepts object entries
  `{ line, condition?, hit_condition?, log_message? }` in `lines`, or plain
  numbers that inherit the call-level settings.
- **Paging**: `variables` and `modules` accept `start`/`count`; oversized
  variable/evaluation values are truncated in the data layer with a char count.
- **Session lifecycle**: `sessionIdleTimeoutMs` idle reaping and
  `maxSessionsPerOwner` LRU eviction (active session never evicted).
- **`source` by reference**: `source_reference` param; in-memory/REPL sources
  are readable. `loaded_sources` reports `source_reference`.
- **Adapter capabilities in snapshot**: model sees what the adapter supports
  without probing every action.
- **Custom TCP port announcement pattern**: `adapters.*.portPattern`.
- **Stable error taxonomy**: adapter failures/timeouts/disconnects map to
  `adapter_error` / `timeout` / `disconnected` DebugError codes.
- **Real-adapter smoke test** (`test/smoke.test.mjs`, skipped unless debugpy
  is installed) and CI lint step (oxlint).
- `stack_trace` is no longer concurrency-safe (it records the current frame);
  it serializes against stepping and other inspection actions.
- TCP transport with an explicit `connectPort` now **spawns the configured
  command** and retries the connection until the child listens, instead of
  silently ignoring the command.
- Teardown cascades to the whole adapter process tree (POSIX process group +
  SIGKILL escalation, Windows `taskkill /T`); `disposeAll` terminates debuggee
  of launch sessions but never attach targets.
- Port-discovery TCP transport now **retries the connect** until the announced
  port accepts (an announcement can precede the actual bind), bounded by the
  new `connectTimeoutMs`; adapter death during any phase settles immediately
  with its stderr tail.

### Fixed

- Resume actions (`continue`/`step_*`/`goto`/`restart`) restore the session
  status when the adapter rejects the request, instead of leaving a lying
  `running` snapshot. `restart` additionally restores the pre-restart stop
  reason, focus thread, and frame. (此前版本该修复随重构丢失：`previousStatus`
  被赋值后从未使用，拒绝后快照永久停留在虚假的 `running`。)
- Rendering now covers `step_back`, `select_thread`, `add_watch`,
  `remove_watch`, and `list_watches`; previously every successful call of
  these five actions rendered "Unknown debug action: …", hiding the new
  state and watch ids from the model.
- Removed the built-in `js-debug` recipe (a bare `node` command is not a DAP
  adapter): launching a `.js/.ts` program without configuring js-debug now
  fails fast with the exact `adapters` config shape to declare, instead of
  hanging until the request timeout. Config-declared `js-debug` rows keep
  working unchanged.
- Port-discovery spawn path handled `child 'error'` (ENOENT) instead of
  crashing with an unhandled exception.
- The resume-timeout hint ("still running after Nms") now reports the
  configured `stepTimeoutMs` instead of a hardcoded 10000ms.
- Built-in `codelldb` recipe passes only `--port 0`: upstream's CLI defines
  long options only (no subcommand, no positional argument), so the previous
  argv made the binary exit with a usage error before listening.
- js-debug 指引修正：确认 `@vscode/js-debug` **不发布到 npm**（registry 404，仅随 VS Code 发行），错误信息/README/USAGE 由"npm install -g"改为指向 `extensions/ms-vscode.js-debug/dist/src/dapDebugServer.js`。
- Lint warnings cleared: the four unused `previousStatus` locals are now the
  actual restore mechanism, and a leftover noop expression in the ledger
  query test was replaced with real temp-file cleanup.
- **examples/**：新增 `examples/debuggee_prod.py` 与 `examples/README.md`——
  真实 dsh headless 会话中定位断言失败的完整可复现样本（经 0.1.5 实测：
  模型用 `debug` 工具 launch→断点→4 次命中→逐次读值→定位 `33 ≠ 34` 根因），
  与 `test/fixtures/` 的单元测试夹具区分开。

## [0.1.3] - 2026-02-22

### Added

- `variables`/`modules`/`source`/`gotoTargets`/`setDataBreakpoints` support.
- `owner`-scoped session registry with cross-agent rejection.

### Fixed

- Deferred start response (debugpy-style) no longer deadlocks the handshake.

[Unreleased]: https://github.com/zerosloney/dsh-debugger-dap/compare/v0.1.6...HEAD
[0.1.6]: https://github.com/zerosloney/dsh-debugger-dap/releases/tag/v0.1.6
[0.1.5]: https://github.com/zerosloney/dsh-debugger-dap/releases/tag/v0.1.5
[0.1.4]: https://github.com/zerosloney/dsh-debugger-dap/releases/tag/v0.1.4
[0.1.3]: https://github.com/zerosloney/dsh-debugger-dap/releases/tag/v0.1.3
