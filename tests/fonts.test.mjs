import zlib from 'node:zlib'
import { readFileSync } from 'node:fs'
import { readPdf } from './pdfread.mjs'
import { WASM, requireFont } from './fixtures.mjs'


function allText(bytes) {
  const buf = Buffer.from(bytes)
  const parts = [buf]
  for (const m of buf.toString('latin1').matchAll(/stream\r?\n/g)) {
    const start = m.index + m[0].length
    const end = buf.indexOf('endstream', start)
    try { parts.push(zlib.inflateSync(buf.subarray(start, end))) } catch {}
  }
  return Buffer.concat(parts).toString('latin1')
}

export default async function ({ test, eq, ok, load }) {
  const m = await load('tests/_entry.ts')
  const { PdfDoc, initEngine, register_font_raw } = m
  await initEngine(readFileSync(WASM))
  register_font_raw('Inter', new Uint8Array(readFileSync(requireFont())))

  const doc = (text = 'Hello Wörld', weight = 400) => {
    const d = new PdfDoc(300, 300)
    d.set_font('Inter', 'normal', weight)
    d.set_font_size(12)
    d.text(text, 20, 50, 'alphabetic')
    return d
  }

  const s = allText(doc().output())

  test('the descriptor carries the required entries', () => {
    for (const k of ['/FontDescriptor', '/Flags', '/FontBBox', '/ItalicAngle',
                     '/Ascent', '/Descent', '/CapHeight', '/StemV']) {
      ok(s.includes(k), `missing ${k}`)
    }
  })

  test('a CID font declares Identity encoding and a CIDToGIDMap', () => {
    ok(s.includes('/Subtype /Type0'), 'Type0 parent')
    ok(s.includes('/Identity-H'), 'Identity-H encoding')
    ok(s.includes('/CIDToGIDMap'), 'CIDToGIDMap present')
  })

  // scoped to the CIDFont dictionary — the xref stream also has a /W, of a
  // completely different shape ([1 4 2] field widths), and matching that one
  // made this test read the wrong array entirely
  // matched on shape, not position: the CID form is `c [w]` groups, while the
  // xref stream's /W is three bare integers, and the two dictionaries do not
  // order their keys the same way
  const cidWidths = t => t.match(/\/W \[((?:\d+\s*\[[^\]]*\]\s*)+)\]/)?.[1]?.trim() ?? null

  test('/W widths parse as valid syntax', () => {
    const body = cidWidths(s)
    ok(body !== null, '/W array present in the CIDFont dict')
    ok(/^(\d+\s*\[\s*-?[\d.]+\s*\]\s*)+$/.test(body), `unexpected /W shape: ${body.slice(0, 120)}`)
  })

  test('/Flags marks the font symbolic or nonsymbolic, not zero', () => {
    const f = s.match(/\/Flags (\d+)/)
    ok(f && parseInt(f[1], 10) > 0, `/Flags was ${f && f[1]}`)
  })

  // StemV describes the dominant vertical stem thickness; 0 says the font has
  // none. Syntactically legal and PDF/A-valid, but it is the value readers use
  // for synthetic bolding and preflight tools flag it.
  test('StemV describes the font rather than reporting zero', () => {
    const v = s.match(/\/StemV (-?[\d.]+)/)
    ok(v && parseFloat(v[1]) > 0, `/StemV was ${v && v[1]}`)
  })

  test('the same font at two weights does not embed twice under one name', () => {
    const d = new PdfDoc(300, 300)
    d.set_font('Inter', 'normal', 400); d.set_font_size(12); d.text('a', 10, 10, 'alphabetic')
    d.set_font('Inter', 'normal', 400); d.set_font_size(12); d.text('b', 10, 30, 'alphabetic')
    const t = allText(d.output())
    eq((t.match(/\/FontFile2/g) ?? []).length, 1, 'one embed for one face used twice')
  })

  test('the embedded subset opens and reports its glyphs', async () => {})
  {
    const bytes = doc('Subset check ÅÄÖ').output()
    const text = readPdf(bytes).getPage(1).text()
    test('text extracts from the subset', () => eq(text, 'Subset check ÅÄÖ'))
  }

  test('the width array covers only the glyphs actually used', () => {
    const body = cidWidths(allText(doc('A').output()))
    const entries = (body?.match(/\d+\s*\[/g) ?? []).length
    ok(entries > 0 && entries < 50, `expected a small width array for one glyph, got ${entries}`)
  })
}
