import assert from 'node:assert/strict'
import { test } from 'node:test'
import { spawnTcpAdapterWithDiscovery, spawnAdapter } from '../lib/connection.js'

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

test('spawnAdapter tcp-with-port connects directly to a listening server', async () => {
  // A bare TCP server (no DAP logic) is enough: the direct path only connects.
  const net = await import('node:net')
  const server = net.createServer()
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const port = server.address().port
  try {
    const spawned = await spawnAdapter(
      { command: 'unused', args: [], transport: 'tcp', host: '127.0.0.1', port },
      { requestTimeoutMs: 5000 },
    )
    await spawned.kill()
  } finally {
    server.close()
  }
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

