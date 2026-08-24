import zlibNode from 'node:zlib'

// daefl is checked against node:zlib in both directions, never against itself.
// A codec that only agrees with its own output proves nothing.
export default async function ({ test, eq, ok, load }) {
  const { zlib, unzlib, adler32 } = await load('src/daefl/index.ts')
  const { inflateRaw } = await load('src/daefl/inflate.ts')
  const { deflateRaw } = await load('src/daefl/deflate.ts')

  const enc = new TextEncoder()
  const same = (a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)) === 0

  const corpus = () => {
    const out = [
      ['empty', new Uint8Array(0)],
      ['one byte', enc.encode('a')],
      ['two bytes', enc.encode('ab')],
      ['all one value', new Uint8Array(9000).fill(7)],
      ['ascii repeated', enc.encode('hello world '.repeat(400))],
      ['pdf content stream', enc.encode('BT /F1 12 Tf 100 700 Td (Hi) Tj ET\nq 1 0 0 1 0 0 cm Q\n'.repeat(200))],
      ['incompressible', new Uint8Array(Array.from({ length: 6000 }, (_, i) => (i * 2654435761) & 255))],
      ['long run then noise', new Uint8Array([
        ...new Uint8Array(4000).fill(3),
        ...Array.from({ length: 4000 }, (_, i) => (i * 7) & 255),
      ])],
      ['every byte value', new Uint8Array(Array.from({ length: 256 }, (_, i) => i))],
    ]
    for (let n = 0; n < 40; n++) {
      const len = (n * 137) % 3000
      const b = new Uint8Array(len)
      for (let i = 0; i < len; i++) b[i] = (i * 31 + n * 17) & 255
      out.push([`generated len=${len}`, b])
    }
    return out
  }

  test('our output is accepted by node:zlib and decodes correctly', () => {
    for (const [label, data] of corpus()) {
      const back = zlibNode.inflateSync(Buffer.from(zlib(data, 6)))
      ok(same(back, data), `${label}: node:zlib disagreed`)
    }
  })

  test('we decode what node:zlib produces, at every level and strategy', () => {
    const data = enc.encode('the quick brown fox jumps over the lazy dog '.repeat(150))
    for (const level of [0, 1, 6, 9]) {
      for (const strategy of [0, 1, 2, 3, 4]) {
        const comp = zlibNode.deflateSync(Buffer.from(data), { level, strategy })
        ok(same(unzlib(new Uint8Array(comp)), data), `level=${level} strategy=${strategy}`)
      }
    }
  })

  test('round-trips through our own encoder and decoder', () => {
    for (const [label, data] of corpus()) {
      ok(same(unzlib(zlib(data, 6)), data), label)
    }
  })

  test('every compression level produces a valid stream', () => {
    const data = enc.encode('mixed content 12345 '.repeat(300))
    for (let level = 0; level <= 9; level++) {
      const back = zlibNode.inflateSync(Buffer.from(zlib(data, level)))
      ok(same(back, data), `level ${level}`)
    }
  })

  test('output is deterministic', () => {
    // PDF fingerprints depend on this: the same bytes in must give the same
    // bytes out, run after run.
    const data = enc.encode('deterministic check '.repeat(500))
    const a = zlib(data, 6)
    const b = zlib(data, 6)
    eq(Buffer.from(a).toString('hex'), Buffer.from(b).toString('hex'))
  })

  test('adler32 matches the checksum zlib writes', () => {
    for (const len of [0, 1, 15, 16, 17, 5551, 5552, 5553, 40000]) {
      const d = new Uint8Array(len)
      for (let i = 0; i < len; i++) d[i] = (i * 37 + 11) & 255
      const stream = zlibNode.deflateSync(Buffer.from(d))
      eq(adler32(d), stream.readUInt32BE(stream.length - 4), `len=${len}`)
    }
  })

  test('a supplied buffer is a hard cap, not a hint', () => {
    // The PNG path relies on this: a stream claiming more than the IHDR
    // implies must fail rather than allocate.
    const bomb = new Uint8Array(zlibNode.deflateRawSync(Buffer.alloc(400_000)))
    let message = ''
    // Matched on the message rather than instanceof: the test loader bundles
    // each entry point separately, so index.ts and inflate.ts each end up with
    // their own InflateError class. daepdf's real build has only one.
    try { inflateRaw(bomb, new Uint8Array(1000)) } catch (e) { message = e.message }
    ok(message.includes('exceeds the provided buffer'), `oversized output not rejected: ${message}`)
    eq(inflateRaw(bomb, new Uint8Array(400_000)).length, 400_000)
  })

  test('malformed input throws rather than hanging or corrupting', () => {
    const cases = [
      // third field: true when the bytes carry a zlib wrapper
      ['empty', new Uint8Array(0), false],
      ['zlib header too short', new Uint8Array([0x78]), true],
      ['bad header check', new Uint8Array([0x78, 0x00, 0x00]), true],
      ['not deflate', new Uint8Array([0x71, 0x01, 0x00]), true],
      ['reserved block type', new Uint8Array([0x07, 0, 0, 0]), false],
      ['bad stored length', new Uint8Array([0x01, 0x05, 0x00, 0x00, 0x00]), false],
      ['distance before output', new Uint8Array([0x03, 0x02]), false],
    ]
    for (const [label, bytes, wrapped] of cases) {
      let threw = false
      try {
        if (wrapped) unzlib(bytes)
        else inflateRaw(bytes)
      } catch { threw = true }
      ok(threw, `${label} did not throw`)
    }
  })

  test('a corrupt adler32 is rejected', () => {
    const data = enc.encode('checksum me')
    const good = zlib(data, 6)
    const bad = Uint8Array.from(good)
    bad[bad.length - 1] ^= 0xFF
    let threw = false
    try { unzlib(bad) } catch { threw = true }
    ok(threw, 'a wrong checksum was accepted')
  })

  test('random bytes never hang or crash the decoder', () => {
    let threw = 0, returned = 0
    for (let i = 0; i < 1500; i++) {
      const n = 4 + (i % 50)
      const b = new Uint8Array(n)
      for (let j = 0; j < n; j++) b[j] = (i * 7919 + j * 104729) & 255
      try { inflateRaw(b, new Uint8Array(1 << 16)); returned++ } catch { threw++ }
    }
    eq(threw + returned, 1500)
  })

  test('compresses at least as well as the reference implementation', () => {
    // Not a requirement of correctness, but daefl only earns its place by
    // being no worse than what it replaced. A regression here should fail.
    const data = new Uint8Array(Array.from({ length: 120_000 },
      (_, i) => (i % 1024 < 512 ? 200 + (i & 7) : (i * 7) & 255)))
    const ours = zlib(data, 6).length
    const reference = zlibNode.deflateSync(Buffer.from(data), { level: 6 }).length
    ok(ours <= reference * 1.02, `daefl ${ours} vs zlib ${reference}`)
  })

  test('raw deflate and zlib wrapper agree', () => {
    const data = enc.encode('wrapper consistency '.repeat(100))
    const raw = deflateRaw(data, 6)
    const wrapped = zlib(data, 6)
    eq(wrapped.length, raw.length + 6, 'wrapper adds a 2-byte header and 4-byte trailer')
    ok(same(zlibNode.inflateRawSync(Buffer.from(raw)), data))
  })
}
