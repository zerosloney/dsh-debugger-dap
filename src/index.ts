/**
 * dsh-debugger-dap: DAP interactive debugger as a DeepSeek Harness plugin.
 *
 * Mounts one model-facing `debug` tool backed by an owner-scoped session
 * registry. Each launch spawns a configured DAP adapter (built-in
 * recipes: debugpy, dlv, netcoredbg) as a child process over stdio or
 * TCP; every result carries a session snapshot so the model always knows
 * where the debuggee is.
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { AdapterUnavailableError, resolveAdapter, type AdapterConfigEntry } from './adapters.js'
import { spawnAdapter } from './connection.js'
import { DebugLedger } from './ledger.js'
import { DebugSessionManager, type SessionLimits } from './session.js'
import { createDebugTool } from './tool.js'

export const name = 'dsh-debugger-dap'

export const inject = ['tools']

/** Plugin config; every tunable is a validated field changeable from cordis.yml. */
export interface Config {
  requestTimeoutMs: number
  stepTimeoutMs: number
  maxOutputChars: number
  maxStackFrames: number
  maxVariables: number
  maxResultChars: number
  sessionIdleTimeoutMs: number
  maxSessionsPerOwner: number
  adapters: Record<string, AdapterConfigEntry>
  ledgerPath: string
  ledgerMaxBytes: number
}

export const Config = z.object({
  requestTimeoutMs: z.natural().min(1000).default(30000).description('Per-request adapter timeout in milliseconds.'),
  stepTimeoutMs: z.natural().min(1000).default(10000).description('How long resume actions wait for the next stop before reporting the program as running.'),
  maxOutputChars: z.natural().min(2000).default(40000).description('Per-session output ring buffer cap in characters.'),
  maxStackFrames: z.natural().min(1).max(200).default(20).description('Maximum stack frames one stack_trace call returns.'),
  maxVariables: z.natural().min(1).max(1000).default(100).description('Maximum variables one variables call returns.'),
  maxResultChars: z.natural().min(2000).default(16000).description('Model-facing text result cap in characters.'),
  sessionIdleTimeoutMs: z.natural().default(30 * 60 * 1000).description('Idle time after which a session is auto-disconnected; 0 disables reaping.'),
  maxSessionsPerOwner: z.natural().default(5).description('Maximum live sessions per agent; beyond this the oldest idle session is evicted.'),
  ledgerPath: z
    .string()
    .default('')
    .description(
      'Session trace ledger (JSONL) path; empty = ~/.dsh-debugger-dap/ledger.jsonl. Appends one line per key debug event (session start/end, breakpoint set/hit, exception, stop, request errors) for later forensics.',
    ),
  ledgerMaxBytes: z
    .natural()
    .min(1024)
    .default(5 * 1024 * 1024)
    .description('Ledger file size cap; when exceeded the file is rotated to <path>.1 before the next append.'),
  adapters: z
    .dict(
      z.object({
        command: z.string(),
        args: z.array(z.string()),
        env: z.dict(z.string()),
        cwd: z.string(),
        launchArgs: z.any(),
        /** Transport layer: 'stdio' (default) or 'tcp'. */
        transport: z.union([z.const('stdio'), z.const('tcp')]).default('stdio'),
        /** TCP connect host (default '127.0.0.1'). Used when transport is 'tcp'. */
        connectHost: z.string().default('127.0.0.1'),
        /** TCP connect port. Optional when transport is 'tcp' — when absent, the port is discovered from the adapter's stdout. */
        connectPort: z.number().min(1),
        /** Regex (string) matching the adapter's port announcement on stdout, one capture group for the port. Used when transport is 'tcp' without connectPort. */
        portPattern: z.string(),
        /** Which child stream carries the port announcement: 'stdout', 'stderr', or 'both' (default 'both'). */
        announceStream: z.union([z.const('stdout'), z.const('stderr'), z.const('both')]).default('both'),
        /** Standard DAP exception filter → adapter-specific filter name (e.g. debugpy: { all: 'raised' }). */
        exceptionFilterMap: z.dict(z.string()),
      }),
    )
    .default({})
    .description(
      "Extra stdio or TCP DAP adapters or overrides for the built-in debugpy/dlv/netcoredbg recipes, keyed by adapter id. TCP entries: the adapter command is spawned as a child and communicated with over TCP. With connectPort set, the command is spawned and the connection retries until the child listens on that port; without it, the port is discovered from stdout (e.g. codelldb's 'Listening on port <N>').",
    ),
})

export function apply(ctx: Context, config: Config): void {
  const limits: SessionLimits = {
    requestTimeoutMs: config.requestTimeoutMs,
    stepTimeoutMs: config.stepTimeoutMs,
    maxOutputChars: config.maxOutputChars,
    maxStackFrames: config.maxStackFrames,
    maxVariables: config.maxVariables,
    maxResultChars: config.maxResultChars,
  }
  const manager = new DebugSessionManager({
    spawn: spec => spawnAdapter(spec, { requestTimeoutMs: config.requestTimeoutMs }),
    resolveAdapter: options => resolveAdapter(options, config.adapters),
    limits,
    sessionIdleTimeoutMs: config.sessionIdleTimeoutMs,
    maxSessionsPerOwner: config.maxSessionsPerOwner,
    ledger: DebugLedger.create({ path: config.ledgerPath, maxFileBytes: config.ledgerMaxBytes }),
  })
  ctx.effect(() => {
    const unregister = ctx.tools.register(createDebugTool(manager, limits))
    return () => {
      unregister()
      void manager.disposeAll()
    }
  })
}

export { AdapterUnavailableError }
