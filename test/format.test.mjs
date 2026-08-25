import assert from 'node:assert/strict'
import { test } from 'node:test'
import { renderDebugText } from '../lib/format.js'

const baseSnapshot = {
  id: 'dbg-1',
  adapter: 'debugpy',
  program: '/w/app.py',
  cwd: '/w',
  status: 'stopped',
  stopReason: 'breakpoint',
  threadId: 1,
  frame: { id: 10, name: 'doWork', path: '/w/src/app.py', line: 42, column: 3 },
  exitCode: undefined,
  configuring: false,
  outputChars: 12,
}

test('snapshot-first rendering anchors every result', () => {
  const text = renderDebugText({ action: 'launch', session_id: 'dbg-1', snapshot: baseSnapshot }, 16000)
  assert.ok(text.includes('Session dbg-1'))
  assert.ok(text.includes('Adapter: debugpy'))
  assert.ok(text.includes('Status: stopped'))
  assert.ok(text.includes('Location: /w/src/app.py:42:3'))
  assert.ok(text.includes('Captured output: 12 chars'))
})

test('resume timeout explains the pause escape hatch', () => {
  const value = {
    action: 'continue',
    snapshot: { ...baseSnapshot, status: 'running', stopReason: undefined, frame: undefined },
    state: 'running',
    timed_out: true,
  }
  const text = renderDebugText(value, 16000)
  assert.ok(text.includes('still running'))
  assert.ok(text.includes('pause'))
  // The hint reports the CONFIGURED step deadline, not a hardcoded constant.
  const customText = renderDebugText(value, 16000, 30_000)
  assert.ok(customText.includes('after 30000ms'), `hint must carry the configured deadline, got: ${customText.split('\n').at(-1)}`)
})

test('stack frames render as jumpable references', () => {
  const text = renderDebugText(
    { action: 'stack_trace', snapshot: baseSnapshot, frames: [{ id: 10, name: 'doWork', path: '/w/a.py', line: 1, column: 1 }], frames_omitted: 2 },
    16000,
  )
  assert.ok(text.includes('- #10 doWork @ /w/a.py:1:1'))
  assert.ok(text.includes('2 more frames omitted'))
})

test('variables carry references for nested expansion', () => {
  const text = renderDebugText(
    {
      action: 'variables',
      snapshot: baseSnapshot,
      variables: [{ name: 'items', value: 'list[2]', type: 'list', variablesReference: 101 }],
      variables_omitted: 0,
    },
    16000,
  )
  assert.ok(text.includes('- items = list[2] (list) [ref=101]'))
})

test('results are bounded by maxResultChars', () => {
  const frames = Array.from({ length: 500 }, (_, index) => ({
    id: index,
    name: `frame-${index}`,
    path: '/very/long/path/to/source/file.ts',
    line: index,
    column: 1,
  }))
  const text = renderDebugText({ action: 'stack_trace', frames }, 2000)
  assert.ok(text.length <= 2000)
  assert.ok(text.includes('truncated (limit 2000'))
})

test('restart, goto, and restart_frame render the snapshot plus a notice', () => {
  for (const [action, notice] of [
    ['restart', 'restarted with the original launch configuration'],
    ['goto', 'jumped to the requested target'],
    ['restart_frame', 'stack frame restarted'],
  ]) {
    const text = renderDebugText({ action, snapshot: baseSnapshot }, 16000)
    assert.ok(text.includes('Session dbg-1'), `${action} anchors the snapshot`)
    assert.ok(text.includes(notice), `${action} explains what happened`)
  }
})

test('source renders content with the mime type', () => {
  const text = renderDebugText(
    { action: 'source', snapshot: baseSnapshot, content: 'def doWork():\n    pass\n', mime_type: 'text/x-python' },
    16000,
  )
  assert.ok(text.includes('Source (text/x-python):'))
  assert.ok(text.includes('def doWork():\n    pass'))
})

test('loaded_sources and modules render lists', () => {
  const sourcesText = renderDebugText(
    { action: 'loaded_sources', snapshot: baseSnapshot, sources: [{ path: '/w/a.py' }, { name: 'lib.py' }] },
    16000,
  )
  assert.ok(sourcesText.includes('Loaded sources (2):'))
  assert.ok(sourcesText.includes('- /w/a.py'))
  assert.ok(sourcesText.includes('- lib.py'))

  const modulesText = renderDebugText(
    {
      action: 'modules',
      snapshot: baseSnapshot,
      modules: [{ id: '7', name: 'app', version: '1.0', loaded: true }, { id: '9', name: 'lib', loaded: false }],
    },
    16000,
  )
  assert.ok(modulesText.includes('Modules (2):'))
  assert.ok(modulesText.includes('- app v1.0'))
  assert.ok(modulesText.includes('- lib (unloaded)'))
})

test('set_data_breakpoints and goto_targets render resolved rows', () => {
  const dataText = renderDebugText(
    { action: 'set_data_breakpoints', snapshot: baseSnapshot, breakpoints: [{ id: '3', verified: true }] },
    16000,
  )
  assert.ok(dataText.includes('- data breakpoint 3: verified'))

  const targetsText = renderDebugText(
    { action: 'goto_targets', snapshot: baseSnapshot, targets: [{ id: 12, label: 'line 88', line: 88 }] },
    16000,
  )
  assert.ok(targetsText.includes('Goto targets (1):'))
  assert.ok(targetsText.includes('- #12 line 88 @ line 88'))
})

test('watch, thread-focus, and reverse-step actions render their outcome', () => {
  // Regression: these five actions used to fall through to the default
  // branch and render "Unknown debug action", hiding state from the model.
  const stepBack = renderDebugText(
    { action: 'step_back', snapshot: baseSnapshot, state: 'stopped', timed_out: false },
    16000,
  )
  assert.ok(stepBack.includes('Session dbg-1'), 'step_back anchors the snapshot')
  assert.ok(stepBack.includes('Stopped at'), 'step_back reports the new stop location')

  const selectThread = renderDebugText({ action: 'select_thread', snapshot: { ...baseSnapshot, threadId: 2 } }, 16000)
  assert.ok(selectThread.includes('Focus thread switched to 2.'))

  const addWatch = renderDebugText({ action: 'add_watch', snapshot: baseSnapshot, watch_id: 'w1' }, 16000)
  assert.ok(addWatch.includes('Watch w1 added.'))
  const removeWatch = renderDebugText({ action: 'remove_watch', snapshot: baseSnapshot, watch_id: 'w1' }, 16000)
  assert.ok(removeWatch.includes('Watch w1 removed.'))

  const listEmpty = renderDebugText(
    { action: 'list_watches', snapshot: { ...baseSnapshot, watches: undefined } },
    16000,
  )
  assert.ok(listEmpty.includes('No watch expressions.'))
  const listFilled = renderDebugText(
    { action: 'list_watches', snapshot: { ...baseSnapshot, watches: [{ id: 'w1', expression: 'x', value: '1' }] } },
    16000,
  )
  assert.ok(listFilled.includes('1 watch expression(s) shown above.'))
})

test('renders data_breakpoint_info, disassemble, read_memory, completions, and terminate', () => {
  const dataInfo = renderDebugText({
    action: 'data_breakpoint_info',
    snapshot: baseSnapshot,
    data_breakpoint_info: {
      data_id: 'ptr_1',
      description: 'Variable buffer',
      access_types: ['read', 'write'],
      can_persist: true,
    },
  }, 16000)
  assert.ok(dataInfo.includes('Data breakpoint info:'))
  assert.ok(dataInfo.includes('Variable buffer'))
  assert.ok(dataInfo.includes('dataId="ptr_1"'))

  const disasm = renderDebugText({
    action: 'disassemble',
    snapshot: baseSnapshot,
    instructions: [
      { address: '0x00401000', instruction: 'mov eax, 1', instruction_bytes: 'B8 01 00 00 00', symbol: 'main' },
    ],
  }, 16000)
  assert.ok(disasm.includes('Disassembly (1 instructions):'))
  assert.ok(disasm.includes('0x00401000'))
  assert.ok(disasm.includes('mov eax, 1'))

  const mem = renderDebugText({
    action: 'read_memory',
    snapshot: baseSnapshot,
    memory: { address: '0x1000', data: 'AQIDBA==' },
  }, 16000)
  assert.ok(mem.includes('Memory at 0x1000:'))
  assert.ok(mem.includes('AQIDBA=='))

  const comp = renderDebugText({
    action: 'completions',
    snapshot: baseSnapshot,
    completions: [{ label: 'myFunc', detail: '() -> void', type: 'function' }],
  }, 16000)
  assert.ok(comp.includes('Completions (1):'))
  assert.ok(comp.includes('myFunc [function] - () -> void'))

  const term = renderDebugText({ action: 'terminate', snapshot: { ...baseSnapshot, status: 'terminated' } }, 16000)
  assert.ok(term.includes('Debuggee terminated.'))
})
