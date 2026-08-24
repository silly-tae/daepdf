import { readPdf } from './pdfread.mjs'

export default async function ({ test, eq, ok, load }) {
  const { PdfDoc } = await load('tests/_entry.ts')

  const withBookmarks = list => {
    const d = new PdfDoc(200, 200)
    d.rect(0, 0, 10, 10, 'F')
    d.add_page(); d.rect(0, 0, 10, 10, 'F')
    for (const [title, page, level] of list) d.add_bookmark(title, page, 0, level)
    return d.output()
  }
  const outlineOf = bytes => readPdf(bytes).outline

  const shape = nodes => (nodes ?? []).map(n => n.title + (n.items?.length ? `(${shape(n.items).join(' ')})` : ''))

  test('a flat outline comes back flat', async () => {})
  {
    const o = await outlineOf(withBookmarks([['A', 1, 0], ['B', 2, 0]]))
    test('flat', () => eq(shape(o).join(' '), 'A B'))
  }

  test('nesting is preserved', async () => {})
  {
    const o = await outlineOf(withBookmarks([['A', 1, 0], ['A1', 1, 1], ['A2', 1, 1], ['B', 2, 0]]))
    test('one level of children', () => eq(shape(o).join(' '), 'A(A1 A2) B'))
  }

  test('a skipped level does not lose the entry', async () => {})
  {
    // level jumps 0 -> 2 with no level-1 parent in between
    const o = await outlineOf(withBookmarks([['A', 1, 0], ['deep', 1, 2], ['B', 1, 0]]))
    const flat = JSON.stringify(o)
    test('the skipped-level entry still appears', () =>
      ok(flat.includes('deep'), `entry vanished from the outline: ${flat}`))
  }

  test('a bookmark pointing past the last page is clamped', async () => {})
  {
    const o = await outlineOf(withBookmarks([['past end', 99, 0]]))
    test('still readable and present', () => ok((o ?? []).length === 1, JSON.stringify(o)))
  }

  test('a document with no bookmarks has no outline', async () => {})
  {
    const d = new PdfDoc(200, 200); d.rect(0, 0, 10, 10, 'F')
    const o = await outlineOf(d.output())
    test('no outline', () => ok(o === null || o.length === 0, JSON.stringify(o)))
  }

  test('link and goto annotations survive', async () => {})
  {
    const d = new PdfDoc(200, 200)
    d.rect(0, 0, 10, 10, 'F')
    d.add_page(); d.rect(0, 0, 10, 10, 'F')
    d.set_page(1)
    d.add_link_annotation(0, 0, 50, 20, 'https://example.com/')
    d.add_goto_annotation(0, 30, 50, 20, 2, 0)
    const anns = readPdf(d.output()).getPage(1).annotations()
    test('two annotations on page 1', () => eq(anns.length, 2, JSON.stringify(anns.map(a => a.subtype))))
    test('the link keeps its url', () => ok(anns.some(a => a.url === 'https://example.com/'),
      JSON.stringify(anns.map(a => a.url))))
  }
}
