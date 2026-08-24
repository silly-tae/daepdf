import zlib from 'node:zlib'

const crcT = (() => { const t = new Uint32Array(256)
  for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0 } return t })()
const crc32 = b => { let c = 0xffffffff; for (const x of b) c = crcT[(c ^ x) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0 }
const chunk = (type, data) => {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length)
  const td = Buffer.concat([Buffer.from(type, 'ascii'), Buffer.from(data)])
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td))
  return Buffer.concat([len, td, crc])
}
const SIG = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])
const ihdr = (w, h, bpc, ct, il = 0) => {
  const b = Buffer.alloc(13); b.writeUInt32BE(w, 0); b.writeUInt32BE(h, 4)
  b[8] = bpc; b[9] = ct; b[12] = il; return chunk('IHDR', b)
}
const rows = (w, h, ch, f) => {
  const rl = w * ch + 1, o = Buffer.alloc(h * rl)
  for (let r = 0; r < h; r++) for (let j = 0; j < w * ch; j++) o[r * rl + 1 + j] = f(r, j)
  return o
}

export default async function ({ test, eq, ok, load }) {
  const sniff = await load('src/images/sniff.ts')
  const { parseImage } = await load('src/images/parse.ts')

  const palettePng = Buffer.concat([SIG, ihdr(3, 1, 8, 3),
    chunk('PLTE', Buffer.from([255,0,0, 0,255,0, 0,0,255])),
    chunk('IDAT', zlib.deflateSync(rows(3, 1, 1, (_r, j) => j % 3))),
    chunk('IEND', Buffer.alloc(0))])

  test('the fast path really does decode a palette PNG', () => {
    const p = parseImage(new Uint8Array(palettePng))
    ok(p !== null, 'parseImage handles colour type 3')
    eq([...p.data].join(','), '255,0,0,0,255,0,0,0,255')
  })

  test('the gate agrees with what the fast path can decode', () => {
    const needsBrowser = sniff.pngNeedsBrowserDecode(new Uint8Array(palettePng))
    const fastPathHandles = parseImage(new Uint8Array(palettePng)) !== null
    ok(!(needsBrowser && fastPathHandles),
      'pngNeedsBrowserDecode sends colour type 3 to the browser even though parseImage decodes it')
  })

  test('sniffFormat identifies the common formats', () => {
    eq(sniff.sniffFormat(new Uint8Array([0xFF, 0xD8, 0, 0])), 'jpeg')
    eq(sniff.sniffFormat(new Uint8Array(palettePng)), 'png')
    eq(sniff.sniffFormat(new Uint8Array([0x47,0x49,0x46,0x38])), 'gif')
    eq(sniff.sniffFormat(new Uint8Array([0x42,0x4D])), 'bmp')
    eq(sniff.sniffFormat(new Uint8Array(Buffer.from('RIFF____WEBP', 'ascii'))), 'webp')
    eq(sniff.sniffFormat(new Uint8Array([1,2,3])), 'unknown')
  })

  test('sniffFormat does not mistake arbitrary data for avif', () => {
    // "ftyp" at 4 with a generic brand, and the word avif appearing in payload
    // beyond the ftyp box, must not be claimed as avif
    const b = Buffer.alloc(64)
    b.writeUInt32BE(16, 0)                       // ftyp box is 16 bytes
    b.write('ftyp', 4); b.write('mp42', 8); b.writeUInt32BE(0, 12)
    b.write('avif', 40)                          // outside the box
    eq(sniff.sniffFormat(new Uint8Array(b)), 'unknown')
  })

  test('a truncated PNG does not hang the chunk walker', () => {
    const t = palettePng.subarray(0, palettePng.length - 6)
    const started = Date.now()
    sniff.pngNeedsBrowserDecode(new Uint8Array(t))
    parseImage(new Uint8Array(t))
    ok(Date.now() - started < 1000, 'walker returned promptly')
  })
}
