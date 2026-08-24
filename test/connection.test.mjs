import assert from 'node:assert/strict'
import { test } from 'node:test'
import { spawnDapAdapter, spawnTcpAdapterWithDiscovery, spawnAdapter } from '../lib/connection.js'

/** Child script: listen on a random port, print it, and answer DAP requests. */
const echoAdapterScript = `
const net = require('node:net')
const server = net.createServer(socket => {
  let buf = Buffer.alloc(0)
  socket.on('data', chunk => {
    buf = Buffer.concat([buf, chunk])
    const headerEnd = buf.indexOf('\\r\\n\\r\\n')
    if (headerEnd === -1) return
    const match = /Content-Length: (\\d+)/.exec(buf.slice(0, headerEnd).toString())
    if (match === null) return
    const length = Number(match[1])
    const bodyStart = headerEnd + 4
    if (buf.length < bodyStart + length) return
    const message = JSON.parse(buf.slice(bodyStart, bodyStart + length).toString())
    const reply = { seq: 1, type: 'response', request_seq: message.seq, command: message.command, success: true }
    const body = Buffer.from(JSON.stringify(reply))
    socket.write(Buffer.concat([Buffer.from('Content-Length: ' + body.length + '\\r\\n\\r\\n'), body]))
  })
})
server.listen(0, '127.0.0.1', () => {
  console.log('Listening on port ' + server.address().port)
})
`

test('discovery connects to the port announced on stdout', async () => {
  const spawned = await spawnTcpAdapterWithDiscovery([process.execPath, '-e', echoAdapterScript], {
    discoveryTimeoutMs: 5000,
    requestTimeoutMs: 5000,
  })
  try {
    // Round-trip one request through the discovered TCP connection.
    const reply = await spawned.connection.send('initialize', { adapterID: 'test' })
    assert.deepEqual(reply, {})
  } finally {
    await spawned.kill()
  }
})

test('discovery rejects with stderr detail when the child exits early', async () => {
  const script = `console.error('boom: missing runtime'); process.exit(1)`
  await assert.rejects(
    spawnTcpAdapterWithDiscovery([process.execPath, '-e', script], { discoveryTimeoutMs: 5000 }),
    /exited \(code 1\).*boom: missing runtime/s,
  )
})

test('discovery retries connecting when the announcement precedes the bind', async () => {
  // Some adapters print "Listening on port N" just before their listener is
  // bound: the first connect hits ECONNREFUSED and discovery must retry
  // until the announced port accepts, not fail the launch outright.
  const net = await import('node:net')
  const hint = await new Promise(resolve => {
    const srv = net.createServer()
    srv.listen(0, '127.0.0.1', () => {
      const port = srv.address().port
      srv.close(() => resolve(port))
    })
  })
  const script = `
const net = require('node:net')
const port = Number(process.env.TEST_PORT)
// Announce FIRST, bind ~300ms later: the first connect must be retried.
console.log('Listening on port ' + port)
setTimeout(() => {
const server = net.createServer(socket => {
let buf = Buffer.alloc(0)
socket.on('data', chunk => {
buf = Buffer.concat([buf, chunk])
const headerEnd = buf.indexOf('\\r\\n\\r\\n')
if (headerEnd === -1) return
const match = /Content-Length: (\\d+)/.exec(buf.slice(0, headerEnd).toString())
if (match === null) return
const length = Number(match[1])
const bodyStart = headerEnd + 4
if (buf.length < bodyStart + length) return
const message = JSON.parse(buf.slice(bodyStart, bodyStart + length).toString())
const reply = { seq: 1, type: 'response', request_seq: message.seq, command: message.command, success: true }
const body = Buffer.from(JSON.stringify(reply))
socket.write(Buffer.concat([Buffer.from('Content-Length: ' + body.length + '\\r\\n\\r\\n'), body]))
})
})
server.listen(port, '127.0.0.1', () => {})
}, 300)
`
  const spawned = await spawnTcpAdapterWithDiscovery([process.execPath, '-e', script], {
    discoveryTimeoutMs: 5000,
    requestTimeoutMs: 5000,
    env: { TEST_PORT: String(hint) },
  })
  try {
    const reply = await spawned.connection.send('initialize', { adapterID: 'test' })
    assert.deepEqual(reply, {})
  } finally {
    await spawned.kill()
  }
})

test('discovery honors a custom port announcement pattern', async () => {
  // A child announcing its port in a non-codelldb format must be discovered
  // when the caller supplies a matching portPattern.
  const script = `
const net = require('node:net')
const server = net.createServer(socket => {
  let buf = Buffer.alloc(0)
  socket.on('data', chunk => {
    buf = Buffer.concat([buf, chunk])
    const headerEnd = buf.indexOf('\\r\\n\\r\\n')
    if (headerEnd === -1) return
    const match = /Content-Length: (\\d+)/.exec(buf.slice(0, headerEnd).toString())
    if (match === null) return
    const length = Number(match[1])
    const bodyStart = headerEnd + 4
    if (buf.length < bodyStart + length) return
    const message = JSON.parse(buf.slice(bodyStart, bodyStart + length).toString())
    const reply = { seq: 1, type: 'response', request_seq: message.seq, command: message.command, success: true }
    const body = Buffer.from(JSON.stringify(reply))
    socket.write(Buffer.concat([Buffer.from('Content-Length: ' + body.length + '\\r\\n\\r\\n'), body]))
  })
})
server.listen(0, '127.0.0.1', () => {
  console.log('DAP_PORT=' + server.address().port)
})
`
  const spawned = await spawnTcpAdapterWithDiscovery([process.execPath, '-e', script], {
    discoveryTimeoutMs: 5000,
    requestTimeoutMs: 5000,
    portPattern: /DAP_PORT=(\d+)/,
  })
  try {
    const reply = await spawned.connection.send('initialize', { adapterID: 'test' })
    assert.deepEqual(reply, {})
  } finally {
    await spawned.kill()
  }
})

test('discovery reads the port announcement from stderr by default', async () => {
  // Some adapters announce on stderr (e.g. `node --inspect` prints
  // "Debugger listening on ws://..."); discovery must scan both streams.
  const script = `
const net = require('node:net')
const server = net.createServer(socket => {
  let buf = Buffer.alloc(0)
  socket.on('data', chunk => {
    buf = Buffer.concat([buf, chunk])
    const headerEnd = buf.indexOf('\\r\\n\\r\\n')
    if (headerEnd === -1) return
    const match = /Content-Length: (\\d+)/.exec(buf.slice(0, headerEnd).toString())
    if (match === null) return
    const length = Number(match[1])
    const bodyStart = headerEnd + 4
    if (buf.length < bodyStart + length) return
    const message = JSON.parse(buf.slice(bodyStart, bodyStart + length).toString())
    const reply = { seq: 1, type: 'response', request_seq: message.seq, command: message.command, success: true }
    const body = Buffer.from(JSON.stringify(reply))
    socket.write(Buffer.concat([Buffer.from('Content-Length: ' + body.length + '\\r\\n\\r\\n'), body]))
  })
})
server.listen(0, '127.0.0.1', () => {
  console.error('Debugger listening on ws://127.0.0.1:' + server.address().port + '/abcdef')
})
`
  const spawned = await spawnTcpAdapterWithDiscovery([process.execPath, '-e', script], {
    discoveryTimeoutMs: 5000,
    requestTimeoutMs: 5000,
    portPattern: /ws:\/\/[^:]+:(\d+)/,
  })
  try {
    const reply = await spawned.connection.send('initialize', { adapterID: 'test' })
    assert.deepEqual(reply, {})
  } finally {
    await spawned.kill()
  }
})

test('spawnAdapter routes tcp-without-port through discovery', async () => {
  const spawned = await spawnAdapter(
    { command: process.execPath, args: ['-e', echoAdapterScript], transport: 'tcp' },
    { requestTimeoutMs: 5000 },
  )
  try {
    const reply = await spawned.connection.send('initialize', { adapterID: 'test' })
    assert.deepEqual(reply, {})
  } finally {
    await spawned.kill()
  }
})

test('spawnAdapter tcp-with-port spawns the command and connects to its fixed port', async () => {
  // The configured command must actually be launched: an echo server that
  // binds the fixed port (passed via env) and answers DAP requests.
  const script = `
const net = require('node:net')
const port = Number(process.env.TEST_PORT)
const server = net.createServer(socket => {
  let buf = Buffer.alloc(0)
  socket.on('data', chunk => {
    buf = Buffer.concat([buf, chunk])
    const headerEnd = buf.indexOf('\\r\\n\\r\\n')
    if (headerEnd === -1) return
    const match = /Content-Length: (\\d+)/.exec(buf.slice(0, headerEnd).toString())
    if (match === null) return
    const length = Number(match[1])
    const bodyStart = headerEnd + 4
    if (buf.length < bodyStart + length) return
    const message = JSON.parse(buf.slice(bodyStart, bodyStart + length).toString())
    const reply = { seq: 1, type: 'response', request_seq: message.seq, command: message.command, success: true }
    const body = Buffer.from(JSON.stringify(reply))
    socket.write(Buffer.concat([Buffer.from('Content-Length: ' + body.length + '\\r\\n\\r\\n'), body]))
  })
})
server.on('error', err => { console.error('bind-failed: ' + err.code); process.exit(4) })
server.listen(port, '127.0.0.1', () => { console.log('READY') })
`
  // Find a port the child can bind: reuse a closed ephemeral port hint.
  const net = await import('node:net')
  const hint = await new Promise(resolve => {
    const srv = net.createServer()
    srv.listen(0, '127.0.0.1', () => {
      const port = srv.address().port
      srv.close(() => resolve(port))
    })
  })
  const spawned = await spawnAdapter(
    { command: process.execPath, args: ['-e', script], env: { TEST_PORT: String(hint) }, transport: 'tcp', host: '127.0.0.1', port: hint },
    { requestTimeoutMs: 5000 },
  )
  try {
    // Round-trip one request through the spawned child's TCP connection.
    const reply = await spawned.connection.send('initialize', { adapterID: 'test' })
    assert.deepEqual(reply, {})
  } finally {
    await spawned.kill()
  }
})

test('spawnAdapter tcp-with-port surfaces stderr when the command cannot bind', async () => {
  // The child exits immediately with an error before accepting connections.
  const script = `console.error('no-runtime-here'); process.exit(3)`
  await assert.rejects(
    spawnAdapter(
      { command: process.execPath, args: ['-e', script], transport: 'tcp', host: '127.0.0.1', port: 1 },
      { requestTimeoutMs: 5000 },
    ),
    /exited \(code 3\).*no-runtime-here/s,
  )
})

test('send rejects immediately when passed an already-aborted signal', async () => {
  const spawned = await spawnTcpAdapterWithDiscovery([process.execPath, '-e', echoAdapterScript], {
    discoveryTimeoutMs: 5000,
    requestTimeoutMs: 5000,
  })
  try {
    const controller = new AbortController()
    controller.abort()
    await assert.rejects(
      spawned.connection.send('initialize', undefined, { signal: controller.signal }),
      /DAP initialize aborted/,
    )
  } finally {
    await spawned.kill()
  }
})

test('kill cascades to the adapter process tree', async () => {
  // The adapter child spawns a grandchild that writes its pid to a file and
  // sleeps. Killing the adapter must take the grandchild down too (POSIX
  // process group / Windows taskkill /T). stdio transport is enough: kill
  // goes through the same spawnChildProcess handle.
  const os = await import('node:os')
  const fs = await import('node:fs')
  const path = await import('node:path')
  const marker = path.join(os.tmpdir(), `dsh-dap-grandchild-${process.pid}-${Date.now()}.pid`)
  const script = `
const { spawn } = require('node:child_process')
const marker = process.env.MARKER
const grandchild = spawn(process.execPath, ['-e', 'require("fs").writeFileSync(process.env.MARKER, String(process.pid)); setInterval(() => {}, 1000)'], { stdio: 'ignore', env: { ...process.env, MARKER: marker } })
grandchild.on('exit', () => process.exit(0))
process.on('SIGTERM', () => {})
setInterval(() => {}, 1000)
`
  const spawned = spawnDapAdapter([process.execPath, '-e', script], { env: { MARKER: marker } })
  try {
    // Wait for the grandchild pid file.
    let grandchildPid
    const deadline = Date.now() + 5000
    while (grandchildPid === undefined && Date.now() < deadline) {
      try {
        grandchildPid = Number(fs.readFileSync(marker, 'utf8'))
      } catch {
        await new Promise(resolve => setTimeout(resolve, 50))
      }
    }
    assert.ok(grandchildPid !== undefined, 'grandchild never wrote its pid')
    // The grandchild must still be alive right before teardown.
    assert.doesNotThrow(() => process.kill(grandchildPid, 0), 'grandchild should be alive before kill')

    await spawned.kill()

    // After the cascade, the grandchild must be gone.
    let alive = true
    const killDeadline = Date.now() + 5000
    while (alive && Date.now() < killDeadline) {
      try {
        process.kill(grandchildPid, 0)
        await new Promise(resolve => setTimeout(resolve, 50))
      } catch {
        alive = false
      }
    }
    assert.equal(alive, false, 'grandchild survived the cascade kill')
  } finally {
    try {
      fs.unlinkSync(marker)
    } catch {
      // already gone
    }
  }
})

