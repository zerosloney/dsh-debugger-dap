/**
 * In-memory fake DAP adapter for tests: speaks the real wire framing over
 * PassThrough streams so session/connection logic is exercised end to end
 * without spawning a process.
 */

import { PassThrough } from 'node:stream'
import { DapConnection } from '../lib/connection.js'
import { encodeMessage, MessageDecoder } from '../lib/framing.js'

/** Build the standard happy-path script every test can extend or override. */
export function standardScript(overrides = {}) {
  return {
    initialize: (server, request) =>
      server.respond(request.seq, 'initialize', {
        capabilities: { supportsConfigurationDoneRequest: true },
      }),
    launch: (server, request) => {
      server.respond(request.seq, 'launch')
      server.emit('initialized')
      if (request.arguments?.stopOnEntry !== false) {
        server.emit('stopped', { reason: 'entry', threadId: 1 })
      }
    },
    configurationDone: (server, request) => server.respond(request.seq, 'configurationDone'),
    threads: (server, request) =>
      server.respond(request.seq, 'threads', { threads: [{ id: 1, name: 'main' }] }),
    stackTrace: (server, request) =>
      server.respond(request.seq, 'stackTrace', {
        stackFrames: [
          { id: 10, name: 'doWork', source: { path: '/w/src/app.py' }, line: 42, column: 3 },
          { id: 11, name: 'main', source: { path: '/w/src/app.py' }, line: 7, column: 1 },
        ],
      }),
    scopes: (server, request) =>
      server.respond(request.seq, 'scopes', {
        scopes: [{ name: 'Locals', variablesReference: 100, expensive: false }],
      }),
    variables: (server, request) =>
      server.respond(request.seq, 'variables', {
        variables: [
          { name: 'count', value: '3', type: 'int', variablesReference: 0 },
          { name: 'items', value: 'list[2]', type: 'list', variablesReference: 101 },
        ],
      }),
    evaluate: (server, request) =>
      server.respond(request.seq, 'evaluate', { result: '6', type: 'int', variablesReference: 0 }),
    setBreakpoints: (server, request) =>
      server.respond(request.seq, 'setBreakpoints', {
        breakpoints: (request.arguments?.breakpoints ?? []).map(breakpoint => ({
          verified: true,
          line: breakpoint.line,
        })),
      }),
    continue: (server, request) => server.respond(request.seq, 'continue', { allThreadsContinued: false }),
    next: (server, request) => server.respond(request.seq, 'next'),
    stepIn: (server, request) => server.respond(request.seq, 'stepIn'),
    stepOut: (server, request) => server.respond(request.seq, 'stepOut'),
    pause: (server, request) => server.respond(request.seq, 'pause'),
    disconnect: (server, request) => server.respond(request.seq, 'disconnect'),
    ...overrides,
  }
}

/**
 * Create one fake adapter the DebugSessionManager can spawn. Handlers map
 * DAP command → (server, request); `stderrTail` is surfaced verbatim on
 * disconnect-during-launch failures.
 */
export function createFakeAdapter(handlers = {}) {
  const clientToServer = new PassThrough()
  const serverToClient = new PassThrough()
  const received = []
  let serverSeq = 1
  let transportClosed = false

  const server = {
    received,
    respond(requestSeq, command, body = {}, success = true) {
      serverToClient.write(
        encodeMessage({ seq: serverSeq++, type: 'response', request_seq: requestSeq, success, command, body }),
      )
    },
    fail(requestSeq, command, message) {
      serverToClient.write(
        encodeMessage({ seq: serverSeq++, type: 'response', request_seq: requestSeq, success: false, command, message }),
      )
    },
    emit(event, body) {
      serverToClient.write(encodeMessage({ seq: serverSeq++, type: 'event', event, body }))
    },
    die() {
      clientToServer.destroy()
      serverToClient.destroy()
    },
  }

  const decoder = new MessageDecoder()
  clientToServer.on('data', chunk => {
    for (const message of decoder.push(chunk)) {
      if (message.type !== 'request') continue
      received.push(message)
      handlers[message.command]?.(server, message, message.arguments ?? {})
    }
  })

  const closeListeners = new Set()
  const notifyClose = () => {
    for (const listener of [...closeListeners]) listener()
  }
  clientToServer.on('close', notifyClose)
  serverToClient.on('close', notifyClose)

  const transport = {
    write(chunk) {
      if (transportClosed) return
      clientToServer.write(chunk)
    },
    close() {
      if (transportClosed) return
      transportClosed = true
      clientToServer.end()
      serverToClient.destroy()
    },
    onData(listener) {
      serverToClient.on('data', listener)
      return () => serverToClient.off('data', listener)
    },
    onError() {
      return () => {}
    },
    onClose(listener) {
      closeListeners.add(listener)
      return () => closeListeners.delete(listener)
    },
  }

  let killCount = 0
  const spawned = {
    connection: new DapConnection(transport, { requestTimeoutMs: 5000 }),
    async kill() {
      killCount += 1
      transport.close()
      server.die()
    },
    stderrTail: () => handlers.__stderrTail ?? '',
  }
  return { spawned, server, get killCount() { return killCount } }
}

/** SessionLimits tuned for fast tests. */
export const testLimits = {
  requestTimeoutMs: 2000,
  stepTimeoutMs: 150,
  maxOutputChars: 2000,
  maxStackFrames: 20,
  maxVariables: 100,
  maxResultChars: 16000,
}
