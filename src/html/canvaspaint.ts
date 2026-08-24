// Shared recursive Canvas2D painter — rasterizes a live element's own subtree
// (background/border/radius, text, images) at device-pixel-ratio scale. Used
// by both CSS filter (filters.ts) and mask-image (mask.ts), neither of which
// has a PDF operator equivalent and so can only be applied by rasterizing
// the element first.
//
// Deliberately NOT built on an SVG <foreignObject> + canvas.drawImage (the
// technique pdf/svg.ts uses for actual <svg> elements): confirmed by testing,
// not assumed, that drawing an SVG-sourced image containing a foreignObject
// permanently taints the destination canvas (toDataURL refuses to export) in
// current Chromium, regardless of the foreignObject's content. That
// technique only works for pure SVG with no embedded HTML — exactly what
// emitInlineSVG already limits itself to, which is why it never hit this wall.
//
// Known limitation (documented, not a bug): text lays out as one fillText per
// text node at the node's own font, vertically centered — no wrapping, no
// multi-line layout, and font resolution is the browser's own rather than
// this renderer's WASM-subset embedding. Background gradients are not
// reproduced (falls back to backgroundColor, transparent if unset). Good
// enough for the overwhelmingly common real-world use of both features: a
// decorative box, icon, or simple label.

const TRANSPARENT = new Set(['rgba(0, 0, 0, 0)', 'transparent'])

// reads only the TOP side/corner and applies it uniformly to the whole box —
// a deliberate simplification for the decorative, usually-uniform boxes this
// path targets; a border with different widths/colors/radii per side paints
// as if every side matched the top one
function paintBoxDecoration(c: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, cs: CSSStyleDeclaration, dpr: number): void {
  if (w <= 0 || h <= 0) return
  const radius = Math.min(parseFloat(cs.borderTopLeftRadius) || 0, w / 2, h / 2) * dpr

  c.beginPath()
  if (radius > 0) c.roundRect(x, y, w, h, radius)
  else c.rect(x, y, w, h)

  const bg = cs.backgroundColor
  if (bg && !TRANSPARENT.has(bg)) { c.fillStyle = bg; c.fill() }

  const bw = parseFloat(cs.borderTopWidth) || 0
  if (bw > 0 && cs.borderTopStyle !== 'none') {
    c.lineWidth = bw * dpr
    c.strokeStyle = cs.borderTopColor
    c.stroke()
  }
}

// single fillText per text node, vertically centered in its parent's box —
// a rough approximation (no wrapping/multi-line layout), documented above
function paintText(c: CanvasRenderingContext2D, node: Text, x: number, y: number, w: number, h: number, cs: CSSStyleDeclaration, dpr: number): void {
  const text = (node.textContent ?? '').replace(/\s+/g, ' ').trim()
  if (!text) return
  c.font = `${cs.fontStyle} ${cs.fontWeight} ${parseFloat(cs.fontSize) * dpr}px ${cs.fontFamily}`
  c.fillStyle = cs.color
  c.textBaseline = 'middle'
  c.textAlign = cs.textAlign === 'center' ? 'center' : cs.textAlign === 'right' ? 'right' : 'left'
  const tx = cs.textAlign === 'center' ? x + w / 2 : cs.textAlign === 'right' ? x + w : x
  c.fillText(text, tx, y + h / 2)
}

function paintImage(c: CanvasRenderingContext2D, img: HTMLImageElement, x: number, y: number, w: number, h: number): void {
  if (!img.complete || img.naturalWidth === 0) return
  try { c.drawImage(img, x, y, w, h) } catch { /* cross-origin source — skipped, not fatal to the rest */ }
}

export function paintNode(node: Element, c: CanvasRenderingContext2D, rootRect: DOMRect, dpr: number): void {
  const cs = getComputedStyle(node)
  if (cs.display === 'none' || cs.visibility === 'hidden') return

  const r = node.getBoundingClientRect()
  const x = (r.left - rootRect.left) * dpr
  const y = (r.top  - rootRect.top)  * dpr
  const w = r.width  * dpr
  const h = r.height * dpr

  if (node.tagName === 'IMG') { paintImage(c, node as HTMLImageElement, x, y, w, h); return }

  c.save()
  paintBoxDecoration(c, x, y, w, h, cs, dpr)
  c.restore()

  for (const child of Array.from(node.childNodes)) {
    if (child.nodeType === Node.ELEMENT_NODE) paintNode(child as Element, c, rootRect, dpr)
    else if (child.nodeType === Node.TEXT_NODE) paintText(c, child as Text, x, y, w, h, cs, dpr)
  }
}

// PNG bytes out of a canvas, synchronous (toDataURL, not toBlob) to match
// this codebase's existing emitCanvas precedent — returns null on a tainted
// canvas rather than throwing, so callers can skip gracefully
export function canvasToPngBytes(canvas: HTMLCanvasElement): Uint8Array | null {
  let dataUrl: string
  try { dataUrl = canvas.toDataURL('image/png') } catch { return null }
  const comma = dataUrl.indexOf(',')
  if (comma < 0) return null
  const bin = atob(dataUrl.slice(comma + 1))
  const bytes = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
  return bytes
}
