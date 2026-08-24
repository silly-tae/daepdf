// C2: page headers/footers + page numbers. A header/footer is a per-page
// callback — (page, totalPages) => htmlString — not a static template with
// magic placeholder classes: the callback covers the static case just as
// easily (`() => '<div>...</div>'`) while also supporting real per-page
// logic (e.g. no header on page 1) a static string can't express, and needs
// no template-scanning implementation on our side.
import type { DrawCommand } from '../types/index.js'
import { PX_PER_PT, type FontBridgeMap, type WalkerCtx } from './types.js'
import { buildRegisteredFontMap } from './fonts.js'
import { walkChildren } from './walk.js'
import { emitBox } from './emit.js'
import { parseSafeHTML, safeInjectParsed, createHiddenContainer, autoRegisterFonts, injectWordBreaks, nextScopeId } from './prep.js'

export type PageChromeFn = (page: number, totalPages: number) => string

async function renderChromeInto(
  fn: PageChromeFn, page: number, totalPages: number, pageWidthPt: number,
): Promise<HTMLDivElement> {
  const html      = fn(page, totalPages)
  const scopeId   = nextScopeId()
  const parsed    = parseSafeHTML(html, scopeId)
  const styleText = Array.from(parsed.querySelectorAll('style')).map(s => s.textContent ?? '').join('\n')
  await autoRegisterFonts(styleText)
  const container = createHiddenContainer(pageWidthPt)
  safeInjectParsed(parsed, container, scopeId)
  injectWordBreaks(container)
  return container
}

// Header/footer height doesn't depend on how many pages the MAIN content
// needs (only the callback's own template does), so it's measured ONCE,
// independently, before the content capture that needs the result. Digit-
// count differences between e.g. "Page 1 of 1" and "Page 10 of 100"
// essentially never change a template's own wrapped line height, so a
// single representative render (page=1, totalPages=1) is enough.
export async function measureChromeHeight(fn: PageChromeFn, pageWidthPt: number): Promise<number> {
  const container = await renderChromeInto(fn, 1, 1, pageWidthPt)
  try {
    return container.scrollHeight / PX_PER_PT
  } finally {
    document.body.removeChild(container)
  }
}

// Captures ONE page's header/footer content as an isolated, single-page
// command list, positioned at ITS OWN local (0,0) origin — every command
// forced onto page 1 of this isolated capture regardless of what an
// internal (and here irrelevant) paginate() call computed, since a
// header/footer is assumed to fit within its own reserved band. The caller
// (src/html/index.ts) applies whatever page-relative translate is
// needed to place these commands in true page coordinates, reusing the
// same TransformCommand mechanism CSS transforms already use rather than a
// bespoke coordinate system just for this.
export async function captureChrome(
  fn: PageChromeFn, page: number, totalPages: number,
  pageWidthPt: number, bandHeightPt: number, fonts: FontBridgeMap,
): Promise<DrawCommand[]> {
  const container = await renderChromeInto(fn, page, totalPages, pageWidthPt)
  try {
    const ctx: WalkerCtx = {
      containerRect:   container.getBoundingClientRect(),
      pageH:           bandHeightPt,
      pageW:           pageWidthPt,
      commands:        [],
      anchors:         new Map(),
      fontMap:         fonts,
      registeredFonts: buildRegisteredFontMap(),
      opacityStack:    [],
      blendStack:      [],
      counters:        new Map(),
      fieldCounter:    { n: 0 },
    }
    const rootStyle = getComputedStyle(container)
    emitBox(container, rootStyle, ctx)
    await walkChildren(container, rootStyle, ctx)
    for (const cmd of ctx.commands) cmd.page = 1
    return ctx.commands
  } finally {
    document.body.removeChild(container)
  }
}
