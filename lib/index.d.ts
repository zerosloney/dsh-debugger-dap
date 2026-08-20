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
    adapters: Record<string, AdapterConfigEntry>;
}
export declare const Config: z<Schemastery.ObjectS<{
    requestTimeoutMs: z<number, number>;
    stepTimeoutMs: z<number, number>;
    maxOutputChars: z<number, number>;
    maxStackFrames: z<number, number>;
    maxVariables: z<number, number>;
    maxResultChars: z<number, number>;
    adapters: z<import("@deepseek-ai/cosmokit").Dict<{
        command?: string | null | undefined;
        args?: string[] | null | undefined;
        env?: import("@deepseek-ai/cosmokit").Dict<string, string> | null | undefined;
        cwd?: string | null | undefined;
        launchArgs?: any;
        transport?: "stdio" | "tcp" | null | undefined;
        connectHost?: string | null | undefined;
        connectPort?: number | null | undefined;
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
        /** TCP connect port. Required when transport is 'tcp'. */
        connectPort: z<number, number>;
    }>, string>>;
}>, Schemastery.ObjectT<{
    requestTimeoutMs: z<number, number>;
    stepTimeoutMs: z<number, number>;
    maxOutputChars: z<number, number>;
    maxStackFrames: z<number, number>;
    maxVariables: z<number, number>;
    maxResultChars: z<number, number>;
    adapters: z<import("@deepseek-ai/cosmokit").Dict<{
        command?: string | null | undefined;
        args?: string[] | null | undefined;
        env?: import("@deepseek-ai/cosmokit").Dict<string, string> | null | undefined;
        cwd?: string | null | undefined;
        launchArgs?: any;
        transport?: "stdio" | "tcp" | null | undefined;
        connectHost?: string | null | undefined;
        connectPort?: number | null | undefined;
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
        /** TCP connect port. Required when transport is 'tcp'. */
        connectPort: z<number, number>;
    }>, string>>;
}>>;
export declare function apply(ctx: Context, config: Config): void;
export { AdapterUnavailableError };
