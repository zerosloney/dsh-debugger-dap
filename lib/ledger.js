/**
 * 调试会话台账（Debug Ledger）：把每次调试会话的关键事件追加到
 * 持久化 JSONL 文件，并提供进程内查询，便于问题回溯。
 *
 * 记录的事件种类（LedgerKind）：
 *  - session_start    会话创建（launch/attach、适配器、程序、cwd）
 *  - session_end      会话结束（disconnect / 适配器关闭 / debuggee 退出）
 *  - breakpoints_set  断点设置（文件 + 行号 + 命中验证数）
 *  - breakpoint_hit   断点命中（reason=breakpoint，尽力附加顶层帧位置）
 *  - exception        异常停机（reason=exception，尽力附加位置与描述）
 *  - stop             其它停机（step/pause/entry 等）
 *  - request_error    模型动作失败（稳定错误码 + 消息）
 *
 * 设计约束：台账是尽力而为（best-effort）的旁路设施——写入失败绝不
 * 影响调试主流程，只累计 writeFailureCount 供诊断。
 */
import { appendFileSync, existsSync, mkdirSync, renameSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
/** 默认台账路径：~/.dsh-debugger-dap/ledger.jsonl */
export const DEFAULT_LEDGER_PATH = join(homedir(), '.dsh-debugger-dap', 'ledger.jsonl');
const MEMORY_CAP = 5000;
const QUERY_LIMIT_MAX = 500;
export class DebugLedger {
    filePath;
    maxFileBytes;
    entries = [];
    seq = 0;
    writeErrors = 0;
    constructor(filePath, maxFileBytes) {
        this.filePath = filePath;
        this.maxFileBytes = maxFileBytes;
    }
    /** 创建台账；path 为空时使用默认路径，目录自动创建。 */
    static create(options) {
        const filePath = options?.path !== undefined && options.path.length > 0 ? options.path : DEFAULT_LEDGER_PATH;
        const maxFileBytes = options?.maxFileBytes ?? 5 * 1024 * 1024;
        return new DebugLedger(filePath, maxFileBytes);
    }
    /** JSONL 文件路径（可人工查阅/归档）。 */
    get path() {
        return this.filePath;
    }
    /** 写盘失败的累计次数（0 = 全部成功）。 */
    get writeFailureCount() {
        return this.writeErrors;
    }
    /** 追加一条记录：内存环形缓冲 + JSONL 追加写（同步、尽力而为）。 */
    record(sessionId, kind, detail = {}) {
        const entry = { seq: ++this.seq, ts: new Date().toISOString(), sessionId, kind, detail };
        this.entries.push(entry);
        if (this.entries.length > MEMORY_CAP) {
            this.entries.splice(0, this.entries.length - MEMORY_CAP);
        }
        try {
            mkdirSync(dirname(this.filePath), { recursive: true });
            if (existsSync(this.filePath)) {
                try {
                    if (statSync(this.filePath).size > this.maxFileBytes) {
                        // 简单轮转：超限时把当前文件改名为 .1（覆盖旧的 .1），继续写新文件。
                        renameSync(this.filePath, `${this.filePath}.1`);
                    }
                }
                catch {
                    // 轮转失败（如文件被占用）就继续追加，不阻塞调试。
                }
            }
            appendFileSync(this.filePath, `${JSON.stringify(entry)}\n`, 'utf8');
        }
        catch {
            this.writeErrors += 1;
        }
    }
    /** 查询最新条目（按 seq 升序返回尾部 slice）。 */
    query(options) {
        let list = this.entries;
        if (options?.sessionId !== undefined)
            list = list.filter(entry => entry.sessionId === options.sessionId);
        if (options?.kinds !== undefined && options.kinds.length > 0) {
            const kinds = new Set(options.kinds);
            list = list.filter(entry => kinds.has(entry.kind));
        }
        if (options?.since !== undefined)
            list = list.filter(entry => entry.ts >= options.since);
        const limit = Math.max(1, Math.min(options?.limit ?? 50, QUERY_LIMIT_MAX));
        const truncated = list.length > limit;
        return { entries: list.slice(-limit), truncated };
    }
}
//# sourceMappingURL=ledger.js.map