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
/** 默认台账路径：~/.dsh-debugger-dap/ledger.jsonl */
export declare const DEFAULT_LEDGER_PATH: string;
export type LedgerKind = 'session_start' | 'session_end' | 'breakpoints_set' | 'breakpoint_hit' | 'exception' | 'stop' | 'request_error';
/** 一条台账记录（JSON 安全，可整行写入 JSONL）。 */
export interface LedgerEntry {
    /** 进程内单调序号，也即写盘顺序。 */
    readonly seq: number;
    /** ISO-8601 时间戳。 */
    readonly ts: string;
    /** 所属会话 id；请求级错误无会话时为空。 */
    readonly sessionId: string | undefined;
    readonly kind: LedgerKind;
    readonly detail: Record<string, unknown>;
}
export interface LedgerQuery {
    /** 只查某会话；缺省查全部。 */
    sessionId?: string;
    /** 只查某些种类；空数组/缺省查全部。 */
    kinds?: readonly LedgerKind[];
    /** 只查 ts >= since 的条目（ISO-8601 字符串比较）。 */
    since?: string;
    /** 返回条数上限（默认 50，最大 500），取最新 N 条。 */
    limit?: number;
}
export declare class DebugLedger {
    private readonly filePath;
    private readonly maxFileBytes;
    private readonly entries;
    private seq;
    private writeErrors;
    private constructor();
    /** 创建台账；path 为空时使用默认路径，目录自动创建。 */
    static create(options?: {
        path?: string;
        maxFileBytes?: number;
    }): DebugLedger;
    /** JSONL 文件路径（可人工查阅/归档）。 */
    get path(): string;
    /** 写盘失败的累计次数（0 = 全部成功）。 */
    get writeFailureCount(): number;
    /** 追加一条记录：内存环形缓冲 + JSONL 追加写（同步、尽力而为）。 */
    record(sessionId: string | undefined, kind: LedgerKind, detail?: Record<string, unknown>): void;
    /** 查询最新条目（按 seq 升序返回尾部 slice）。 */
    query(options?: LedgerQuery): {
        entries: LedgerEntry[];
        truncated: boolean;
    };
}
