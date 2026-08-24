import { applyToPDF, rasterizeSVGs } from '../pdf/index.js'
import { resolvePageSize } from '../types/index.js'
import type { PageConfig, DocDefinition, DrawCommand, TransformCommand, ClipCommand, AnchorEntry } from '../types/index.js'
import { PX_PER_PT, pruneStructTreePages, type FontBridgeMap, type HTMLCapture, type HTMLToPDFOptions, type WalkerCtx } from './types.js'
import { buildRegisteredFontMap } from './fonts.js'
import { walkChildren } from './walk.js'
import { emitBox } from './emit.js'
import { parseSafeHTML, safeInjectParsed, createHiddenContainer, autoRegisterFonts, waitForLayout, injectWordBreaks, nextScopeId, extractFontFaceBlocks } from './prep.js'
import { applyCounters } from './counters.js'
import { applyPageBreaks, undoPageBreaks } from './breaks.js'
import { measureChromeHeight, captureChrome, type PageChromeFn } from './chrome.js'

export type { FontBridgeMap, HTMLCapture, HTMLToPDFOptions }
export { invalidateFontMapCache } from './fonts.js'
export { invalidateImageCache } from './images.js'

export async function fromDOM(
  el:        HTMLElement,
  config:    PageConfig,
  fonts:     FontBridgeMap = {},
  taggedPdf: boolean = false,
): Promise<HTMLCapture> {
  const size = resolvePageSize(config.size, config.orientation)
  await waitForLayout()

  // page-break pass mutates the DOM with marked spacers (browser print behavior:
  // no cut lines/rows) — always undone, since el may be the caller's live element
  applyPageBreaks(el, size.height * PX_PER_PT)
  try {
    // D3: the root itself is never a real StructElem (its kids ARE
    // /StructTreeRoot's own /K array) — tag 'Root' is a sentinel only
    // enterStruct/tagStructContent ever look at (via the stack), never
    // written to the PDF
    const structRoot = { tag: 'Root', kids: [] }
    const ctx: WalkerCtx = {
      containerRect:   el.getBoundingClientRect(),
      pageH:           size.height,
      pageW:           size.width,
      commands:        [],
      anchors:         new Map(),
      fontMap:         fonts,
      registeredFonts: buildRegisteredFontMap(),
      opacityStack:    [],
      blendStack:      [],
      counters:        new Map(),
      struct: taggedPdf
        ? { root: structRoot, stack: [structRoot], mcidCounters: new Map(), artifactDepth: 0 }
        : undefined,
      fieldCounter:    { n: 0 },
      fixedElements:   [],
    }

    // the root's own background/border — walkChildren only visits children, and the
    // template's body/:root styles land on this very element after CSS scoping
    // (same for a body-level counter-reset; nothing outlives the walk, no pop needed)
    const rootStyle = getComputedStyle(el)
    applyCounters(ctx.counters, rootStyle)
    emitBox(el, rootStyle, ctx)
    await walkChildren(el, rootStyle, ctx)

    const totalHPx  = el.scrollHeight
    const rawPages  = totalHPx / (size.height * PX_PER_PT)
    const frac      = rawPages - Math.floor(rawPages)
    const pageCount = Math.max(1, frac < 0.01 ? Math.floor(rawPages) : Math.ceil(rawPages))

    // the same sub-pixel overshoot the pageCount forgiveness above just dismissed can
    // still have produced page-N+1 slices via paginateSpan — drop them, or set_page()
    // would materialize a stray near-blank trailing page (clip push/pop pairs share a
    // page number, so they are always dropped or kept together)
    const commands = ctx.commands.filter(c => c.page <= pageCount)

    // position:fixed content, captured once (see walk.ts's captureFixedElement)
    // at whichever page it naturally fell on — replicated onto every OTHER real
    // page now that pageCount is known, matching CSS Paged Media's repeat-per-
    // page-box semantics. Scope limit, documented rather than silently wrong:
    // mcid/structTag (D3 tagged PDF) is kept only on the natural-page instance —
    // reusing the same mcid on a different page would collide with that page's
    // own independent mcid counter, so replicated copies are struct-untagged.
    for (const group of ctx.fixedElements ?? []) {
      if (!group.length) continue
      const naturalPage = Math.min(...group.map(c => c.page))
      if (naturalPage > pageCount) continue
      for (let page = 1; page <= pageCount; page++) {
        for (const cmd of group) {
          if (page === naturalPage) { commands.push(cmd); continue }
          const clone = { ...cmd, page } as typeof cmd & { mcid?: number; structTag?: string }
          delete clone.mcid
          delete clone.structTag
          commands.push(clone)
        }
      }
    }

    if (taggedPdf) pruneStructTreePages(structRoot, pageCount)

    return { commands, pageCount, anchors: ctx.anchors, structRoot: taggedPdf ? structRoot : undefined }
  } finally {
    undoPageBreaks(el)
  }
}

export async function fromHTML(
  html:      string,
  config:    PageConfig,
  fonts:     FontBridgeMap = {},
  chrome:    { header?: PageChromeFn | undefined; footer?: PageChromeFn | undefined } = {},
  taggedPdf: boolean = false,
): Promise<HTMLCapture> {
  const scopeId   = nextScopeId()
  const parsed    = parseSafeHTML(html, scopeId)
  const styleText = Array.from(parsed.querySelectorAll('style'))
    .map(s => s.textContent ?? '').join('\n')
  await autoRegisterFonts(styleText)
  const trueSize  = resolvePageSize(config.size, config.orientation)

  // header/footer reserve fixed top/bottom bands, independent of how many pages
  // the content itself needs — measured once, before laying out content against
  // the resulting shrunken page height
  const headerH = chrome.header ? await measureChromeHeight(chrome.header, trueSize.width) : 0
  const footerH = chrome.footer ? await measureChromeHeight(chrome.footer, trueSize.width) : 0
  const contentConfig: PageConfig = (headerH || footerH)
    ? { size: { width: trueSize.width, height: trueSize.height - headerH - footerH } }
    : config
  const contentHeight = resolvePageSize(contentConfig.size, contentConfig.orientation).height

  const container = createHiddenContainer(trueSize.width, contentHeight)
  let capture: HTMLCapture
  try {
    safeInjectParsed(parsed, container, scopeId)
    // container is already attached (createHiddenContainer appends it to document.body),
    // so getComputedStyle here correctly resolves stylesheet-cascaded white-space —
    // unlike inside parseSafeHTML, which runs on a still-detached document
    injectWordBreaks(container)
    // scoped to the export container — a bare * selector would restyle the host
    // page for the duration of the export
    const opszStyle = document.createElement('style')
    opszStyle.textContent = `[data-tpdf-scope="${scopeId}"] *{font-optical-sizing:none}`
    container.appendChild(opszStyle)
    capture = await fromDOM(container, contentConfig, fonts, taggedPdf)
  } finally {
    document.body.removeChild(container)
  }

  if (!headerH && !footerH) return capture
  return applyChrome(capture, chrome, trueSize, headerH, footerH, fonts)
}

// Shifts the already-captured content down by headerH (reusing the exact
// TransformCommand mechanism CSS transforms use — a pure translate, matrix
// f=-headerH: see B1's buildPdfTransformMatrix for the same PDF-native cm
// convention) and appends one header/footer capture per real page, each
// wrapped in its own translate so its LOCAL (0,0)-origin content lands in
// true page coordinates. Header needs no shift (its local origin already IS
// the true page top); footer's f=-(trueHeight-footerH) places its local top
// at the true bottom band's start.
async function applyChrome(
  capture:  HTMLCapture,
  chrome:   { header?: PageChromeFn | undefined; footer?: PageChromeFn | undefined },
  trueSize: { width: number; height: number },
  headerH:  number,
  footerH:  number,
  fonts:    FontBridgeMap,
): Promise<HTMLCapture> {
  const pages = Array.from(new Set(capture.commands.map(c => c.page))).sort((a, b) => a - b)
  const out: DrawCommand[] = []
  const contentH = trueSize.height - headerH - footerH

  for (const page of pages) {
    if (headerH) out.push({ type: 'transform-push', page, matrix: [1, 0, 0, 1, 0, -headerH] } satisfies TransformCommand)
    // Several existing draw paths (emit.ts's paginateSpan callers: box borders,
    // rules, etc.) draw an element's FULL, unsliced shape on every page it
    // spans and rely on the page's own MediaBox to crop the off-page portion —
    // true only when the content area's own height equals the true physical
    // page height. Once a header/footer shrinks it, that assumption breaks:
    // a border/rule extending past the shrunk content height is no longer cut
    // off by the (larger, unshrunk) physical MediaBox, and bleeds into the
    // header/footer band below. An explicit clip restores the boundary this
    // relied on implicitly. Caught via direct visual inspection of a real
    // multi-page invoice render — a table's column border lines bled through
    // the footer — not by any operator-level test.
    out.push({ type: 'clip-push', page, x: 0, y: 0, w: trueSize.width, h: contentH } satisfies ClipCommand)
    for (const cmd of capture.commands) if (cmd.page === page) out.push(cmd)
    out.push({ type: 'clip-pop', page } satisfies ClipCommand)
    if (headerH) out.push({ type: 'transform-pop', page } satisfies TransformCommand)
  }

  for (let page = 1; page <= capture.pageCount; page++) {
    // a template that measures to 0 height (e.g. an empty string) contributes no
    // reserved band at all — skip its own capture too, since ctx.pageH=0 would
    // divide-by-zero inside the walker's own pagination math
    if (chrome.header && headerH > 0) {
      const cmds = await captureChrome(chrome.header, page, capture.pageCount, trueSize.width, headerH, fonts)
      // clips to the reserved band — the header's own natural height was measured
      // from a single representative render (page=1, totalPages=1); a real page's
      // digit count ("Page 10 of 250" vs "Page 1 of 1") can wrap a shade taller, and
      // this keeps that from bleeding into the content directly below it
      out.push({ type: 'clip-push', page, x: 0, y: 0, w: trueSize.width, h: headerH } satisfies ClipCommand)
      for (const c of cmds) { c.page = page; out.push(c) }
      out.push({ type: 'clip-pop', page } satisfies ClipCommand)
    }
    if (chrome.footer && footerH > 0) {
      const cmds = await captureChrome(chrome.footer, page, capture.pageCount, trueSize.width, footerH, fonts)
      out.push({ type: 'transform-push', page, matrix: [1, 0, 0, 1, 0, -(trueSize.height - footerH)] } satisfies TransformCommand)
      out.push({ type: 'clip-push', page, x: 0, y: 0, w: trueSize.width, h: footerH } satisfies ClipCommand)
      for (const c of cmds) { c.page = page; out.push(c) }
      out.push({ type: 'clip-pop', page } satisfies ClipCommand)
      out.push({ type: 'transform-pop', page } satisfies TransformCommand)
    }
  }

  // anchors were captured against the content's own local coordinates (0 at
  // content top) — shift by headerH so a named dest / #fragment link still
  // points at the right spot once content moved down
  const anchors = new Map<string, AnchorEntry>()
  for (const [id, entry] of capture.anchors) {
    anchors.set(id, headerH ? { page: entry.page, y: entry.y + headerH } : entry)
  }

  return { commands: out, pageCount: capture.pageCount, anchors, structRoot: capture.structRoot }
}

// previewHTML strips @font-face from each call's own injected content (see
// below) so the browser doesn't re-trigger a font fetch on every re-render —
// but the SAME rule still needs to reach the browser's real font set once,
// or the preview falls back to a system font with no @font-face anywhere to
// load it from. Injected once per unique rule text into a persistent,
// cross-call <style> in the real document head (not the per-call container),
// so a caller never has to also declare the font in their own global CSS.
const _injectedPreviewFonts = new Set<string>()
let _previewFontStyleEl: HTMLStyleElement | null = null

function ensurePreviewFontStyleEl(): HTMLStyleElement {
  if (!_previewFontStyleEl || !_previewFontStyleEl.isConnected) {
    _previewFontStyleEl = document.createElement('style')
    _previewFontStyleEl.dataset['tpdfPreviewFonts'] = ''
    document.head.appendChild(_previewFontStyleEl)
  }
  return _previewFontStyleEl
}

export function previewHTML(
  html:      string,
  container: HTMLElement,
  config:    PageConfig,
): void {
  container.dataset['tpdfPreview'] = ''

  // opsz-disable rule must persist across re-renders — inject once and leave it
  if (!container.querySelector('[data-tpdf-opsz]')) {
    const opszEl = document.createElement('style')
    opszEl.dataset['tpdfOpsz'] = ''
    opszEl.textContent = '[data-tpdf-preview] *,[data-tpdf-measure] *{font-optical-sizing:none}'
    container.appendChild(opszEl)
  }

  const size    = resolvePageSize(config.size, config.orientation)
  const pageWPx = size.width  * PX_PER_PT
  const pageHPx = size.height * PX_PER_PT

  // unique per call — see nextScopeId's own comment: a live preview's content stays
  // attached in the DOM until the NEXT preview call replaces it, which can overlap
  // with a render() call made in between (e.g. exporting a PDF while the preview is
  // still showing); a shared/constant scope marker let those two @scope blocks
  // cross-apply to each other for any property one didn't redeclare
  const scopeId = nextScopeId()
  const parsed  = parseSafeHTML(html, scopeId)

  // @font-face blocks are stripped from the per-call content so the browser doesn't
  // re-trigger a font fetch on every preview render — any block not already injected
  // into the persistent head style gets added there first, so the font still loads
  // globally without the caller declaring it a second time anywhere
  for (const el of Array.from(parsed.querySelectorAll('style'))) {
    const css = el.textContent ?? ''
    const blocks = extractFontFaceBlocks(css)
    let stripped = css
    for (const block of blocks) {
      if (!_injectedPreviewFonts.has(block)) {
        _injectedPreviewFonts.add(block)
        ensurePreviewFontStyleEl().appendChild(document.createTextNode(block + '\n'))
      }
      stripped = stripped.replace(block, '')
    }
    el.textContent = stripped
  }

  // measure off-screen so the container keeps its current content — no flash between
  // renders. Word breaks AND page-break spacers are applied here, then each page div
  // receives a CLONE of the measured DOM: preview pages carry the exact same spacers
  // the PDF capture will produce, so preview == PDF page-for-page.
  const measure = document.createElement('div')
  measure.dataset['tpdfMeasure'] = ''
  // transform:translateZ(0) establishes a containing block for position:fixed
  // descendants (see createHiddenContainer's own comment in prep.ts) — without
  // it, a user's position:fixed element resolves against the real viewport
  // instead of this off-screen div while it's briefly attached to measure.
  measure.style.cssText = `position:fixed;top:-99999px;left:-99999px;width:${pageWPx}px;height:auto;visibility:hidden;transform:translateZ(0);`
  safeInjectParsed(parsed, measure, scopeId)
  document.body.appendChild(measure)
  injectWordBreaks(measure)
  applyPageBreaks(measure, pageHPx)
  const totalHPx = measure.scrollHeight
  const measured = Array.from(measure.childNodes).map(n => n.cloneNode(true))
  document.body.removeChild(measure)

  // fractional overshoot < 1% of page height is sub-pixel rounding, not real overflow
  const rawPages  = totalHPx / pageHPx
  const frac      = rawPages - Math.floor(rawPages)
  const pageCount = Math.max(1, frac < 0.01 ? Math.floor(rawPages) : Math.ceil(rawPages))

  const frag = document.createDocumentFragment()
  for (let p = 0; p < pageCount; p++) {
    const page = document.createElement('div')
    // transform:translateZ(0) establishes a containing block for position:fixed
    // descendants — this page div is a real, visible, in-document element (unlike
    // measure above), so without it, a user's position:fixed content would escape
    // to the actual browser viewport and land on the host page, not just fail to
    // repeat per page.
    page.style.cssText = `position:relative;width:${pageWPx}px;height:${pageHPx}px;overflow:hidden;flex-shrink:0;background:white;box-shadow:0 2px 8px rgba(0,0,0,0.15);transform:translateZ(0);`
    if (p < pageCount - 1) page.style.marginBottom = '24px'

    const inner = document.createElement('div')
    // scope root for the @scope CSS wrapper (normally set by safeInjectParsed) — must
    // be the SAME scopeId the measured content's <style> tags were scoped with
    inner.dataset['tpdfScope'] = scopeId
    // margin:0 pins the clone to the page top — a template body margin becomes
    // ":scope { margin }" after scoping, which would displace this absolutely-
    // positioned div and shift every preview boundary by that amount (the PDF
    // capture container's own margin never moves content within containerRect)
    inner.style.cssText = `position:absolute;top:${-(p * pageHPx)}px;left:0;width:100%;margin:0;`
    for (const node of measured) inner.appendChild(node.cloneNode(true))
    page.appendChild(inner)
    frag.appendChild(page)
  }

  // Atomic swap: remove old page divs (keep the opsz style element), add new pages
  for (const child of Array.from(container.children)) {
    if (child.tagName !== 'STYLE') container.removeChild(child)
  }
  container.appendChild(frag)
}

export async function renderHTMLtoPDF(
  html:    string,
  config:  PageConfig,
  options: HTMLToPDFOptions = {},
  fonts:   FontBridgeMap   = {},
): Promise<Uint8Array> {
  // PDF/A disallows encryption outright — a caller finds out immediately
  // rather than silently getting a non-conformant (or unencrypted) file
  if (options.pdfA && options.security) {
    throw new Error('[daepdf] PDF/A does not allow encryption — pass either `pdfA` or `security`, not both.')
  }
  const taggedPdf = !!(options.taggedPdf || options.pdfA)
  const { commands, anchors, structRoot } = await fromHTML(
    html, config, fonts, { header: options.header, footer: options.footer }, taggedPdf,
  )
  await rasterizeSVGs(commands)

  const shim: DocDefinition = {
    config,
    metadata:  options.metadata,
    security:  options.security,
    bookmarks: options.bookmarks,
    taggedPdf,
    pdfA:      !!options.pdfA,
  }

  return applyToPDF(commands, shim, anchors, structRoot)
}
