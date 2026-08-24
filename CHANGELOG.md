# Changelog

All notable changes to this project are documented in this file. The format
follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this
project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

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

### Changed

- `stack_trace` is no longer concurrency-safe (it records the current frame);
  it serializes against stepping and other inspection actions.
- TCP transport with an explicit `connectPort` now **spawns the configured
  command** and retries the connection until the child listens, instead of
  silently ignoring the command.
- Teardown cascades to the whole adapter process tree (POSIX process group +
  SIGKILL escalation, Windows `taskkill /T`); `disposeAll` terminates debuggee
  of launch sessions but never attach targets.

### Fixed

- Resume actions (`continue`/`step_*`/`goto`/`restart`) restore the session
  status when the adapter rejects the request, instead of leaving a lying
  `running` snapshot.
- Port-discovery spawn path handled `child 'error'` (ENOENT) instead of
  crashing with an unhandled exception.

## [0.1.3] - 2026-02-22

### Added

- `variables`/`modules`/`source`/`gotoTargets`/`setDataBreakpoints` support.
- `owner`-scoped session registry with cross-agent rejection.

### Fixed

- Deferred start response (debugpy-style) no longer deadlocks the handshake.

[Unreleased]: https://github.com/dsh-debugger-dap/dsh-debugger-dap/compare/v0.1.3...HEAD
[0.1.3]: https://github.com/dsh-debugger-dap/dsh-debugger-dap/releases/tag/v0.1.3
