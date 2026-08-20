/**
 * Pure formatting of the debug tool's canonical value into model-facing
 * text. Mirrors the session-snapshot-first style so every response anchors
 * the model at the current debuggee location.
 */

import type { BreakpointRecord, DebugSnapshot, DapFrameView, OutputPage } from './session.js'

/** A function breakpoint as reported by the adapter (no source line). */
export interface FunctionBreakpointRecord {
  name: string
  verified: boolean
  line?: number
  message?: string
}

/** One scope row as rendered to the model. */
export interface ScopeView {
  name: string
  variablesReference: number
  expensive: boolean
}

/** One variable row as rendered to the model. */
export interface VariableView {
  name: string
  value: string
  type?: string
  variablesReference: number
}

/** One thread row as rendered to the model. */
export interface ThreadView {
  id: number
  name: string
}

/** The debug tool's canonical output value. */
export interface DebugToolValue {
  action: string
  session_id?: string
  snapshot?: DebugSnapshot
  state?: 'stopped' | 'running' | 'terminated'
  timed_out?: boolean
  file?: string
  breakpoints?: Array<{ id: string; verified: boolean; message?: string } | BreakpointRecord | FunctionBreakpointRecord>
  frames?: DapFrameView[]
  frames_omitted?: number
  threads?: ThreadView[]
  scopes?: ScopeView[]
  variables?: VariableView[]
  variables_omitted?: number
  evaluation?: { result: string; type?: string; variables_reference: number }
  set_result?: { result: string; type?: string; variables_reference: number }
  exception?: {
    exception_id: string
    description?: string
    break_mode?: string
    message?: string
    type_name?: string
    stack?: string
  }
  output?: { text: string; offset: number; total_chars: number; truncated: boolean }
  sessions?: DebugSnapshot[]
  content?: string
  mime_type?: string
  sources?: Array<{ path?: string; name?: string }>
  modules?: Array<{ id: string; name?: string; path?: string; version?: string; loaded?: boolean }>
  targets?: Array<{ id: number; label: string; line: number }>
}

function formatLocation(snapshot: DebugSnapshot | undefined): string | null {
  const frame = snapshot?.frame
  if (frame === undefined) return null
  const path = frame.path ?? '<unknown>'
  return `${path}:${frame.line}:${frame.column}`
}

export function formatSnapshotLines(snapshot: DebugSnapshot): string[] {
  const lines = [
    `Session ${snapshot.id}`,
    `Adapter: ${snapshot.adapter}`,
    `Status: ${snapshot.status}`,
  ]
  if (snapshot.program !== undefined && snapshot.program.length > 0) lines.push(`Program: ${snapshot.program}`)
  if (snapshot.cwd !== undefined && snapshot.cwd.length > 0) lines.push(`CWD: ${snapshot.cwd}`)
  if (snapshot.stopReason !== undefined) lines.push(`Stop reason: ${snapshot.stopReason}`)
  if (snapshot.frame !== undefined) lines.push(`Frame: ${snapshot.frame.name}`)
  const location = formatLocation(snapshot)
  if (location !== null) lines.push(`Location: ${location}`)
  if (snapshot.exitCode !== undefined) lines.push(`Exit code: ${snapshot.exitCode}`)
  if (snapshot.outputChars > 0) lines.push(`Captured output: ${snapshot.outputChars} chars (action "output" reads it)`)
  return lines
}

export function formatBreakpoints(
  file: string,
  breakpoints: Array<{ id: string; verified: boolean; message?: string } | BreakpointRecord | FunctionBreakpointRecord>,
): string[] {
  const lines = [`Breakpoints for ${file}:`]
  if (breakpoints.length === 0) {
    lines.push('(none)')
    return lines
  }
  for (const breakpoint of breakpoints) {
    if ('name' in breakpoint) {
      const bp = breakpoint as FunctionBreakpointRecord
      lines.push(`- ${bp.name}: ${bp.verified ? 'verified' : 'pending'}${bp.message && bp.message.length > 0 ? ` (${bp.message})` : ''}`)
      continue
    }
    if ('id' in breakpoint && !('line' in breakpoint)) {
      const bp = breakpoint as { id: string; verified: boolean; message?: string }
      lines.push(`- data breakpoint ${bp.id}: ${bp.verified ? 'verified' : 'pending'}${bp.message && bp.message.length > 0 ? ` (${bp.message})` : ''}`)
      continue
    }
    const record = breakpoint as BreakpointRecord
    const placement =
      record.actualLine !== undefined && record.actualLine !== record.line
        ? ` (moved to line ${record.actualLine})`
        : ''
    lines.push(
      `- line ${record.line}: ${record.verified ? 'verified' : 'pending'}${placement}${
        record.message !== undefined && record.message.length > 0 ? ` (${record.message})` : ''
      }`,
    )
  }
  return lines
}

export function formatFrames(frames: DapFrameView[], omitted: number): string[] {
  const lines = ['Stack trace:']
  if (frames.length === 0) {
    lines.push('(empty)')
    return lines
  }
  for (const frame of frames) {
    const path = frame.path ?? '<unknown>'
    lines.push(`- #${frame.id} ${frame.name} @ ${path}:${frame.line}:${frame.column}`)
  }
  if (omitted > 0) lines.push(`… ${omitted} more frame${omitted === 1 ? '' : 's'} omitted (pass a higher 'levels').`)
  return lines
}

export function formatThreads(threads: ThreadView[]): string[] {
  const lines = ['Threads:']
  if (threads.length === 0) {
    lines.push('(none)')
    return lines
  }
  for (const thread of threads) lines.push(`- ${thread.id}: ${thread.name}`)
  return lines
}

export function formatScopes(scopes: ScopeView[]): string[] {
  const lines = ['Scopes:']
  if (scopes.length === 0) {
    lines.push('(none)')
    return lines
  }
  for (const scope of scopes) {
    lines.push(`- ${scope.name}: ref=${scope.variablesReference}${scope.expensive ? ', expensive' : ''}`)
  }
  return lines
}

export function formatVariables(variables: VariableView[], omitted: number): string[] {
  const lines = ['Variables:']
  if (variables.length === 0) {
    lines.push('(none)')
    return lines
  }
  for (const variable of variables) {
    const suffix = variable.variablesReference > 0 ? ` [ref=${variable.variablesReference}]` : ''
    lines.push(`- ${variable.name} = ${variable.value}${variable.type !== undefined ? ` (${variable.type})` : ''}${suffix}`)
  }
  if (omitted > 0) lines.push(`… ${omitted} more variable${omitted === 1 ? '' : 's'} omitted.`)
  return lines
}

export function formatOutcome(value: DebugToolValue, timeoutMs: number): string[] {
  const lines = formatSnapshotLines(value.snapshot ?? unreachableSnapshot())
  if (value.timed_out === true) {
    lines.push(`Program is still running after ${timeoutMs}ms. Use action "pause" to interrupt and inspect state.`)
    return lines
  }
  if (value.state === 'stopped') {
    lines.push(`Stopped at ${formatLocation(value.snapshot) ?? 'unknown location'}.`)
    return lines
  }
  if (value.state === 'terminated') {
    lines.push(
      `Program terminated${value.snapshot?.exitCode !== undefined ? ` with exit code ${value.snapshot.exitCode}` : ''}.`,
    )
    return lines
  }
  lines.push('Program is running.')
  return lines
}

export function formatSessions(sessions: DebugSnapshot[]): string[] {
  if (sessions.length === 0) return ['No debug sessions.']
  return sessions.flatMap(session => formatSnapshotLines(session))
}

export function formatOutput(page: OutputPage): string[] {
  const lines = [`Output (${page.offset}..${page.offset + page.text.length} of ${page.totalChars} chars):`]
  lines.push(page.text.length > 0 ? page.text.replace(/\n$/, '') : '(no output captured)')
  if (page.truncated) lines.push('… output truncated; re-read with an offset or smaller window.')
  return lines
}

function unreachableSnapshot(): DebugSnapshot {
  return { id: '?', adapter: '?', program: '', status: 'terminated', configuring: false, outputChars: 0 }
}

/** Render the canonical value into one bounded text block. */
export function renderDebugText(value: DebugToolValue, maxResultChars: number): string {
  let sections: string[]
  switch (value.action) {
    case 'launch':
    case 'attach':
    case 'disconnect':
      sections = formatSnapshotLines(value.snapshot ?? unreachableSnapshot())
      if (value.action === 'disconnect') sections.push('Debug session disconnected.')
      break
    case 'sessions':
      sections = formatSessions(value.sessions ?? [])
      break
    case 'set_breakpoints':
      sections = formatBreakpoints(value.file ?? '?', value.breakpoints ?? [])
      break
    case 'set_function_breakpoints':
      sections = formatBreakpoints('functions', value.breakpoints ?? [])
      break
    case 'set_exception_breakpoints':
      sections = ['Exception breakpoints configured.']
      break
    case 'continue':
    case 'step_in':
    case 'step_over':
    case 'step_out':
    case 'pause':
      sections = formatOutcome(value, 10_000)
      break
    case 'stack_trace':
      sections = formatFrames(value.frames ?? [], value.frames_omitted ?? 0)
      break
    case 'threads':
      sections = formatThreads(value.threads ?? [])
      break
    case 'scopes':
      sections = formatScopes(value.scopes ?? [])
      break
    case 'variables':
      sections = formatVariables(value.variables ?? [], value.variables_omitted ?? 0)
      break
    case 'evaluate':
    case 'set_variable':
    case 'set_expression':
      sections = [`Result: ${value.set_result?.result ?? value.evaluation?.result ?? ''}`]
      if (value.set_result?.type !== undefined) sections.push(`Type: ${value.set_result.type}`)
      if ((value.set_result?.variables_reference ?? 0) > 0) {
        sections.push(`Variables ref: ${value.set_result?.variables_reference}`)
      }
      break
    case 'exception_info': {
      const info = value.exception
      sections = [`Exception: ${info?.exception_id ?? '<unknown>'}`]
      if (info?.description !== undefined) sections.push(`Description: ${info.description}`)
      if (info?.type_name !== undefined) sections.push(`Type: ${info.type_name}`)
      if (info?.message !== undefined) sections.push(`Message: ${info.message}`)
      if (info?.break_mode !== undefined) sections.push(`Break mode: ${info.break_mode}`)
      if (info?.stack !== undefined) sections.push(`Stack:\n${info.stack}`)
      break
    }
    case 'restart':
      sections = formatSnapshotLines(value.snapshot ?? unreachableSnapshot())
      sections.push('Debuggee restarted with the original launch configuration.')
      break
    case 'source': {
      sections = formatSnapshotLines(value.snapshot ?? unreachableSnapshot())
      const content = value.content ?? ''
      if (content.length === 0) {
        sections.push('Source: (no content returned by the adapter)')
      } else {
        sections.push(`Source${value.mime_type !== undefined ? ` (${value.mime_type})` : ''}:\n${content}`)
      }
      break
    }
    case 'loaded_sources': {
      const sources = value.sources ?? []
      sections = formatSnapshotLines(value.snapshot ?? unreachableSnapshot())
      sections.push(`Loaded sources (${sources.length}):`)
      if (sources.length === 0) sections.push('(none)')
      for (const source of sources) {
        sections.push(`- ${source.path ?? source.name ?? '<unknown>'}`)
      }
      break
    }
    case 'modules': {
      const modules = value.modules ?? []
      sections = formatSnapshotLines(value.snapshot ?? unreachableSnapshot())
      sections.push(`Modules (${modules.length}):`)
      if (modules.length === 0) sections.push('(none)')
      for (const module of modules) {
        const version = module.version !== undefined ? ` v${module.version}` : ''
        sections.push(`- ${module.name ?? module.path ?? module.id}${version}${module.loaded === false ? ' (unloaded)' : ''}`)
      }
      break
    }
    case 'set_data_breakpoints':
      sections = formatSnapshotLines(value.snapshot ?? unreachableSnapshot())
      sections.push(...formatBreakpoints('data', value.breakpoints ?? []))
      break
    case 'goto_targets': {
      const targets = value.targets ?? []
      sections = formatSnapshotLines(value.snapshot ?? unreachableSnapshot())
      sections.push(`Goto targets (${targets.length}):`)
      if (targets.length === 0) sections.push('(none)')
      for (const target of targets) {
        sections.push(`- #${target.id} ${target.label} @ line ${target.line}`)
      }
      break
    }
    case 'goto':
      sections = formatSnapshotLines(value.snapshot ?? unreachableSnapshot())
      sections.push('Execution jumped to the requested target.')
      break
    case 'restart_frame':
      sections = formatSnapshotLines(value.snapshot ?? unreachableSnapshot())
      sections.push('Current stack frame restarted (function re-entered).')
      break
    case 'output':
      sections = formatOutput({
        text: value.output?.text ?? '',
        offset: value.output?.offset ?? 0,
        totalChars: value.output?.total_chars ?? 0,
        truncated: value.output?.truncated ?? false,
      })
      break
    default:
      sections = [`Unknown debug action: ${value.action}`]
  }
  const text = sections.join('\n')
  if (text.length <= maxResultChars) return text
  const notice = `\n… truncated (limit ${maxResultChars} characters).`
  return `${text.slice(0, Math.max(0, maxResultChars - notice.length))}${notice}`
}
