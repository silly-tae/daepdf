import { readPdf } from './pdfread.mjs'
import { WASM, requireFont } from './fixtures.mjs'

export default async function ({ test, ok, load }) {
  const { readFileSync } = await import('node:fs')
  const m = await load('tests/_entry.ts')
  const { PdfDoc, initEngine, register_font_raw } = m
  await initEngine(readFileSync(WASM))
  register_font_raw('Inter', new Uint8Array(readFileSync(requireFont())))

  // x, y, w, h, fieldType, name, fontName, fontStyle, weight, size, color,
  // value, checked, options
  const withField = (name, value) => {
    const d = new PdfDoc(300, 300)
    d.rect(0, 0, 10, 10, 'F')
    d.add_form_field(10, 10, 120, 20, 'Tx', name,
                     'Inter', 'normal', 400, 12, [0, 0, 0],
                     value, undefined, undefined)
    return d
  }

  test('a text field survives into the annotation list', async () => {})
  {
    const d = withField('fullName', 'Taeha')
    let anns = []
    try {
      anns = readPdf(d.output()).getPage(1).annotations()
    } catch (e) { anns = [{ error: e.message }] }
    test('one widget annotation', () => ok(anns.length >= 1, JSON.stringify(anns)))
    test('field name preserved', () =>
      ok(anns.some(a => a.fieldName === 'fullName'), JSON.stringify(anns.map(a => a.fieldName))))
  }

  test('a non-ASCII field value survives', async () => {})
  {
    const d = withField('namn', 'Åkesson')
    const anns = readPdf(d.output()).getPage(1).annotations()
    test('value decodes correctly', () =>
      ok(anns.some(a => a.fieldValue === 'Åkesson'), JSON.stringify(anns.map(a => a.fieldValue))))
  }

  test('a non-ASCII field NAME survives', async () => {})
  {
    const d = withField('förnamn', 'x')
    const anns = readPdf(d.output()).getPage(1).annotations()
    test('name decodes correctly', () =>
      ok(anns.some(a => a.fieldName === 'förnamn'), JSON.stringify(anns.map(a => a.fieldName))))
  }
}
