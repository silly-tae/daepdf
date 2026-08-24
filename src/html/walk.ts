import type { DrawCommand, ClipCommand, TransformCommand, BorderRadius, TextCommand, ImageCommand, RawImageCommand } from '../types/index.js'
import {
  domRectToPt, paginateSpan, cssBlendToPdf, PX_PER_PT, type WalkerCtx,
  enterStruct, exitStruct, tagStructContent,
} from './types.js'
import { parseBorderRadius, insetBorderRadius, splitByTopLevelComma, pxToPt } from './css.js'
import { parseClipPath } from './clippath.js'
import { applyCounters, popCounters } from './counters.js'
import { hasBorderImage, emitBorderImage } from './borderimage.js'
import { parseCSSMatrix, buildPdfTransformMatrix } from './transform.js'
import { hasFilter, emitFilteredElement } from './filters.js'
import { hasMask, emitMaskedElement } from './mask.js'
import { emitBox, emitListMarker, captureTextNode, captureVerticalTextNode, emitLinks, emitFormField, captureAnchor, capturePseudo } from './emit.js'
import { emitImage, emitInlineSVG, emitCanvas, emitBgImage, extractBgUrl } from './images.js'

const SKIP_TAGS = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'META', 'LINK', 'HEAD', 'TITLE', 'TEMPLATE'])

// A4: dispatches to the vertical-writing-mode text capture instead of the
// normal horizontal one when the parent block is actually set vertically
function captureAnyTextNode(node: Text, parent: Element, parentStyle: CSSStyleDeclaration, ctx: WalkerCtx): void {
  if (parentStyle.writingMode === 'vertical-rl' || parentStyle.writingMode === 'vertical-lr') {
    captureVerticalTextNode(node, parent, parentStyle, ctx)
  } else {
    captureTextNode(node, parent, parentStyle, ctx)
  }
}

// D3: tags freshly-emitted text commands (which can be several — one per
// page a text node's line spans, or one per word on a bidi/justify path)
// to whatever structure element is innermost right now. A no-op array walk
// when tagging is off, since tagStructContent itself short-circuits.
function tagTextCommands(ctx: WalkerCtx, cmds: DrawCommand[]): void {
  if (!ctx.struct) return
  for (const cmd of cmds) {
    if (cmd.type !== 'text') continue
    const tagged = tagStructContent(ctx, cmd.page)
    if (tagged) { (cmd as TextCommand).mcid = tagged.mcid; (cmd as TextCommand).structTag = tagged.tag }
  }
}

// D3: same idea as tagTextCommands, for the one (or few, if paginated
// across a break) ImageCommand/RawImageCommand a <img>/inline <svg> produces
function tagImageCommands(ctx: WalkerCtx, cmds: DrawCommand[]): void {
  if (!ctx.struct) return
  for (const cmd of cmds) {
    if (cmd.type !== 'image' && cmd.type !== 'raw-image') continue
    const tagged = tagStructContent(ctx, cmd.page)
    if (tagged) {
      const c = cmd as ImageCommand | RawImageCommand
      c.mcid = tagged.mcid; c.structTag = tagged.tag
    }
  }
}

// A child is only naturally inset from its parent's border by the border's width, not
// its curvature — a plain square-cornered child clipped to the parent's outer (border-box)
// curve still reaches into the ring the border itself occupies near the corner, painting
// over part of it (children paint after their parent, correct order everywhere except this
// gap). Real browsers clip descendant content to the padding-box: the border-box rect
// inset by the border width on every side, AND its radius reduced by that same amount —
// not just a smaller radius on the original rect, which is a different curve entirely
// (confirmed by the first attempt at this fix: matching the radius alone didn't fix it,
// because the curve's underlying rect was still the outer one).
function paddingBoxClip(
  x: number, y: number, w: number, h: number,
  radius: BorderRadius | undefined, s: CSSStyleDeclaration,
): { x: number; y: number; w: number; h: number; radius: BorderRadius | undefined } {
  const top    = pxToPt(s.borderTopWidth    || '0px')
  const right  = pxToPt(s.borderRightWidth  || '0px')
  const bottom = pxToPt(s.borderBottomWidth || '0px')
  const left   = pxToPt(s.borderLeftWidth   || '0px')
  if (!top && !right && !bottom && !left) return { x, y, w, h, radius }

  return {
    x: x + left, y: y + top,
    w: Math.max(0, w - left - right), h: Math.max(0, h - top - bottom),
    radius: insetBorderRadius(radius, top, right, bottom, left),
  }
}

export async function walkChildren(
  parent:      Element,
  parentStyle: CSSStyleDeclaration,
  ctx:         WalkerCtx,
): Promise<void> {
  const children = Array.from(parent.childNodes)

  let needsZSort = false
  for (const child of children) {
    if (child.nodeType !== Node.ELEMENT_NODE) continue
    if (getComputedStyle(child as Element).position !== 'static') { needsZSort = true; break }
  }

  // counters a child resets stay in scope for its FOLLOWING SIBLINGS — they
  // pop when this parent finishes its children, not when the child exits
  const childCounters: string[] = []

  if (!needsZSort) {
    for (const child of children) {
      if (child.nodeType === Node.TEXT_NODE) {
        const startIdx = ctx.commands.length
        captureAnyTextNode(child as Text, parent, parentStyle, ctx)
        tagTextCommands(ctx, ctx.commands.slice(startIdx))
      } else if (child.nodeType === Node.ELEMENT_NODE) {
        childCounters.push(...await walkElement(child as Element, ctx))
      }
    }
    popCounters(ctx.counters, childCounters)
    return
  }

  // CSS painting order (simplified Appendix E): negative z-index → in-flow content in
  // DOM order → positioned elements with z-index auto/0 in DOM order → positive
  // z-index. Positioned elements paint above their in-flow siblings even WITHOUT a
  // z-index — plain DOM order put an early absolutely-positioned badge underneath
  // later static content that the browser draws it on top of.
  interface Layer { z: number; group: number; commands: DrawCommand[] }
  const layers: Layer[] = []

  for (const child of children) {
    const subCtx: WalkerCtx = { ...ctx, commands: [], opacityStack: [...ctx.opacityStack], blendStack: [...ctx.blendStack] }

    if (child.nodeType === Node.TEXT_NODE) {
      captureAnyTextNode(child as Text, parent, parentStyle, subCtx)
      tagTextCommands(ctx, subCtx.commands)
      layers.push({ z: 0, group: 1, commands: subCtx.commands })
    } else if (child.nodeType === Node.ELEMENT_NODE) {
      const childEl     = child as Element
      const cs          = getComputedStyle(childEl)
      const positioned  = cs.position !== 'static'
      const zRaw        = parseInt(cs.zIndex, 10)
      const z           = positioned && !isNaN(zRaw) ? zRaw : 0
      const group       = !positioned ? 1 : z < 0 ? 0 : z > 0 ? 3 : 2

      childCounters.push(...await walkElement(childEl, subCtx))
      layers.push({ z, group, commands: subCtx.commands })
    }
  }
  popCounters(ctx.counters, childCounters)

  const ordered = [
    ...layers.filter(l => l.group === 0).sort((a, b) => a.z - b.z),
    ...layers.filter(l => l.group === 1),
    ...layers.filter(l => l.group === 2),
    ...layers.filter(l => l.group === 3).sort((a, b) => a.z - b.z),
  ]
  for (const layer of ordered) {
    for (const cmd of layer.commands) ctx.commands.push(cmd)
  }
}

// returns the counter names this element's own reset/set/increment pushed —
// they stay alive for following siblings, so the parent pops them, not us
async function walkElement(el: Element, ctx: WalkerCtx): Promise<string[]> {
  const tag = el.tagName.toUpperCase()
  if (SKIP_TAGS.has(tag)) return []

  const s = getComputedStyle(el)
  // display:none elements neither render nor affect counters, per spec
  if (s.display === 'none') return []

  // D3: pushed/popped around the WHOLE dispatch below (not threaded through
  // each individual branch's own early returns) so every exit path — filter,
  // mask, SVG, IMG, CANVAS, the normal body — stays balanced automatically
  const structEntry = enterStruct(el, tag, ctx)
  try {
    // Paged-media semantics (repeats per page box), not continuous-scroll
    // "pinned to viewport" semantics — see captureFixedElement below. Only
    // when ctx.fixedElements is opted in (chrome.ts's own header/footer
    // captures don't set it, so a nested position:fixed there just falls
    // through to normal handling — already inherently single-instance).
    if (s.position === 'fixed' && ctx.fixedElements) {
      return await captureFixedElement(el, tag, s, ctx)
    }

    // CSS transforms: capture this element's entire subtree (box + children) in
    // UNTRANSFORMED layout space into an isolated command list, then wrap the
    // whole thing with a PDF `cm` matrix — see captureTransformedElement for why.
    if (s.transform && s.transform !== 'none') {
      return await captureTransformedElement(el, tag, s, ctx)
    }

    return await walkElementBody(el, tag, s, ctx)
  } finally {
    exitStruct(ctx, structEntry)
  }
}

// Captured once here, in its real DOM position (so inherited styles/cascading
// stay exactly correct — no re-parsing or cloning into an isolated fragment
// needed), same isolated-subCtx pattern as captureTransformedElement. index.ts's
// fromDOM replicates these commands across every real page once pageCount is
// known — this function only captures the ONE natural instance and defers.
async function captureFixedElement(el: Element, tag: string, s: CSSStyleDeclaration, ctx: WalkerCtx): Promise<string[]> {
  const subCtx: WalkerCtx = { ...ctx, commands: [], opacityStack: [...ctx.opacityStack], blendStack: [...ctx.blendStack] }
  const counters = (s.transform && s.transform !== 'none')
    ? await captureTransformedElement(el, tag, s, subCtx)
    : await walkElementBody(el, tag, s, subCtx)
  ctx.fixedElements!.push(subCtx.commands)
  return counters
}

// Neutralizes the element's transform, measures its TRUE (untransformed) box
// position — CSS transforms never affect layout, only paint, so nothing else
// on the page shifts as a result — captures the subtree exactly as
// walkElementBody normally would (into an isolated subCtx, mirroring the
// z-sort layering pattern in walkChildren), restores the transform, then
// wraps the captured commands with a `cm` matrix equivalent to the CSS one.
async function captureTransformedElement(
  el: Element, tag: string, s: CSSStyleDeclaration, ctx: WalkerCtx,
): Promise<string[]> {
  const rawMatrix = parseCSSMatrix(s.transform)
  // matrix3d (3D transforms) has no 2D equivalent to fall back to safely —
  // render untransformed rather than risk a wrong projection
  if (!rawMatrix) {
    console.warn('[daepdf] 3D transforms (matrix3d/perspective) are not supported — element rendered untransformed.')
    return walkElementBody(el, tag, s, ctx)
  }
  // a,b,c,d are unitless ratios (unaffected by the px/pt scale), but e,f are the
  // matrix's translation and come out of getComputedStyle in CSS px like every
  // other length here — only these two need the pt conversion
  const cssMatrix: typeof rawMatrix = [
    rawMatrix[0], rawMatrix[1], rawMatrix[2], rawMatrix[3],
    rawMatrix[4] / PX_PER_PT, rawMatrix[5] / PX_PER_PT,
  ]

  const htmlEl = el as HTMLElement
  const savedInline = htmlEl.style.transform
  htmlEl.style.transform = 'none'
  const boxRect = el.getBoundingClientRect()
  const { x: boxX, y: boxY } = domRectToPt(boxRect, ctx.containerRect)

  // transform-origin always resolves to absolute "Npx Mpx" (a possible 3rd
  // z-value is irrelevant for a 2D matrix)
  const [oxStr, oyStr] = s.transformOrigin.split(/\s+/)
  const originX = boxX + (parseFloat(oxStr ?? '') || 0) / PX_PER_PT
  const originY = boxY + (parseFloat(oyStr ?? '') || 0) / PX_PER_PT

  const subCtx: WalkerCtx = { ...ctx, commands: [], opacityStack: [...ctx.opacityStack], blendStack: [...ctx.blendStack] }
  const counters = await walkElementBody(el, tag, s, subCtx)

  htmlEl.style.transform = savedInline

  const matrix = buildPdfTransformMatrix(cssMatrix, originX, originY, ctx.pageH)

  // mirrors clip-push/pop's own multi-page pattern: each page this subtree's
  // commands touch gets its own push/pop pair, routed into that page's own
  // buffer independently of where they fall in the flat command array
  const pages = [...new Set(subCtx.commands.map(c => c.page))].sort((a, b) => a - b)
  for (const page of pages) ctx.commands.push({ type: 'transform-push', page, matrix } as TransformCommand)
  for (const cmd of subCtx.commands) ctx.commands.push(cmd)
  for (const page of pages) ctx.commands.push({ type: 'transform-pop', page } as TransformCommand)

  return counters
}

async function walkElementBody(el: Element, tag: string, s: CSSStyleDeclaration, ctx: WalkerCtx): Promise<string[]> {
  // visibility:hidden suppresses only this element's own painting — a descendant with
  // visibility:visible still renders, so the subtree must still be walked
  const hiddenSelf = s.visibility === 'hidden' || s.visibility === 'collapse'

  const ownCounters = applyCounters(ctx.counters, s)

  captureAnchor(el, ctx)

  const elOpacity    = parseFloat(s.opacity)
  const hasOwnOpacity = !isNaN(elOpacity) && elOpacity < 1
  if (hasOwnOpacity) ctx.opacityStack.push(elOpacity)
  const ownBlend = cssBlendToPdf(s.mixBlendMode)
  if (ownBlend) ctx.blendStack.push(ownBlend)
  const popStacks = () => {
    if (hasOwnOpacity) ctx.opacityStack.pop()
    if (ownBlend) ctx.blendStack.pop()
  }

  // CSS filter rasterizes the element's ENTIRE subtree (box + descendants) as
  // one flat image — clip-path/border-radius/children are already baked into
  // that raster by construction, so none of the per-feature logic below runs
  // at all. Checked before clip-path/SVG/box-emission for exactly that reason.
  if (hasFilter(s)) {
    if (!hiddenSelf) emitFilteredElement(el, s, ctx)
    popStacks()
    return ownCounters
  }

  // mask-image: same whole-subtree rasterization reasoning as filter above —
  // checked second so an element with BOTH just gets the filter (mask is
  // ignored in that rare combined case, a documented scope limitation)
  if (hasMask(s)) {
    if (!hiddenSelf) await emitMaskedElement(el, s, ctx)
    popStacks()
    return ownCounters
  }

  // clip-path clips the ELEMENT'S OWN box (background/border) too, unlike
  // overflow — pushed before emitBox so it's already active when the box paints.
  // An independent clip layer that composes with overflow (both apply at once
  // when both are set), so it gets its own push/pop pair, pushed outermost.
  let clipPathSpans: Array<{ page: number }> = []
  const clipPathVal = (s as any).clipPath as string | undefined
  if (clipPathVal && clipPathVal !== 'none') {
    const box = domRectToPt(el.getBoundingClientRect(), ctx.containerRect)
    const shape = parseClipPath(clipPathVal, box)
    if (shape?.kind === 'rect') {
      const spans = paginateSpan(shape.y, Math.max(shape.h, 1e-3), ctx.pageH)
      for (const { page, y: ly } of spans) {
        ctx.commands.push({ type: 'clip-push', page, x: shape.x, y: ly, w: shape.w, h: shape.h, radius: shape.radius } as ClipCommand)
      }
      clipPathSpans = spans
    } else if (shape?.kind === 'path') {
      const ys = shape.ops.flatMap(seg => seg.args.filter((_, i) => i % 2 === 1))
      const minY = Math.min(...ys), maxY = Math.max(...ys)
      const spans = paginateSpan(minY, Math.max(maxY - minY, 1e-3), ctx.pageH)
      for (const { page, y: ly } of spans) {
        const dy  = ly - minY
        const ops = shape.ops.map(seg => ({ op: seg.op, args: seg.args.map((v, i) => i % 2 === 1 ? v + dy : v) }))
        ctx.commands.push({ type: 'clip-push', page, path: ops, evenOdd: shape.evenOdd } as ClipCommand)
      }
      clipPathSpans = spans
    }
  }
  const popClipPath = () => {
    for (const { page } of clipPathSpans) ctx.commands.push({ type: 'clip-pop', page } as ClipCommand)
  }

  if (tag === 'SVG') {
    if (!hiddenSelf) {
      const startIdx = ctx.commands.length
      await emitInlineSVG(el as SVGSVGElement, ctx)
      tagImageCommands(ctx, ctx.commands.slice(startIdx))
    }
    popClipPath()
    popStacks()
    return ownCounters
  }

  if (!hiddenSelf) {
    emitBox(el, s, ctx)
    emitListMarker(el, s, ctx)
    // border-image paints over the CSS border emitBox already suppressed for
    // this element — same "part of the element's own decoration" treatment,
    // so it also happens before the overflow clip-push below
    if (hasBorderImage(s)) await emitBorderImage(el, s, ctx)
  }

  // auto and scroll clip just like hidden (the PDF has no scrollbars to reveal the
  // rest); mixed per-axis values (e.g. "hidden auto") must clip too, so check the
  // longhands rather than comparing the shorthand string
  const clips = (v: string) => v === 'hidden' || v === 'clip' || v === 'auto' || v === 'scroll'
  const needsClip = clips(s.overflowX) || clips(s.overflowY)
  // Each page is its own content stream, so a clip region spanning pages needs its
  // own push/pop pair on EVERY page it touches (each at that page's local y).
  // Command array order guarantees each page's stream sees push → children → pop;
  // popping per page keeps every stream's q/Q stack LIFO-balanced.
  let clipSpans: Array<{ page: number; y: number }> = []
  let clipRegion: ReturnType<typeof paddingBoxClip> | null = null
  if (needsClip) {
    const r = el.getBoundingClientRect()
    const { x, y, w, h } = domRectToPt(r, ctx.containerRect)
    clipRegion = paddingBoxClip(x, y, w, h, parseBorderRadius(s, el), s)
    clipSpans  = paginateSpan(clipRegion.y, Math.max(clipRegion.h, 1e-3), ctx.pageH)
    for (const { page, y: ly } of clipSpans) {
      ctx.commands.push({
        type: 'clip-push', page, x: clipRegion.x, y: ly, w: clipRegion.w, h: clipRegion.h,
        radius: clipRegion.radius,
      } as ClipCommand)
    }
  }
  const popClips = () => {
    for (const { page } of clipSpans) {
      ctx.commands.push({ type: 'clip-pop', page } as ClipCommand)
    }
    popClipPath()
  }

  // CSS background-image URL — iterate layers so url() works even when not the first layer
  // emitted after clip-push so the image respects overflow:hidden / border-radius clipping.
  // Layer index is passed through so size/position/repeat (each their own comma-separated,
  // cyclically-repeating list per the spec) resolve against the matching layer, not layer 0.
  // CSS paints image layers LAST → FIRST (the first listed layer ends up on top), so
  // iterate reversed. Gradient/conic layers are painted by emitBox in their paint slot.
  if (!hiddenSelf && s.backgroundImage && s.backgroundImage !== 'none') {
    const layers = splitByTopLevelComma(s.backgroundImage)
    for (let i = layers.length - 1; i >= 0; i--) {
      const url = extractBgUrl((layers[i] ?? '').trim())
      if (url) await emitBgImage(el, url, ctx, i, layers.length)
    }
  }

  if (tag === 'IMG') {
    if (!hiddenSelf) {
      const startIdx = ctx.commands.length
      await emitImage(el as HTMLImageElement, ctx)
      tagImageCommands(ctx, ctx.commands.slice(startIdx))
    }
    popClips()
    popStacks()
    return ownCounters
  }

  if (tag === 'CANVAS') {
    if (!hiddenSelf) emitCanvas(el as HTMLCanvasElement, ctx)
    popClips()
    popStacks()
    return ownCounters
  }

  // D1 (AcroForm): INPUT/TEXTAREA/SELECT become a real form field — see
  // emitFormField for which input types qualify. No struct-tree tagging
  // (D3) attempted for these, a stated scope cut.
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') {
    if (!hiddenSelf) emitFormField(el, s, ctx)
    popClips()
    popStacks()
    return ownCounters
  }

  if (tag === 'A' && !hiddenSelf) emitLinks(el as HTMLAnchorElement, ctx)

  await capturePseudo(el, '::before', ctx)

  await walkChildren(el, s, ctx)

  await capturePseudo(el, '::after', ctx)

  popClips()
  popStacks()
  return ownCounters
}
