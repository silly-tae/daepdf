// Page-break engine: mutates the attached, styled container with marked spacer
// elements so the browser itself reflows content below each fix — geometry stays
// truthful because it IS the layout, not a prediction of it. Every mutation is
// marked with data-tpdf-break and reverted by undoPageBreaks (fromDOM may receive
// the caller's live element).
//
// Policy (browser-print behavior): never slice a text line, image, canvas, SVG,
// or table row across a page boundary; treat flex/grid containers and explicit
// break-inside:avoid subtrees as atomic; honor break-before/after: page.
// Anything taller than one page is left to the geometric MediaBox slicing.

const BREAK_ATTR = 'data-tpdf-break'
const MAX_FIXES  = 300

interface Violation {
  top:  number
  fix:  () => boolean
}

function isOutOfFlow(cs: CSSStyleDeclaration): boolean {
  return cs.position === 'absolute' || cs.position === 'fixed'
}

function wantsBreakBefore(cs: CSSStyleDeclaration): boolean {
  const v = (cs as any).breakBefore ?? ''
  return v === 'page' || v === 'left' || v === 'right' || v === 'always'
}

function wantsBreakAfter(cs: CSSStyleDeclaration): boolean {
  const v = (cs as any).breakAfter ?? ''
  return v === 'page' || v === 'left' || v === 'right' || v === 'always'
}

function avoidsBreakInside(cs: CSSStyleDeclaration): boolean {
  const v = (cs as any).breakInside ?? ''
  return v === 'avoid' || v === 'avoid-page'
}

const ATOMIC_TAGS = new Set(['IMG', 'CANVAS', 'SVG', 'TR'])

function isAtomic(el: Element, cs: CSSStyleDeclaration): boolean {
  if (ATOMIC_TAGS.has(el.tagName.toUpperCase())) return true
  if (avoidsBreakInside(cs)) return true
  // a spacer inside a flex/grid container can't push items down individually
  const d = cs.display
  return d === 'flex' || d === 'grid' || d === 'inline-flex' || d === 'inline-grid'
}

// distance from `top` up to the next page boundary strictly above it
function pushHeight(top: number, containerTop: number, pageHPx: number): number {
  const rel = top - containerTop
  const next = (Math.floor(rel / pageHPx) + 1) * pageHPx
  return next - rel
}

function makeSpacer(doc: Document, forTag: string, heightPx: number): Element {
  if (forTag === 'TR') {
    const tr = doc.createElement('tr')
    tr.setAttribute(BREAK_ATTR, '')
    const td = doc.createElement('td')
    td.colSpan = 100
    td.style.cssText = `height:${heightPx}px;padding:0;border:0;background:transparent;`
    tr.appendChild(td)
    return tr
  }
  const div = doc.createElement('div')
  div.setAttribute(BREAK_ATTR, '')
  div.style.cssText = `display:block;height:${heightPx}px;margin:0;padding:0;border:0;`
  return div
}

// Insert a spacer before `node`, then correct its height once by the residual
// between where the target actually landed and the intended page top — margin
// collapse and table row sizing are absorbed exactly instead of predicted.
function insertSpacer(node: Node, targetRect: () => DOMRect, containerTop: number, pageHPx: number): boolean {
  const parent = node.parentNode
  if (!parent) return false
  const doc = node.ownerDocument ?? document
  const startTop = targetRect().top
  const h = pushHeight(startTop, containerTop, pageHPx)
  if (h <= 0.5 || h >= pageHPx) return false

  const forTag = node.nodeType === Node.ELEMENT_NODE ? (node as Element).tagName.toUpperCase() : ''
  const spacer = makeSpacer(doc, forTag, h) as HTMLElement
  parent.insertBefore(spacer, node)

  const intendedRel = (Math.floor((startTop - containerTop) / pageHPx) + 1) * pageHPx
  const actualRel   = targetRect().top - containerTop
  const residual    = intendedRel - actualRel
  if (Math.abs(residual) > 0.5) {
    const inner = forTag === 'TR' ? (spacer.firstElementChild as HTMLElement) : spacer
    const newH  = h + residual
    if (newH <= 0.5 || newH >= pageHPx * 1.5) { parent.removeChild(spacer); return false }
    inner.style.height = `${newH}px`
  }
  // the correction itself must land within tolerance, or this violation would
  // re-trigger forever — accept whatever landed (better than looping)
  return true
}

// C1: repeats a table's own <thead> rows right after a pushed <tr> lands at a
// new page's top — real browsers do this natively for print; this DOM-
// mutation engine doesn't get it for free, so it's reproduced explicitly.
// Called AFTER insertSpacer already placed `tr` at the page boundary — the
// clone's own natural height pushes `tr` (and everything after it) down by
// exactly its real rendered height, no synthetic sizing guess needed, unlike
// insertSpacer's own height correction dance.
//
// Cloned as PLAIN <tr> siblings — deliberately NOT wrapped in a new <thead>
// and NOT given `display: table-header-group`. Either of those gets pulled to
// the very TOP of the table by the CSS table layout algorithm regardless of
// DOM position (CSS 2.1 §17.5.2: all header-groups render before all row-
// groups, unconditionally) — exactly the opposite of "appear at this break
// point." Plain <tr> elements have no such reordering.
//
// Documented limitation: a clone's ancestor is no longer literally <thead>,
// so an author rule like `thead th { ... }` won't match it — a rule on
// `th`/a class directly still works fine.
function repeatThead(tr: Element): void {
  if (tr.closest('thead')) return // the header's own row crossed — don't repeat it above itself
  const table = tr.closest('table')
  if (!table) return
  const thead = table.querySelector(':scope > thead') as HTMLTableSectionElement | null
  if (!thead || !thead.rows.length) return
  const parent = tr.parentNode
  if (!parent) return
  const frag = (tr.ownerDocument ?? document).createDocumentFragment()
  for (const row of Array.from(thead.rows)) {
    const clone = row.cloneNode(true) as HTMLElement
    clone.setAttribute(BREAK_ATTR, '')
    frag.appendChild(clone)
  }
  parent.insertBefore(frag, tr)
}

function crossesBoundary(rect: DOMRect, containerTop: number, pageHPx: number): boolean {
  if (rect.height <= 0.5 || rect.height >= pageHPx) return false
  const topRel = rect.top - containerTop
  const botRel = rect.bottom - containerTop
  // 0.5px tolerance: sub-pixel rounding at an exact boundary is not a violation
  return Math.floor((topRel + 0.5) / pageHPx) !== Math.floor((botRel - 0.5) / pageHPx)
}

function atPageTop(rect: DOMRect, containerTop: number, pageHPx: number): boolean {
  const rel = (rect.top - containerTop) % pageHPx
  return rel < 1
}

// The earliest (topmost) violation in the container, or null when clean.
// Only the FIRST violation matters per iteration — fixing it reflows everything
// below, so later candidates are stale the moment a spacer lands.
function findViolation(
  root: HTMLElement, containerTop: number, pageHPx: number, skip: Set<Node>,
): Violation | null {
  let best: Violation | null = null
  const consider = (top: number, fix: () => boolean, node: Node) => {
    if (skip.has(node)) return
    if (best === null || top < best.top - 0.5) {
      best = { top, fix: () => { const ok = fix(); if (!ok) skip.add(node); return ok } }
    }
  }

  const walkEl = (el: Element): void => {
    const cs = getComputedStyle(el)
    // the root is the capture/measure container — it is position:fixed itself
    // (createHiddenContainer, previewHTML's measure div), so the out-of-flow
    // skip must not apply to it, only to its descendants
    if (el !== root) {
      if (cs.display === 'none' || isOutOfFlow(cs)) return
      if (el.hasAttribute(BREAK_ATTR)) return
    }

    const rect = el.getBoundingClientRect()

    if (wantsBreakBefore(cs) && rect.height > 0 && !atPageTop(rect, containerTop, pageHPx)) {
      consider(rect.top, () => insertSpacer(el, () => el.getBoundingClientRect(), containerTop, pageHPx), el)
    }

    if (wantsBreakAfter(cs)) {
      let sib = el.nextElementSibling
      while (sib && (sib.hasAttribute(BREAK_ATTR) || getComputedStyle(sib).display === 'none')) sib = sib.nextElementSibling
      if (sib) {
        const sr = sib.getBoundingClientRect()
        const target = sib
        if (sr.height > 0 && !atPageTop(sr, containerTop, pageHPx)) {
          consider(sr.top, () => insertSpacer(target, () => target.getBoundingClientRect(), containerTop, pageHPx), target)
        }
      }
    }

    if (isAtomic(el, cs)) {
      if (crossesBoundary(rect, containerTop, pageHPx)) {
        const isRow = el.tagName.toUpperCase() === 'TR'
        const fix = () => {
          const ok = insertSpacer(el, () => el.getBoundingClientRect(), containerTop, pageHPx)
          if (ok && isRow) repeatThead(el)
          return ok
        }
        consider(rect.top, fix, el)
      }
      // atomic subtrees are pushed whole — their interior is never split
      return
    }

    for (const child of Array.from(el.childNodes)) {
      if (child.nodeType === Node.ELEMENT_NODE) {
        walkEl(child as Element)
      } else if (child.nodeType === Node.TEXT_NODE && (child.textContent ?? '').trim()) {
        walkText(child as Text)
      }
    }
  }

  const walkText = (textNode: Text): void => {
    const range = (textNode.ownerDocument ?? document).createRange()
    range.selectNodeContents(textNode)
    const rects = Array.from(range.getClientRects()).filter(r => r.height > 0.5 && r.width > 0.1)
    for (const r of rects) {
      if (!crossesBoundary(r, containerTop, pageHPx)) continue
      const lineTop = r.top
      consider(lineTop, () => fixTextLineWithOrphansWidows(textNode, lineTop, containerTop, pageHPx), textNode)
      break
    }
  }

  walkEl(root)
  return best
}

// Split the text node at the start of the crossing line (per-char rect tops)
// and push that line to the next page top with a block spacer. The line already
// starts at a word/wrap point, so wrapping is preserved after the push.
function fixTextLine(textNode: Text, lineTop: number, containerTop: number, pageHPx: number): boolean {
  const doc   = textNode.ownerDocument ?? document
  const range = doc.createRange()
  const len   = textNode.length
  let splitAt = -1
  for (let i = 0; i < len; i++) {
    range.setStart(textNode, i)
    range.setEnd(textNode, i + 1)
    const cr = range.getBoundingClientRect()
    if (cr.height <= 0.5 && cr.width <= 0.1) continue
    if (cr.top >= lineTop - 1) { splitAt = i; break }
  }
  if (splitAt < 0) return false

  let target: Node = textNode
  if (splitAt > 0) target = textNode.splitText(splitAt)

  const parent = target.parentNode
  if (!parent) return false
  // inside inline context a div is invalid — a block span behaves identically
  const block = doc.createElement('span')
  block.setAttribute(BREAK_ATTR, '')
  block.style.cssText = 'display:block;height:1px;margin:0;padding:0;border:0;'
  parent.insertBefore(block, target)

  const rectOf = () => {
    const r2 = doc.createRange()
    r2.setStart(target, 0)
    r2.setEnd(target, Math.min(1, (target as Text).length))
    return r2.getBoundingClientRect()
  }
  const startTop = rectOf().top
  const h = pushHeight(startTop, containerTop, pageHPx)
  if (h <= 0.5 || h >= pageHPx) { parent.removeChild(block); return false }
  block.style.height = `${h}px`

  const intendedRel = (Math.floor((startTop - containerTop) / pageHPx) + 1) * pageHPx
  const residual    = intendedRel - (rectOf().top - containerTop)
  if (Math.abs(residual) > 0.5) {
    const newH = h + residual
    if (newH <= 0.5 || newH >= pageHPx * 1.5) { parent.removeChild(block); return false }
    block.style.height = `${newH}px`
  }
  return true
}

// C3: the nearest ancestor whose OWN rendering directly produces the line
// boxes orphans/widows apply against (a paragraph, list item, plain div of
// text, etc.) — not just any block, but the one this text node's lines
// actually belong to.
function findLineBlock(node: Node): Element | null {
  let el = node.parentElement
  while (el) {
    const d = getComputedStyle(el).display
    if (d === 'block' || d === 'list-item' || d === 'table-cell' || d === 'flow-root') return el
    el = el.parentElement
  }
  return null
}

// Generalizes fixTextLine's own per-character scan across EVERY text node in
// `block`, not just one — needed when the orphans/widows-adjusted split line
// falls in a different text node than the one that first reported the
// crossing (e.g. a paragraph split across a <b>/<i> inline boundary). Once
// the right node is found, fixTextLine re-derives the exact offset within
// it independently — a small redundant re-scan, but far simpler than
// threading a starting offset through.
function fixLineAcrossBlock(block: Element, targetTop: number, containerTop: number, pageHPx: number): boolean {
  const doc     = block.ownerDocument ?? document
  const walker  = doc.createTreeWalker(block, NodeFilter.SHOW_TEXT)
  const range   = doc.createRange()
  let node: Node | null
  while ((node = walker.nextNode())) {
    const text = node as Text
    for (let i = 0; i < text.length; i++) {
      range.setStart(text, i)
      range.setEnd(text, i + 1)
      const cr = range.getBoundingClientRect()
      if (cr.height <= 0.5 && cr.width <= 0.1) continue
      if (cr.top >= targetTop - 1) return fixTextLine(text, targetTop, containerTop, pageHPx)
    }
  }
  return false
}

// Wraps fixTextLine with orphans/widows enforcement: a block container's
// `orphans` (minimum lines kept on the FIRST page) and `widows` (minimum
// lines carried to the NEXT page) can require moving the split point earlier
// than the naive first-crossing-line detection found — or, if the crossing
// happens too early in the block for orphans to be satisfiable at all,
// pushing the WHOLE block instead of splitting it (reusing the exact same
// atomic-element push path isAtomic() elements already use).
function fixTextLineWithOrphansWidows(textNode: Text, lineTop: number, containerTop: number, pageHPx: number): boolean {
  const block = findLineBlock(textNode)
  if (!block) return fixTextLine(textNode, lineTop, containerTop, pageHPx)

  const cs      = getComputedStyle(block)
  const orphans = parseInt((cs as any).orphans, 10) || 2
  const widows  = parseInt((cs as any).widows, 10) || 2
  // fast path: CSS defaults both to 2, so this still runs for the common
  // case — but only once per actual crossing line, not per line overall
  if (orphans <= 1 && widows <= 1) return fixTextLine(textNode, lineTop, containerTop, pageHPx)

  const doc = textNode.ownerDocument ?? document
  const blockRange = doc.createRange()
  blockRange.selectNodeContents(block)
  const lineRects = Array.from(blockRange.getClientRects()).filter(r => r.height > 0.5 && r.width > 0.1)
  if (!lineRects.length) return fixTextLine(textNode, lineTop, containerTop, pageHPx)

  const N = lineRects.length
  const K = lineRects.findIndex(r => Math.abs(r.top - lineTop) < 1)
  if (K < 0) return fixTextLine(textNode, lineTop, containerTop, pageHPx) // shouldn't happen — stay safe

  if (K < orphans) {
    // too few lines would remain before the break — can't satisfy orphans by
    // splitting inside this block at all; push the whole block instead
    return insertSpacer(block, () => block.getBoundingClientRect(), containerTop, pageHPx)
  }

  const splitIdx = (N - K < widows) ? Math.max(orphans, N - widows) : K
  if (splitIdx === K) return fixTextLine(textNode, lineTop, containerTop, pageHPx)

  return fixLineAcrossBlock(block, lineRects[splitIdx]!.top, containerTop, pageHPx)
}

export function applyPageBreaks(root: HTMLElement, pageHPx: number): void {
  if (pageHPx <= 0) return
  // single-page content can't cross a boundary via NATURAL overflow — but an
  // explicit break-before/after/inside can still force a break regardless of
  // height (e.g. "always start this section on a fresh page" on genuinely
  // short content), so the skip only holds when no such property could even
  // be present. A cheap substring check on the container's own markup (a
  // getComputedStyle-based check per element would cost as much as the walk
  // itself, defeating the whole point of the fast path) — CSS scoping only
  // rewrites :root/html/body selectors and wraps in @scope, never touching
  // property names, so this substring survives scoping intact.
  const mightBreak = /break-(?:before|after|inside)/.test(root.innerHTML)
  if (!mightBreak && root.scrollHeight <= pageHPx + 0.5) return

  const skip = new Set<Node>()
  for (let i = 0; i < MAX_FIXES; i++) {
    const containerTop = root.getBoundingClientRect().top
    const violation = findViolation(root, containerTop, pageHPx, skip)
    if (!violation) return
    violation.fix()
  }
  console.warn('[daepdf] Page-break pass hit the fix cap — layout may still contain cut content.')
}

export function undoPageBreaks(root: HTMLElement): void {
  const spacers = root.querySelectorAll(`[${BREAK_ATTR}]`)
  const parents = new Set<Node>()
  for (const sp of Array.from(spacers)) {
    if (sp.parentNode) parents.add(sp.parentNode)
    sp.remove()
  }
  // re-merge the text nodes fixTextLine split
  for (const p of parents) p.normalize()
}
