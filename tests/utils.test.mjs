export default async function ({ test, eq, ok, load }) {
  const { hpf, toPdfName, pdfEscape, encodeColor } = await load('src/pdf_doc/utils.ts')
  const { toUnicodeCmap } = await load('src/pdf_doc/cmap.ts')

  test('hpf trims trailing zeros correctly', () => {
    eq(hpf(0), '0'); eq(hpf(1), '1'); eq(hpf(100), '100')
    eq(hpf(1.5), '1.5'); eq(hpf(1.05), '1.05'); eq(hpf(-2.25), '-2.25')
    eq(hpf(0.0004), '0')
  })

  test('hpf emits a valid PDF number for non-finite input', () => {
    const isPdfNumber = s => /^-?\d*\.?\d+$/.test(s)
    for (const v of [NaN, Infinity, -Infinity]) {
      ok(isPdfNumber(hpf(v)), `hpf(${v}) produced ${JSON.stringify(hpf(v))}, which is not a PDF number`)
    }
  })

  test('hpf emits a valid PDF number for very large input', () => {
    const isPdfNumber = s => /^-?\d*\.?\d+$/.test(s)
    const v = 1e21
    ok(isPdfNumber(hpf(v)), `hpf(1e21) produced ${JSON.stringify(hpf(v))}`)
  })

  test('encodeColor stays in range', () => {
    eq(encodeColor(255, 255, 255, false), '1 g')
    eq(encodeColor(0, 0, 0, true), '0 G')
    eq(encodeColor(255, 0, 0, false), '1 0 0 rg')
  })

  test('toPdfName escapes every character PDF forbids in a name', () => {
    eq(toPdfName('Inter Variable'), 'Inter#20Variable')
    eq(toPdfName('a#b'), 'a#23b')
    eq(toPdfName('a/b'), 'a#2Fb')
    // whitespace PDF treats as a name terminator, same class as space
    for (const [ch, code] of [['\t', '09'], ['\f', '0C'], ['\0', '00']]) {
      const got = toPdfName('a' + ch + 'b')
      eq(got, `a#${code}b`, `${JSON.stringify(ch)} must be escaped in a PDF name`)
    }
  })

  test('pdfEscape covers the literal-string metacharacters', () => {
    eq(pdfEscape('a(b)c'), 'a\\(b\\)c')
    eq(pdfEscape('a\\b'), 'a\\\\b')
    // a bare CR inside a literal string is read back as LF, corrupting the value
    ok(!pdfEscape('a\rb').includes('\r'), 'a raw CR survives into the literal string')
  })

  test('toUnicodeCmap maps a simple run', () => {
    const m = new Map([[1, [0x41]], [2, [0x42]], [3, [0x43]]])
    const s = toUnicodeCmap(m)
    ok(s.includes('beginbfrange'), 'consecutive gids should compress to a bfrange')
    ok(s.includes('<0001><0003><0041>'), `range not as expected:\n${s}`)
  })

  test('toUnicodeCmap emits ligatures as bfchar', () => {
    const s = toUnicodeCmap(new Map([[7, [0x66, 0x69]]]))
    ok(s.includes('beginbfchar') && s.includes('<0007><00660069>'), s)
  })

  test('toUnicodeCmap surrogate-pairs astral codepoints', () => {
    const s = toUnicodeCmap(new Map([[9, [0x1D400]]]))
    ok(s.includes('<d835dc00>'), `expected a surrogate pair, got:\n${s}`)
  })

  // CMap spec: in a bfrange with a single destination string, the LAST BYTE of
  // that string is what increments, so a range may not span more than 256 codes.
  test('toUnicodeCmap never emits a bfrange spanning more than 256 codes', () => {
    const m = new Map()
    for (let i = 0; i < 400; i++) m.set(1 + i, [0x4E00 + i])
    const s = toUnicodeCmap(m)
    const bad = []
    for (const [, lo, hi] of s.matchAll(/<([0-9a-f]{4})><([0-9a-f]{4})><[0-9a-f]+>/g)) {
      const span = parseInt(hi, 16) - parseInt(lo, 16) + 1
      if (span > 256) bad.push(`<${lo}>..<${hi}> spans ${span}`)
    }
    ok(bad.length === 0, `bfrange too wide: ${bad.join(', ')}`)
  })
}
