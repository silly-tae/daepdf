import { domRectToPt, paginateSpan, stackOpacity, type WalkerCtx } from './types.js'
import { paintNode, canvasToPngBytes } from './canvaspaint.js'
import type { ImageCommand } from '../types/index.js'

export function hasFilter(s: CSSStyleDeclaration): boolean {
  return !!s.filter && s.filter !== 'none'
}

// CSS filter has no PDF operator equivalent, so the element is rasterized
// (see canvaspaint.ts for the painter and why it isn't foreignObject-based).
export function emitFilteredElement(el: Element, s: CSSStyleDeclaration, ctx: WalkerCtx): void {
  const domRect = el.getBoundingClientRect()
  if (domRect.width < 1 || domRect.height < 1) return
  const { x, y, w, h } = domRectToPt(domRect, ctx.containerRect)

  // 3x the CSS pixel size, matching svg.ts's own inline-SVG rasterization DPI
  const dpr = 3
  const cw = Math.max(1, Math.round(domRect.width * dpr))
  const ch = Math.max(1, Math.round(domRect.height * dpr))

  const source  = document.createElement('canvas')
  source.width  = cw
  source.height = ch
  paintNode(el, source.getContext('2d')!, domRect, dpr)

  // filter applies ONCE to the whole composited element, not per shape —
  // painted unfiltered onto `source` above, then drawn through onto this
  // second canvas with the filter active for that single drawImage call
  const filtered  = document.createElement('canvas')
  filtered.width  = cw
  filtered.height = ch
  const fctx = filtered.getContext('2d')!
  fctx.filter = s.filter
  fctx.drawImage(source, 0, 0)

  const src = canvasToPngBytes(filtered)
  if (!src) return /* tainted canvas (e.g. a cross-origin image child) */

  const opacity = stackOpacity(ctx)
  for (const { page, y: ly } of paginateSpan(y, h, ctx.pageH)) {
    ctx.commands.push({ type: 'image', page, src, format: 'png', x, y: ly, w, h, opacity } as ImageCommand)
  }
}
