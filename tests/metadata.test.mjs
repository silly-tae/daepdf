// Drives the real writer and reads the result back through tests/pdfread.mjs,
// so this checks what a reader actually gets, not what we think we wrote.
import { readPdf } from './pdfread.mjs'

const CASES = [
  ['ASCII', 'Quarterly Report'],
  ['Swedish', 'Årsredovisning för Åkesson'],
  ['en dash', 'Taeha Beom – CV'],
  ['Japanese', '請求書'],
  ['emoji, astral', 'Invoice \u{1F9FE} 2026'],
  ['parens and backslash', 'a(b)c\\d'],
]

export default async function ({ test, eq, ok, load }) {
  const { PdfDoc } = await load('tests/_entry.ts')

  const withTitle = title => {
    const d = new PdfDoc(200, 200)
    d.set_metadata('Title', title)
    d.set_metadata('Author', title)
    d.rect(0, 0, 10, 10, 'F')
    return d.output()
  }
  const infoOf = bytes => readPdf(bytes).info

  for (const [label, title] of CASES) {
    const info = await infoOf(withTitle(title))
    test(`metadata survives: ${label}`, () => {
      eq(info.Title, title, 'Title')
      eq(info.Author, title, 'Author')
    })
  }

  test('a CR in metadata is preserved rather than folded to LF', async () => {})
  {
    const info = await infoOf(withTitle('line1\rline2'))
    test('CR preserved', () => eq(info.Title, 'line1\rline2'))
  }

  test('encrypted metadata decrypts to the same text', async () => {})
  {
    const d = new PdfDoc(200, 200)
    d.set_security('', 'owner', -3904)
    d.set_metadata('Title', 'Årsredovisning – 請求書')
    d.rect(0, 0, 10, 10, 'F')
    const info = readPdf(d.output(), { password: '' }).info
    test('encrypted non-ASCII title', () => eq(info.Title, 'Årsredovisning – 請求書'))
  }

  test('a non-ASCII link URI stays ASCII in the file', () => {
    const d = new PdfDoc(200, 200)
    d.add_link_annotation(0, 0, 50, 20, 'https://example.com/sökväg?q=ä')
    const s = Buffer.from(d.output()).toString('latin1')
    const m = s.match(/\/URI \(([^)]*)\)/)
    ok(m, `no /URI literal found`)
    ok(/^[\x20-\x7E]*$/.test(m[1]), `URI is not ASCII: ${JSON.stringify(m[1])}`)
    ok(m[1].includes('%C3%B6'), `expected percent-encoded UTF-8, got ${JSON.stringify(m[1])}`)
  })

  test('bookmark titles survive too', async () => {})
  {
    const d = new PdfDoc(200, 200)
    d.rect(0, 0, 10, 10, 'F')
    d.add_bookmark('Översikt', 1, 0, 0)
    const outline = readPdf(d.output()).outline
    test('outline title decodes', () => eq(outline?.[0]?.title, 'Översikt'))
  }
}
