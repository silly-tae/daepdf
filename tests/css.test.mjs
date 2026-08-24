export default async function ({ test, eq, ok, load }) {
  const c = await load('src/html/css.ts')

  test('parseColorAlpha handles the classic computed forms', () => {
    eq(JSON.stringify(c.parseColorAlpha('rgb(255, 0, 0)')), '[255,0,0,255]')
    eq(JSON.stringify(c.parseColorAlpha('rgba(1, 2, 3, 0.5)')), '[1,2,3,128]')
    eq(JSON.stringify(c.parseColorAlpha('red')), '[255,0,0,255]')
    ok(c.parseColorAlpha('transparent') === null)
    eq(JSON.stringify(c.parseColorAlpha('transparent', true)), '[0,0,0,0]')
  })

  // What Chrome's getComputedStyle actually returns for CSS Color 4 values: it
  // preserves the function rather than converting to rgb().
  test('parseColorAlpha handles CSS Color 4 computed values', () => {
    const modern = [
      'color(srgb 1 0 0)',
      'oklch(0.7 0.1 200)',
      'lab(50% 40 30)',
      'color(display-p3 1 0 0)',
      'rgb(255 0 0)',
      'rgb(255 0 0 / 50%)',
    ]
    const dropped = modern.filter(s => c.parseColorAlpha(s) === null)
    ok(dropped.length === 0, `silently dropped, so nothing is painted: ${dropped.join(', ')}`)
  })

  // Reference values: the OKLab/CIELab coordinates of sRGB primaries are fixed
  // published quantities, so these check the conversion maths against something
  // outside the implementation rather than against itself.
  test('CSS Color 4 converts to the right sRGB values', () => {
    const near = (got, want, tol, what) => {
      ok(got, `${what}: returned null`)
      for (let i = 0; i < 3; i++) {
        ok(Math.abs(got[i] - want[i]) <= tol,
          `${what}: channel ${i} was ${got[i]}, expected about ${want[i]} — full ${JSON.stringify(got)}`)
      }
    }
    near(c.parseColorAlpha('oklab(0.6279 0.2249 0.1258)'), [255, 0, 0], 3, 'OKLab sRGB red')
    near(c.parseColorAlpha('oklch(0.6279 0.2577 29.23)'),  [255, 0, 0], 3, 'OKLCh sRGB red')
    near(c.parseColorAlpha('oklab(1 0 0)'),                [255, 255, 255], 2, 'OKLab white')
    near(c.parseColorAlpha('oklab(0 0 0)'),                [0, 0, 0], 1, 'OKLab black')
    near(c.parseColorAlpha('lab(54.29 80.80 69.89)'),      [255, 0, 0], 4, 'CIELab D50 red')
    near(c.parseColorAlpha('lab(100 0 0)'),                [255, 255, 255], 2, 'CIELab white')
    near(c.parseColorAlpha('color(srgb 1 0 0)'),           [255, 0, 0], 1, 'color(srgb) red')
    near(c.parseColorAlpha('color(srgb 0.5 0.5 0.5)'),     [128, 128, 128], 2, 'color(srgb) mid grey')
    near(c.parseColorAlpha('color(display-p3 1 0 0)'),     [255, 0, 0], 2, 'P3 red clamps into sRGB')
    near(c.parseColorAlpha('rgb(255 0 0)'),                [255, 0, 0], 0, 'space-separated rgb')
  })

  test('CSS Color 4 alpha is honoured', () => {
    eq(c.parseColorAlpha('rgb(255 0 0 / 50%)')[3], 128)
    eq(c.parseColorAlpha('color(srgb 1 0 0 / 0.5)')[3], 128)
    ok(c.parseColorAlpha('oklch(0.6 0.2 30 / 0)') === null, 'fully transparent still drops by default')
    eq(c.parseColorAlpha('oklch(0.6 0.2 30 / 0)', true)[3], 0, 'unless the caller keeps zero alpha')
  })

  test('nonsense inside a colour function is still rejected', () => {
    ok(c.parseColorAlpha('oklch(nope bad here)') === null)
    ok(c.parseColorAlpha('color(some-space 1 0 0)') === null)
    ok(c.parseColorAlpha('notacolor(1 2 3)') === null)
  })

  test('splitByTopLevelComma respects nesting', () => {
    eq(JSON.stringify(c.splitByTopLevelComma('a, b')), '["a","b"]')
    eq(JSON.stringify(c.splitByTopLevelComma('rgb(1,2,3), blue')), '["rgb(1,2,3)","blue"]')
  })

  test('splitByTopLevelComma does not emit empty parts', () => {
    const got = c.splitByTopLevelComma('a,,b')
    ok(!got.includes(''), `empty part leaks through: ${JSON.stringify(got)}`)
  })

  test('splitPositionPair keeps calc() intact', () => {
    eq(JSON.stringify(c.splitPositionPair('calc(100% - 10px) 20px')), '["calc(100% - 10px)","20px"]')
    eq(JSON.stringify(c.splitPositionPair('red 20% 40%')), '["red","20%","40%"]')
  })

  test('pxToPt converts and rejects', () => {
    eq(c.pxToPt('96px').toFixed(2), '72.00')
    eq(c.pxToPt('auto'), 0)
  })

  test('isTransparentColor distinguishes unparseable from transparent', () => {
    ok(c.isTransparentColor('transparent'))
    ok(c.isTransparentColor('rgba(0, 0, 0, 0)'))
    ok(!c.isTransparentColor('rgb(0, 0, 0)'))
  })

  test('parseCSSBoxShadow reads a computed shadow', () => {
    const s = c.parseCSSBoxShadow('rgba(0, 0, 0, 0.5) 0px 2px 4px 1px')
    eq(s.length, 1)
    eq(s[0].color[3], 128)
    ok(s[0].blur > 0 && s[0].spread > 0, JSON.stringify(s[0]))
  })

  test('clampRadiusToBox turns a huge radius into a pill', () => {
    const r = c.clampRadiusToBox({ all: 9999 }, 100, 40)
    eq(r.topLeft.v, 20, 'v should clamp to half the height')
  })

  test('overlap clamping leaves a fitting radius alone', () => {
    const r = c.clampRadiusToBox({ all: 5 }, 100, 40)
    eq(r.all, 5)
  })

  // A repeating gradient with a small period needs many tiles; the loop stops at
  // 200 stops with no diagnostic.
  test('tileStops covers the whole 0..1 range for a fine repeating gradient', () => {
    const period = 0.004   // 0.4% — 250 tiles of 2 stops
    const stops = [{ color: [255,0,0,255], position: 0 }, { color: [0,0,255,255], position: period }]
    const out = c.tileStops(stops, true)
    const last = out[out.length - 1]
    ok(last.position >= 1,
      `tiling stopped at ${last.position.toFixed(3)} instead of reaching 1 — ${out.length} stops`)
  })
}
