/**
 * dsh-debugger-dap: DAP interactive debugger as a DeepSeek Harness plugin.
 *
 * Mounts one model-facing `debug` tool backed by an owner-scoped session
 * registry. Each launch spawns a configured DAP adapter (built-in
 * recipes: debugpy, dlv, netcoredbg) as a child process over stdio or
 * TCP; every result carries a session snapshot so the model always knows
 * where the debuggee is.
 */
import z from '@deepseek-ai/schemastery';
import { AdapterUnavailableError, resolveAdapter } from './adapters.js';
import { spawnAdapter } from './connection.js';
import { DebugSessionManager } from './session.js';
import { createDebugTool } from './tool.js';
export const name = 'dsh-debugger-dap';
export const inject = ['tools'];
export const Config = z.object({
    requestTimeoutMs: z.natural().min(1000).default(30000).description('Per-request adapter timeout in milliseconds.'),
    stepTimeoutMs: z.natural().min(1000).default(10000).description('How long resume actions wait for the next stop before reporting the program as running.'),
    maxOutputChars: z.natural().min(2000).default(40000).description('Per-session output ring buffer cap in characters.'),
    maxStackFrames: z.natural().min(1).max(200).default(20).description('Maximum stack frames one stack_trace call returns.'),
    maxVariables: z.natural().min(1).max(1000).default(100).description('Maximum variables one variables call returns.'),
    maxResultChars: z.natural().min(2000).default(16000).description('Model-facing text result cap in characters.'),
    adapters: z
        .dict(z.object({
        command: z.string(),
        args: z.array(z.string()),
        env: z.dict(z.string()),
        cwd: z.string(),
        launchArgs: z.any(),
        /** Transport layer: 'stdio' (default) or 'tcp'. */
        transport: z.union([z.const('stdio'), z.const('tcp')]).default('stdio'),
        /** TCP connect host (default '127.0.0.1'). Used when transport is 'tcp'. */
        connectHost: z.string().default('127.0.0.1'),
        /** TCP connect port. Required when transport is 'tcp'. */
        connectPort: z.number().min(1),
    }))
        .default({})
        .description("Extra stdio or TCP DAP adapters or overrides for the built-in debugpy/dlv/netcoredbg recipes, keyed by adapter id. TCP entries: the adapter process is spawned as a child and communicated with over TCP; set connectPort to the port the adapter listens on."),
});
export function apply(ctx, config) {
    const limits = {
        requestTimeoutMs: config.requestTimeoutMs,
        stepTimeoutMs: config.stepTimeoutMs,
        maxOutputChars: config.maxOutputChars,
        maxStackFrames: config.maxStackFrames,
        maxVariables: config.maxVariables,
        maxResultChars: config.maxResultChars,
    };
    const manager = new DebugSessionManager({
        spawn: spec => spawnAdapter(spec, { requestTimeoutMs: config.requestTimeoutMs }),
        resolveAdapter: options => resolveAdapter(options, config.adapters),
        limits,
    });
    ctx.effect(() => {
        const unregister = ctx.tools.register(createDebugTool(manager, limits));
        return () => {
            unregister();
            void manager.disposeAll();
        };
    });
}
export { AdapterUnavailableError };
//# sourceMappingURL=index.js.map