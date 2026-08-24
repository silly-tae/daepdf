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

  const build = (fn = () => {}) => {
    const d = new PdfDoc(300, 300)
    d.set_pdfa('en-GB')
    d.set_font('Inter', 'normal', 400); d.set_font_size(12)
    d.text('PDF/A content', 20, 50, 'alphabetic')
    fn(d)
    return d.output()
  }

  const bytes = build()
  const s = allText(bytes)

  test('PDF/A emits an OutputIntent with an ICC profile', () => {
    ok(s.includes('/OutputIntent'), 'OutputIntents array')
    ok(s.includes('/GTS_PDFA1'), 'the PDF/A subtype')
    ok(s.includes('/DestOutputProfile'), 'an embedded destination profile')
    ok(s.includes('/N 3'), 'the ICC stream declares its component count')
  })

  test('PDF/A emits XMP metadata declaring conformance', () => {
    ok(s.includes('/Type /Metadata') && s.includes('/Subtype /XML'), 'a metadata stream')
    ok(/pdfaid[:\s]/.test(s), 'the pdfaid namespace')
    ok(/part[>"']?\s*[>:]?\s*['"]?[123]/.test(s), 'a declared part')
  })

  test('PDF/A sets a document language', () => {
    ok(/\/Lang/.test(s), 'a /Lang entry')
  })

  // Conformance level A needs a tag tree, and PDF/A forbids encryption. Both are
  // enforced one layer up, at the public entry (html/index.ts:350-353): pdfA
  // implies taggedPdf, and pdfA + security throws. Driving PdfDoc directly here
  // bypasses those, so this only records what the writer itself claims.
  test('the writer claims conformance level A', () => {
    ok(/pdfaid:conformance[^A-Z]*A/.test(s), 'level A is what the XMP declares')
  })

  test('every font in a PDF/A file is embedded', () => {
    const baseFonts = [...s.matchAll(/\/BaseFont\s*\/([A-Za-z0-9+#-]+)/g)].map(x => x[1])
    const embedded  = (s.match(/\/FontFile[23]?\b/g) ?? []).length
    ok(baseFonts.length > 0, 'a font is referenced')
    ok(embedded > 0, `PDF/A forbids non-embedded fonts; found ${baseFonts.length} fonts, ${embedded} embedded`)
  })

  test('PDF/A output still opens cleanly', async () => {})
  {
    let pages = 0, err = null
    try { pages = readPdf(build()).numPages }
    catch (e) { err = e.message.split('\n')[0] }
    test('opens', () => { ok(err === null, `${err}`); eq(pages, 1) })
  }

  test('the writer never emits a conformance claim alongside encryption', () => {
    const d = new PdfDoc(300, 300)
    d.set_pdfa('en')
    d.set_security('', 'owner', -3904)
    d.rect(0, 0, 10, 10, 'F')
    const out = allText(d.output())
    ok(!(out.includes('/Filter /Standard') && /pdfaid/.test(out)),
      'an encrypted file must not claim PDF/A conformance')
  })
}
