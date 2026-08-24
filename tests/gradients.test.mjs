export default async function ({ test, ok, load }) {
  const { PdfDoc } = await load('tests/_entry.ts')

  // stops are flat quintuples: position, r, g, b, a  (colour channels 0-255)
  const grad = (type, stops, extra = {}) => {
    const d = new PdfDoc(300, 300)
    const id = d.add_gradient(type, extra.angle ?? 0, Float64Array.from(stops),
                              extra.cx ?? 0.5, extra.cy ?? 0.5, extra.fx ?? 0.5, extra.fy ?? 0.5)
    d.fill_with_gradient(id, 20, 20, 200, 100)
    return Buffer.from(d.output()).toString('latin1')
  }

  const boundsIn = s => [...s.matchAll(/\/Bounds \[([^\]]*)\]/g)]
    .map(m => m[1].trim().split(/\s+/).filter(Boolean).map(Number))

  test('a simple two-stop gradient emits a shading', () => {
    const s = grad(0, [0, 255, 0, 0, 255, 1, 0, 0, 255, 255])
    ok(s.includes('/ShadingType'), 'a shading dictionary is emitted')
    ok(s.includes('/PatternType'), 'a pattern is emitted')
  })

  test('/Bounds is strictly increasing for ordinary stops', () => {
    const s = grad(0, [0, 255,0,0,255,  0.5, 0,255,0,255,  1, 0,0,255,255])
    for (const b of boundsIn(s)) {
      for (let i = 1; i < b.length; i++) {
        ok(b[i] > b[i - 1], `/Bounds not increasing: ${JSON.stringify(b)}`)
      }
    }
  })

  // "red 40%, blue 40%" — a hard colour stop, which repeats a position
  test('/Bounds stays strictly increasing across a hard stop', () => {
    const s = grad(0, [0, 255,0,0,255,  0.4, 255,0,0,255,  0.4, 0,0,255,255,  1, 0,0,255,255])
    const all = boundsIn(s)
    ok(all.length > 0, 'a stitching function was emitted')
    for (const b of all) {
      for (let i = 1; i < b.length; i++) {
        ok(b[i] > b[i - 1], `/Bounds not increasing across a hard stop: ${JSON.stringify(b)}`)
      }
    }
  })

  test('/Bounds survives three stops at the same position', () => {
    const s = grad(0, [0, 255,0,0,255,  0.5, 0,255,0,255,  0.5, 0,0,255,255,  0.5, 255,255,0,255,  1, 0,0,0,255])
    for (const b of boundsIn(s)) {
      for (let i = 1; i < b.length; i++) {
        ok(b[i] > b[i - 1], `/Bounds not increasing: ${JSON.stringify(b)}`)
      }
    }
  })

  test('stops given out of order still yield increasing bounds', () => {
    const s = grad(0, [1, 0,0,255,255,  0, 255,0,0,255,  0.5, 0,255,0,255])
    for (const b of boundsIn(s)) {
      for (let i = 1; i < b.length; i++) {
        ok(b[i] > b[i - 1], `/Bounds not increasing for unsorted input: ${JSON.stringify(b)}`)
      }
    }
  })

  test('a translucent gradient registers a soft mask', () => {
    const s = grad(0, [0, 255,0,0,128,  1, 0,0,255,255])
    ok(s.includes('/SMask'), 'expected a luminosity soft mask for partial alpha')
  })

  test('a single-stop gradient does not emit a degenerate function', () => {
    const s = grad(0, [0.5, 255, 0, 0, 255])
    for (const b of boundsIn(s)) {
      for (let i = 1; i < b.length; i++) ok(b[i] > b[i - 1], JSON.stringify(b))
    }
    ok(s.startsWith('%PDF'), 'still a PDF')
  })

  // Round 2 raised the repeating-gradient stop cap to 2000, which is more
  // positions than three-decimal /Bounds could separate. This pins the
  // interaction so the cap and the bound precision cannot drift apart again.
  test('/Bounds stays increasing at the repeating-gradient stop cap', async () => {
    const css = await load('src/html/css.ts')
    for (const period of [0.004, 0.002, 0.001]) {
      const tiled = css.tileStops(
        [{ color: [255, 0, 0, 255], position: 0 }, { color: [0, 0, 255, 255], position: period }], true)
      const flat = []
      for (const st of tiled) flat.push(st.position, ...st.color)
      const s2 = grad(0, flat)
      for (const b of boundsIn(s2)) {
        for (let i = 1; i < b.length; i++) {
          ok(b[i] > b[i - 1],
            `period ${period}: ${tiled.length} stops gave a non-increasing bound at ${i} (${b[i-1]} then ${b[i]})`)
        }
      }
    }
  })

  test('a radial gradient emits ShadingType 3', () => {
    const s = grad(1, [0, 255,0,0,255, 1, 0,0,255,255], { cx: 0.5, cy: 0.5 })
    ok(/\/ShadingType 3/.test(s), 'radial should be a type 3 shading')
  })
}
