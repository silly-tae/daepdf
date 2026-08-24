import { readFileSync } from 'node:fs'
import { readPdf } from './pdfread.mjs'
import { WASM, requireFont } from './fixtures.mjs'


export default async function ({ test, eq, ok, load }) {
  const m = await load('tests/_entry.ts')
  const { PdfDoc, initEngine, register_font_raw } = m
  await initEngine(readFileSync(WASM))
  register_font_raw('Inter', new Uint8Array(readFileSync(requireFont())))

  const draw = (s, fn = () => {}) => {
    const d = new PdfDoc(400, 200)
    d.set_font('Inter', 'normal', 400)
    d.set_font_size(12)
    fn(d)
    d.text(s, 20, 100, 'alphabetic')
    return d.output()
  }

  const readBack = bytes => readPdf(bytes).getPage(1).text()

  test('plain text round-trips through the reader', () => {})
  {
    const got = await readBack(draw('Hello world'))
    test('text extracts as written', () => eq(got, 'Hello world'))
  }

  test('non-ASCII text round-trips', async () => {})
  {
    const s = 'Årsredovisning för Åkesson'
    const got = await readBack(draw(s))
    test('Swedish text extracts correctly', () => eq(got, s))
  }

  test('astral text round-trips', async () => {})
  {
    const s = 'a\u{1D400}b'
    const got = await readBack(draw(s))
    test('astral codepoint survives ToUnicode', () => ok(got.includes('\u{1D400}'), `got ${JSON.stringify(got)}`))
  }

  test('empty and whitespace-only text do not emit broken operators', () => {
    const d = new PdfDoc(200, 200)
    d.set_font('Inter', 'normal', 400); d.set_font_size(12)
    d.text('', 10, 10, 'alphabetic')
    d.text('   ', 10, 30, 'alphabetic')
    const s = Buffer.from(d.output()).toString('latin1')
    ok(s.startsWith('%PDF'), 'still a PDF')
  })

  test('an unregistered font does not crash or emit a broken font ref', () => {
    const d = new PdfDoc(200, 200)
    d.set_font('NoSuchFontHere', 'normal', 400)
    d.set_font_size(12)
    d.text('abc', 10, 10, 'alphabetic')
    const out = Buffer.from(d.output()).toString('latin1')
    ok(out.startsWith('%PDF'), 'still a PDF')
    ok(!/\/F\w*\s+undefined/.test(out), 'no undefined font reference')
    ok(!out.includes('NaN'), 'no NaN in the output')
  })

  test('a huge font size does not produce exponential notation', () => {
    const d = new PdfDoc(200, 200)
    d.set_font('Inter', 'normal', 400)
    d.set_font_size(1e22)
    d.text('x', 10, 10, 'alphabetic')
    const s = Buffer.from(d.output()).toString('latin1')
    ok(!/\de[+-]\d/.test(s), 'exponential notation is not valid PDF syntax')
  })
}
