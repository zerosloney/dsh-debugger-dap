/**
 * dsh-debugger-dap: DAP interactive debugger as a DeepSeek Harness plugin.
 *
 * Mounts one model-facing `debug` tool backed by an owner-scoped session
 * registry. Each launch spawns a configured stdio DAP adapter (built-in
 * recipes: debugpy, dlv) as a child process; every result carries a session
 * snapshot so the model always knows the debuggee location.
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
export declare const Config: z<Config>;
export declare function apply(ctx: Context, config: Config): void;
export { AdapterUnavailableError };
