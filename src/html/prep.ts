import { loadAndRegisterFont } from '../../engine.js'
import { PX_PER_PT } from './types.js'
import { invalidateFontMapCache } from './fonts.js'

export async function waitForLayout(): Promise<void> {
  if (typeof document !== 'undefined' && document.fonts?.ready) {
    await document.fonts.ready
  }
  await new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())))
}

// call this only once the node is attached to a live, styled document — getComputedStyle
// can't resolve stylesheet-cascaded values on a detached DOMParser document, only inline
// styles, so this must run after safeInjectParsed(), not inside parseSafeHTML()
export function injectWordBreaks(root: Node, chunkSize = 25): void {
  const d      = root.ownerDocument ?? document
  const walker = d.createTreeWalker(root, NodeFilter.SHOW_TEXT)
  const targets: Text[] = []
  let node: Node | null
  while ((node = walker.nextNode())) targets.push(node as Text)

  for (const text of targets) {
    const raw = text.textContent ?? ''
    if (!/\S{26,}/.test(raw)) continue
    const parent = text.parentNode
    if (!parent) continue
    if (parent.nodeType === Node.ELEMENT_NODE) {
      const ws = getComputedStyle(parent as Element).whiteSpace
      if (ws === 'nowrap' || ws === 'pre') continue
    }
    const frag = d.createDocumentFragment()
    let last = 0
    const re = /\S{26,}/g
    let m: RegExpExecArray | null
    while ((m = re.exec(raw)) !== null) {
      if (m.index > last) frag.appendChild(d.createTextNode(raw.slice(last, m.index)))
      const word = m[0]
      for (let i = 0; i < word.length; i += chunkSize) {
        frag.appendChild(d.createTextNode(word.slice(i, i + chunkSize)))
        if (i + chunkSize < word.length) frag.appendChild(d.createElement('wbr'))
      }
      last = m.index + word.length
    }
    if (last < raw.length) frag.appendChild(d.createTextNode(raw.slice(last)))
    parent.replaceChild(frag, text)
  }
}

// Each render()/preview() call needs its OWN scope-root marker value, not a shared
// constant — a live preview's container stays attached in the DOM (by design, so the
// page doesn't flash between renders) for as long as it takes the NEXT preview to
// replace it, which overlaps with any render() call made in the meantime (e.g. a host
// app exporting a PDF while its own preview is still showing). Two containers alive at
// once that both matched the SAME generic `[data-tpdf-scope]` selector let their
// `@scope` blocks cross-apply to each other's elements for any property the later
// one didn't redeclare — confirmed by direct reproduction: a render() call picked up
// a border from an unrelated, already-completed preview() call's stylesheet, for two
// templates that only happened to reuse the same class name. A per-call unique id
// closes this off structurally, regardless of the exact engine mechanism at fault.
let scopeCounter = 0
export function nextScopeId(): string {
  scopeCounter += 1
  return `s${scopeCounter}${Math.random().toString(36).slice(2, 8)}`
}

// Template <style> blocks are injected into the live document, where they apply
// document-wide: a template's body/:root/bare-element selectors would restyle the
// host app — persistently in preview (styles stay attached between renders). @scope
// confines every rule to the injection container. :root/html/body are mapped to
// :scope so base-style and CSS-variable patterns keep working (they only ever
// "worked" before by leaking onto the host page and inheriting back down), and
// @font-face stays top-level since it is invalid inside @scope.
function scopeTemplateCSS(css: string, scopeId: string): string {
  const faces: string[] = []
  const rest = css.replace(/@font-face\s*\{[^}]*\}/g, m => { faces.push(m); return '' })
  const body = rest.trim()
    .replace(/:root\b/g, ':scope')
    .replace(/(^|[},\s])(html|body)(?=[\s,{.:#[>+~])/g, '$1:scope')
  const scoped = body ? `@scope ([data-tpdf-scope="${scopeId}"]) {\n${body}\n}` : ''
  return [faces.join('\n'), scoped].filter(Boolean).join('\n')
}

// DOMParser strips script/event-handler injection without executing anything
export function parseSafeHTML(html: string, scopeId: string): Document {
  const doc = new DOMParser().parseFromString(html, 'text/html')
  // an externally-linked stylesheet silently vanishing is an easy mistake to make
  // (inline <style> blocks work fine) — warn instead of dropping it with no trace
  doc.querySelectorAll('link[rel="stylesheet"]').forEach(l => {
    console.warn(`[daepdf] <link rel="stylesheet" href="${l.getAttribute('href')}"> is not supported and was removed — use an inline <style> block instead.`)
  })
  doc.querySelectorAll('script, link, object, embed, iframe, video, audio').forEach(s => s.remove())
  doc.querySelectorAll('style').forEach(s => {
    const css = s.textContent ?? ''
    for (const imp of css.match(/@import\b[^;]*/g) ?? []) {
      console.warn(`[daepdf] "${imp.trim()}" is not supported and was removed — inline the imported stylesheet's contents instead.`)
    }
    s.textContent = scopeTemplateCSS(css.replace(/@import\b[^;]*;?/g, ''), scopeId)
  })
  const XLINK_NS = 'http://www.w3.org/1999/xlink'
  const isScriptScheme = (v: string | null): boolean => !!v && /^\s*(javascript|data|vbscript):/i.test(v)
  doc.querySelectorAll('*').forEach(el => {
    for (const { name } of Array.from(el.attributes)) {
      if (name.startsWith('on')) el.removeAttribute(name)
    }
    // previews inject into the live DOM, where a script-scheme link is clickable.
    // SVG's own <a> element (a genuine navigational element, unlike <use>/<image>,
    // which don't execute javascript: URIs in resource-fetch context) still
    // accepts the legacy xlink:href form — plain href alone left it uncovered,
    // the same href/xlink:href duality src/pdf/svgvector.ts's own <use>
    // resolution already has to check both forms of.
    if (isScriptScheme(el.getAttribute('href'))) el.removeAttribute('href')
    if (isScriptScheme(el.getAttributeNS(XLINK_NS, 'href'))) el.removeAttributeNS(XLINK_NS, 'href')
    if (isScriptScheme(el.getAttribute('xlink:href'))) el.removeAttribute('xlink:href')
  })
  return doc
}

// DOMParser hoists <style> to <head> — copy head styles or template CSS drops silently
export function safeInjectParsed(doc: Document, container: HTMLElement, scopeId: string): void {
  // scope root for the @scope wrapper produced by scopeTemplateCSS — must be the
  // SAME id passed to parseSafeHTML for this same html, or the CSS's embedded
  // @scope selector never matches this container at all
  container.dataset['tpdfScope'] = scopeId
  const frag = document.createDocumentFragment()
  for (const style of Array.from(doc.head.querySelectorAll('style'))) {
    frag.appendChild(document.importNode(style, true))
  }
  for (const node of Array.from(doc.body.childNodes)) {
    frag.appendChild(document.importNode(node, true))
  }
  container.textContent = ''
  container.appendChild(frag)
}

// pageHPt (the true single-page height) is optional and defaults to auto —
// chrome.ts's own header/footer measurement container has no single "page"
// height of its own to give (and doesn't need one: nested position:fixed
// content there never reaches captureFixedElement's special handling in the
// first place, since ctx.fixedElements is unset for that capture — see
// walk.ts). fromHTML's real per-document container DOES pass it, which is
// what actually matters: without an explicit height, a bottom/right-anchored
// position:fixed element resolves its offset against however tall the
// ACTUAL (often much-shorter-than-a-page) content is, not the true page
// height previewHTML's own page-card divs correctly use — landing far too
// high/left on export while looking right in the live preview. Confirmed via
// a real user report (a bottom-right image exported to the top-right) and by
// directly verifying overflow:visible + an explicit height does NOT affect
// scrollHeight (still reports the full, true content height including
// anything visually overflowing past it) — so fromDOM's own pagination math
// stays exactly as accurate as before this fix.
export function createHiddenContainer(pageWPt: number, pageHPt?: number): HTMLDivElement {
  const div = document.createElement('div')
  // transform:translateZ(0) is a zero-distance, purely-cosmetic-free translate —
  // its only effect is establishing a new containing block for position:fixed
  // descendants (per spec, only transform/filter/perspective/will-change/contain
  // do this, NOT position:fixed itself). Without it, a user's own position:fixed
  // element inside this container escapes to the REAL viewport instead of this
  // (off-screen, at -99999,-99999) container, landing tens of thousands of
  // pixels from any real page and silently never rendering at all — confirmed
  // by direct reproduction, not a hypothetical.
  const height = pageHPt !== undefined ? `${pageHPt * PX_PER_PT}px` : 'auto'
  div.style.cssText = `position:fixed;top:-99999px;left:-99999px;width:${pageWPt * PX_PER_PT}px;height:${height};overflow:visible;pointer-events:none;z-index:-9999;transform:translateZ(0);`
  document.body.appendChild(div)
  return div
}

// Brace/paren/string-aware scan for @font-face blocks — a naive [^}]*
// regex would stop at the first '}', including one inside a quoted src
// url() or a comment. Returns each block's full raw text, wrapper included
// (e.g. "@font-face { font-family: ... }"), in source order.
export function extractFontFaceBlocks(css: string): string[] {
  const blocks: string[] = []
  const startRe = /@font-face\s*\{/g
  let sm: RegExpExecArray | null

  while ((sm = startRe.exec(css)) !== null) {
    let pos        = sm.index + sm[0].length
    let depth      = 1
    let parenDepth = 0
    let inStr: string | null = null

    while (pos < css.length && depth > 0) {
      const ch = css[pos]
      if (inStr) {
        if (ch === '\\') { pos += 2; continue }
        if (ch === inStr) inStr = null
      } else if (parenDepth > 0) {
        if      (ch === ')')            parenDepth--
        else if (ch === '(')            parenDepth++
        else if (ch === '"' || ch === "'") inStr = ch
      } else {
        if      (ch === '"' || ch === "'") inStr = ch
        else if (ch === '(')            parenDepth++
        else if (ch === '{')            depth++
        else if (ch === '}')            depth--
      }
      pos++
    }

    blocks.push(css.slice(sm.index, pos))
    startRe.lastIndex = pos
  }

  return blocks
}

function parseAtFontFace(html: string): { name: string; url: string }[] {
  const results: { name: string; url: string }[] = []
  for (const block of extractFontFaceBlocks(html)) {
    const nameM = block.match(/font-family\s*:\s*['"]?([^'";,]+)['"]?/)
    const urlM  = block.match(/src\s*:[^;]*url\(['"]?([^'")\s]+)['"]?\)/)
    if (nameM && urlM) results.push({ name: (nameM[1] ?? '').trim(), url: (urlM[1] ?? '').trim() })
  }
  return results
}

export async function autoRegisterFonts(styleText: string): Promise<void> {
  const faces = parseAtFontFace(styleText)
  if (!faces.length) return
  await Promise.all(faces.map(f =>
    loadAndRegisterFont({ path: f.url, name: f.name })
      .catch((e) => console.warn(`[daepdf] Could not load font "${f.name}" from ${f.url}:`, e))
  ))
  invalidateFontMapCache()
}
