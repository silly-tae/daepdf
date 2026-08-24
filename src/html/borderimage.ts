import type { ImageCommand, ClipCommand, Gradient, ConicGradient } from '../types/index.js'
import { PX_PER_PT, domRectToPt, paginateSpan, stackOpacity, type WalkerCtx } from './types.js'
import { pxToPt, parseCSSGradient, parseCSSConicGradient } from './css.js'
import { extractBgUrl } from './images.js'

interface Sides { top: number; right: number; bottom: number; left: number }

function parseSideValues(v: string): [string, string, string, string] {
  const toks = v.trim().split(/\s+/).filter(Boolean)
  const t0 = toks[0] ?? ''
  return [t0, toks[1] ?? t0, toks[2] ?? t0, toks[3] ?? toks[1] ?? t0]
}

// border-image-slice: numbers are source-image pixels, percentages are of the
// source's own natural size — resolved once the natural size is known (fetch
// happens first). The 'fill' keyword can appear anywhere in the value.
function parseSlice(v: string, naturalW: number, naturalH: number): Sides & { fill: boolean } {
  const fill = /\bfill\b/.test(v)
  const clean = v.replace(/\bfill\b/, '').trim()
  const [t, r, b, l] = parseSideValues(clean)
  const resolve = (tok: string, ref: number) => {
    const pctM = tok.match(/^(-?[\d.]+)%$/)
    if (pctM) return +pctM[1]! / 100 * ref
    return parseFloat(tok) || 0
  }
  return { top: resolve(t, naturalH), right: resolve(r, naturalW), bottom: resolve(b, naturalH), left: resolve(l, naturalW), fill }
}

// border-image-width: a bare number is a MULTIPLE of the matching border-*-width
// (default 1); a length/percentage resolves against the border box directly
function parseWidth(v: string, borderW: Sides, boxW: number, boxH: number): Sides {
  const [t, r, b, l] = parseSideValues(v)
  const resolve = (tok: string, side: number, ref: number) => {
    const pctM = tok.match(/^(-?[\d.]+)%$/)
    if (pctM) return +pctM[1]! / 100 * ref
    const pxM = tok.match(/^(-?[\d.]+)px$/)
    if (pxM) return +pxM[1]! / PX_PER_PT
    const n = parseFloat(tok)
    return isNaN(n) ? side : n * side
  }
  return { top: resolve(t, borderW.top, boxH), right: resolve(r, borderW.right, boxW), bottom: resolve(b, borderW.bottom, boxH), left: resolve(l, borderW.left, boxW) }
}

// border-image-outset: same numeric-multiple-of-border-width convention as width
function parseOutset(v: string, borderW: Sides): Sides {
  const [t, r, b, l] = parseSideValues(v)
  const resolve = (tok: string, side: number) => {
    const pxM = tok.match(/^(-?[\d.]+)px$/)
    if (pxM) return +pxM[1]! / PX_PER_PT
    const n = parseFloat(tok)
    return isNaN(n) ? 0 : n * side
  }
  return { top: resolve(t, borderW.top), right: resolve(r, borderW.right), bottom: resolve(b, borderW.bottom), left: resolve(l, borderW.left) }
}

type RepeatMode = 'stretch' | 'repeat' | 'round' | 'space'

function parseRepeat(v: string): [RepeatMode, RepeatMode] {
  const toks = v.trim().split(/\s+/)
  const h = (toks[0] as RepeatMode) || 'stretch'
  const w = (toks[1] as RepeatMode) || h
  return [h, w]
}

function loadImageElement(url: string): Promise<HTMLImageElement | null> {
  return new Promise(resolve => {
    const img = new Image()
    img.onload  = () => resolve(img)
    img.onerror = () => resolve(null)
    img.src = url
  })
}

// canvas's own linear/radial gradient primitives cover both — angle/stops
// already parsed by the same CSS gradient parser the background path uses
function paintGradientToCanvas(canvas: HTMLCanvasElement, g: Gradient): void {
  const ctx = canvas.getContext('2d')!
  const w = canvas.width, h = canvas.height
  let grad: CanvasGradient
  if (g.type === 'linear') {
    const rad = g.angle * Math.PI / 180
    const dx = Math.sin(rad), dy = -Math.cos(rad)
    const half = Math.abs(w * dx) / 2 + Math.abs(h * dy) / 2
    const cx = w / 2, cy = h / 2
    grad = ctx.createLinearGradient(cx - dx * half, cy - dy * half, cx + dx * half, cy + dy * half)
  } else {
    const cx = (g.cx ?? 0.5) * w, cy = (g.cy ?? 0.5) * h
    const r  = Math.hypot(Math.max(cx, w - cx), Math.max(cy, h - cy))
    grad = ctx.createRadialGradient(cx, cy, 0, cx, cy, r)
  }
  for (const st of g.stops) {
    const [r, gr, b, a] = st.color
    grad.addColorStop(Math.min(1, Math.max(0, st.position)), `rgba(${r},${gr},${b},${a / 255})`)
  }
  ctx.fillStyle = grad
  ctx.fillRect(0, 0, w, h)
}

function paintConicToCanvas(canvas: HTMLCanvasElement, cg: ConicGradient): void {
  const ctx = canvas.getContext('2d')
  if (!ctx || typeof ctx.createConicGradient !== 'function') return
  const grad = ctx.createConicGradient((cg.fromDeg - 90) * Math.PI / 180, cg.cx * canvas.width, cg.cy * canvas.height)
  for (const st of cg.stops) {
    const [r, g, b, a] = st.color
    grad.addColorStop(Math.min(1, Math.max(0, st.position)), `rgba(${r},${g},${b},${a / 255})`)
  }
  ctx.fillStyle = grad
  ctx.fillRect(0, 0, canvas.width, canvas.height)
}

interface SourceCanvas { canvas: HTMLCanvasElement; w: number; h: number }

// resolves border-image-source to a full offscreen canvas: an actual url()
// image loaded and drawn once, or a CSS gradient rasterized at the border
// box's own pixel size (a gradient has no intrinsic size of its own — per
// spec, its "natural size" for slicing purposes IS the border image area)
async function resolveSourceCanvas(source: string, boxWpx: number, boxHpx: number): Promise<SourceCanvas | null> {
  const url = extractBgUrl(source)
  if (url) {
    const img = await loadImageElement(url)
    if (!img || !img.naturalWidth || !img.naturalHeight) return null
    const canvas = document.createElement('canvas')
    canvas.width = img.naturalWidth
    canvas.height = img.naturalHeight
    canvas.getContext('2d')!.drawImage(img, 0, 0)
    return { canvas, w: canvas.width, h: canvas.height }
  }

  const w = Math.max(1, Math.round(boxWpx)), h = Math.max(1, Math.round(boxHpx))
  const canvas = document.createElement('canvas')
  canvas.width = w; canvas.height = h
  const g = parseCSSGradient(source)
  if (g) { paintGradientToCanvas(canvas, g); return { canvas, w, h } }
  const cg = parseCSSConicGradient(source)
  if (cg) { paintConicToCanvas(canvas, cg); return { canvas, w, h } }
  return null
}

function cropToPng(src: SourceCanvas, sx: number, sy: number, sw: number, sh: number): Uint8Array | null {
  if (sw <= 0 || sh <= 0) return null
  const canvas = document.createElement('canvas')
  canvas.width = Math.max(1, Math.round(sw))
  canvas.height = Math.max(1, Math.round(sh))
  const ctx = canvas.getContext('2d')!
  ctx.drawImage(src.canvas, sx, sy, sw, sh, 0, 0, canvas.width, canvas.height)
  const dataUrl = canvas.toDataURL('image/png')
  const comma = dataUrl.indexOf(',')
  if (comma < 0) return null
  const bin = atob(dataUrl.slice(comma + 1))
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}

// mirrors MAX_BG_TILES in images.ts — an author-controlled tiny tile size
// against a large box would otherwise produce an uncapped cartesian product
// of ImageCommands per edge/side (emitBorderImage nests this over both axes)
const MAX_BORDER_TILES = 500

// tiles a cropped slice image along one axis to fill `length` — the same
// stretch/repeat/round/space modes background-repeat uses, but 1-dimensional
// (edge slices only repeat along their own edge, never across the box)
function tilePositions(mode: RepeatMode, length: number, tileSize: number): { positions: number[]; size: number } {
  if (mode === 'stretch' || tileSize <= 0.01) return { positions: [0], size: length }
  if (mode === 'round') {
    const count = Math.min(MAX_BORDER_TILES, Math.max(1, Math.round(length / tileSize)))
    return { positions: Array.from({ length: count }, (_, i) => i * (length / count)), size: length / count }
  }
  if (mode === 'space') {
    const count = Math.min(MAX_BORDER_TILES, Math.max(1, Math.floor(length / tileSize)))
    if (count <= 1) return { positions: [(length - tileSize) / 2], size: tileSize }
    const gap = (length - count * tileSize) / (count - 1)
    return { positions: Array.from({ length: count }, (_, i) => i * (tileSize + gap)), size: tileSize }
  }
  // repeat: tiles clipped to the edge rect, so a partial tile at the end is fine
  const count = Math.min(MAX_BORDER_TILES, Math.max(1, Math.ceil(length / tileSize)))
  return { positions: Array.from({ length: count }, (_, i) => i * tileSize), size: tileSize }
}

export function hasBorderImage(s: CSSStyleDeclaration): boolean {
  const src = (s as any).borderImageSource as string | undefined
  return !!src && src !== 'none'
}

export async function emitBorderImage(el: Element, s: CSSStyleDeclaration, ctx: WalkerCtx): Promise<void> {
  const source = (s as any).borderImageSource as string
  if (!source || source === 'none') return

  const domRect = el.getBoundingClientRect()
  const { x, y, w, h } = domRectToPt(domRect, ctx.containerRect)
  if (w <= 0 || h <= 0) return

  const borderW: Sides = {
    top: pxToPt(s.borderTopWidth || '0px'), right: pxToPt(s.borderRightWidth || '0px'),
    bottom: pxToPt(s.borderBottomWidth || '0px'), left: pxToPt(s.borderLeftWidth || '0px'),
  }

  const src = await resolveSourceCanvas(source, w * PX_PER_PT, h * PX_PER_PT)
  if (!src) return

  const slice  = parseSlice((s as any).borderImageSlice || '100%', src.w, src.h)
  const width  = parseWidth((s as any).borderImageWidth || '1', borderW, w, h)
  const outset = parseOutset((s as any).borderImageOutset || '0', borderW)
  const [repeatH, repeatV] = parseRepeat((s as any).borderImageRepeat || 'stretch')

  const X = x - outset.left, Y = y - outset.top
  const W = w + outset.left + outset.right, H = h + outset.top + outset.bottom
  const { top: wt, right: wr, bottom: wb, left: wl } = width
  const midW = Math.max(0, W - wl - wr), midH = Math.max(0, H - wt - wb)

  const sT = slice.top, sR = slice.right, sB = slice.bottom, sL = slice.left
  const srcMidW = Math.max(0, src.w - sL - sR), srcMidH = Math.max(0, src.h - sT - sB)

  interface Region { sx: number; sy: number; sw: number; sh: number; dx: number; dy: number; dw: number; dh: number; repeatX?: RepeatMode; repeatY?: RepeatMode }
  const regions: Region[] = [
    { sx: 0, sy: 0, sw: sL, sh: sT, dx: X, dy: Y, dw: wl, dh: wt },
    { sx: src.w - sR, sy: 0, sw: sR, sh: sT, dx: X + W - wr, dy: Y, dw: wr, dh: wt },
    { sx: 0, sy: src.h - sB, sw: sL, sh: sB, dx: X, dy: Y + H - wb, dw: wl, dh: wb },
    { sx: src.w - sR, sy: src.h - sB, sw: sR, sh: sB, dx: X + W - wr, dy: Y + H - wb, dw: wr, dh: wb },
    { sx: sL, sy: 0, sw: srcMidW, sh: sT, dx: X + wl, dy: Y, dw: midW, dh: wt, repeatX: repeatH },
    { sx: sL, sy: src.h - sB, sw: srcMidW, sh: sB, dx: X + wl, dy: Y + H - wb, dw: midW, dh: wb, repeatX: repeatH },
    { sx: 0, sy: sT, sw: sL, sh: srcMidH, dx: X, dy: Y + wt, dw: wl, dh: midH, repeatY: repeatV },
    { sx: src.w - sR, sy: sT, sw: sR, sh: srcMidH, dx: X + W - wr, dy: Y + wt, dw: wr, dh: midH, repeatY: repeatV },
  ]
  if (slice.fill) {
    regions.push({ sx: sL, sy: sT, sw: srcMidW, sh: srcMidH, dx: X + wl, dy: Y + wt, dw: midW, dh: midH, repeatX: repeatH, repeatY: repeatV })
  }

  const opacity = stackOpacity(ctx)
  for (const r of regions) {
    if (r.dw <= 0.01 || r.dh <= 0.01 || r.sw <= 0 || r.sh <= 0) continue
    const png = cropToPng(src, r.sx, r.sy, r.sw, r.sh)
    if (!png) continue

    // an edge slice tiles at its OWN aspect-corrected size along the repeat axis,
    // matching the fixed cross-axis size (the border width) exactly
    const naturalTileW = r.repeatX ? r.sw * (r.dh / r.sh) : r.dw
    const naturalTileH = r.repeatY ? r.sh * (r.dw / r.sw) : r.dh

    const tx = r.repeatX ? tilePositions(r.repeatX, r.dw, naturalTileW) : { positions: [0], size: r.dw }
    const ty = r.repeatY ? tilePositions(r.repeatY, r.dh, naturalTileH) : { positions: [0], size: r.dh }

    const needsTileClip = !!(r.repeatX || r.repeatY)
    for (const { page, y: boxLy } of paginateSpan(r.dy, r.dh, ctx.pageH)) {
      if (needsTileClip) ctx.commands.push({ type: 'clip-push', page, x: r.dx, y: boxLy, w: r.dw, h: r.dh } as ClipCommand)
      for (const px of tx.positions) {
        for (const py of ty.positions) {
          ctx.commands.push({
            type: 'image', page, src: png, format: 'png',
            x: r.dx + px, y: boxLy + py, w: tx.size, h: ty.size,
            opacity,
          } as ImageCommand)
        }
      }
      if (needsTileClip) ctx.commands.push({ type: 'clip-pop', page } as ClipCommand)
    }
  }
}
