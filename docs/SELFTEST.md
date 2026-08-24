# dsh-debugger-dap 自测报告（SELFTEST）

- 日期：2026-08-24
- 环境：Windows 10（22631）· Node v22.22.0 · Python 3.13.12 + debugpy · netcoredbg 已安装 · dsh 0.1.1-rc.2 生态
- 版本：0.1.4（本次完善后）

## 1. 测试矩阵（npm test，99 项）

| 分组 | 用例数 | 结果 |
| --- | --- | --- |
| session / connection / framing / protocol / format / tool / adapters（fake 适配器） | 91 | 91 通过（含新增 8 项 ledger 测试） |
| smoke（真实 debugpy） | 1 | 1 通过 |
| integration（真实 debugpy / netcoredbg；dlv 未安装跳过） | 3 | 2 通过、1 跳过 |
| **合计** | **99** | **98 通过、1 跳过（dlv）、0 失败** |

修复的既有测试缺陷（安装 debugpy 后暴露）：
1. smoke 测试手写 spec 缺 `launchArgs.program` → debugpy 收不到 program 一直挂起 → 改用 `resolveAdapter`；
2. 断点设在赋值前停止的行（Locals 为空）→ 改到可命中且 Locals 非空的行；
3. 断言失败不清理适配器进程 → `node --test` 因残留子进程挂起 → 统一 `try/finally` 清理。

## 2. 真实 debugpy 会话闭环验证（scripts/e2e-real.mjs，全部断言通过）

| # | 场景 | 验证点 | 结果 |
| --- | --- | --- | --- |
| 1 | launch（stopOnEntry） | DAP 初始化完成、`initialized` 事件、入口停止（status=stopped, reason=entry, threadId=1） | 通过 |
| 2 | 断点命中 | line 13 断点 verified；continue 后停在 line 13，source 指向被测程序、stopReason=breakpoint | 通过 |
| 3 | 调用栈/作用域/变量 | 栈含 main 帧；Locals 作用域；count=1、total=42、i=0（与程序实际状态一致） | 通过 |
| 4 | 单步与求值 | next 13→12（reason=step）；continue 再次命中 13；evaluate("count + 41")=42 | 通过 |
| 5 | stepIn/stepOut | 断点 11 → stepIn 进入 add@line5 → stepOut 回 main@line11 | 通过 |
| 6 | 异常断点 | `set_exception_breakpoints(['all'])`（映射为 debugpy `raised`）→ 停机 reason=exception、ZeroDivisionError@line5 | 通过 |
| 7 | 断开无残留 | 两个会话 disconnect(terminateDebuggee=true) 后 debugpy.adapter 进程 0 → 0 | 通过 |
| 8 | 台账 | 18 条 JSONL 记录：session_start×3、breakpoints_set×2、breakpoint_hit×3（带 file/line/function）、exception×1（带 description/file/line/function）、stop×6、session_end×3（带 durationMs） | 通过 |

完整输出见 `docs/selftest-e2e-output.txt`；台账样本见 `docs/selftest-e2e-ledger.jsonl`（为 e2e 专用台账路径 `.e2e-ledger.jsonl` 的快照；插件默认路径为 `~/.dsh-debugger-dap/ledger.jsonl`）。

## 3. 本次完善内容

1. **调试会话台账（ledger）**：`src/ledger.ts` 新增——JSONL 追加持久化 + 内存环形缓冲 + 查询（sessionId/kind/since/limit）+ 超限轮转 + 写入失败隔离（best-effort，不影响调试主流程）；`DebugSession` 在启动/断点/停机/异常/结束/错误各点入账；断点与异常命中尽力补全顶层帧位置。
2. **`ledger` 动作**：只读、并发安全；支持 `session_id`/`ledger_kinds`/`ledger_since`/`ledger_limit`。
3. **异常断点过滤器映射**：debugpy 配方 `{ all: 'raised' }`；自定义适配器 `adapters.<id>.exceptionFilterMap`；未映射过滤器透传。
4. **配置**：`ledgerPath`（默认 `~/.dsh-debugger-dap/ledger.jsonl`）、`ledgerMaxBytes`（默认 5MB）。
5. **测试与文档**：新增 `test/ledger.test.mjs`（8 项）；修复 smoke/integration 既有缺陷；新增 `test/fixtures/debuggee.py`、`debuggee_exc.py`；README/USAGE/CHANGELOG 更新；新增 `scripts/e2e-real.mjs` 闭环验证脚本与本文档。

## 4. 已知限制

- 台账位置补全（breakpoint_hit/exception 的 file/line）依赖适配器在停机时支持 `stackTrace`（debugpy/dlv/netcoredbg 均支持）；不支持时条目仍记录 reason/threadId，无位置字段。
- `attach` 场景未在本机实测（无现成可附加进程）；launch 场景已全覆盖。
- dlv（Go）未安装，integration 中对应用例跳过。
- 台账写入为尽力而为：文件系统异常（权限/磁盘满）时记录 `writeFailureCount`，不抛出。
