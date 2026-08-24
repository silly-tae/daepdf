import type {
  Color, ColorAlpha, Gradient, ConicGradient, BorderRadius, Corner, FontRef,
  TextCommand, RectCommand, LineCommand, LinkCommand, ClipCommand, ImageCommand, FieldCommand,
} from '../types/index.js'
import { measure_string_width } from '../../engine.js'
import { PX_PER_PT, domRectToPt, paginate, paginateSpan, stackOpacity, stackBlend, type WalkerCtx } from './types.js'
import {
  parseColorAlpha, parseCSSBoxShadow, parseCSSGradient, parseCSSConicGradient, tileStops,
  parseBorderRadius, clampRadiusToBox, insetBorderRadius, pxToPt, splitByTopLevelComma, isTransparentColor,
} from './css.js'
import { resolveFontRef, splitByFontCoverage } from './fonts.js'
import { romanNumeral, alphaLabel, applyCounters, popCounters, resolveContentList } from './counters.js'
import { hasBorderImage } from './borderimage.js'

// also used for text-decoration-style, the only caller that can ever produce
// 'wavy' — CSS border-style never has that value
type Side = 'Top' | 'Right' | 'Bottom' | 'Left'
const perSide = <T>(f: (d: Side) => T): [T, T, T, T] => [f('Top'), f('Right'), f('Bottom'), f('Left')]

function normBorderStyle(s: string): 'solid' | 'dashed' | 'dotted' | 'wavy' {
  if (s === 'dashed') return 'dashed'
  if (s === 'dotted') return 'dotted'
  if (s === 'wavy') return 'wavy'
  return 'solid'
}

// A3 (bidi): strong-RTL Unicode blocks (Hebrew, Arabic + its extensions/
// presentation forms, Syriac, Thaana, N'Ko, Samaritan, Mandaic — deliberately
// bounded, not a full UAX#9 bidi-class table, since only "is this paragraph
// direction-homogeneous" needs answering here, not full-spec classification)
const RTL_RANGES: [number, number][] = [
  [0x0591, 0x08FF], // Hebrew through Arabic Extended-A
  [0xFB1D, 0xFDFF], // Hebrew + Arabic presentation forms-A
  [0xFE70, 0xFEFF], // Arabic presentation forms-B
]
function isStrongRTL(cp: number): boolean {
  return RTL_RANGES.some(([a, b]) => cp >= a && cp <= b)
}

// True when `text` mixes a strong-RTL script with a strong-LTR letter — the
// case rustybuzz's own per-call script/direction auto-detection (guess_
// segment_properties) can't handle within ONE shape_text call, since it picks
// a single direction for the whole buffer. The browser's own layout already
// resolves this correctly per word (real Unicode Bidi Algorithm) — captureTextNode's
// existing per-word emission (see `perWord` below) reuses each word's own
// already-correct DOM rect for position AND already shapes each word through
// its own separate, single-script `shape_text` call, so forcing per-word mode
// for a mixed line is the complete fix, not a partial one: no new shaping or
// reordering logic needed, confirmed by direct inspection of real output
// (a forced-justify mixed-bidi line correctly interleaves LTR/RTL word
// positions matching the browser's own bidi-resolved layout) before this was
// wired in as the general fix for ANY bidi-mixed line, not just justified ones.
function hasBidiMix(text: string): boolean {
  let sawRTL = false, sawLTR = false
  for (const ch of text) {
    const cp = ch.codePointAt(0)!
    if (isStrongRTL(cp)) sawRTL = true
    else if (/\p{L}/u.test(ch)) sawLTR = true
    if (sawRTL && sawLTR) return true
  }
  return false
}

// parseColor() (RGB only) drops rgba()'s alpha entirely, rendering any partially
// transparent fill/stroke/text color fully opaque. Split it into the RGB triple plus
// a 0-1 alpha and fold that into the command's own `opacity`, the same mechanism
// already used for CSS `opacity` — real alpha compositing via ExtGState, not a fake blend.
function splitColorAlpha(ca: ColorAlpha | null): { color: Color | null; alpha: number } {
  if (!ca) return { color: null, alpha: 1 }
  return { color: [ca[0], ca[1], ca[2]], alpha: ca[3] / 255 }
}

function combineOpacity(base: number | undefined, extra: number): number | undefined {
  const combined = (base ?? 1) * extra
  return combined < 1 ? combined : undefined
}

// Parts of a gradient only resolve against the box it paints: corner keywords
// (spec: the gradient line runs perpendicular to the diagonal joining the two
// neighboring corners — the parse-time 45° multiple is only correct for squares)
// and px-positioned stops (fractions of the gradient-line length).
export function resolveGradientBox(gradient: Gradient, w: number, h: number): Gradient {
  if (w <= 0 || h <= 0) return gradient

  if (gradient.type === 'linear' && gradient.corner) {
    const a = Math.atan2(h, w) * 180 / Math.PI
    const cornerAngle: Record<string, number> = {
      'top right': a, 'bottom right': 180 - a, 'bottom left': 180 + a, 'top left': 360 - a,
    }
    gradient = { ...gradient, angle: cornerAngle[gradient.corner] ?? gradient.angle }
  }

  if (gradient.stops.some(st => st.posPx !== undefined)) {
    let linePt: number
    if (gradient.type === 'linear') {
      const rad = gradient.angle * Math.PI / 180
      linePt = Math.abs(w * Math.sin(rad)) + Math.abs(h * Math.cos(rad))
    } else {
      // farthest-corner radius, matching the shading's ending circle
      const cxPt = (gradient.cx ?? 0.5) * w
      const cyPt = (gradient.cy ?? 0.5) * h
      linePt = Math.hypot(Math.max(cxPt, w - cxPt), Math.max(cyPt, h - cyPt))
    }
    if (linePt > 0) {
      gradient = { ...gradient, stops: gradient.stops.map(st =>
        st.posPx !== undefined
          ? { color: st.color, position: (st.posPx / PX_PER_PT) / linePt }
          : st
      ) }
    }
  }

  // repeating-linear/radial-gradient: tile the stop pattern across [0,1] — the
  // domain is fractional position along the gradient line (linear) or shading
  // radius (radial), so one tiling function covers both.
  if (gradient.repeating) {
    gradient = { ...gradient, repeating: undefined, stops: tileStops(gradient.stops, true) } as Gradient
  }

  return gradient
}

// Conic gradients have no PDF shading equivalent (axial/radial only) — rasterize
// through a canvas at 3× (≈216 dpi, matching svg.ts). Cached by definition + size;
// same-page repeats (badges, chips) reuse the bytes and the PDF embeds them once.
const _conicCache = new Map<string, Uint8Array | null>()

function rasterizeConic(cg: ConicGradient, wPt: number, hPt: number): Uint8Array | null {
  if (wPt <= 0 || hPt <= 0) return null
  const key = `${cg.fromDeg}|${cg.cx}|${cg.cy}|${cg.repeating ?? false}|${cg.stops.map(st => `${st.position}:${st.color}`).join(',')}|${wPt.toFixed(2)}|${hPt.toFixed(2)}`
  const hit = _conicCache.get(key)
  if (hit !== undefined) return hit

  let out: Uint8Array | null = null
  try {
    const dpr = 3
    const canvas  = document.createElement('canvas')
    canvas.width  = Math.max(1, Math.round(wPt * dpr))
    canvas.height = Math.max(1, Math.round(hPt * dpr))
    const c2d = canvas.getContext('2d')
    if (c2d && typeof c2d.createConicGradient === 'function') {
      // canvas measures the start angle from the +x axis, CSS from 12 o'clock
      const grad = c2d.createConicGradient(
        (cg.fromDeg - 90) * Math.PI / 180,
        cg.cx * canvas.width, cg.cy * canvas.height,
      )
      // repeating-conic-gradient: canvas has no native repeat for conic stops,
      // so the same [0,1]-domain tiling used for linear/radial pre-expands them
      const stops = tileStops(cg.stops, cg.repeating)
      for (const st of stops) {
        const [r, g, b, a] = st.color
        grad.addColorStop(Math.min(1, Math.max(0, st.position)), `rgba(${r},${g},${b},${a / 255})`)
      }
      c2d.fillStyle = grad
      c2d.fillRect(0, 0, canvas.width, canvas.height)
      const dataUrl = canvas.toDataURL('image/png')
      const comma   = dataUrl.indexOf(',')
      if (comma >= 0) {
        const bin = atob(dataUrl.slice(comma + 1))
        out = new Uint8Array(bin.length)
        for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
      }
    }
  } catch { out = null }

  _conicCache.set(key, out)
  return out
}

// box-decoration-break: 'slice' zeroes the corners on a fragment's CUT side(s) —
// left for any line fragment but the first, right for any but the last. A middle
// fragment gets both, i.e. fully square. 'clone' (the caller's job to detect and
// simply not call this) keeps every corner, matching a standalone complete box.
function suppressRadiusSide(radius: BorderRadius | undefined, suppressLeft: boolean, suppressRight: boolean): BorderRadius | undefined {
  if (!radius || (!suppressLeft && !suppressRight)) return radius
  const a = radius.all ?? 0
  const c = (x?: Corner): Corner => x ? { h: x.h, v: x.v } : { h: a, v: a }
  const tl = c(radius.topLeft), tr = c(radius.topRight)
  const br = c(radius.bottomRight), bl = c(radius.bottomLeft)
  if (suppressLeft)  { tl.h = 0; tl.v = 0; bl.h = 0; bl.v = 0 }
  if (suppressRight) { tr.h = 0; tr.v = 0; br.h = 0; br.v = 0 }
  return { topLeft: tl, topRight: tr, bottomRight: br, bottomLeft: bl }
}

export function emitBox(el: Element, s: CSSStyleDeclaration, ctx: WalkerCtx): void {
  const isInline = s.display === 'inline'
  const rects    = isInline
    ? Array.from((el as HTMLElement).getClientRects())
    : [el.getBoundingClientRect()]

  const opacity = stackOpacity(ctx)
  const blend   = stackBlend(ctx)
  const boxDecorationBreak = (s as any).boxDecorationBreak === 'clone' ? 'clone' : 'slice'

  for (const [rectIndex, domRect] of rects.entries()) {
    if (domRect.width < 0.5 && domRect.height < 0.5) continue
    const { x, y, w, h } = domRectToPt(domRect, ctx.containerRect)

    const { color: bgColor, alpha: bgAlpha } = splitColorAlpha(parseColorAlpha(s.backgroundColor))
    // inline fragments can be smaller than the union rect the radius was clamped
    // against — re-clamp per fragment
    const baseRadius = isInline
      ? clampRadiusToBox(parseBorderRadius(s, el), w, h)
      : parseBorderRadius(s, el)
    const shadows = parseCSSBoxShadow(s.boxShadow)
    const bgImg   = s.backgroundImage

    // An inline box wrapped across multiple lines is fragmented along the INLINE
    // axis (left/right) — under the CSS default 'slice', only the true left edge
    // (first fragment) and true right edge (last fragment) get their corner/
    // border; a fragment's "wrong" side, or both sides for a middle fragment, are
    // square, as if the box continues past an artificial cut. Top/bottom are
    // NOT cut edges for inline fragmentation (each line is already a complete
    // line box along that axis), so they're unaffected either way. A BLOCK
    // element spanning multiple PAGES is handled separately below — the default
    // slice behavior there already falls out of drawing one continuous absolute
    // shape and letting each page's own MediaBox reveal its true portion
    // (verified directly against rendered output; see task-map.md's B12 notes),
    // so no corner suppression is needed for that case.
    const fragmented    = isInline && rects.length > 1 && boxDecorationBreak === 'slice'
    const suppressLeft  = fragmented && rectIndex > 0
    const suppressRight = fragmented && rectIndex < rects.length - 1
    const radius = suppressRadiusSide(baseRadius, suppressLeft, suppressRight)

    const bWidths       = perSide(d => pxToPt((s as any)[`border${d}Width`] ?? '0px'))
    const bColorAlphas  = perSide(d => parseColorAlpha((s as any)[`border${d}Color`] ?? ''))
    const bStyles       = perSide(d => (s as any)[`border${d}Style`] as string ?? 'none')

    const allSame = bWidths.every(v => v === bWidths[0]) &&
      bStyles.every(v => v === bStyles[0]) &&
      bColorAlphas.every(c => JSON.stringify(c) === JSON.stringify(bColorAlphas[0]))
    // border_ring is a solid even-odd fill with no dash support — dashed/dotted must
    // take the line branch, which carries the dash pattern (corners go square there:
    // an approximation, but the dash pattern is the author-visible intent). 'double'
    // (the classic accounting rule) goes there too, drawn as two thin sub-lines.
    // A fragmented (sliced) box also forces the line branch regardless of style —
    // border_ring always draws all four sides as one ring, with no way to omit
    // just the cut side(s) the way the per-side line loop below can.
    const uniformSolid = !fragmented && allSame && bStyles[0] !== 'dashed' && bStyles[0] !== 'dotted' && bStyles[0] !== 'double'

    // background-clip: 'text' can't clip a box fill to glyph outlines in a PDF — the
    // box paints nothing but its shadow (captureTextNode substitutes the text color
    // instead); padding-box/content-box shrink the paint area and its radius. The
    // shadow always belongs to the border box, so it splits into its own command
    // whenever the fill area differs. background-clip is a per-layer list; the
    // background-color clips to the LAST layer's value per spec.
    const bgClipList = String((s as any).webkitBackgroundClip || s.backgroundClip || 'border-box')
      .split(',').map(t => t.trim())
    const bgClipText = bgClipList[bgClipList.length - 1] === 'text'
    const paintsFill = !bgClipText && !!bgColor

    // outline draws as a ring outside the border box, offset by outline-offset
    // (which may be negative, pulling the outline inside the box). Left as a
    // full ring on every fragment even when sliced — cut-edge suppression for
    // outline would need the same "stroke only some sides" primitive border
    // does not have either, and outline+inline-wrap+radius is a rare enough
    // combination that this is a documented approximation, not a fix target.
    const oWidth  = pxToPt(s.outlineWidth || '0px')
    const oStyle  = s.outlineStyle
    const oColorA = (oWidth > 0 && oStyle && oStyle !== 'none') ? parseColorAlpha(s.outlineColor) : null
    const oGrow   = oColorA ? pxToPt(s.outlineOffset || '0px') + oWidth : 0
    let oRadius: typeof radius
    if (oColorA && radius) {
      const a = radius.all ?? 0
      // rounded corners grow with the outline's offset ring; square corners stay square
      const grown = (c?: Corner): Corner => {
        const base = c ?? { h: a, v: a }
        if (base.h <= 0 || base.v <= 0) return { h: 0, v: 0 }
        return { h: Math.max(0, base.h + oGrow), v: Math.max(0, base.v + oGrow) }
      }
      oRadius = {
        topLeft:     grown(radius.topLeft),
        topRight:    grown(radius.topRight),
        bottomRight: grown(radius.bottomRight),
        bottomLeft:  grown(radius.bottomLeft),
      }
    }

    // CSS paints background-color first, then image layers LAST → FIRST; each
    // layer clips to its own background-clip value. Gradient/conic layers are
    // collected here and emitted between the color fill and the border commands
    // — borders paint above backgrounds. url() layers are handled in walk.ts
    // (async fetch), likewise in reverse order. Parameterized on the box's
    // effective height so box-decoration-break:clone (below) can recompute this
    // per page-fragment, insetting from THAT fragment's own edges — the common
    // (non-clone) case calls this once, exactly as before the refactor.
    interface BgLayer { gradient?: Gradient; conicSrc?: Uint8Array; box: { dx: number; dy: number; w: number; h: number; radius?: BorderRadius | undefined } }
    const computeGeom = (effH: number) => {
      const clipBoxFor = (kind: string) => {
        const box = { dx: 0, dy: 0, w, h: effH, radius }
        if (kind !== 'padding-box' && kind !== 'content-box') return box
        const pad = kind === 'content-box'
        const iT = bWidths[0] + (pad ? pxToPt(s.paddingTop    || '0px') : 0)
        const iR = bWidths[1] + (pad ? pxToPt(s.paddingRight  || '0px') : 0)
        const iB = bWidths[2] + (pad ? pxToPt(s.paddingBottom || '0px') : 0)
        const iL = bWidths[3] + (pad ? pxToPt(s.paddingLeft   || '0px') : 0)
        if (!iT && !iR && !iB && !iL) return box
        return {
          dx: iL, dy: iT,
          w: Math.max(0, w - iL - iR), h: Math.max(0, effH - iT - iB),
          radius: insetBorderRadius(radius, iT, iR, iB, iL),
        }
      }
      const colorClip = bgClipList.at(-1) ?? 'border-box'
      const fillBox   = clipBoxFor(colorClip)
      const fillInset = fillBox.dx !== 0 || fillBox.dy !== 0 || fillBox.w !== w || fillBox.h !== effH

      const bgLayers: BgLayer[] = []
      if (bgImg && bgImg !== 'none') {
        const layerList = splitByTopLevelComma(bgImg)
        for (let i = layerList.length - 1; i >= 0; i--) {
          const kind = bgClipList[i % bgClipList.length] ?? 'border-box'
          if (kind === 'text') continue
          const layer = (layerList[i] ?? '').trim()
          const g = parseCSSGradient(layer)
          if (g) {
            const box = clipBoxFor(kind)
            if (box.w > 0 && box.h > 0) bgLayers.push({ gradient: resolveGradientBox(g, box.w, box.h), box })
            continue
          }
          const cg = parseCSSConicGradient(layer)
          if (cg) {
            const box = clipBoxFor(kind)
            const src = rasterizeConic(cg, box.w, box.h)
            if (src) bgLayers.push({ conicSrc: src, box })
          }
        }
      }
      return { fillBox, fillInset, bgLayers }
    }

    const spans = paginateSpan(y, h, ctx.pageH)
    // box-decoration-break:clone on a BLOCK element spanning multiple pages: each
    // page-fragment becomes an independent, complete box at its OWN local height
    // (not the full element height), full border/radius on all sides — unlike
    // default 'slice', which keeps drawing the one full-height absolute shape at
    // every page and lets that page's own MediaBox reveal only its true portion.
    const blockClone = !isInline && boxDecorationBreak === 'clone' && spans.length > 1
    const defaultGeom = blockClone ? null : computeGeom(h)

    // A box taller than one page draws its full, unmodified shape once per page it
    // touches — each page's own MediaBox naturally clips it to the right visible
    // slice, so the fill/border continues seamlessly across the break instead of
    // being lost past the first page's bottom edge. (blockClone overrides this.)
    for (const { page, y: ly } of spans) {
      let by = ly, bh = h
      if (blockClone) {
        const fragTop    = Math.max(0, ly)
        const fragBottom = Math.min(ctx.pageH, ly + h)
        bh = fragBottom - fragTop
        if (bh <= 0.01) continue
        by = fragTop
      }
      const { fillBox, fillInset, bgLayers } = blockClone ? computeGeom(bh) : defaultGeom!

      const splitShadow = shadows.length > 0 && (bgClipText || fillInset)
      if (splitShadow) {
        ctx.commands.push({
          type: 'rect', page, x, y: by, w, h: bh,
          fill: null, shadow: shadows, radius,
          opacity, blend,
        } as RectCommand)
      }
      if (paintsFill || (shadows.length && !splitShadow)) {
        // rgba()'s own alpha only applies to the plain solid fill — gradient stops
        // and shadow colors already carry their own alpha independently
        ctx.commands.push({
          type: 'rect', page,
          x: x + fillBox.dx, y: by + fillBox.dy, w: fillBox.w, h: fillBox.h,
          fill:     paintsFill ? (bgColor ?? null) : null,
          shadow:   splitShadow ? undefined : (shadows.length ? shadows : undefined),
          radius:   fillBox.radius,
          opacity: combineOpacity(opacity, bgAlpha),
          blend,
        } as RectCommand)
      }

      for (const L of bgLayers) {
        const lx = x + L.box.dx, lyy = by + L.box.dy
        if (L.gradient) {
          ctx.commands.push({
            type: 'rect', page,
            x: lx, y: lyy, w: L.box.w, h: L.box.h,
            fill: null, gradient: L.gradient,
            radius: L.box.radius,
            opacity, blend,
          } as RectCommand)
        } else if (L.conicSrc) {
          const rounded = !!L.box.radius
          if (rounded) ctx.commands.push({ type: 'clip-push', page, x: lx, y: lyy, w: L.box.w, h: L.box.h, radius: L.box.radius } as ClipCommand)
          ctx.commands.push({
            type: 'image', page, src: L.conicSrc, format: 'png',
            x: lx, y: lyy, w: L.box.w, h: L.box.h,
            opacity, blend,
          } as ImageCommand)
          if (rounded) ctx.commands.push({ type: 'clip-pop', page } as ClipCommand)
        }
      }

      // border-image, when its source resolves, paints OVER the normal CSS
      // border entirely (border-style/color still exist for layout only) —
      // the actual image tiles are async (fetch/canvas crop), so they're
      // emitted separately from walk.ts's emitBorderImage, not inline here
      if (!hasBorderImage(s)) {
      if (uniformSolid && bWidths[0] > 0 && bStyles[0] !== 'none' && bColorAlphas[0]) {
        const { color: strokeColor, alpha: strokeAlpha } = splitColorAlpha(bColorAlphas[0])
        ctx.commands.push({
          type: 'rect', page, x, y: by, w, h: bh,
          fill: null,
          stroke: strokeColor,
          strokeWidth: bWidths[0],
          radius, opacity: combineOpacity(opacity, strokeAlpha), blend,
        } as RectCommand)
      } else if (!fragmented && allSame && radius && bWidths[0] > 0 && bColorAlphas[0] &&
                 (bStyles[0] === 'dashed' || bStyles[0] === 'dotted')) {
        // uniform dashed/dotted with rounded corners: a stroked path carries the
        // dash pattern around the curve — the four-line branch would square them
        const { color: strokeColor, alpha: strokeAlpha } = splitColorAlpha(bColorAlphas[0])
        ctx.commands.push({
          type: 'rect', page, x, y: by, w, h: bh,
          fill: null,
          stroke: strokeColor,
          strokeWidth: bWidths[0],
          strokeStyle: bStyles[0],
          radius, opacity: combineOpacity(opacity, strokeAlpha), blend,
        } as RectCommand)
      } else {
        // each side's line runs at `off` from its own outer edge, perpendicular to it
        const sideLine = (i: number, off: number) =>
          i === 0 ? { x1: x,           y1: by + off,      x2: x + w,       y2: by + off      } :
          i === 1 ? { x1: x + w - off, y1: by,            x2: x + w - off, y2: by + bh       } :
          i === 2 ? { x1: x,           y1: by + bh - off, x2: x + w,       y2: by + bh - off } :
                    { x1: x + off,     y1: by,            x2: x + off,     y2: by + bh       }
        for (let i = 0; i < 4; i++) {
          // a fragment's cut side draws no border line at all — the box
          // visually continues past it, there is no true edge there to stroke
          if ((i === 3 && suppressLeft) || (i === 1 && suppressRight)) continue
          const bw = bWidths[i]!, bStyle = bStyles[i]!, bCA = bColorAlphas[i]
          if (bw > 0 && bStyle !== 'none' && bCA) {
            const { color: lineColor, alpha: lineAlpha } = splitColorAlpha(bCA)
            const lineOpacity = combineOpacity(opacity, lineAlpha)
            // double = two sub-lines of a third the width at the outer and inner
            // thirds of the border band, with the middle third left open
            if (bStyle === 'double' && bw >= 2) {
              const t = bw
              for (const off of [t / 6, t * 5 / 6]) {
                ctx.commands.push({
                  type: 'line', page, ...sideLine(i, off),
                  width: t / 3, color: lineColor!,
                  lineStyle: 'solid',
                  opacity: lineOpacity, blend,
                } as LineCommand)
              }
              continue
            }
            ctx.commands.push({
              type: 'line', page, ...sideLine(i, bw / 2),
              width: bw, color: lineColor!,
              lineStyle: normBorderStyle(bStyle),
              opacity: lineOpacity, blend,
            } as LineCommand)
          }
        }
      }
      }

      if (oColorA && w + oGrow * 2 > 0 && bh + oGrow * 2 > 0) {
        const { color: oc, alpha: oa } = splitColorAlpha(oColorA)
        ctx.commands.push({
          type: 'rect', page,
          x: x - oGrow, y: by - oGrow, w: w + oGrow * 2, h: bh + oGrow * 2,
          fill: null,
          stroke: oc,
          strokeWidth: oWidth,
          strokeStyle: (oStyle === 'dashed' || oStyle === 'dotted') ? oStyle : undefined,
          radius: oRadius,
          opacity: combineOpacity(opacity, oa),
          blend,
        } as RectCommand)
      }
    }
  }
}

function applyTextTransform(text: string, transform: string): string {
  if (transform === 'uppercase')  return text.toUpperCase()
  if (transform === 'lowercase')  return text.toLowerCase()
  // \b\w is ASCII-only — "över" or "état" would stay lowercase while the preview
  // capitalizes them. Apostrophes are word-internal ("don't" → "Don't", not "Don'T").
  if (transform === 'capitalize') return text.replace(/(^|[^\p{L}\p{N}'’])(\p{L})/gu, (_, p, c) => p + c.toUpperCase())
  return text
}

// ::first-letter/::first-line apply to the block's opening text — this node
// carries them only if nothing (element or non-blank text) precedes it
function isFirstContentOfBlock(textNode: Text): boolean {
  let n = textNode.previousSibling
  while (n) {
    if (n.nodeType === Node.ELEMENT_NODE) return false
    if (n.nodeType === Node.TEXT_NODE && (n.textContent ?? '').trim()) return false
    n = n.previousSibling
  }
  return true
}

// getComputedStyle(el, pseudo) resolves even when no rule matched — the only
// signal a rule EXISTS is a computed value differing from the element's own
function pseudoTextOverride(el: Element, which: '::first-letter' | '::first-line', s: CSSStyleDeclaration): CSSStyleDeclaration | null {
  const p = getComputedStyle(el, which)
  const differs = p.fontSize !== s.fontSize || p.fontFamily !== s.fontFamily ||
    p.fontWeight !== s.fontWeight || p.fontStyle !== s.fontStyle ||
    p.color !== s.color || p.letterSpacing !== s.letterSpacing ||
    p.textTransform !== s.textTransform ||
    (which === '::first-letter' && p.cssFloat !== 'none')
  return differs ? p : null
}

interface LineStyle {
  fontRef:     { name: string; style: string; weight: number }
  sizePt:      number
  color:       Color
  textOpacity: number | undefined
  lsPt:        number | undefined
}

// Flex/grid containers wrap each contiguous in-flow text run in its own
// anonymous item — but a plain element inserted among the children is NOT
// part of that run, so it becomes a SEPARATE item, independently aligned
// (e.g. align-items:center centers a zero-height anchor on its own, landing
// at the container's cross-axis center rather than on the real text's own
// baseline). A wrapper wasn't needed before because the common case (block/
// inline text) has no such grouping to break — a sibling span there just
// joins the same line box as everything else.
function baselineNeedsWrapper(parentEl: Element): boolean {
  const d = getComputedStyle(parentEl).display
  return d === 'flex' || d === 'inline-flex' || d === 'grid' || d === 'inline-grid'
}

// Reads a text run's real on-screen baseline Y (viewport px) via a zero-size
// `vertical-align:baseline` anchor. In a flex/grid parentEl, the anchor is
// wrapped together with textNode in one shared inline box first, so both
// remain a single flex/grid item and the anchor inherits the run's own line
// box instead of being centered as an independent, contentless item.
function measureBaselineY(parentEl: Element, textNode: Text, before: boolean): number {
  const anchor = document.createElement('span')
  anchor.style.cssText = 'display:inline;font-size:0;line-height:0;vertical-align:baseline;'
  if (!baselineNeedsWrapper(parentEl)) {
    parentEl.insertBefore(anchor, before ? textNode : textNode.nextSibling)
    const y = anchor.getBoundingClientRect().top
    parentEl.removeChild(anchor)
    return y
  }
  const wrapper = document.createElement('span')
  wrapper.style.cssText = 'display:inline;'
  parentEl.insertBefore(wrapper, textNode)
  if (before) { wrapper.appendChild(anchor); wrapper.appendChild(textNode) }
  else        { wrapper.appendChild(textNode); wrapper.appendChild(anchor) }
  const y = anchor.getBoundingClientRect().top
  parentEl.insertBefore(textNode, wrapper)
  parentEl.removeChild(wrapper)
  return y
}

// A4 (vertical writing modes): a deliberately scoped-down sibling of
// captureTextNode below, for `writing-mode: vertical-rl/lr` blocks. Supports
// plain colored text down a column; does NOT attempt decorations, shadows,
// ellipsis, first-letter/line, or per-character font fallback — those are
// all real, separate features whose horizontal implementations don't
// translate onto a rotated axis for free, and combining "rare CSS feature"
// with "rare writing mode" isn't worth the added complexity this pass.
// Multi-page vertical columns are also out of scope (assumed to fit one page).
export function captureVerticalTextNode(
  textNode: Text,
  _parentEl: Element,
  s:        CSSStyleDeclaration,
  ctx:      WalkerCtx,
): void {
  const raw = textNode.textContent ?? ''
  if (!raw.trim()) return
  if (s.visibility === 'hidden' || s.visibility === 'collapse') return

  const fontRef = resolveFontRef(s.fontFamily, s.fontWeight, s.fontStyle, ctx.fontMap, ctx.registeredFonts)
  if (!fontRef) {
    const fam = (s.fontFamily.split(',')[0] ?? '').replace(/["']/g, '').trim()
    console.warn(`[daepdf] Font "${fam}" is not registered — vertical text skipped. Register via loadFontsFromManifest() or loadAndRegisterFont().`)
    return
  }

  const sizePx = parseFloat(s.fontSize) || 16
  const sizePt = sizePx / PX_PER_PT
  const colorAlphaVal = parseColorAlpha(s.color)
  const color: Color = colorAlphaVal ? [colorAlphaVal[0], colorAlphaVal[1], colorAlphaVal[2]] : [0, 0, 0]
  const opacity = stackOpacity(ctx)
  const blend   = stackBlend(ctx)

  const chars = [...raw]
  const range = document.createRange()
  interface CharHit { ch: string; rect: DOMRect }
  const hits: CharHit[] = []
  let charIdx = 0
  for (const ch of chars) {
    range.setStart(textNode, charIdx)
    range.setEnd(textNode, charIdx + ch.length)
    const r = range.getBoundingClientRect()
    charIdx += ch.length
    if (r.width < 0.01 && r.height < 0.01) continue
    hits.push({ ch, rect: r })
  }
  range.detach?.()
  if (!hits.length) return

  // group by LEFT (column) instead of TOP (line) — the same tolerance-
  // clustering captureTextNode uses for horizontal lines, axes swapped:
  // a vertical column's characters share an x position and advance in y,
  // the mirror image of a horizontal line's shared y and advancing x
  interface ColumnGroup { chars: CharHit[]; left: number; minTop: number }
  const columns: ColumnGroup[] = []
  for (const hit of hits) {
    const left = hit.rect.left
    const existing = columns.find(c => Math.abs(c.left - left) < 3)
    if (existing) {
      existing.chars.push(hit)
      existing.minTop = Math.min(existing.minTop, hit.rect.top)
    } else {
      columns.push({ chars: [hit], left, minTop: hit.rect.top })
    }
  }

  // vertical-rl columns progress right-to-left, vertical-lr left-to-right —
  // each column's own explicit position makes this ordering immaterial to
  // correctness, kept only for deterministic/readable command output
  columns.sort((a, b) => s.writingMode === 'vertical-lr' ? a.left - b.left : b.left - a.left)

  for (const col of columns) {
    const text = col.chars.map(c => c.ch).join('')
    if (!text.trim()) continue
    const colLeft  = Math.min(...col.chars.map(c => c.rect.left))
    const colRight = Math.max(...col.chars.map(c => c.rect.right))
    // the LEFT edge, not the center — PDF vertical writing positions the
    // text matrix at the glyph's "horizontal origin" (the same left-edge
    // reference normal horizontal Tj uses) and the viewer itself shifts by
    // the font's own v1x (half the glyph's width, from /W2's per-spec
    // default) to find the centered "vertical origin" — passing the center
    // here would double that offset
    const colX     = (colLeft - ctx.containerRect.left) / PX_PER_PT
    const colTopPx = col.minTop - ctx.containerRect.top

    const { page, y: ly } = paginate(colTopPx / PX_PER_PT, ctx.pageH)
    ctx.commands.push({
      type: 'text', page, text, vertical: true,
      x: colX, y: ly,
      font: fontRef.name, style: fontRef.style, weight: fontRef.weight,
      size: sizePt, color,
      align: 'left', maxWidth: (colRight - colLeft) / PX_PER_PT,
      opacity, blend,
    } as TextCommand)
  }
}

export function captureTextNode(
  textNode: Text,
  parentEl: Element,
  s:        CSSStyleDeclaration,
  ctx:      WalkerCtx,
): void {
  const raw = textNode.textContent ?? ''
  if (!raw.trim()) return
  // visibility is the parent's — hidden text still occupies space but never paints
  if (s.visibility === 'hidden' || s.visibility === 'collapse') return

  const fontRef = resolveFontRef(s.fontFamily, s.fontWeight, s.fontStyle, ctx.fontMap, ctx.registeredFonts)
  if (!fontRef) {
    const fam = (s.fontFamily.split(',')[0] ?? '').replace(/["']/g, '').trim()
    console.warn(`[daepdf] Font "${fam}" is not registered — text skipped. Register via loadFontsFromManifest() or loadAndRegisterFont().`)
    return
  }

  const sizePx  = parseFloat(s.fontSize) || 16
  const sizePt  = sizePx / PX_PER_PT
  // -webkit-text-fill-color overrides color for painting (it defaults to the color
  // value) — the gradient-text pattern almost always uses text-fill-color:transparent
  const colorSrc = String((s as any).webkitTextFillColor || s.color)
  const colorAlphaVal = parseColorAlpha(colorSrc)
  const { color: colorRgb, alpha: colorAlpha } = splitColorAlpha(colorAlphaVal)
  let color    = colorRgb ?? ([0, 0, 0] as Color)
  let drawText = true
  // a transparent paint color parses to null exactly like "no color" — without this it
  // falls back to opaque black. background-clip:text (transparent text over a gradient)
  // is approximated with the first gradient stop / background color as the text color,
  // since a PDF box fill can't be clipped to glyph outlines.
  if (colorAlphaVal === null && isTransparentColor(colorSrc)) {
    let sub: Color | null = null
    const clipsText = String((s as any).webkitBackgroundClip || s.backgroundClip || '').includes('text')
    if (clipsText) {
      if (s.backgroundImage && s.backgroundImage !== 'none') {
        for (const layer of splitByTopLevelComma(s.backgroundImage)) {
          const g = parseCSSGradient(layer.trim())
          const gs0 = g?.stops[0]
          if (gs0) { sub = [gs0.color[0], gs0.color[1], gs0.color[2]]; break }
        }
      }
      if (!sub) {
        const bg = parseColorAlpha(s.backgroundColor)
        if (bg) sub = [bg[0], bg[1], bg[2]]
      }
    }
    if (sub) color = sub
    // image-clipped text has no color to substitute — readable black beats invisible
    else if (!clipsText) drawText = false
  }
  const lsPt    = s.letterSpacing === 'normal' ? undefined : pxToPt(s.letterSpacing) || undefined
  const wsPt    = s.wordSpacing   === 'normal' ? undefined : pxToPt(s.wordSpacing)   || undefined
  const txform  = s.textTransform
  const opacity  = stackOpacity(ctx)
  const blend    = stackBlend(ctx)
  const textOpacity = combineOpacity(opacity, colorAlpha)

  // -webkit-text-stroke — PDF strokes glyph outlines natively (render mode 1/2);
  // a transparent fill with a stroke means stroke-only (mode 1), not invisible text
  const tsWidthPt = pxToPt(String((s as any).webkitTextStrokeWidth || '0px'))
  const tsCA      = tsWidthPt > 0 ? parseColorAlpha(String((s as any).webkitTextStrokeColor || '')) : null
  const textStroke = tsCA ? { color: [tsCA[0], tsCA[1], tsCA[2]] as Color, width: tsWidthPt } : null
  let strokeOnly = false
  if (textStroke && !drawText) { drawText = true; strokeOnly = true }

  // text-decoration paints across descendants but is NOT inherited — computed style on
  // a <span> inside an underlined <a> reports "none", so read the ancestor chain up to
  // the nearest propagation boundary (out-of-flow, float, atomic inline), as browsers do
  interface Deco {
    part: string; color: Color; alpha: number; lineStyle: 'solid' | 'dashed' | 'dotted' | 'wavy'
    thicknessPt?: number | undefined; underlineOffsetPt?: number | undefined
  }
  const decos: Deco[] = []
  {
    const seen = new Set<string>()
    let decoEl: Element | null = parentEl
    let decoStyle = s
    while (decoEl) {
      const dl = decoStyle.textDecorationLine
      if (dl && dl !== 'none') {
        for (const part of dl.split(' ')) {
          if (seen.has(part)) continue
          seen.add(part)
          // an explicitly transparent decoration color means invisible — only fall
          // back to the text color when the value merely failed to parse
          const dcRaw = decoStyle.textDecorationColor
          const ca = parseColorAlpha(dcRaw) ?? (isTransparentColor(dcRaw) ? null : parseColorAlpha(decoStyle.color))
          if (!ca) continue
          // authored px values override the heuristics; auto/from-font keep them
          const thM = (decoStyle.textDecorationThickness || '').match(/^(-?[\d.]+)px$/)
          const uoM = ((decoStyle as any).textUnderlineOffset || '').match(/^(-?[\d.]+)px$/)
          decos.push({
            part,
            color: [ca[0], ca[1], ca[2]],
            alpha: ca[3] / 255,
            lineStyle: normBorderStyle(decoStyle.textDecorationStyle),
            thicknessPt:       thM?.[1] ? Math.max(0.1, +thM[1] / PX_PER_PT) : undefined,
            underlineOffsetPt: uoM?.[1] ? +uoM[1] / PX_PER_PT : undefined,
          })
        }
      }
      const d = decoStyle.display
      if (decoStyle.position === 'absolute' || decoStyle.position === 'fixed' ||
          decoStyle.cssFloat !== 'none' ||
          d === 'inline-block' || d === 'inline-table' || d === 'inline-flex' || d === 'inline-grid') break
      decoEl = decoEl.parentElement
      if (!decoEl || decoEl === document.body) break
      decoStyle = getComputedStyle(decoEl)
    }
  }

  if (!drawText && !decos.length) return

  // ::first-letter / ::first-line style overrides for the block's opening text.
  // The browser already laid the styled glyphs out — every rect measured below
  // reflects the pseudo styling; only the EMITTED font/size/color must follow.
  const blockish = s.display === 'block' || s.display === 'list-item' ||
    s.display === 'flow-root' || s.display === 'table-cell'
  const firstContent = blockish && isFirstContentOfBlock(textNode)
  const flStyle  = firstContent && drawText ? pseudoTextOverride(parentEl, '::first-letter', s) : null
  const fllStyle = firstContent && drawText ? pseudoTextOverride(parentEl, '::first-line', s) : null

  // first letter = leading punctuation + one letter/digit + combining marks; it
  // gets its own TextCommand, so the word scan below starts past it
  let flStart = 0, flEnd = 0
  if (flStyle) {
    const flM = raw.match(/^(\s*)([\p{P}\p{S}]*[\p{L}\p{N}][̀-ͯ]*)/u)
    if (flM) { flStart = (flM[1] ?? '').length; flEnd = flStart + (flM[2] ?? '').length }
  }

  const range = document.createRange()

  // a <wbr>-chunked long word continues across text nodes — its continuation chunk
  // must not be treated as a fresh word start by text-transform: capitalize
  const continuesWord = textNode.previousSibling?.nodeName === 'WBR'

  interface WordHit { text: string; rect: DOMRect; start: number; len: number }
  const wordHits: WordHit[] = []
  const re = /\S+/g
  re.lastIndex = flEnd
  let m: RegExpExecArray | null
  while ((m = re.exec(raw)) !== null) {
    try {
      range.setStart(textNode, m.index)
      range.setEnd(textNode, m.index + m[0].length)
    } catch {
      continue
    }
    const midWordChunk = txform === 'capitalize' && m.index === 0 && continuesWord
    const frags = Array.from(range.getClientRects()).filter(fr => fr.width > 0.1 && fr.height > 0.1)
    if (frags.length <= 1) {
      const r = frags[0] ?? range.getBoundingClientRect()
      if (r.width < 0.1 && r.height < 0.1) continue
      wordHits.push({
        text: midWordChunk ? m[0] : applyTextTransform(m[0], txform),
        rect: r, start: m.index, len: m[0].length,
      })
      continue
    }
    // the word wraps across line boxes (long token / CJK run) — its bounding rect is
    // the useless union of all fragments. Segment it per line via per-char tops so
    // each piece lands on its own line at its own measured position.
    let segStart = m.index
    let prevTop: number | null = null
    const closeSegment = (endIdx: number) => {
      if (endIdx <= segStart) return
      range.setStart(textNode, segStart)
      range.setEnd(textNode, endIdx)
      const sr = range.getBoundingClientRect()
      if (sr.width < 0.1 && sr.height < 0.1) return
      const slice = raw.slice(segStart, endIdx)
      // capitalize only applies at a word start — a mid-word segment must not re-capitalize
      const capAtStart = segStart === m!.index && !midWordChunk
      const segText = (txform !== 'capitalize' || capAtStart) ? applyTextTransform(slice, txform) : slice
      wordHits.push({ text: segText, rect: sr, start: segStart, len: endIdx - segStart })
    }
    for (let ci = 0; ci < m[0].length; ci++) {
      range.setStart(textNode, m.index + ci)
      range.setEnd(textNode, m.index + ci + 1)
      const cr = range.getBoundingClientRect()
      if (cr.width < 0.01 && cr.height < 0.01) continue
      if (prevTop !== null && Math.abs(cr.top - prevTop) > 3) {
        closeSegment(m.index + ci)
        segStart = m.index + ci
      }
      prevTop = cr.top
    }
    closeSegment(m.index + m[0].length)
  }
  range.detach?.()

  // A6 (hyphenation glyph): `hyphens: auto`'s browser-inserted hyphen at a line
  // break is a rendering-only decoration, never part of the DOM text — without
  // this, the emitted PDF silently drops the trailing "-" a wrapped word shows
  // on screen. Detected here, not against the hyphenation dictionary's exact
  // break point (not queryable): two consecutive wordHits are actually one
  // continuous source word split by a MID-WORD wrap when the next hit picks up
  // exactly where this one ends (no whitespace was skipped — `\S+` can't match
  // two tokens with zero gap) AND lands on a different line. Appending '-'
  // directly to the wordHit's own text means both the joined-line (`lineOut`)
  // and per-word emission paths pick it up for free, since both read straight
  // from `wordHits[i].text` — no separate handling needed for either.
  if (s.hyphens === 'auto') {
    for (let i = 0; i < wordHits.length - 1; i++) {
      const cur = wordHits[i]!, next = wordHits[i + 1]!
      if (next.start === cur.start + cur.len && Math.abs(next.rect.top - cur.rect.top) > 3) {
        cur.text += '-'
      }
    }
  }

  if (!wordHits.length && !flEnd) return

  interface LineGroup { words: WordHit[]; minX: number; top: number }
  const lines: LineGroup[] = []
  for (const hit of wordHits) {
    const top = hit.rect.top
    const existing = lines.find(l => Math.abs(l.top - top) < 3)
    if (existing) {
      existing.words.push(hit)
      existing.minX = Math.min(existing.minX, hit.rect.left)
    } else {
      lines.push({ words: [hit], minX: hit.rect.left, top })
    }
  }

  const firstBaselineY = measureBaselineY(parentEl, textNode, true) - ctx.containerRect.top

  if (flEnd > 0) {
    const flRange = document.createRange()
    flRange.setStart(textNode, flStart)
    flRange.setEnd(textNode, flEnd)
    const flRect = flRange.getBoundingClientRect()
    if (flRect.width > 0.1 && flRect.height > 0.1) {
      const flFont   = resolveFontRef(flStyle!.fontFamily, flStyle!.fontWeight, flStyle!.fontStyle, ctx.fontMap, ctx.registeredFonts) ?? fontRef
      const flSizePx = parseFloat(flStyle!.fontSize) || sizePx
      const flCA     = parseColorAlpha(String((flStyle as any).webkitTextFillColor || flStyle!.color))
      // an inline drop cap sits on the first line's shared baseline (that IS
      // inline layout); a floated one lives in its own box, so approximate its
      // baseline from the glyph box center, matching text()'s 'middle' math
      const floated    = flStyle!.cssFloat !== 'none'
      const baselinePx = floated
        ? (flRect.top + flRect.bottom) / 2 - ctx.containerRect.top + flSizePx * 0.35
        : firstBaselineY
      const { page, y: ly } = paginate(baselinePx / PX_PER_PT, ctx.pageH)
      ctx.commands.push({
        type: 'text', page,
        text: applyTextTransform(raw.slice(flStart, flEnd), flStyle!.textTransform),
        x: (flRect.left - ctx.containerRect.left) / PX_PER_PT, y: ly,
        font: flFont.name, style: flFont.style, weight: flFont.weight,
        size: flSizePx / PX_PER_PT,
        color: flCA ? [flCA[0], flCA[1], flCA[2]] as Color : color,
        align: 'left',
        maxWidth: flRect.width / PX_PER_PT + flSizePx / PX_PER_PT,
        opacity: combineOpacity(opacity, flCA ? flCA[3] / 255 : colorAlpha),
        blend,
      } as TextCommand)
    }
  }
  if (!lines.length) return

  // justify stretches inter-word gaps and pre preserves space runs — a line joined
  // with single spaces loses both, drifting further right the longer the line gets.
  // Each word already has its own measured rect, so emit words individually instead.
  // word-spacing also forces per-word emission: the PDF Tw operator only applies to
  // single-byte code 32, which never occurs in Identity-H (2-byte CID) text — the
  // browser's word rects already carry the widened gaps, Tw would be a silent no-op
  const wsMode  = s.whiteSpace
  // a bidi-mixed run (e.g. "Invoice مرحبا 123") also needs per-word emission —
  // see hasBidiMix's own comment for why this is a complete fix, not a partial one
  const perWord = s.textAlign === 'justify' || wsMode === 'pre' || wsMode === 'pre-wrap' || wsMode === 'break-spaces' ||
    wsPt !== undefined || hasBidiMix(raw)

  // computed text-shadow shares box-shadow's serialization (color first, px lengths)
  const tShadows = parseCSSBoxShadow(s.textShadow)

  // text-overflow: ellipsis — the browser paints "…" where our overflow clip would
  // hard-cut glyphs mid-shape. Only kicks in when the parent actually overflows.
  // RTL puts the ellipsis on the left; a hard clip beats truncating the wrong side.
  let ellipsisLimitPx = Infinity
  if (drawText && s.textOverflow === 'ellipsis' && wsMode === 'nowrap' && s.direction !== 'rtl') {
    const ox = s.overflowX
    if (ox === 'hidden' || ox === 'clip' || ox === 'auto' || ox === 'scroll') {
      const pe = parentEl as HTMLElement
      if (pe.scrollWidth > pe.clientWidth + 1) {
        const pr = pe.getBoundingClientRect()
        ellipsisLimitPx = pr.left + pe.clientLeft + pe.clientWidth - (parseFloat(s.paddingRight) || 0)
      }
    }
  }

  const firstLineTop = Math.min(...lines.map(l => l.top))
  // constant offset from a line's top to its own baseline, for this font/size — real
  // fonts' natural line-height varies from any fixed multiplier (the old code assumed
  // sizePx*1.2 for CSS line-height:normal), so extrapolating later lines' Y as
  // lineIndex*lineHeightPx drifted further off with every additional line. Using each
  // line's own measured top plus this constant instead needs no line-height guess at all.
  const ascentOffset = firstBaselineY - (firstLineTop - ctx.containerRect.top)

  const baseStyle: LineStyle = { fontRef, sizePt, color, textOpacity, lsPt }
  let fllResolved: LineStyle | null = null
  // a first-line override changes the top-to-baseline distance for line 1 only —
  // the start probe measured line 1's baseline, so a second probe after the node
  // (in the last, normally-styled line) supplies the offset for the other lines
  let ascentOffsetRest = ascentOffset
  if (fllStyle && lines.length) {
    const fllFont   = resolveFontRef(fllStyle.fontFamily, fllStyle.fontWeight, fllStyle.fontStyle, ctx.fontMap, ctx.registeredFonts) ?? fontRef
    const fllSizePx = parseFloat(fllStyle.fontSize) || sizePx
    const fllCA     = parseColorAlpha(String((fllStyle as any).webkitTextFillColor || fllStyle.color))
    fllResolved = {
      fontRef: fllFont,
      sizePt:  fllSizePx / PX_PER_PT,
      color:   fllCA ? [fllCA[0], fllCA[1], fllCA[2]] as Color : color,
      textOpacity: combineOpacity(opacity, fllCA ? fllCA[3] / 255 : colorAlpha),
      lsPt: fllStyle.letterSpacing === 'normal' ? undefined : pxToPt(fllStyle.letterSpacing) || undefined,
    }
    if (lines.length > 1) {
      const lastBaselineY = measureBaselineY(parentEl, textNode, false) - ctx.containerRect.top
      const lastLineTop = Math.max(...lines.map(l => l.top))
      ascentOffsetRest = lastBaselineY - (lastLineTop - ctx.containerRect.top)
    }
  }

  for (const [li, line] of lines.entries()) {
    const st   = li === 0 && fllResolved ? fllResolved : baseStyle
    // ::first-line overrides font-family too — per-character fallback must walk
    // THAT family list, not the node's own, or it fails to find fonts the
    // override itself would have covered
    const famSrc = li === 0 && fllResolved ? fllStyle! : s
    const lineAscent = li === 0 ? ascentOffset : (fllResolved ? ascentOffsetRest : ascentOffset)
    const lineText = line.words.map(w => w.text).join(' ')
    if (!lineText.trim()) continue

    const xPx       = line.minX - ctx.containerRect.left
    const yPx        = (line.top - ctx.containerRect.top) + lineAscent
    const xPt        = xPx / PX_PER_PT
    const yPt        = yPx / PX_PER_PT
    const rightEdge  = Math.max(...line.words.map(w => w.rect.right))
    const wPt        = (rightEdge - ctx.containerRect.left) / PX_PER_PT - xPt

    const { page, y: ly } = paginate(yPt, ctx.pageH)

    // truncate at the ellipsis limit: whole words while they fit, then the boundary
    // word character by character, then append the ellipsis the browser shows
    let lineOut   = lineText
    let truncated = false
    if (ellipsisLimitPx !== Infinity) {
      const ellW  = measure_string_width('…', fontRef.name, fontRef.style, fontRef.weight, 0, sizePt) * PX_PER_PT
      const limit = ellipsisLimitPx - ellW
      const kept: string[] = []
      for (const wd of line.words) {
        if (wd.rect.right <= limit) { kept.push(wd.text); continue }
        truncated = true
        if (wd.rect.left < limit) {
          let sub = ''
          for (let ci = 1; ci <= wd.len; ci++) {
            const r2 = document.createRange()
            r2.setStart(textNode, wd.start)
            r2.setEnd(textNode, wd.start + ci)
            if (r2.getBoundingClientRect().right > limit) break
            sub = raw.slice(wd.start, wd.start + ci)
          }
          if (sub) kept.push(applyTextTransform(sub, txform))
        }
        break
      }
      if (truncated) {
        // if even the first word starts past the limit, an earlier sibling node
        // already carries the ellipsis — emit nothing here
        const anyVisible = kept.length > 0 || (line.words[0]?.rect.left ?? 0) < limit
        lineOut = anyVisible ? kept.join(' ') + '…' : ''
      }
      if (!lineOut) continue
    }

    const emitRun = (txt: string, tx: number, maxW: number, font: FontRef, ws?: number) => {
      for (let si = tShadows.length - 1; si >= 0; si--) {
        const sh = tShadows[si]!
        ctx.commands.push({
          type: 'text', page, text: txt,
          x: tx + sh.x, y: ly + sh.y,
          font: font.name, style: font.style, weight: font.weight,
          size: st.sizePt, color: [sh.color[0], sh.color[1], sh.color[2]] as Color,
          align: 'left', maxWidth: maxW,
          direction: s.direction === 'rtl' ? 'rtl' : 'ltr',
          letterSpacing: st.lsPt, wordSpacing: ws,
          // blur is approximated by knocking the shadow's alpha down
          opacity: combineOpacity(opacity, (sh.color[3] ?? 255) / 255 * (sh.blur ? 0.55 : 1)),
          blend,
        } as TextCommand)
      }
      ctx.commands.push({
        type: 'text', page, text: txt,
        x: tx, y: ly,
        font: font.name, style: font.style, weight: font.weight,
        size: st.sizePt, color: st.color,
        align: 'left', maxWidth: maxW,
        direction: s.direction === 'rtl' ? 'rtl' : 'ltr',
        letterSpacing: st.lsPt, wordSpacing: ws,
        opacity: st.textOpacity,
        stroke: textStroke?.color,
        strokeWidth: textStroke?.width,
        strokeOnly: textStroke ? strokeOnly : undefined,
        blend,
      } as TextCommand)
    }

    // per-character font fallback (a codepoint st.fontRef doesn't cover falls
    // back to a font that does) splits txt into per-font runs, each emitted at
    // its own cumulative x — skipped for RTL, where maxWidth instead anchors
    // the whole run's right edge (pdf/index.ts) and a sub-run's own width
    // would need its own bidi-aware repositioning, out of this batch's scope
    const emitTextCmd = (txt: string, tx: number, maxW: number, ws?: number) => {
      if (s.direction === 'rtl') { emitRun(txt, tx, maxW, st.fontRef, ws); return }
      const runs = splitByFontCoverage(txt, st.fontRef, famSrc.fontFamily, famSrc.fontWeight, famSrc.fontStyle, ctx.fontMap, ctx.registeredFonts)
      if (runs.length === 1) { emitRun(txt, tx, maxW, st.fontRef, ws); return }
      let runX = tx
      for (const run of runs) {
        const runWidthPt = measure_string_width(run.text, run.font.name, run.font.style, run.font.weight, 0, st.sizePt)
        emitRun(run.text, runX, runWidthPt, run.font, ws)
        runX += runWidthPt
      }
    }

    // browser positions each word via DOM rects — emit left-aligned at the captured x
    if (drawText && perWord && !truncated) {
      for (const wd of line.words) {
        emitTextCmd(wd.text, (wd.rect.left - ctx.containerRect.left) / PX_PER_PT, wd.rect.width / PX_PER_PT)
      }
    } else if (drawText) {
      emitTextCmd(lineOut, xPt, wPt || st.sizePt * lineOut.length * 0.6, wsPt)
    }

    for (const deco of decos) {
      let dy: number
      if (deco.part === 'underline')         dy = ly + (deco.underlineOffsetPt ?? st.sizePt * 0.15)
      else if (deco.part === 'overline')     dy = ly - st.sizePt * 0.8
      else if (deco.part === 'line-through') dy = ly - st.sizePt * 0.3
      else continue
      ctx.commands.push({
        type: 'line', page,
        x1: xPt, y1: dy, x2: xPt + wPt, y2: dy,
        width: deco.thicknessPt ?? Math.max(0.4, st.sizePt / 14),
        color: deco.color,
        lineStyle: deco.lineStyle,
        opacity: combineOpacity(opacity, deco.alpha),
        blend,
      } as LineCommand)
    }
  }
}

function markerLabel(type: string, index: number): string | null {
  switch (type) {
    case 'disc':                 return '•'
    case 'circle':               return '◦'
    case 'square':               return '▪'
    case 'decimal':              return `${index}.`
    case 'decimal-leading-zero': return `${index < 10 && index >= 0 ? '0' : ''}${index}.`
    case 'lower-alpha':
    case 'lower-latin':          return `${alphaLabel(index)}.`
    case 'upper-alpha':
    case 'upper-latin':          return `${alphaLabel(index).toUpperCase()}.`
    case 'lower-roman':          return `${romanNumeral(index).toLowerCase()}.`
    case 'upper-roman':          return `${romanNumeral(index)}.`
    default:                     return '•'
  }
}

// Per the HTML living standard: an item's own `value` wins outright; otherwise
// it's one more than the NEAREST preceding list-item sibling's own ordinal
// (which itself may have come from an explicit `value`), not a fixed
// start-plus-position formula blind to any override in between. A prior
// version computed purely from `start + position`, silently ignoring any
// `<li value>` on an earlier sibling — e.g. `<li value="10">`, `<li>` numbered
// the second item "2" (position-based) instead of "11" (value-based).
function listIndex(el: Element): number {
  const li = el as HTMLLIElement
  if (li.value > 0) return li.value

  let gap = 0
  let sib: Element | null = el.previousElementSibling
  while (sib) {
    if (getComputedStyle(sib).display === 'list-item') {
      gap++
      const sibLi = sib as HTMLLIElement
      if (sibLi.value > 0) return sibLi.value + gap
    }
    sib = sib.previousElementSibling
  }
  const parent = el.parentElement
  const start = parent instanceof HTMLOListElement ? parent.start : 1
  return start + gap
}

// ul/ol bullets and numbers are ::marker boxes, not text nodes — without synthesizing
// them here, every list exports as indented text with no markers at all. The marker is
// right-aligned to end a small gap before the first line's content, which holds for
// both list-style-position values (for 'inside' the content starts after the marker,
// so the probe still lands to its right).
export function emitListMarker(el: Element, s: CSSStyleDeclaration, ctx: WalkerCtx): void {
  if (s.display !== 'list-item') return
  const type = s.listStyleType
  if (!type || type === 'none') return

  const ms = getComputedStyle(el, '::marker')
  // an authored ::marker { content: none } suppresses the marker (default is 'normal')
  if (ms.content === 'none') return
  let text: string | null = null
  const strM = (ms.content ?? '').match(/^"((?:[^"\\]|\\.)*)"$/)
  if (strM?.[1] !== undefined) text = strM[1].replace(/\\(.)/g, '$1')
  if (text === null) text = markerLabel(type, listIndex(el))
  if (!text) return

  const fontRef = resolveFontRef(s.fontFamily, s.fontWeight, s.fontStyle, ctx.fontMap, ctx.registeredFonts)
  if (!fontRef) return

  const probe = document.createElement('span')
  probe.style.cssText = 'display:inline;font-size:0;line-height:0;vertical-align:baseline;visibility:hidden;pointer-events:none;'
  try {
    el.insertBefore(probe, el.firstChild)
    const pr = probe.getBoundingClientRect()
    el.removeChild(probe)

    const sizePx = parseFloat(s.fontSize) || 16
    const sizePt = sizePx / PX_PER_PT
    const markerW = measure_string_width(text, fontRef.name, fontRef.style, fontRef.weight, 0, sizePt)
    const gapPt   = sizePt * 0.4

    const xPt = (pr.left - ctx.containerRect.left) / PX_PER_PT - gapPt - markerW
    const yPt = (pr.top  - ctx.containerRect.top)  / PX_PER_PT
    const { page, y: ly } = paginate(yPt, ctx.pageH)
    const { color: clr, alpha } = splitColorAlpha(parseColorAlpha(ms.color || s.color))

    ctx.commands.push({
      type: 'text', page,
      text,
      x: xPt, y: ly,
      font: fontRef.name, style: fontRef.style, weight: fontRef.weight,
      size: sizePt, color: clr ?? ([0, 0, 0] as Color),
      align: 'left',
      maxWidth: markerW + sizePt,
      opacity: combineOpacity(stackOpacity(ctx), alpha),
    } as TextCommand)
  } catch {
    try { el.removeChild(probe) } catch { /* already removed or never inserted */ }
  }
}

function isSafeHref(href: string): boolean {
  if (href.startsWith('#')) return true
  const lower = href.toLowerCase().trimStart()
  return lower.startsWith('http://') || lower.startsWith('https://') || lower.startsWith('mailto:')
}

export function emitLinks(el: HTMLAnchorElement, ctx: WalkerCtx): void {
  const href = el.getAttribute('href')
  if (!href || !isSafeHref(href)) return
  for (const domRect of Array.from(el.getClientRects())) {
    if (domRect.width < 1 || domRect.height < 1) continue
    const { x, y, w, h } = domRectToPt(domRect, ctx.containerRect)
    for (const { page, y: ly } of paginateSpan(y, h, ctx.pageH)) {
      // annotation rects aren't auto-clipped by the MediaBox the way drawn content
      // is, so each page's slice needs its own explicit clamped height
      const sliceTop = Math.max(0, ly)
      const sliceH   = Math.min(ctx.pageH, ly + h) - sliceTop
      if (sliceH < 0.5) continue
      ctx.commands.push({ type: 'link', page, href, x, y: sliceTop, w, h: sliceH } as LinkCommand)
    }
  }
}

// D1 (AcroForm): date/time/color/file/range/etc. have no plain-text PDF
// field equivalent worth the effort, and submit/button/reset/hidden/image
// aren't data fields at all — scoped to the controls that map cleanly onto
// /FT /Tx, /Btn, /Ch.
const TEXT_LIKE_INPUT_TYPES = new Set(['text', 'email', 'tel', 'url', 'number', 'password', 'search', ''])

// A form control spanning a page break would need /Kids (multiple widgets
// sharing one field) — real, but a genuine edge case for a typically-small
// input/select; placed on its single primary page only, a documented
// simplification matching the same "not attempted" scope as radio grouping.
export function emitFormField(el: Element, s: CSSStyleDeclaration, ctx: WalkerCtx): void {
  const tag = el.tagName.toUpperCase()
  const rect = el.getBoundingClientRect()
  if (rect.width < 1 || rect.height < 1) return
  const { x, y, w, h } = domRectToPt(rect, ctx.containerRect)
  const { page, y: ly } = paginate(y, ctx.pageH)
  const color = parseColorAlpha(s.color)
  const rgb: Color = color ? [color[0], color[1], color[2]] : [0, 0, 0]

  // field names must be unique per document — the DOM's own `name` attribute
  // is the natural source; an absent one still needs a stable, distinct name
  const name = (el as HTMLInputElement).name || `field${ctx.fieldCounter.n++}`

  // Btn (checkbox/radio) draws a pure-vector checkmark — no font involved at
  // all — so this must be dispatched BEFORE the font-resolution gate below.
  // Browsers' own UA stylesheets typically give form controls a non-inherited
  // default control font distinct from the surrounding page's font-family, so
  // gating on a resolved font (needed for Tx/Ch, which actually draw text)
  // silently dropped every checkbox/radio field entirely — confirmed via a
  // real render whose checkboxes never appeared in /AcroForm /Fields at all.
  if (tag === 'INPUT') {
    const inputType = ((el as HTMLInputElement).type || 'text').toLowerCase()
    if (inputType === 'checkbox' || inputType === 'radio') {
      ctx.commands.push({
        type: 'field', page, x, y: ly, w, h, name,
        font: '', style: '', weight: 400, size: 0, color: rgb,
        fieldType: 'Btn', checked: (el as HTMLInputElement).checked,
      } as FieldCommand)
      return
    }
  }

  // Unlike a plain text node, a form field's /V (value) and /T (name) carry
  // real document data with nothing to do with fonts — an unresolvable font
  // must only blank out the STATIC appearance (add_form_field degrades to an
  // empty AP stream, no /DA), not drop the whole field/widget/AcroForm entry.
  // This matters in practice: browsers give form controls a non-inherited
  // default control font (the same reason Btn is handled above), so an input
  // that doesn't EXPLICITLY repeat font-family on itself — extremely common,
  // since most authors rely on inheriting the page's own font — would
  // otherwise silently lose its entire field, confirmed via a real render.
  const fontRef = resolveFontRef(s.fontFamily, s.fontWeight, s.fontStyle, ctx.fontMap, ctx.registeredFonts)
  const sizePt = fontRef ? (parseFloat(s.fontSize) || 16) / PX_PER_PT : 0
  const base = {
    type: 'field' as const, page, x, y: ly, w, h, name,
    font: fontRef?.name ?? '', style: fontRef?.style ?? '', weight: fontRef?.weight ?? 400, size: sizePt, color: rgb,
  }

  if (tag === 'SELECT') {
    const select = el as HTMLSelectElement
    const options = Array.from(select.options).map(o => o.value || o.text)
    const sel = select.options[select.selectedIndex]
    ctx.commands.push({ ...base, fieldType: 'Ch', value: sel?.value || sel?.text || '', options } as FieldCommand)
    return
  }

  if (tag === 'TEXTAREA') {
    ctx.commands.push({ ...base, fieldType: 'Tx', value: (el as HTMLTextAreaElement).value } as FieldCommand)
    return
  }

  if (tag === 'INPUT') {
    const input = el as HTMLInputElement
    const inputType = (input.type || 'text').toLowerCase()
    if (TEXT_LIKE_INPUT_TYPES.has(inputType)) {
      ctx.commands.push({ ...base, fieldType: 'Tx', value: input.value } as FieldCommand)
    }
  }
}

export function captureAnchor(el: Element, ctx: WalkerCtx): void {
  if (!el.id) return
  // duplicate ids resolve to the first element, like getElementById
  if (ctx.anchors.has(el.id)) return
  const r   = el.getBoundingClientRect()
  const yPt = (r.top - ctx.containerRect.top) / PX_PER_PT
  const { page, y } = paginate(yPt, ctx.pageH)
  ctx.anchors.set(el.id, { page, y })
}

// Decorative pseudo boxes (accent bars, dividers, dots): content:'' plus a background
// and explicit dimensions. There is no DOM node to measure, so the box is placed from
// the geometry the browser DOES expose — computed size/margins/offsets plus the
// element's own rect — and only for layouts where that placement is exact; anything
// ambiguous (auto offsets, transforms beyond pure translate, flex/grid parents) is
// skipped rather than painted in the wrong place.
interface PseudoBoxSpec {
  anchor:    'flow' | 'abs' | 'probe'
  w:         number
  h:         number
  dx:        number
  dy:        number
  mL:        number | null
  mR:        number | null
  mT:        number
  mB:        number
  fill:      Color | null
  fillAlpha: number
  gradient?: Gradient | undefined
  border:    { w: number; color: Color; alpha: number } | null
  radius?:   BorderRadius | undefined
}

function pseudoBoxSpec(el: Element, ps: CSSStyleDeclaration): PseudoBoxSpec | null {
  const wPx = parseFloat(ps.width)
  const hPx = parseFloat(ps.height)
  if (!(wPx > 0) || !(hPx > 0)) return null
  const w = wPx / PX_PER_PT
  const h = hPx / PX_PER_PT

  const bgCA = parseColorAlpha(ps.backgroundColor)
  let gradient: Gradient | undefined
  if (ps.backgroundImage && ps.backgroundImage !== 'none') {
    for (const layer of splitByTopLevelComma(ps.backgroundImage)) {
      gradient = parseCSSGradient(layer.trim()) ?? undefined
      if (gradient) break
    }
  }
  let border: PseudoBoxSpec['border'] = null
  const bw = pxToPt(ps.borderTopWidth || '0px')
  if (bw > 0 && ps.borderTopStyle !== 'none' &&
      ps.borderRightWidth === ps.borderTopWidth &&
      ps.borderBottomWidth === ps.borderTopWidth &&
      ps.borderLeftWidth === ps.borderTopWidth) {
    const bCA = parseColorAlpha(ps.borderTopColor)
    if (bCA) border = { w: bw, color: [bCA[0], bCA[1], bCA[2]], alpha: bCA[3] / 255 }
  }
  if (!bgCA && !gradient && !border) return null

  // the ubiquitous translate() centering resolves to a pure-translation matrix with
  // px offsets already computed — anything else can't be placed truthfully
  let dx = 0, dy = 0
  if (ps.transform && ps.transform !== 'none') {
    const m = ps.transform.match(/^matrix\(1,\s*0,\s*0,\s*1,\s*(-?[\d.]+),\s*(-?[\d.]+)\)$/)
    if (!m) return null
    dx = +(m[1] ?? 0) / PX_PER_PT
    dy = +(m[2] ?? 0) / PX_PER_PT
  }
  if (ps.position === 'relative') {
    const rl = parseFloat(ps.left), rr = parseFloat(ps.right)
    const rt = parseFloat(ps.top),  rb = parseFloat(ps.bottom)
    dx += (isFinite(rl) ? rl : isFinite(rr) ? -rr : 0) / PX_PER_PT
    dy += (isFinite(rt) ? rt : isFinite(rb) ? -rb : 0) / PX_PER_PT
  }

  const mlAuto = ps.marginLeft === 'auto', mrAuto = ps.marginRight === 'auto'
  const spec: PseudoBoxSpec = {
    anchor: 'flow', w, h, dx, dy,
    mL: mlAuto ? null : pxToPt(ps.marginLeft  || '0px'),
    mR: mrAuto ? null : pxToPt(ps.marginRight || '0px'),
    mT: pxToPt(ps.marginTop    || '0px'),
    mB: pxToPt(ps.marginBottom || '0px'),
    fill:      bgCA ? [bgCA[0], bgCA[1], bgCA[2]] : null,
    fillAlpha: bgCA ? bgCA[3] / 255 : 1,
    gradient, border,
    radius: clampRadiusToBox(parseBorderRadius(ps, undefined, { w, h }), w, h),
  }

  const elS = getComputedStyle(el)
  if (ps.position === 'absolute' || ps.position === 'fixed') {
    // offsets only resolve against the element's padding box when the element itself
    // is the containing block; a statically-positioned pseudo needs layout we don't have
    if (elS.position === 'static') return null
    const hasH = isFinite(parseFloat(ps.left)) || isFinite(parseFloat(ps.right))
    const hasV = isFinite(parseFloat(ps.top))  || isFinite(parseFloat(ps.bottom))
    if (!hasH || !hasV) return null
    spec.anchor = 'abs'
    return spec
  }

  if (ps.position !== 'static' && ps.position !== 'relative') return null
  // in-flow anchoring is only exact inside plain block containers — flex/grid make
  // the pseudo an item, inline/table wrap it in anonymous boxes
  const elD = elS.display
  if (elD !== 'block' && elD !== 'inline-block' && elD !== 'list-item' &&
      elD !== 'flow-root' && elD !== 'table-cell') return null

  const d = ps.display
  if (d === 'block' || d === 'flex' || d === 'grid' || d === 'flow-root') return spec
  if (d === 'inline-block' && (ps.verticalAlign === 'baseline' || ps.verticalAlign === 'middle')) {
    spec.anchor = 'probe'
    return spec
  }
  return null
}

function emitPseudoBox(
  el:        Element,
  which:     '::before' | '::after',
  ps:        CSSStyleDeclaration,
  spec:      PseudoBoxSpec,
  probeRect: DOMRect | null,
  ctx:       WalkerCtx,
): void {
  const elR = domRectToPt(el.getBoundingClientRect(), ctx.containerRect)
  const elS = getComputedStyle(el)
  const bL = pxToPt(elS.borderLeftWidth || '0px'), bR = pxToPt(elS.borderRightWidth  || '0px')
  const bT = pxToPt(elS.borderTopWidth  || '0px'), bB = pxToPt(elS.borderBottomWidth || '0px')

  let x: number, y: number
  if (spec.anchor === 'abs') {
    const pL = elR.x + bL,          pT = elR.y + bT
    const pR = elR.x + elR.w - bR,  pB = elR.y + elR.h - bB
    const oL = parseFloat(ps.left), oR = parseFloat(ps.right)
    const oT = parseFloat(ps.top),  oB = parseFloat(ps.bottom)
    x = isFinite(oL) ? pL + oL / PX_PER_PT + (spec.mL ?? 0)
                     : pR - oR / PX_PER_PT - spec.w - (spec.mR ?? 0)
    y = isFinite(oT) ? pT + oT / PX_PER_PT + spec.mT
                     : pB - oB / PX_PER_PT - spec.h - spec.mB
  } else if (spec.anchor === 'flow') {
    const cL = elR.x + bL + pxToPt(elS.paddingLeft || '0px')
    const cR = elR.x + elR.w - bR - pxToPt(elS.paddingRight || '0px')
    const cT = elR.y + bT + pxToPt(elS.paddingTop || '0px')
    const cB = elR.y + elR.h - bB - pxToPt(elS.paddingBottom || '0px')
    if (spec.mL === null && spec.mR === null) x = cL + (cR - cL - spec.w) / 2
    else if (spec.mL === null)                x = cR - (spec.mR ?? 0) - spec.w
    else                                      x = cL + spec.mL
    // ::before is the first box in the content flow, ::after the last — anchor to the
    // matching content-box edge (exact for the accent-bar idiom; the opposite-side
    // margin may collapse away, so only the near-side margin participates)
    y = which === '::before' ? cT + spec.mT : cB - spec.mB - spec.h
  } else {
    if (!probeRect) return
    const probeLeft = (probeRect.left - ctx.containerRect.left) / PX_PER_PT
    const baseline  = (probeRect.top  - ctx.containerRect.top)  / PX_PER_PT
    // the probe sits after a ::before pseudo and before a ::after pseudo in DOM order
    x = which === '::before'
      ? probeLeft - (spec.mR ?? 0) - spec.w
      : probeLeft + (spec.mL ?? 0)
    if (ps.verticalAlign === 'middle') {
      const xh = (parseFloat(ps.fontSize) || 16) / PX_PER_PT * 0.5
      y = baseline - xh / 2 - spec.h / 2
    } else {
      // an empty inline-block's baseline is its bottom margin edge
      y = baseline - spec.mB - spec.h
    }
  }
  x += spec.dx
  y += spec.dy

  let gradient = spec.gradient
  if (gradient) gradient = resolveGradientBox(gradient, spec.w, spec.h)

  const elOp = parseFloat(ps.opacity)
  const base = !isNaN(elOp) && elOp < 1 ? combineOpacity(stackOpacity(ctx), elOp) : stackOpacity(ctx)

  for (const { page, y: ly } of paginateSpan(y, spec.h, ctx.pageH)) {
    if (spec.fill || gradient) {
      ctx.commands.push({
        type: 'rect', page, x, y: ly, w: spec.w, h: spec.h,
        fill: gradient ? null : spec.fill,
        gradient,
        radius: spec.radius,
        opacity: gradient ? base : combineOpacity(base, spec.fillAlpha),
      } as RectCommand)
    }
    if (spec.border) {
      ctx.commands.push({
        type: 'rect', page, x, y: ly, w: spec.w, h: spec.h,
        fill: null,
        stroke: spec.border.color,
        strokeWidth: spec.border.w,
        radius: spec.radius,
        opacity: combineOpacity(base, spec.border.alpha),
      } as RectCommand)
    }
  }
}

export async function capturePseudo(
  el:    Element,
  which: '::before' | '::after',
  ctx:   WalkerCtx,
): Promise<void> {
  const ps = getComputedStyle(el, which)

  // a pseudo that generates no box has no counter effect either, per spec
  if (ps.display === 'none' || !ps.content || ps.content === 'none' || ps.content === 'normal') return
  if (ps.visibility === 'hidden' || ps.visibility === 'collapse') return

  // the pseudo's own counter-increment mutates the shared scope (persists for
  // later content); any counter-reset it declares is scoped to the pseudo alone
  const pseudoCounters = applyCounters(ctx.counters, ps)
  try {
    await capturePseudoContent(el, which, ps, ctx)
  } finally {
    popCounters(ctx.counters, pseudoCounters)
  }
}

async function capturePseudoContent(
  el:    Element,
  which: '::before' | '::after',
  ps:    CSSStyleDeclaration,
  ctx:   WalkerCtx,
): Promise<void> {
  // strings, counter() and counters() resolve; anything else (attr(), quotes,
  // url()) bails entirely rather than leaking raw CSS text into the output
  const resolved = resolveContentList(ps.content, ctx.counters)
  if (resolved === null) return

  const psColorSrc = String((ps as any).webkitTextFillColor || ps.color)
  const text = applyTextTransform(resolved, ps.textTransform)
  const fontRef = text && !isTransparentColor(psColorSrc)
    ? resolveFontRef(ps.fontFamily, ps.fontWeight, ps.fontStyle, ctx.fontMap, ctx.registeredFonts)
    : null

  const box = pseudoBoxSpec(el, ps)
  if (!fontRef && !box) return

  // zero-size probe with vertical-align:baseline — its top == the line's baseline
  let probeRect: DOMRect | null = null
  if (fontRef || box?.anchor === 'probe') {
    const probe = document.createElement('span')
    probe.style.cssText = 'display:inline;font-size:0;line-height:0;vertical-align:baseline;visibility:hidden;pointer-events:none;'
    try {
      if (which === '::before') el.insertBefore(probe, el.firstChild)
      else el.appendChild(probe)
      probeRect = probe.getBoundingClientRect()
    } catch { /* detached or non-container element */ }
    try { el.removeChild(probe) } catch { /* never inserted */ }
  }

  if (box) emitPseudoBox(el, which, ps, box, probeRect, ctx)

  if (!fontRef || !probeRect) return

  const sizePx = parseFloat(ps.fontSize) || 16
  const sizePt = sizePx / PX_PER_PT
  const xPt    = (probeRect.left - ctx.containerRect.left) / PX_PER_PT
  const yPt    = (probeRect.top  - ctx.containerRect.top)  / PX_PER_PT
  const { page, y: ly } = paginate(yPt, ctx.pageH)
  const { color: colorRgb, alpha: colorAlpha } = splitColorAlpha(parseColorAlpha(psColorSrc))
  const color   = colorRgb ?? ([0, 0, 0] as Color)
  const opacity = stackOpacity(ctx)
  const lsPt    = ps.letterSpacing === 'normal' ? undefined : pxToPt(ps.letterSpacing) || undefined

  ctx.commands.push({
    type: 'text', page,
    text,
    x: xPt, y: ly,
    font: fontRef.name, style: fontRef.style, weight: fontRef.weight,
    size: sizePt, color,
    align: 'left',
    maxWidth: ctx.pageW,
    letterSpacing: lsPt,
    opacity: combineOpacity(opacity, colorAlpha),
  } as TextCommand)
}
