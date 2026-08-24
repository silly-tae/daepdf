// CSS transforms: 2D affine only (rotate/scale/skew/translate/matrix). Any
// matrix3d(...)/perspective resolves to a 16-value 3D matrix computed style
// has no 2D equivalent for — those elements render untransformed rather than
// risk a wrong projection.

export type Affine = [number, number, number, number, number, number]

// getComputedStyle(el).transform always resolves to this form for a 2D
// transform (browsers only emit matrix3d for anything with 3D components)
export function parseCSSMatrix(transformStr: string): Affine | null {
  const m = transformStr.match(/^matrix\(([^)]+)\)$/)
  if (!m) return null
  const parts = (m[1] ?? '').split(',').map(v => parseFloat(v.trim()))
  if (parts.length !== 6 || parts.some(Number.isNaN)) return null
  return parts as Affine
}

// composes m2 ∘ m1 (m1 applied first, then m2) — standard affine composition
// under the convention x' = a*x + c*y + e, y' = b*x + d*y + f
export function composeAffine(m2: Affine, m1: Affine): Affine {
  const [a1, b1, c1, d1, e1, f1] = m1
  const [a2, b2, c2, d2, e2, f2] = m2
  return [
    a2 * a1 + c2 * b1,
    b2 * a1 + d2 * b1,
    a2 * c1 + c2 * d1,
    b2 * c1 + d2 * d1,
    a2 * e1 + c2 * f1 + e2,
    b2 * e1 + d2 * f1 + f2,
  ]
}

// Adapts a CSS matrix(a,b,c,d,e,f) (Y-down screen convention) into the PDF
// `cm` matrix that produces the SAME visual transform once PDF's own Y-up
// convention is accounted for. Derivation: a PDF-native point is (x, H - y)
// for our normal "y measured from page top" content coordinate — conjugating
// the CSS matrix by that flip works out to negating just b, c, and f (not a,
// d, or e) — verified against rotate(90deg): CSS matrix(0,1,-1,0,0,0) sends
// local (1,0) to (0,1) (right → down-the-screen, correct CSS rotation
// direction); the flipped PDF matrix (0,-1,1,0,0,0) sends the same (1,0) to
// (0,-1) (right → down-the-PAGE, i.e. negative-y in PDF's up-positive space —
// the same physical direction, confirming the sign flip is right).
//
// The whole thing is further conjugated by the transform-origin point (in its
// PDF-native, page-relative position) since CSS transforms pivot around that
// point, not the page origin.
export function buildPdfTransformMatrix(
  css: Affine,
  originPageX: number, originPageY: number, pageH: number,
): Affine {
  const [a, b, c, d, e, f] = css
  const flipped: Affine = [a, -b, -c, d, e, -f]

  const pdfOriginX = originPageX
  const pdfOriginY = pageH - originPageY

  const toOrigin:   Affine = [1, 0, 0, 1, -pdfOriginX, -pdfOriginY]
  const fromOrigin: Affine = [1, 0, 0, 1,  pdfOriginX,  pdfOriginY]

  return composeAffine(fromOrigin, composeAffine(flipped, toOrigin))
}
