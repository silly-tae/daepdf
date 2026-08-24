import { domRectToPt, paginateSpan, stackOpacity, type WalkerCtx } from './types.js'
import { paintNode, canvasToPngBytes } from './canvaspaint.js'
import { parseCSSGradient, parseCSSConicGradient, tileStops } from './css.js'
import { resolveGradientBox } from './emit.js'
import type { ImageCommand } from '../types/index.js'
import type { GradientStop } from '../types/index.js'

export function hasMask(s: CSSStyleDeclaration): boolean {
  const v = (s as any).maskImage as string | undefined
  return !!v && v !== 'none'
}

function addStops(grad: CanvasGradient, stops: GradientStop[]): void {
  for (const st of stops) {
    const [r, g, b, a] = st.color
    grad.addColorStop(Math.min(1, Math.max(0, st.position)), `rgba(${r},${g},${b},${a / 255})`)
  }
}

function loadImage(url: string): Promise<HTMLImageElement | null> {
  return new Promise(resolve => {
    const img = new Image()
    img.onload  = () => resolve(img)
    img.onerror = () => resolve(null)
    img.src = url
  })
}

// Paints the mask-image source onto a canvas at the element's own pixel
// size. Gradients resolve with the exact math the background-gradient path
// uses (resolveGradientBox), so a mask gradient behaves identically to the
// same gradient used as a background — canvas is Y-down like CSS/DOM, unlike
// the PDF shading path, so the linear-gradient direction vector here is
// (sin, -cos), not putShadingPatterns' PDF-Y-up (sin, cos). url() sources
// load as an <img> and draw directly, the same same-origin/data-URI
// assumption this renderer's existing background-image handling makes.
async function paintMaskSource(spec: string, wPt: number, hPt: number, cw: number, ch: number): Promise<HTMLCanvasElement | null> {
  const canvas = document.createElement('canvas')
  canvas.width  = cw
  canvas.height = ch
  const c = canvas.getContext('2d')!

  const lin = parseCSSGradient(spec)
  if (lin) {
    const g = resolveGradientBox(lin, wPt, hPt)
    let grad: CanvasGradient
    if (g.type === 'linear') {
      const rad = g.angle * Math.PI / 180
      const dx = Math.sin(rad), dy = -Math.cos(rad)
      const hw = cw / 2, hh = ch / 2
      const projs = [-hw * dx - hh * dy, hw * dx - hh * dy, -hw * dx + hh * dy, hw * dx + hh * dy]
      const tMin = Math.min(...projs), tMax = Math.max(...projs)
      const cx = cw / 2, cy = ch / 2
      grad = c.createLinearGradient(cx + tMin * dx, cy + tMin * dy, cx + tMax * dx, cy + tMax * dy)
    } else {
      const gcx = cw * (g.cx ?? 0.5), gcy = ch * (g.cy ?? 0.5)
      const r = Math.hypot(Math.max(gcx, cw - gcx), Math.max(gcy, ch - gcy))
      grad = c.createRadialGradient(gcx, gcy, 0, gcx, gcy, r)
    }
    addStops(grad, g.stops)
    c.fillStyle = grad
    c.fillRect(0, 0, cw, ch)
    return canvas
  }

  const conic = parseCSSConicGradient(spec)
  if (conic && typeof c.createConicGradient === 'function') {
    const grad = c.createConicGradient((conic.fromDeg - 90) * Math.PI / 180, conic.cx * cw, conic.cy * ch)
    addStops(grad, tileStops(conic.stops, conic.repeating))
    c.fillStyle = grad
    c.fillRect(0, 0, cw, ch)
    return canvas
  }

  const urlM = spec.match(/^url\((['"]?)(.*?)\1\)$/)
  if (urlM) {
    const img = await loadImage(urlM[2]!)
    if (!img) return null
    c.drawImage(img, 0, 0, cw, ch)
    return canvas
  }

  return null
}

// mask-image has no PDF operator equivalent — the element is rasterized (see
// canvaspaint.ts, shared with CSS filter), then composited against the mask
// source's ALPHA channel via destination-in. Alpha, not luminance: confirmed
// against the browser's own rendering that the common `linear-gradient(black,
// transparent)` fade-out mask works via alpha — a luminance read would make
// the "black" end fully OPAQUE-but-black instead of fully visible, which is
// not what mask-image does.
export async function emitMaskedElement(el: Element, s: CSSStyleDeclaration, ctx: WalkerCtx): Promise<void> {
  const domRect = el.getBoundingClientRect()
  if (domRect.width < 1 || domRect.height < 1) return
  const { x, y, w, h } = domRectToPt(domRect, ctx.containerRect)

  const dpr = 3
  const cw = Math.max(1, Math.round(domRect.width * dpr))
  const ch = Math.max(1, Math.round(domRect.height * dpr))

  const maskSpec   = (s as any).maskImage as string
  const maskCanvas = await paintMaskSource(maskSpec, w, h, cw, ch)
  // an unresolvable source (e.g. a url() that fails to load) leaves the
  // element unrendered rather than guessing — matching how a failed
  // background-image degrades, not a hard error
  if (!maskCanvas) return

  const content = document.createElement('canvas')
  content.width  = cw
  content.height = ch
  paintNode(el, content.getContext('2d')!, domRect, dpr)

  const finalCanvas  = document.createElement('canvas')
  finalCanvas.width  = cw
  finalCanvas.height = ch
  const fc = finalCanvas.getContext('2d')!
  fc.drawImage(content, 0, 0)
  fc.globalCompositeOperation = 'destination-in'
  fc.drawImage(maskCanvas, 0, 0)

  const src = canvasToPngBytes(finalCanvas)
  if (!src) return

  const opacity = stackOpacity(ctx)
  for (const { page, y: ly } of paginateSpan(y, h, ctx.pageH)) {
    ctx.commands.push({ type: 'image', page, src, format: 'png', x, y: ly, w, h, opacity } as ImageCommand)
  }
}
