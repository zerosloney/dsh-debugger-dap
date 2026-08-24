/**
 * dsh-debugger-dap: DAP interactive debugger as a DeepSeek Harness plugin.
 *
 * Mounts one model-facing `debug` tool backed by an owner-scoped session
 * registry. Each launch spawns a configured DAP adapter (built-in
 * recipes: debugpy, dlv, netcoredbg) as a child process over stdio or
 * TCP; every result carries a session snapshot so the model always knows
 * where the debuggee is.
 */
import type { Context } from '@deepseek-ai/cordis';
import z from '@deepseek-ai/schemastery';
import { AdapterUnavailableError, type AdapterConfigEntry } from './adapters.js';
export declare const name = "dsh-debugger-dap";
export declare const inject: string[];
/** Plugin config; every tunable is a validated field changeable from cordis.yml. */
export interface Config {
    requestTimeoutMs: number;
    stepTimeoutMs: number;
    maxOutputChars: number;
    maxStackFrames: number;
    maxVariables: number;
    maxResultChars: number;
    sessionIdleTimeoutMs: number;
    maxSessionsPerOwner: number;
    adapters: Record<string, AdapterConfigEntry>;
    ledgerPath: string;
    ledgerMaxBytes: number;
}
export declare const Config: z<Schemastery.ObjectS<{
    requestTimeoutMs: z<number, number>;
    stepTimeoutMs: z<number, number>;
    maxOutputChars: z<number, number>;
    maxStackFrames: z<number, number>;
    maxVariables: z<number, number>;
    maxResultChars: z<number, number>;
    sessionIdleTimeoutMs: z<number, number>;
    maxSessionsPerOwner: z<number, number>;
    ledgerPath: z<string, string>;
    ledgerMaxBytes: z<number, number>;
    adapters: z<import("@deepseek-ai/cosmokit").Dict<{
        command?: string | null | undefined;
        args?: string[] | null | undefined;
        env?: import("@deepseek-ai/cosmokit").Dict<string, string> | null | undefined;
        cwd?: string | null | undefined;
        launchArgs?: any;
        transport?: "stdio" | "tcp" | null | undefined;
        connectHost?: string | null | undefined;
        connectPort?: number | null | undefined;
        portPattern?: string | null | undefined;
        announceStream?: "stdout" | "stderr" | "both" | null | undefined;
        exceptionFilterMap?: import("@deepseek-ai/cosmokit").Dict<string, string> | null | undefined;
    } & import("@deepseek-ai/cosmokit").Dict, string>, import("@deepseek-ai/cosmokit").Dict<Schemastery.ObjectT<{
        command: z<string, string>;
        args: z<string[], string[]>;
        env: z<import("@deepseek-ai/cosmokit").Dict<string, string>, import("@deepseek-ai/cosmokit").Dict<string, string>>;
        cwd: z<string, string>;
        launchArgs: z<any, any>;
        /** Transport layer: 'stdio' (default) or 'tcp'. */
        transport: z<"stdio" | "tcp", "stdio" | "tcp">;
        /** TCP connect host (default '127.0.0.1'). Used when transport is 'tcp'. */
        connectHost: z<string, string>;
        /** TCP connect port. Optional when transport is 'tcp' — when absent, the port is discovered from the adapter's stdout. */
        connectPort: z<number, number>;
        /** Regex (string) matching the adapter's port announcement on stdout, one capture group for the port. Used when transport is 'tcp' without connectPort. */
        portPattern: z<string, string>;
        /** Which child stream carries the port announcement: 'stdout', 'stderr', or 'both' (default 'both'). */
        announceStream: z<"stdout" | "stderr" | "both", "stdout" | "stderr" | "both">;
        /** Standard DAP exception filter → adapter-specific filter name (e.g. debugpy: { all: 'raised' }). */
        exceptionFilterMap: z<import("@deepseek-ai/cosmokit").Dict<string, string>, import("@deepseek-ai/cosmokit").Dict<string, string>>;
    }>, string>>;
}>, Schemastery.ObjectT<{
    requestTimeoutMs: z<number, number>;
    stepTimeoutMs: z<number, number>;
    maxOutputChars: z<number, number>;
    maxStackFrames: z<number, number>;
    maxVariables: z<number, number>;
    maxResultChars: z<number, number>;
    sessionIdleTimeoutMs: z<number, number>;
    maxSessionsPerOwner: z<number, number>;
    ledgerPath: z<string, string>;
    ledgerMaxBytes: z<number, number>;
    adapters: z<import("@deepseek-ai/cosmokit").Dict<{
        command?: string | null | undefined;
        args?: string[] | null | undefined;
        env?: import("@deepseek-ai/cosmokit").Dict<string, string> | null | undefined;
        cwd?: string | null | undefined;
        launchArgs?: any;
        transport?: "stdio" | "tcp" | null | undefined;
        connectHost?: string | null | undefined;
        connectPort?: number | null | undefined;
        portPattern?: string | null | undefined;
        announceStream?: "stdout" | "stderr" | "both" | null | undefined;
        exceptionFilterMap?: import("@deepseek-ai/cosmokit").Dict<string, string> | null | undefined;
    } & import("@deepseek-ai/cosmokit").Dict, string>, import("@deepseek-ai/cosmokit").Dict<Schemastery.ObjectT<{
        command: z<string, string>;
        args: z<string[], string[]>;
        env: z<import("@deepseek-ai/cosmokit").Dict<string, string>, import("@deepseek-ai/cosmokit").Dict<string, string>>;
        cwd: z<string, string>;
        launchArgs: z<any, any>;
        /** Transport layer: 'stdio' (default) or 'tcp'. */
        transport: z<"stdio" | "tcp", "stdio" | "tcp">;
        /** TCP connect host (default '127.0.0.1'). Used when transport is 'tcp'. */
        connectHost: z<string, string>;
        /** TCP connect port. Optional when transport is 'tcp' — when absent, the port is discovered from the adapter's stdout. */
        connectPort: z<number, number>;
        /** Regex (string) matching the adapter's port announcement on stdout, one capture group for the port. Used when transport is 'tcp' without connectPort. */
        portPattern: z<string, string>;
        /** Which child stream carries the port announcement: 'stdout', 'stderr', or 'both' (default 'both'). */
        announceStream: z<"stdout" | "stderr" | "both", "stdout" | "stderr" | "both">;
        /** Standard DAP exception filter → adapter-specific filter name (e.g. debugpy: { all: 'raised' }). */
        exceptionFilterMap: z<import("@deepseek-ai/cosmokit").Dict<string, string>, import("@deepseek-ai/cosmokit").Dict<string, string>>;
    }>, string>>;
}>>;
export declare function apply(ctx: Context, config: Config): void;
export { AdapterUnavailableError };
