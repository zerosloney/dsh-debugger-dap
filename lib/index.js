/**
 * dsh-debugger-dap: DAP interactive debugger as a DeepSeek Harness plugin.
 *
 * Mounts one model-facing `debug` tool backed by an owner-scoped session
 * registry. Each launch spawns a configured stdio DAP adapter (built-in
 * recipes: debugpy, dlv) as a child process; every result carries a session
 * snapshot so the model always knows the debuggee location.
 */
import z from '@deepseek-ai/schemastery';
import { AdapterUnavailableError, resolveAdapter } from './adapters.js';
import { spawnDapAdapter } from './connection.js';
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
    }))
        .default({})
        .description('Extra stdio DAP adapters or overrides for the built-in debugpy/dlv recipes, keyed by adapter id. Each entry may carry extra launchArgs spread into the DAP launch request.'),
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
        spawn: spec => spawnDapAdapter([spec.command, ...spec.args], {
            cwd: spec.cwd,
            env: spec.env,
            requestTimeoutMs: config.requestTimeoutMs,
        }),
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