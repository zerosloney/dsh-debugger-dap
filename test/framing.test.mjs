import assert from 'node:assert/strict'
import { test } from 'node:test'
import { encodeMessage, FramingError, MessageDecoder } from '../lib/framing.js'

test('encodeMessage frames Content-Length headers', () => {
  const frame = encodeMessage({ seq: 1, type: 'request', command: 'initialize' })
  const text = frame.toString('utf8')
  const body = JSON.stringify({ seq: 1, type: 'request', command: 'initialize' })
  assert.ok(text.startsWith(`Content-Length: ${Buffer.byteLength(body)}\r\n\r\n`))
  assert.ok(text.endsWith(body))
})

test('decoder round-trips one message', () => {
  const decoder = new MessageDecoder()
  const messages = decoder.push(encodeMessage({ type: 'event', event: 'stopped', body: { reason: 'entry' } }))
  assert.equal(messages.length, 1)
  assert.equal(messages[0].event, 'stopped')
  assert.equal(messages[0].body.reason, 'entry')
})

test('decoder reassembles messages split across arbitrary chunk boundaries', () => {
  const decoder = new MessageDecoder()
  const wire = Buffer.concat([
    encodeMessage({ type: 'event', event: 'a' }),
    encodeMessage({ type: 'event', event: 'b' }),
    encodeMessage({ type: 'event', event: 'c' }),
  ])
  const collected = []
  // Feed one byte at a time to prove boundary handling.
  for (let index = 0; index < wire.length; index += 1) {
    collected.push(...decoder.push(Buffer.from([wire[index]])))
  }
  assert.deepEqual(
    collected.map(message => message.event),
    ['a', 'b', 'c'],
  )
})

test('decoder coalesces several messages in one chunk', () => {
  const decoder = new MessageDecoder()
  const messages = decoder.push(
    Buffer.concat([encodeMessage({ type: 'event', event: 'x' }), encodeMessage({ type: 'event', event: 'y' })]),
  )
  assert.equal(messages.length, 2)
})

test('decoder rejects a missing Content-Length header', () => {
  const decoder = new MessageDecoder()
  assert.throws(() => decoder.push(Buffer.from('X-Custom: 1\r\n\r\n{}')), FramingError)
})

test('decoder rejects an invalid Content-Length', () => {
  const decoder = new MessageDecoder()
  assert.throws(() => decoder.push(Buffer.from('Content-Length: nope\r\n\r\n{}')), FramingError)
})

test('decoder rejects bodies over the cap', () => {
  const decoder = new MessageDecoder({ maxBodyBytes: 16 })
  assert.throws(() => decoder.push(encodeMessage({ padding: 'x'.repeat(64) })), FramingError)
})

test('decoder rejects non-JSON bodies', () => {
  const decoder = new MessageDecoder()
  const body = Buffer.from('not json')
  const wire = Buffer.concat([Buffer.from(`Content-Length: ${body.length}\r\n\r\n`, 'ascii'), body])
  assert.throws(() => decoder.push(wire), FramingError)
})

test('decoder tolerates partial headers waiting for more bytes', () => {
  const decoder = new MessageDecoder()
  const wire = encodeMessage({ type: 'event', event: 'later' })
  const split = wire.indexOf('\r\n\r\n')
  assert.deepEqual(decoder.push(wire.subarray(0, split - 2)), [])
  const messages = decoder.push(wire.subarray(split - 2))
  assert.equal(messages.length, 1)
  assert.equal(messages[0].event, 'later')
})
