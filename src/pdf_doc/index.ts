import type { Corner, StructNode } from '../types/index.js'
import type { RawImage } from '../images/decode.js'
import {
  get_glyph_ids, shape_text, get_advance_widths,
  get_colr_layers, get_glyph_bitmap, get_vertical_advance,
} from '../daepl/wasm/daepl.js'
import { deflate } from './deflate.js'
import { parseImage as parse_image } from '../images/parse.js'
import type { InternalCtx } from './types.js'
import type { DocFont, EmbedImage, SecurityConfig, GradDef, ShadPat, GradSoftMask, Bookmark, PageAnnot, ObjStmItem } from './types.js'
import { _te, hpf, encodeColor, pdfEscape, pdfDate, bytesToHex, toPdfName, textStringBytes } from './utils.js'
import { computeR6Security } from './crypto_r6.js'
import { aesCbcEncrypt } from './aes.js'
import { putPages } from './build_pages.js'
import { putFonts } from './build_fonts.js'
import { putImages, putShadingPatterns, putGradientSoftMasks, putResourceDictionary, packObjStm } from './build_resources.js'
import { putCatalog, putEncryptDict, buildXrefStream } from './build_catalog.js'
import { putStructTree } from './build_structtree.js'
import { putPdfAExtras } from './build_pdfa.js'

// CSS: a corner rounds only when BOTH radius components are positive
const Z: Corner = { h: 0, v: 0 }
function rounds(c: Corner): boolean {
  return c.h > 0 && c.v > 0
}

// inner curve of a border band: each component shrinks by the band width,
// clamping at square — never a negative or lopsided-degenerate radius
function insetCorner(c: Corner, by: number): Corner {
  return { h: Math.max(0, c.h - by), v: Math.max(0, c.v - by) }
}

export class PdfDoc implements InternalCtx {
  buf:         Uint8Array[] = []
  byteLen      = 0
  objectNumber = 0
  offsets:     number[] = [0]

  fonts:           DocFont[] = []
  private fontMap: Map<string, number> = new Map()
  usedFonts:       Set<string> = new Set()

  images: EmbedImage[] = []

  gradDefs:      GradDef[] = []
  shadPats:      ShadPat[] = []
  gradSoftMasks: GradSoftMask[] = []
  extGStates:    { alpha: number; blend: string }[] = []

  allPageBufs:           string[][] = []
  pageAnnots:            PageAnnot[][] = []
  private currentPageIdx = -1
  pageObjIds:            number[] = []
  formFieldObjIds:       number[] = []

  // D1 (AcroForm): while set, pageOut() redirects to this scratch buffer
  // instead of the current page's own — lets an appearance stream reuse
  // set_font/set_font_size/set_text_color/text() (with all their correct
  // glyph-shaping/hex-CID/ToUnicode machinery) without touching real page
  // content. captureAppearance() is the only thing that sets/clears it.
  private apBuf: string[] | null = null

  rootDictObjId:     number
  resourceDictObjId: number

  security: SecurityConfig | undefined = undefined
  fileId:   Uint8Array

  metadata:   [string, string][] = []
  bookmarks:  Bookmark[] = []
  namedDests: [string, number, number][] = []

  objStmQueue:          ObjStmItem[] = []
  objStmMembers:        [number, number, number][] = []
  private captureStack: string[][] = []

  structRoot: StructNode | undefined = undefined
  pdfA        = false
  pdfaLang:   string | undefined = undefined

  formatW:      number
  formatH:      number
  creationDate: string

  private built           = false
  private builtBytes:     Uint8Array | null = null
  private activeFontKey   = ''
  private activeFontSize  = 16
  private activeCharSpace = 0
  private activeWordSpace = 0
  private strokeColor     = '0 G'
  private textColor       = '0 g'
  private lineWidth       = 0.200025

  // Stream-emission caches: what the CURRENT page's content stream last had written
  // to it. They are per-stream state, so they must be invalidated on any page switch
  // and restored on Q (which reverts font/color/spacing per the PDF graphics-state
  // model). Fill and text colors share the single non-stroke operator (rg/g), so
  // they share one cache — tracking them separately let a box fill silently change
  // the color under a deduped text op (and vice versa).
  private lastFontKey   = ''
  private lastFontSize  = -1
  private lastLeading   = -1
  private lastNonstroke = ''
  private lastStroke    = ''
  private lastLineWidth = -1
  private lastCharSpace = 0
  private lastWordSpace = 0
  // PDF text rendering mode (Tr) — 0 fill, 1 stroke, 2 fill+stroke. Persists
  // across BT/ET blocks like the other text-state operators above, so it needs
  // the same page-start reset and q/Q reversion, not just a per-call value.
  private lastTextRenderMode = 0

  // emoji/color-font glyphs (A1): a bitmap glyph repeated across a document
  // (the same emoji reused) would otherwise re-embed identical PNG bytes on
  // every occurrence — keyed by the exact inputs get_glyph_bitmap itself uses
  private glyphImageCache = new Map<string, number>()

  // a font's own COLR/bitmap coverage never changes once registered — every
  // ordinary glyph in ordinary text would otherwise pay 1-2 WASM boundary
  // crossings (get_colr_layers + get_glyph_bitmap) on EVERY occurrence, not
  // just the first. Memoized per (font, style, gid[, ppem for bitmap]) so a
  // real document's heavy glyph repetition (the same letters over and over)
  // costs this check exactly once per unique glyph, not once per character.
  private colrCache   = new Map<string, { gid: number; r: number; g: number; b: number; isFg: boolean }[] | null>()
  private bitmapCache = new Map<string, { png: Uint8Array; ppem: number; originX: number; originY: number } | null>()

  private gsStack: {
    activeKey: string; activeSize: number; textColor: string
    strokeColor: string; lineWidth: number
    activeCharSpace: number; activeWordSpace: number
    lastFontKey: string; lastFontSize: number; lastLeading: number
    lastNonstroke: string; lastStroke: string; lastLineWidth: number
    lastCharSpace: number; lastWordSpace: number; lastTextRenderMode: number
  }[] = []

  constructor(width: number, height: number) {
    this.formatW      = width
    this.formatH      = height
    this.fileId       = crypto.getRandomValues(new Uint8Array(16))
    this.creationDate = pdfDate()

    this.write('%PDF-1.6\n')
    this.writeBytes(new Uint8Array([0x25, 0xBA, 0xDF, 0xAC, 0xE0, 0x0A]))

    this.rootDictObjId     = this.newObjectDeferred()
    this.resourceDictObjId = this.newObjectDeferred()

    this.addPageInternal()
  }

  private get ctx(): InternalCtx {
    return this
  }

  write(s: string): void {
    const enc = _te.encode(s)
    this.buf.push(enc)
    this.byteLen += enc.length
  }

  writeBytes(b: Uint8Array): void {
    this.buf.push(b)
    this.byteLen += b.length
  }

  newObjectDeferred(): number {
    this.objectNumber++
    while (this.offsets.length <= this.objectNumber) this.offsets.push(0)
    this.offsets[this.objectNumber] = Number.MAX_SAFE_INTEGER
    return this.objectNumber
  }

  newObjectDeferredBegin(oid: number, doOutput: boolean): void {
    while (this.offsets.length <= oid) this.offsets.push(0)
    this.offsets[oid] = this.byteLen
    if (doOutput) this.out(`${oid} 0 obj`)
  }

  newObject(): number {
    const oid = this.newObjectDeferred()
    this.newObjectDeferredBegin(oid, true)
    return oid
  }

  out(s: string): void {
    const top = this.captureStack.at(-1)
    if (top) top.push(s + '\n')
    else this.write(s + '\n')
  }

  outBytes(b: Uint8Array): void {
    const data = this.encBytes(b)
    this.writeBytes(data)
    this.write('\n')
  }

  // Every stream's /Length dict entry is written BEFORE outBytes() runs
  // (PDF syntax requires the dict to precede the `stream` keyword), so a
  // caller computing /Length from its own plaintext buffer's length is
  // silently wrong the moment encryption is on: encBytes() grows the
  // written bytes by a 16-byte IV plus 1-16 bytes of PKCS#7 padding, which
  // the dict never accounted for. Every /Length-then-outBytes call site
  // must run its plaintext length through this first.
  encryptedLength(plainLen: number): number {
    if (!this.security) return plainLen
    const paddedLen = Math.ceil((plainLen + 1) / 16) * 16
    return 16 + paddedLen
  }

  beginCapture(): void {
    this.captureStack.push([])
  }

  endCapture(): string {
    return (this.captureStack.pop() ?? []).join('')
  }

  queueForObjStm(content: string): number {
    const oid = this.newObjectDeferred()
    this.objStmQueue.push({ oid, content })
    return oid
  }

  // V5/R6 (AESV3): every object is encrypted with the SAME file key — no
  // per-object key derivation like the R3 handler this replaced needed —
  // just a fresh random IV per string/stream, prepended to the ciphertext
  strLit(s: string): string {
    const bytes = textStringBytes(s)
    if (this.security) {
      const iv  = crypto.getRandomValues(new Uint8Array(16))
      const ct  = aesCbcEncrypt(this.security.fileKey, iv, bytes, true)
      return `<${bytesToHex(iv)}${bytesToHex(ct)}>`
    }
    // UTF-16BE has to go out as a hex string: its bytes include NUL and other
    // values a literal string cannot carry safely.
    if (bytes.length >= 2 && bytes[0] === 0xFE && bytes[1] === 0xFF) return `<${bytesToHex(bytes)}>`
    return `(${pdfEscape(s)})`
  }

  encBytes(data: Uint8Array): Uint8Array {
    if (!this.security) return data
    const iv = crypto.getRandomValues(new Uint8Array(16))
    const ct = aesCbcEncrypt(this.security.fileKey, iv, data, true)
    const out = new Uint8Array(iv.length + ct.length)
    out.set(iv); out.set(ct, iv.length)
    return out
  }

  private pageOut(s: string): void {
    if (this.apBuf) { this.apBuf.push(s); return }
    this.allPageBufs[this.currentPageIdx]?.push(s)
  }

  // Runs `draw` with pageOut() diverted into an isolated buffer, scoped by
  // save_graphics_state()/restore_graphics_state() so the REAL page's own
  // font/size/color/spacing emission caches (and the q/Q depth) are exactly
  // as they were once this returns — the appearance stream is built as a
  // total side effect-free detour from the main document's own content
  // emission, even though it reuses the exact same stateful drawing methods.
  //
  // apBuf is a BRAND NEW, independent content stream — but the lastFontKey/
  // lastFontSize/... fields are a "what has this stream already emitted"
  // dedup cache (text()/set_font() skip re-emitting Tf/Tc/Tw/Tr/color when
  // they match the cache, an optimization against the PAGE's own stream), so
  // they must be forced to "nothing emitted yet" sentinels for the duration
  // of the capture and restored after — the exact same reset set_page()
  // already does when switching to a different page's stream. Without this,
  // whenever the page happened to have just emitted the same font/size the
  // field also uses (an extremely common case — a field textually near page
  // content in the same font), the field's own first Tf gets silently
  // deduped away, producing a `BT ... Tj ET` with no font ever set at all.
  // Caught by pdfjs itself refusing to render it ("Missing setFont (Tf)
  // operator before text rendering operator") — confirmed via a real render.
  private captureAppearance(draw: () => void): string {
    const saved = this.apBuf
    this.apBuf = []

    const savedFontKey = this.lastFontKey, savedFontSize = this.lastFontSize, savedLeading = this.lastLeading
    const savedNonstroke = this.lastNonstroke, savedStroke = this.lastStroke, savedLineWidth = this.lastLineWidth
    const savedCharSpace = this.lastCharSpace, savedWordSpace = this.lastWordSpace
    const savedTextRenderMode = this.lastTextRenderMode
    this.lastFontKey = ''; this.lastFontSize = -1; this.lastLeading = -1
    this.lastNonstroke = ''; this.lastStroke = ''; this.lastLineWidth = -1
    this.lastCharSpace = -1; this.lastWordSpace = -1
    this.lastTextRenderMode = -1

    this.save_graphics_state()
    draw()
    this.restore_graphics_state()

    this.lastFontKey = savedFontKey; this.lastFontSize = savedFontSize; this.lastLeading = savedLeading
    this.lastNonstroke = savedNonstroke; this.lastStroke = savedStroke; this.lastLineWidth = savedLineWidth
    this.lastCharSpace = savedCharSpace; this.lastWordSpace = savedWordSpace
    this.lastTextRenderMode = savedTextRenderMode

    const result = this.apBuf.join('\n')
    this.apBuf = saved
    return result
  }

  private putStyle(style: string): void {
    this.pageOut(style === 'F' ? 'f' : 'S')
  }

  private addPageInternal(): void {
    this.allPageBufs.push([])
    this.pageAnnots.push([])
    this.currentPageIdx = this.allPageBufs.length - 1

    this.lastFontKey   = ''
    this.lastFontSize  = -1
    this.lastLeading   = -1
    this.lastNonstroke = ''
    this.lastCharSpace = 0
    this.lastWordSpace = 0
    // 0 (Fill) is Tr's actual stream default, unlike stroke color/width below —
    // no re-emission needed, same as the Tc/Tw reset just above
    this.lastTextRenderMode = 0

    this.pageOut(`${hpf(this.lineWidth)} w`)
    this.pageOut(this.strokeColor)
    this.lastLineWidth = this.lineWidth
    this.lastStroke    = this.strokeColor
  }

  private getOrCreateFont(name: string, style: string, weight: number): DocFont {
    const key = `${name.toLowerCase()}|${style}:${weight}`
    const existing = this.fontMap.get(key)
    if (existing !== undefined) return this.fonts[existing]!

    const id  = `F${this.fonts.length + 1}`
    const idx = this.fonts.length
    this.fonts.push({
      id,
      fontName:       name,
      style,
      weight,
      opsz:           0,
      glyphIds:       new Set([0]),
      glyphToUnicode: new Map(),
      objectNumber:   0,
      isAlreadyPutted: false,
      usedVertically:       false,
      verticalObjectNumber: 0,
    })
    this.fontMap.set(key, idx)
    return this.fonts[idx]!
  }

  set_font(fontName: string, fontStyle: string, cssWeight: number): void {
    this.activeFontKey = this.getOrCreateFont(fontName, fontStyle, cssWeight).id
  }

  set_font_size(size: number): void {
    this.activeFontSize = size
  }

  set_char_space(space: number): void {
    this.activeCharSpace = space
  }

  set_word_spacing(pt: number): void {
    this.activeWordSpace = pt
  }

  // 3 decimals to match set_text_color — at 2, a box and text in the same subtle
  // hex shade can encode to visibly different grays (1/255 ≈ 0.004)
  set_draw_color(r: number, g: number, b: number): void {
    const c = encodeColor(r, g, b, true, 3)
    this.strokeColor = c
    if (c !== this.lastStroke) { this.pageOut(c); this.lastStroke = c }
  }

  set_fill_color(r: number, g: number, b: number): void {
    const c = encodeColor(r, g, b, false, 3)
    if (c !== this.lastNonstroke) { this.pageOut(c); this.lastNonstroke = c }
  }

  set_text_color(r: number, g: number, b: number): void {
    this.textColor = encodeColor(r, g, b, false, 3)
  }

  set_line_width(width: number): void {
    this.lineWidth = width
    if (width !== this.lastLineWidth) { this.pageOut(`${hpf(width)} w`); this.lastLineWidth = width }
  }

  set_line_dash(dashArray: number[] | null, dashPhase: number): void {
    const arr = dashArray && dashArray.length ? dashArray.map(hpf).join(' ') : ''
    this.pageOut(`[${arr}] ${hpf(dashPhase)} d`)
  }

  // PDF line cap (J): 0 butt (default), 1 round, 2 projecting square —
  // matches SVG stroke-linecap's butt/round/square 1:1
  set_line_cap(cap: number): void {
    this.pageOut(`${cap} J`)
  }

  // PDF line join (j): 0 miter (default), 1 round, 2 bevel — matches SVG
  // stroke-linejoin's miter/round/bevel (miter-clip/arcs, SVG2 additions
  // with no PDF equivalent, degrade to the miter default)
  set_line_join(join: number): void {
    this.pageOut(`${join} j`)
  }

  save_graphics_state(): void {
    this.gsStack.push({
      activeKey: this.activeFontKey, activeSize: this.activeFontSize, textColor: this.textColor,
      strokeColor: this.strokeColor, lineWidth: this.lineWidth,
      activeCharSpace: this.activeCharSpace, activeWordSpace: this.activeWordSpace,
      lastFontKey: this.lastFontKey, lastFontSize: this.lastFontSize, lastLeading: this.lastLeading,
      lastNonstroke: this.lastNonstroke, lastStroke: this.lastStroke, lastLineWidth: this.lastLineWidth,
      lastCharSpace: this.lastCharSpace, lastWordSpace: this.lastWordSpace,
      lastTextRenderMode: this.lastTextRenderMode,
    })
    this.pageOut('q')
  }

  // Q reverts the stream's font/size/color/spacing to their values at the matching q
  // — the emission caches must revert with it, or the next op that happens to match
  // the inside-the-region value gets deduped away and renders with the reverted state
  restore_graphics_state(): void {
    this.pageOut('Q')
    const st = this.gsStack.pop()
    if (st) {
      this.activeFontKey = st.activeKey; this.activeFontSize = st.activeSize; this.textColor = st.textColor
      this.strokeColor = st.strokeColor; this.lineWidth = st.lineWidth
      this.activeCharSpace = st.activeCharSpace; this.activeWordSpace = st.activeWordSpace
      this.lastFontKey = st.lastFontKey; this.lastFontSize = st.lastFontSize; this.lastLeading = st.lastLeading
      this.lastNonstroke = st.lastNonstroke; this.lastStroke = st.lastStroke; this.lastLineWidth = st.lastLineWidth
      this.lastCharSpace = st.lastCharSpace; this.lastWordSpace = st.lastWordSpace
      this.lastTextRenderMode = st.lastTextRenderMode
    } else {
      this.lastFontKey = ''; this.lastFontSize = -1; this.lastLeading = -1
      this.lastNonstroke = ''; this.lastStroke = ''; this.lastLineWidth = -1
      this.lastCharSpace = -1; this.lastWordSpace = -1
      this.lastTextRenderMode = -1
    }
  }

  // blend defaults to Normal (never omitted from the dict) — an ExtGState's /BM
  // key that's merely absent means "leave blend mode unchanged" per spec, which
  // would leak a prior non-Normal mode into whatever draws next instead of resetting it
  set_alpha(opacity: number, blend?: string): void {
    const bm = blend ?? 'Normal'
    const rounded = Math.round(Math.max(0, Math.min(1, opacity)) * 1000)
    let idx = this.extGStates.findIndex(v => Math.round(v.alpha * 1000) === rounded && v.blend === bm)
    if (idx < 0) { idx = this.extGStates.length; this.extGStates.push({ alpha: opacity, blend: bm }) }
    this.pageOut(`/GS${idx} gs`)
  }

  set_clip_rect(x: number, y: number, w: number, h: number): void {
    const yp = this.formatH - y - h
    this.pageOut(`${hpf(x)} ${hpf(yp)} ${hpf(w)} ${hpf(h)} re W n`)
  }

  // even-odd clip to everything OUTSIDE the given rounded rect — outer box-shadows
  // must not paint under the box itself (the spec clips them out of the border box)
  set_clip_outside_rounded_rect(x: number, y: number, w: number, h: number,
                                 tl: Corner, tr: Corner, br: Corner, bl: Corner): void {
    this.pathRect(0, 0, this.formatW, this.formatH)
    this.pathRoundedRect(x, y, w, h, tl, tr, br, bl)
    this.pageOut('W* n')
  }

  set_clip_rounded_rect(x: number, y: number, w: number, h: number,
                         tl: Corner, tr: Corner, br: Corner, bl: Corner): void {
    if (!rounds(tl) && !rounds(tr) && !rounds(br) && !rounds(bl)) { this.set_clip_rect(x, y, w, h); return }
    // the exact same construction as every drawn rounded rect — a border and a
    // clip at the same radius must produce byte-identical curves or the border's
    // arc visibly disagrees with the clip's wherever they meet
    this.pathRoundedRect(x, y, w, h, tl, tr, br, bl)
    this.pageOut('W n')
  }

  // shared by set_clip_path and draw_path (D5) — every PathSeg-consuming
  // caller needs the identical DOM-Y-down-to-PDF-Y-up flip, on just the Y
  // component of each point, applied exactly once at this one boundary.
  private emitPathOps(ops: { op: 'm' | 'l' | 'c'; args: number[] }[]): void {
    const ph = this.formatH
    for (const seg of ops) {
      const [a0 = 0, a1 = 0, a2 = 0, a3 = 0, a4 = 0, a5 = 0] = seg.args
      if (seg.op === 'm') this.pageOut(`${hpf(a0)} ${hpf(ph - a1)} m`)
      else if (seg.op === 'l') this.pageOut(`${hpf(a0)} ${hpf(ph - a1)} l`)
      else this.pageOut(`${hpf(a0)} ${hpf(ph - a1)} ${hpf(a2)} ${hpf(ph - a3)} ${hpf(a4)} ${hpf(ph - a5)} c`)
    }
  }

  // clip-path: polygon()/path() — an arbitrary path clip (nonzero or even-odd
  // winding) rather than a (rounded) rect. `m`ove starts each subpath; a path
  // clip-path is always effectively closed (the clip region is well-defined
  // even for an open subpath, per PDF's own W/W* semantics), so no explicit
  // closepath operator is needed before W/W*.
  set_clip_path(ops: { op: 'm' | 'l' | 'c'; args: number[] }[], evenOdd: boolean): void {
    this.emitPathOps(ops)
    this.pageOut(evenOdd ? 'W* n' : 'W n')
  }

  // D5 (SVG as true vectors): fills and/or strokes an arbitrary path — the
  // same Y-flip machinery as set_clip_path, ending in a paint operator
  // instead of a clip one.
  //
  // A gradient fill+stroke together draw the path TWICE (fill pass, then
  // stroke pass) rather than sharing one B/B* — /Pattern cs must be scoped
  // to JUST the fill (via save_graphics_state()/restore_graphics_state(),
  // not a raw pageOut('q'/'Q'), so the lastStroke/lastLineWidth dedup
  // caches revert correctly too), and setting the stroke color/width INSIDE
  // that same scope would corrupt those caches the instant Q reverts them
  // but the cache still claims they're active — the exact class of bug D1's
  // captureAppearance() had with lastFontKey (see task-map.md).
  draw_path(
    ops: { op: 'm' | 'l' | 'c'; args: number[] }[], evenOdd: boolean,
    fill?: [number, number, number],
    gradientFill?: { gradientId: number; x: number; y: number; w: number; h: number },
    stroke?: { color: [number, number, number]; width: number; dash?: number[] | undefined; lineCap?: number | undefined; lineJoin?: number | undefined },
  ): void {
    const hasFill = fill !== undefined || gradientFill !== undefined
    const hasStroke = stroke !== undefined
    if (!hasFill && !hasStroke) return

    if (gradientFill) {
      this.save_graphics_state()
      const patName = `Sh${this.shadPats.length}`
      const gsOp = this.registerSoftMaskIfNeeded(
        gradientFill.gradientId, gradientFill.x, gradientFill.y, gradientFill.w, gradientFill.h,
      )
      if (gsOp) this.pageOut(gsOp.trimEnd())
      this.shadPats.push({
        patName, defIdx: gradientFill.gradientId,
        x: gradientFill.x, y: gradientFill.y, w: gradientFill.w, h: gradientFill.h,
        pageH: this.formatH, objId: 0,
      })
      this.pageOut('/Pattern cs')
      this.pageOut(`/${patName} scn`)
      this.emitPathOps(ops)
      this.pageOut(evenOdd ? 'f*' : 'f')
      this.restore_graphics_state()
    } else if (fill) {
      this.set_fill_color(fill[0], fill[1], fill[2])
      if (!hasStroke) {
        this.emitPathOps(ops)
        this.pageOut(evenOdd ? 'f*' : 'f')
      }
    }

    if (hasStroke) {
      this.set_draw_color(stroke.color[0], stroke.color[1], stroke.color[2])
      this.set_line_width(stroke.width)
      if (stroke.dash?.length) this.set_line_dash(stroke.dash, 0)
      if (stroke.lineCap)  this.set_line_cap(stroke.lineCap)
      if (stroke.lineJoin) this.set_line_join(stroke.lineJoin)
      this.emitPathOps(ops)
      // a plain (non-gradient) fill shares this same path definition with
      // its stroke via B/B* — one pass, matching how every other filled+
      // stroked shape in this file already draws (e.g. border_ring's own
      // fill-then-separate-stroke aside, rect() itself uses B for this case)
      this.pageOut(fill && !gradientFill ? (evenOdd ? 'B*' : 'B') : 'S')
      if (stroke.dash?.length) this.set_line_dash([], 0)
      // reset to PDF's own defaults so a later stroke without an explicit
      // cap/join (e.g. a plain CSS border draw) doesn't inherit this one's
      // — mirrors the dash reset immediately above for the same reason
      if (stroke.lineCap)  this.set_line_cap(0)
      if (stroke.lineJoin) this.set_line_join(0)
    }
  }

  // CSS transforms: matrix is the PDF-native cm 6-tuple, already Y-adapted and
  // origin-pivoted by html/transform.ts. Callers pair this with
  // save_graphics_state()/restore_graphics_state() the same way clip-push/pop
  // do — cm concatenates onto the CTM, so it must be scoped by q/Q or it leaks
  // into every draw for the rest of the page.
  set_transform(matrix: number[]): void {
    this.pageOut(`${matrix.map(hpf).join(' ')} cm`)
  }

  // D3 (tagged PDF): wraps content in BDC/EMC so it can be traced back to a
  // /StructTreeRoot element via (page, mcid) — the inline << /MCID n >>
  // dict needs no /Properties resource entry (that's only required when
  // BDC's 2nd operand is a NAME reference into the resource dict instead of
  // an inline dict, per PDF 32000-1 §14.6.2)
  begin_marked_content(structTag: string, mcid: number): void {
    this.pageOut(`/${toPdfName(structTag)} << /MCID ${mcid} >> BDC`)
  }

  end_marked_content(): void {
    this.pageOut('EMC')
  }

  // stroke: -webkit-text-stroke — strokeOnly picks Tr 1 (stroke only), otherwise
  // Tr 2 (fill+stroke). Stroke color/width reuse the same graphics-state operators
  // (RG/w) path and rect strokes already use — it's the same PDF state either way.
  text(text: string, x: number, y: number, baseline: string,
       stroke?: { color: [number, number, number]; width: number; strokeOnly: boolean }): void {
    if (!text) return

    const height  = this.activeFontSize
    const leading = height * 1.15
    const descent = height * 0.15
    let adjY = y
    if      (baseline === 'bottom')   adjY = y - descent
    else if (baseline === 'top')      adjY = y + height - descent
    else if (baseline === 'hanging')  adjY = y + height - 2 * descent
    else if (baseline === 'middle')   adjY = y + height / 2 - descent

    const font = this.fonts.find(f => f.id === this.activeFontKey)
    if (!font) return

    // deferred until after the font guard so an aborted draw never leaves
    // a stray stroke color/width mutation in the stream with nothing drawn
    if (stroke) {
      this.set_draw_color(stroke.color[0], stroke.color[1], stroke.color[2])
      this.set_line_width(stroke.width)
    }
    const textRenderMode = stroke ? (stroke.strokeOnly ? 1 : 2) : 0

    const posY   = this.formatH - adjY
    this.usedFonts.add(this.activeFontKey)

    // Shaped path: rustybuzz applies GSUB/GPOS (ligatures, kerning, complex
    // scripts). Kerning is honored via TJ adjustments — Identity-H Tj advances
    // by hmtx alone, so each gap's correction is (hmtx − shaped) in 1000-upm
    // units. ToUnicode maps a ligature glyph back to its cluster's codepoints.
    const chars  = [...text]
    let body: string | null = null
    const shaped = shape_text(text, font.fontName, font.style, font.weight, font.opsz, false) as
      { glyphs: Uint16Array; advances: Float64Array; clusters: Uint32Array } | null
    if (shaped && shaped.glyphs.length) {
      const gids = shaped.glyphs
      const hmtx = get_advance_widths(font.fontName, font.style, font.weight, font.opsz, gids) as Float64Array
      const sorted = [...new Set(shaped.clusters)].sort((a, b) => a - b)
      const nextOf = new Map<number, number>()
      for (const [s, c] of sorted.entries()) nextOf.set(c, sorted[s + 1] ?? chars.length)

      // emoji/color-font glyphs (A1): COLR v0 (vector, stacked colored layers
      // over the SAME base outline — checked first, preferred when a font has
      // both) or sbix/CBDT (a raster strike). Either way, the base glyph's own
      // outline is a metrics-only placeholder in these fonts and must NOT also
      // be Tj-shown, or it doubles up under/beside the real color rendering.
      interface ColrLayer { gid: number; r: number; g: number; b: number; isFg: boolean }
      const colrOf:   (ColrLayer[] | null)[] = new Array(gids.length).fill(null)
      const bitmapOf: ({ png: Uint8Array; ppem: number; originX: number; originY: number } | null)[] = new Array(gids.length).fill(null)
      let hasSpecial = false
      // 3x the point size, matching this codebase's established "3x for
      // print quality" convention (svg.ts/canvaspaint.ts's own dpr=3)
      const targetPpem = Math.max(1, Math.round(height * 3))
      for (const [i, gid] of gids.entries()) {
        const colrKey = `${font.fontName}|${font.style}|${gid}`
        let layers = this.colrCache.get(colrKey)
        if (layers === undefined) {
          const layersRaw = get_colr_layers(font.fontName, font.style, gid) as Uint32Array
          layers = layersRaw.length ? [] : null
          if (layers) {
            // 6 words per layer record; require a whole one to be present
            for (let k = 0; k + 5 < layersRaw.length; k += 6) {
              layers.push({ gid: layersRaw[k]!, r: layersRaw[k+1]!, g: layersRaw[k+2]!, b: layersRaw[k+3]!, isFg: layersRaw[k+5] !== 0 })
            }
          }
          this.colrCache.set(colrKey, layers)
        }
        if (layers) {
          colrOf[i] = layers
          hasSpecial = true
          continue
        }
        const bmKey = `${colrKey}|${targetPpem}`
        let bm = this.bitmapCache.get(bmKey)
        if (bm === undefined) {
          bm = get_glyph_bitmap(font.fontName, font.style, gid, targetPpem) as
            { png: Uint8Array; ppem: number; originX: number; originY: number } | null
          this.bitmapCache.set(bmKey, bm)
        }
        if (bm) { bitmapOf[i] = bm; hasSpecial = true }
      }

      if (!hasSpecial) {
        const parts: string[] = []
        let run = ''
        for (const [i, gid] of gids.entries()) {
          font.glyphIds.add(gid)
          if (!font.glyphToUnicode.has(gid)) {
            const c0  = shaped.clusters[i]!
            const cps = chars.slice(c0, nextOf.get(c0)).map(ch => ch.codePointAt(0)!)
            font.glyphToUnicode.set(gid, cps.length ? cps : [0xFFFD])
          }
          run += gid.toString(16).padStart(4, '0')
          const adj = (hmtx[i] ?? 0) - shaped.advances[i]!
          if (Math.abs(adj) >= 0.5 && i < gids.length - 1) {
            parts.push(`<${run}>`, hpf(adj))
            run = ''
          }
        }
        if (run) parts.push(`<${run}>`)
        body = parts.length === 1 ? `${parts[0]} Tj` : `[${parts.join(' ')}] TJ`
      } else {
        this.emitColorGlyphRun(
          gids, hmtx, shaped, chars, nextOf, colrOf, bitmapOf,
          font, height, x, adjY, posY, stroke,
        )
        return
      }
    }

    // per-character fallback for fonts rustybuzz can't open — weight still
    // selects among multiple static files so gids match the embedded subset
    if (body === null) {
      const gidArr = get_glyph_ids(text, font.fontName, font.style, font.weight) as Uint16Array
      let hexStr = ''
      for (const [i, ch] of chars.entries()) {
        const gid = gidArr[i] ?? 0
        const cp  = ch.codePointAt(0)!
        font.glyphIds.add(gid)
        if (!font.glyphToUnicode.has(gid)) font.glyphToUnicode.set(gid, [cp])
        hexStr += gid.toString(16).padStart(4, '0')
      }
      body = `<${hexStr}> Tj`
    }

    const charSpace = this.activeCharSpace
    const wordSpace = this.activeWordSpace

    let result = 'BT\n'

    if (this.activeFontKey !== this.lastFontKey || height !== this.lastFontSize || leading !== this.lastLeading) {
      result += `/${this.activeFontKey} ${height} Tf\n${hpf(leading)} TL\n`
      this.lastFontKey  = this.activeFontKey
      this.lastFontSize = height
      this.lastLeading  = leading
    }
    if (this.textColor !== this.lastNonstroke) {
      result += this.textColor + '\n'
      this.lastNonstroke = this.textColor
    }
    if (charSpace !== this.lastCharSpace) {
      result += `${hpf(charSpace)} Tc\n`
      this.lastCharSpace = charSpace
    }
    if (wordSpace !== this.lastWordSpace) {
      result += `${hpf(wordSpace)} Tw\n`
      this.lastWordSpace = wordSpace
    }
    if (textRenderMode !== this.lastTextRenderMode) {
      result += `${textRenderMode} Tr\n`
      this.lastTextRenderMode = textRenderMode
    }
    result += `${hpf(x)} ${hpf(posY)} Td\n${body}\nET`
    this.pageOut(result)
  }

  // A1: emits a shaped run containing one or more COLR/bitmap glyphs. Text
  // state (Tf/TL/color/Tc/Tw/Tr) is emitted once, OUTSIDE any BT/ET — per PDF
  // spec 9.3 these are general graphics-state parameters, not restricted to
  // text objects, so they persist across the separate BT/ET blocks this
  // method opens per run of ordinary glyphs (a bitmap glyph's image Do can't
  // appear inside a text object at all, forcing ET before it and a fresh BT
  // after). Each BT/ET's own Td is an ABSOLUTE position (Td right after BT is
  // relative to the identity text-line-matrix BT itself resets to) rather
  // than relying on natural Tj advance to carry position across segments —
  // simpler to reason about correctly than reconciling COLR's same-origin
  // layer stacking against the ordinary advance-then-continue model.
  private emitColorGlyphRun(
    gids: Uint16Array, hmtx: Float64Array,
    shaped: { advances: Float64Array; clusters: Uint32Array },
    chars: string[], nextOf: Map<number, number>,
    colrOf: ({ gid: number; r: number; g: number; b: number; isFg: boolean }[] | null)[],
    bitmapOf: ({ png: Uint8Array; ppem: number; originX: number; originY: number } | null)[],
    font: DocFont, height: number, x: number, adjY: number, posY: number,
    stroke?: { color: [number, number, number]; width: number; strokeOnly: boolean },
  ): void {
    const textRenderMode = stroke ? (stroke.strokeOnly ? 1 : 2) : 0
    const leading   = height * 1.15
    const charSpace = this.activeCharSpace
    const wordSpace = this.activeWordSpace

    let setup = ''
    if (this.activeFontKey !== this.lastFontKey || height !== this.lastFontSize || leading !== this.lastLeading) {
      setup += `/${this.activeFontKey} ${height} Tf\n${hpf(leading)} TL\n`
      this.lastFontKey = this.activeFontKey; this.lastFontSize = height; this.lastLeading = leading
    }
    if (this.textColor !== this.lastNonstroke) { setup += this.textColor + '\n'; this.lastNonstroke = this.textColor }
    if (charSpace !== this.lastCharSpace) { setup += `${hpf(charSpace)} Tc\n`; this.lastCharSpace = charSpace }
    if (wordSpace !== this.lastWordSpace) { setup += `${hpf(wordSpace)} Tw\n`; this.lastWordSpace = wordSpace }
    if (textRenderMode !== this.lastTextRenderMode) { setup += `${textRenderMode} Tr\n`; this.lastTextRenderMode = textRenderMode }
    if (setup) this.pageOut(setup.replace(/\n$/, ''))

    let cum = 0
    const cumBefore = new Float64Array(gids.length)
    for (let i = 0; i < gids.length; i++) { cumBefore[i] = cum; cum += shaped.advances[i]! }
    const xAt = (i: number) => x + cumBefore[i]! * height / 1000

    const trackUnicode = (gid: number, clusterGid: number) => {
      font.glyphIds.add(gid)
      if (!font.glyphToUnicode.has(gid)) {
        const c0  = shaped.clusters[clusterGid]!
        const cps = chars.slice(c0, nextOf.get(c0)).map(ch => ch.codePointAt(0)!)
        font.glyphToUnicode.set(gid, cps.length ? cps : [0xFFFD])
      }
    }

    const buildRunBody = (from: number, to: number): string => {
      const parts: string[] = []
      let run = ''
      for (let i = from; i < to; i++) {
        const gid = gids[i]!
        trackUnicode(gid, i)
        run += gid.toString(16).padStart(4, '0')
        const adj = (hmtx[i] ?? 0) - shaped.advances[i]!
        if (Math.abs(adj) >= 0.5 && i < to - 1) { parts.push(`<${run}>`, hpf(adj)); run = '' }
      }
      if (run) parts.push(`<${run}>`)
      return parts.length === 1 ? parts[0] + ' Tj' : `[${parts.join(' ')}] TJ`
    }

    let runStart = -1
    // the i === gids.length pass is a sentinel whose only job is to flush a
    // still-open run, so it must not take the "keep accumulating" branch
    for (let i = 0; i <= gids.length; i++) {
      const atEnd   = i >= gids.length
      const special = !atEnd && (colrOf[i] || bitmapOf[i])
      if (!special && !atEnd) { if (runStart < 0) runStart = i; continue }
      if (runStart >= 0) {
        this.pageOut(`BT\n${hpf(xAt(runStart))} ${hpf(posY)} Td\n${buildRunBody(runStart, i)}\nET`)
        runStart = -1
      }
      if (atEnd) break

      if (colrOf[i]) {
        trackUnicode(gids[i]!, i)
        const lines = ['BT', `${hpf(xAt(i))} ${hpf(posY)} Td`]
        for (const layer of colrOf[i]!) {
          trackUnicode(layer.gid, i)
          lines.push(layer.isFg ? this.textColor : encodeColor(layer.r, layer.g, layer.b, false))
          lines.push(`<${layer.gid.toString(16).padStart(4, '0')}> Tj`)
        }
        lines.push('ET')
        this.pageOut(lines.join('\n'))
        // the running color cache now reflects a one-off layer color, not the
        // real text color the NEXT segment expects — force it to re-emit
        this.lastNonstroke = ''
      } else if (bitmapOf[i]) {
        const bm = bitmapOf[i]!
        font.glyphIds.add(gids[i]!) // metrics-only reference; not text-selectable (documented scope limit)
        const cacheKey = `${font.fontName}|${font.style}|${gids[i]!}|${bm.ppem}`
        let imgId = this.glyphImageCache.get(cacheKey)
        if (imgId === undefined) {
          imgId = this.embed_image(bm.png)
          if (imgId !== 0xFFFFFFFF) this.glyphImageCache.set(cacheKey, imgId)
        }
        const img = imgId === undefined ? undefined : this.images[imgId]
        if (img && imgId !== undefined) {
          const scale = height / bm.ppem
          const wPt   = img.width  * scale
          const hPt   = img.height * scale
          const drawX = xAt(i) + bm.originX * scale
          const topY  = adjY - bm.originY * scale - hPt
          this.draw_image(imgId, drawX, topY, wPt, hPt)
        }
      }
    }
  }

  // A4: draws `text` down a vertical column. Confirmed (initial attempt used
  // a Tm rotated 90°, matching how a CSS transform would tip the whole run —
  // WRONG, and confirmed wrong by rendering it through two independent PDF
  // engines, pdfjs and macOS Quartz/CoreGraphics, which both showed the same
  // sideways-spread mess) that PDF's own vertical writing mode needs NO
  // matrix rotation at all: glyphs are shown upright, in the ordinary text
  // matrix, and Identity-V + /W2/DW2 (build_fonts.ts) tell the VIEWER to
  // advance the NEXT glyph position along -y instead of +x after each Tj/TJ
  // show. This is exactly the right behavior for real vertical CJK glyphs,
  // which are designed to be drawn upright while stacking top-to-bottom.
  // A horizontal-script (e.g. Latin) run rotating 90° as a connected unit —
  // the browser's own CSS `text-orientation: mixed` convention — has no PDF
  // vertical-writing equivalent and is a documented, out-of-scope limitation:
  // this renders such text upright rather than sideways-rotated. x/yTop are
  // the column's own anchor point ("y measured from top", matching every
  // other draw call in this class), computed by the caller from real DOM
  // layout, exactly like text()'s own x/y are computed by its callers.
  text_vertical(text: string, x: number, yTop: number,
                stroke?: { color: [number, number, number]; width: number; strokeOnly: boolean }): void {
    if (!text) return
    const height  = this.activeFontSize
    const leading = height * 1.15

    const font = this.fonts.find(f => f.id === this.activeFontKey)
    if (!font) return
    font.usedVertically = true

    if (stroke) {
      this.set_draw_color(stroke.color[0], stroke.color[1], stroke.color[2])
      this.set_line_width(stroke.width)
    }
    const textRenderMode = stroke ? (stroke.strokeOnly ? 1 : 2) : 0

    this.usedFonts.add(this.activeFontKey)
    // distinct cache key from the horizontal one ("F1" vs "F1V") — reusing
    // lastFontKey directly means switching orientation for the same font is
    // detected and re-emits Tf, with no separate "was it vertical" flag needed
    const vFontKey = `${this.activeFontKey}V`

    const chars = [...text]
    const shaped = shape_text(text, font.fontName, font.style, font.weight, font.opsz, true) as
      { glyphs: Uint16Array; advances: Float64Array; clusters: Uint32Array } | null

    let body: string
    if (shaped && shaped.glyphs.length) {
      const gids  = shaped.glyphs
      // 0 from get_vertical_advance means "no real vmtx table," not "this
      // glyph's advance really is 0" — build_fonts.ts's /W2 leaves that case
      // OUT of the array entirely, falling through to /DW2's own -1000
      // default, so the correction math here must assume the SAME 1000
      // magnitude for those glyphs to match what the font resource actually
      // advances by, not a false 0
      const vAdvs = Float64Array.from(gids, gid => {
        const raw = get_vertical_advance(font.fontName, font.style, font.weight, font.opsz, gid)
        return raw > 0 ? raw : 1000
      })
      const sorted = [...new Set(shaped.clusters)].sort((a, b) => a - b)
      const nextOf = new Map<number, number>()
      for (const [s, c] of sorted.entries()) nextOf.set(c, sorted[s + 1] ?? chars.length)

      const parts: string[] = []
      let run = ''
      for (const [i, gid] of gids.entries()) {
        font.glyphIds.add(gid)
        if (!font.glyphToUnicode.has(gid)) {
          const c0  = shaped.clusters[i]!
          const cps = chars.slice(c0, nextOf.get(c0)).map(ch => ch.codePointAt(0)!)
          font.glyphToUnicode.set(gid, cps.length ? cps : [0xFFFD])
        }
        run += gid.toString(16).padStart(4, '0')
        // /W2 makes Tj naturally advance by the REAL vmtx-sourced value
        // (vAdvs) — any GPOS-shaped deviation from that raw value still
        // needs the same kind of TJ correction the horizontal path applies
        const adj = (vAdvs[i] ?? 0) - shaped.advances[i]!
        if (Math.abs(adj) >= 0.5 && i < gids.length - 1) {
          parts.push(`<${run}>`, hpf(adj))
          run = ''
        }
      }
      if (run) parts.push(`<${run}>`)
      body = parts.length === 1 ? `${parts[0]} Tj` : `[${parts.join(' ')}] TJ`
    } else {
      const gidArr = get_glyph_ids(text, font.fontName, font.style, font.weight) as Uint16Array
      let hexStr = ''
      for (const [i, ch] of chars.entries()) {
        const gid = gidArr[i] ?? 0
        const cp  = ch.codePointAt(0)!
        font.glyphIds.add(gid)
        if (!font.glyphToUnicode.has(gid)) font.glyphToUnicode.set(gid, [cp])
        hexStr += gid.toString(16).padStart(4, '0')
      }
      body = `<${hexStr}> Tj`
    }

    const charSpace = this.activeCharSpace
    const wordSpace = this.activeWordSpace
    // the viewer draws each glyph offset from the text position by the
    // font's own /DW2 (or /W2) v1y — "how far above the horizontal-origin
    // baseline the vertical origin sits" — so the text position itself
    // must sit that far BELOW the intended visual top, or the glyph renders
    // too high. No exact per-font ascent is threaded in here; 0.85em
    // mirrors the same approximate ascent ratio text()'s own baseline math
    // already assumes (descent = height*0.15 there implies ascent ≈ 0.85)
    const adjY = yTop + height * 0.85
    const posY = this.formatH - adjY

    let result = 'BT\n'
    if (vFontKey !== this.lastFontKey || height !== this.lastFontSize || leading !== this.lastLeading) {
      result += `/${vFontKey} ${height} Tf\n${hpf(leading)} TL\n`
      this.lastFontKey = vFontKey; this.lastFontSize = height; this.lastLeading = leading
    }
    if (this.textColor !== this.lastNonstroke) { result += this.textColor + '\n'; this.lastNonstroke = this.textColor }
    if (charSpace !== this.lastCharSpace) { result += `${hpf(charSpace)} Tc\n`; this.lastCharSpace = charSpace }
    if (wordSpace !== this.lastWordSpace) { result += `${hpf(wordSpace)} Tw\n`; this.lastWordSpace = wordSpace }
    if (textRenderMode !== this.lastTextRenderMode) { result += `${textRenderMode} Tr\n`; this.lastTextRenderMode = textRenderMode }
    result += `${hpf(x)} ${hpf(posY)} Td\n${body}\nET`
    this.pageOut(result)
  }

  private pathRect(x: number, y: number, w: number, h: number): void {
    this.pageOut(`${hpf(x)} ${hpf(this.formatH - y)} ${hpf(w)} ${hpf(-h)} re`)
  }

  // Elliptical corners: the K=0.5523 bezier quadrant approximation applies
  // independently per axis — control-point x offsets scale with the corner's h
  // radius, y offsets with its v radius. rounds() gates each corner: CSS says a
  // corner with EITHER component zero is square, so a degenerate corner (h>0,
  // v=0 after insetting) must not emit a lopsided curve.
  private pathRoundedRect(x: number, y: number, w: number, h: number,
                           tl: Corner, tr: Corner, br: Corner, bl: Corner): void {
    const TL = rounds(tl) ? tl : Z, TR = rounds(tr) ? tr : Z
    const BR = rounds(br) ? br : Z, BL = rounds(bl) ? bl : Z
    if (TL === Z && TR === Z && BR === Z && BL === Z) { this.pathRect(x, y, w, h); return }
    const ph = this.formatH, yt = ph - y, yb = ph - y - h, K = 0.5523
    this.pageOut(`${hpf(x+TL.h)} ${hpf(yt)} m`)
    this.pageOut(`${hpf(x+w-TR.h)} ${hpf(yt)} l`)
    if (TR !== Z) this.pageOut(`${hpf(x+w-TR.h+TR.h*K)} ${hpf(yt)} ${hpf(x+w)} ${hpf(yt-TR.v+TR.v*K)} ${hpf(x+w)} ${hpf(yt-TR.v)} c`)
    this.pageOut(`${hpf(x+w)} ${hpf(yb+BR.v)} l`)
    if (BR !== Z) this.pageOut(`${hpf(x+w)} ${hpf(yb+BR.v-BR.v*K)} ${hpf(x+w-BR.h+BR.h*K)} ${hpf(yb)} ${hpf(x+w-BR.h)} ${hpf(yb)} c`)
    this.pageOut(`${hpf(x+BL.h)} ${hpf(yb)} l`)
    if (BL !== Z) this.pageOut(`${hpf(x+BL.h-BL.h*K)} ${hpf(yb)} ${hpf(x)} ${hpf(yb+BL.v-BL.v*K)} ${hpf(x)} ${hpf(yb+BL.v)} c`)
    this.pageOut(`${hpf(x)} ${hpf(yt-TL.v)} l`)
    if (TL !== Z) this.pageOut(`${hpf(x)} ${hpf(yt-TL.v+TL.v*K)} ${hpf(x+TL.h-TL.h*K)} ${hpf(yt)} ${hpf(x+TL.h)} ${hpf(yt)} c`)
    this.pageOut('h')
  }

  rect(x: number, y: number, w: number, h: number, style: string): void {
    this.pathRect(x, y, w, h)
    this.putStyle(style)
  }

  rounded_rect(x: number, y: number, w: number, h: number,
               tl: Corner, tr: Corner, br: Corner, bl: Corner, style: string): void {
    this.pathRoundedRect(x, y, w, h, tl, tr, br, bl)
    this.putStyle(style)
  }

  // Fills the exact band between an outer and inner rounded-rect path (even-odd winding),
  // rather than stroking a single centered path. This makes the border's outer curve use
  // the identical construction as an overflow:hidden clip at the same radius — a stroke's
  // curve-offset approximation and a directly-built curve can disagree by a hair at the
  // arc itself (never on straight edges), which is visible wherever a border meets a clip.
  border_ring(x: number, y: number, w: number, h: number,
              tl: Corner, tr: Corner, br: Corner, bl: Corner,
              strokeWidth: number): void {
    const sw = strokeWidth
    const ix = x + sw, iy = y + sw
    const iw = Math.max(0, w - 2 * sw), ih = Math.max(0, h - 2 * sw)

    this.pathRoundedRect(x, y, w, h, tl, tr, br, bl)
    if (iw > 0 && ih > 0) {
      this.pathRoundedRect(ix, iy, iw, ih, insetCorner(tl, sw), insetCorner(tr, sw), insetCorner(br, sw), insetCorner(bl, sw))
    }
    this.pageOut('f*')
  }

  // Dashed/dotted borders and outlines: border_ring's even-odd band fill has no
  // way to carry a dash pattern, so this strokes the rounded-rect path itself,
  // centered on the same band (inset by half the stroke width) that border_ring
  // fills solid — the straight-line dashed branch already centers its strokes
  // the same way, so a rounded and a straight dashed border land on one band.
  stroke_rounded_rect_dashed(x: number, y: number, w: number, h: number,
                             tl: Corner, tr: Corner, br: Corner, bl: Corner,
                             strokeWidth: number, dashArray: number[]): void {
    const half = strokeWidth / 2
    const ix = x + half, iy = y + half
    const iw = Math.max(0, w - strokeWidth), ih = Math.max(0, h - strokeWidth)

    this.set_line_width(strokeWidth)
    this.set_line_dash(dashArray, 0)
    this.pathRoundedRect(ix, iy, iw, ih, insetCorner(tl, half), insetCorner(tr, half), insetCorner(br, half), insetCorner(bl, half))
    this.pageOut('S')
    this.set_line_dash([], 0)
  }

  line(x1: number, y1: number, x2: number, y2: number): void {
    const ph = this.formatH
    this.pageOut(`${hpf(x1)} ${hpf(ph-y1)} m`)
    this.pageOut(`${hpf(x2)} ${hpf(ph-y2)} l`)
    this.pageOut('S')
  }

  // text-decoration-style: wavy — approximated as a sine-like squiggle of cubic
  // bezier bumps, alternating above/below the line at each half-wavelength. Only
  // meaningful for horizontal decoration lines (underline/overline/line-through),
  // which is the only shape this is ever called with.
  wavy_line(x1: number, y1: number, x2: number, y2: number, amplitude: number, wavelength: number): void {
    const len = x2 - x1
    if (len <= 0 || wavelength <= 0) { this.line(x1, y1, x2, y2); return }
    const yTop     = this.formatH - y1
    const halfWave = wavelength / 2
    const steps    = Math.max(1, Math.round(len / halfWave))
    const stepLen  = len / steps

    this.pageOut(`${hpf(x1)} ${hpf(yTop)} m`)
    for (let i = 0; i < steps; i++) {
      const dir    = i % 2 === 0 ? 1 : -1
      const xStart = x1 + i * stepLen
      const xEnd   = xStart + stepLen
      const yPeak  = yTop + dir * amplitude
      this.pageOut(`${hpf(xStart + stepLen * 0.25)} ${hpf(yPeak)} ${hpf(xStart + stepLen * 0.75)} ${hpf(yPeak)} ${hpf(xEnd)} ${hpf(yTop)} c`)
    }
    this.pageOut('S')
  }

  add_gradient(gradType: number, angle: number, stops: Float64Array, cx = 0.5, cy = 0.5, fx = cx, fy = cy): number {
    const parsed: [number, number, number, number, number][] = []
    for (let i = 0; i + 4 < stops.length; i += 5)
      parsed.push([stops[i]!, stops[i+1]!/255, stops[i+2]!/255, stops[i+3]!/255, stops[i+4]!/255])
    this.gradDefs.push({ gradType, angle, cx, cy, fx, fy, stops: parsed })
    return this.gradDefs.length - 1
  }

  // PDF shading patterns have no native alpha channel — a gradient with any
  // stop below full opacity needs a separate luminosity soft mask (a
  // grayscale shading of the same geometry, composited via an ExtGState)
  // applied right before the color pattern fills. Registered lazily, by
  // predictable name, the same way patName is derived from shadPats.length —
  // a fully-opaque gradient (every case before this fix) costs nothing extra.
  private registerSoftMaskIfNeeded(gradientId: number, x: number, y: number, w: number, h: number): string {
    const def = this.gradDefs[gradientId]
    if (!def || !def.stops.some(s => s[4] < 1)) return ''
    const gsName = `GSM${this.gradSoftMasks.length}`
    this.gradSoftMasks.push({ gsName, defIdx: gradientId, x, y, w, h, pageH: this.formatH, objId: 0 })
    return `/${gsName} gs\n`
  }

  fill_with_gradient(gradientId: number, x: number, y: number, w: number, h: number): void {
    if (gradientId < 0 || gradientId >= this.gradDefs.length) return
    const patName = `Sh${this.shadPats.length}`
    const yp = this.formatH - y - h
    const gsOp = this.registerSoftMaskIfNeeded(gradientId, x, y, w, h)
    this.shadPats.push({ patName, defIdx: gradientId, x, y, w, h, pageH: this.formatH, objId: 0 })
    this.pageOut(`q\n${gsOp}/Pattern cs\n/${patName} scn\n${hpf(x)} ${hpf(yp)} ${hpf(w)} ${hpf(h)} re\nf\nQ`)
  }

  fill_with_gradient_rounded(gradientId: number, x: number, y: number, w: number, h: number,
                              tl: Corner, tr: Corner, br: Corner, bl: Corner): void {
    if (!rounds(tl) && !rounds(tr) && !rounds(br) && !rounds(bl)) { this.fill_with_gradient(gradientId, x, y, w, h); return }
    if (gradientId < 0 || gradientId >= this.gradDefs.length) return
    const patName = `Sh${this.shadPats.length}`
    const yb = this.formatH - y - h
    const gsOp = this.registerSoftMaskIfNeeded(gradientId, x, y, w, h)
    this.shadPats.push({ patName, defIdx: gradientId, x, y, w, h, pageH: this.formatH, objId: 0 })
    this.pageOut('q')
    this.pathRoundedRect(x, y, w, h, tl, tr, br, bl)
    this.pageOut('W n')
    this.pageOut(`${gsOp}/Pattern cs\n/${patName} scn\n${hpf(x)} ${hpf(yb)} ${hpf(w)} ${hpf(h)} re\nf\nQ`)
  }

  embed_image(bytes: Uint8Array): number {
    const raw = parse_image(bytes)
    if (!raw) return 0xFFFFFFFF
    const idx  = this.images.length
    const data = raw.isJpeg ? raw.data : (deflate(raw.data) as Uint8Array)
    this.images.push({
      name:        `Im${idx}`,
      width:       raw.width,
      height:      raw.height,
      colorSpace:  raw.colorSpace,
      filter:      raw.isJpeg ? '/DCTDecode' : '/FlateDecode',
      data,
      smask:       raw.smask,
      decodeInvert: !!raw.decodeInvert,
      orientation:  raw.orientation || 1,
      objectNumber: 0,
    })
    return idx
  }

  // browser-decoded pixels skip the WASM parser entirely
  embed_raw_image(raw: RawImage): number {
    if (!raw.width || !raw.height || !raw.data.length) return 0xFFFFFFFF
    const idx = this.images.length
    this.images.push({
      name:        `Im${idx}`,
      width:       raw.width,
      height:      raw.height,
      colorSpace:  raw.colorSpace,
      filter:      '/FlateDecode',
      data:        deflate(raw.data) as Uint8Array,
      smask:       raw.smask,
      decodeInvert: false,
      orientation:  1,
      objectNumber: 0,
    })
    return idx
  }

  // EXIF orientation is corrected here via the cm matrix — the browser already
  // laid the box out at corrected dimensions (naturalWidth is EXIF-aware), and
  // DCT passthrough can't rotate pixels. Derivation: stored image unit square
  // (s right, t up, row 0 at t=1) mapped so the DISPLAYED image is upright.
  draw_image(imageId: number, x: number, y: number, w: number, h: number): void {
    const img  = this.images[imageId]
    if (!img) return
    const yp   = this.formatH - y - h
    const o    = img.orientation
    const m: number[] =
      o === 2 ? [-w, 0, 0, h, x + w, yp] :
      o === 3 ? [-w, 0, 0, -h, x + w, yp + h] :
      o === 4 ? [w, 0, 0, -h, x, yp + h] :
      o === 5 ? [0, -h, -w, 0, x + w, yp + h] :
      o === 6 ? [0, -h, w, 0, x, yp + h] :
      o === 7 ? [0, h, w, 0, x, yp] :
      o === 8 ? [0, h, -w, 0, x + w, yp] :
                [w, 0, 0, h, x, yp]
    this.pageOut(`q\n${m.map(hpf).join(' ')} cm\n/${img.name} Do\nQ`)
  }

  add_link_annotation(x: number, y: number, w: number, h: number, url: string): void {
    const ph = this.formatH
    this.pageAnnots[this.currentPageIdx]?.push({ rect: [x, ph-y-h, x+w, ph-y], href: url })
  }

  add_goto_annotation(x: number, y: number, w: number, h: number, destPage: number, destY: number): void {
    const ph = this.formatH
    this.pageAnnots[this.currentPageIdx]?.push({ rect: [x, ph-y-h, x+w, ph-y], destPage, destY: ph - destY })
  }

  // D1 (AcroForm): builds the field's appearance stream(s) immediately (the
  // font registry / emission-cache state captureAppearance depends on is
  // only correct RIGHT NOW, during normal command processing — not
  // reconstructable later during buildDocument), and records everything
  // else build_pages.ts needs to emit the actual Widget/Field PDF object
  // once page content is finalized.
  add_form_field(
    x: number, y: number, w: number, h: number,
    fieldType: 'Tx' | 'Btn' | 'Ch', name: string,
    fontName: string, fontStyle: string, weight: number, size: number, color: [number, number, number],
    value: string | undefined, checked: boolean | undefined, options: string[] | undefined,
  ): void {
    const ph = this.formatH

    let da: string | undefined
    let apOn: string, apOff: string | undefined
    if (fieldType === 'Btn') {
      // pure vector geometry — no font involved, so unlike Tx/Ch this must
      // NOT register a font or build a /DA (the caller has no real font name
      // to give it, since checkboxes/radios never resolve one — see emit.ts)
      const built = this.buildCheckboxAppearances(w, h, color)
      apOn = built.on; apOff = built.off
    } else if (!fontName) {
      // emit.ts couldn't resolve a registered font for this control (the
      // same "unregistered font" precedent every other text draw already
      // follows) — the field's /V/T/FT/Rect are still real, useful document
      // data, so only the STATIC appearance degrades, to an empty-but-valid
      // stream (matching Btn's own "off" state), not the whole field
      apOn = ''
    } else {
      const fontId  = this.getOrCreateFont(fontName, fontStyle, weight).id
      this.usedFonts.add(fontId)
      da = `/${fontId} ${hpf(size)} Tf ${encodeColor(color[0], color[1], color[2], false, 3)}`

      // captureAppearance's own drawing runs against a LOCAL, field-sized
      // coordinate system (BBox [0 0 w h]), not the page's — formatH is
      // temporarily overridden so text()'s existing page-relative Y-flip
      // math (posY = formatH - adjY) produces the right LOCAL flip instead
      const savedFormatH = this.formatH
      this.formatH = h
      apOn = this.captureAppearance(() => {
        this.set_clip_rect(0, 0, w, h)
        this.set_font(fontName, fontStyle, weight)
        this.set_font_size(size)
        this.set_text_color(color[0], color[1], color[2])
        this.text(value ?? '', 2, h / 2, 'middle')
      })
      this.formatH = savedFormatH
    }

    this.pageAnnots[this.currentPageIdx]?.push({
      rect: [x, ph-y-h, x+w, ph-y],
      fieldType, fieldName: name, fieldDA: da,
      fieldValue: value, fieldChecked: checked, fieldOptions: options,
      fieldApOn: apOn, fieldApOff: apOff,
    })
  }

  // A simple two-line checkmark, scaled to the field's own box — plain
  // vector geometry, so unlike the text appearance above this needs no
  // captureAppearance detour (a bare content-stream string is already in
  // the AP's own local, Y-up coordinate system with no page-relative flip
  // to account for). The "off" state is a deliberately empty stream — a
  // valid, zero-length content stream, not a placeholder.
  private buildCheckboxAppearances(w: number, h: number, color: [number, number, number]): { on: string; off: string } {
    const stroke = encodeColor(color[0], color[1], color[2], true, 3)
    const lw = Math.max(1, Math.min(w, h) * 0.12)
    const on = [
      'q', `${hpf(lw)} w`, stroke,
      `${hpf(w * 0.2)} ${hpf(h * 0.5)} m`,
      `${hpf(w * 0.42)} ${hpf(h * 0.25)} l`,
      `${hpf(w * 0.8)} ${hpf(h * 0.78)} l`,
      'S', 'Q',
    ].join('\n')
    return { on, off: '' }
  }

  add_named_dest(name: string, page: number, y: number): void {
    this.namedDests.push([name, page, y])
  }

  set_metadata(key: string, value: string): void {
    this.metadata.push([key, value])
  }

  add_bookmark(title: string, page: number, y: number, level: number): void {
    this.bookmarks.push({ title, page, y, level })
  }

  set_security(userPw: string, ownerPw: string, permissions: number): void {
    this.security = computeR6Security(userPw, ownerPw, permissions)
  }

  set_struct_tree(root: StructNode): void {
    this.structRoot = root
  }

  set_pdfa(lang: string | undefined): void {
    this.pdfA = true
    this.pdfaLang = lang
  }

  add_page(): void {
    this.addPageInternal()
  }

  // Random-access page targeting: creates any missing pages up to n, then switches
  // to it. Content spanning a page break needs to append to a page it already
  // finished visiting earlier in DOM order, not just monotonically advance.
  // Switching to an already-started page invalidates the emission caches — they
  // describe the page we just left, not the stream we're appending to now.
  set_page(n: number): void {
    // pages are 1-based; n < 1 left currentPageIdx at -1, which silently
    // dropped every later draw and crashed the annotation helpers
    if (!Number.isInteger(n) || n < 1) return
    while (this.allPageBufs.length < n) this.addPageInternal()
    if (this.currentPageIdx === n - 1) return
    this.currentPageIdx = n - 1
    this.lastFontKey = ''; this.lastFontSize = -1; this.lastLeading = -1
    this.lastNonstroke = ''; this.lastStroke = ''; this.lastLineWidth = -1
    this.lastCharSpace = -1; this.lastWordSpace = -1
    // -1 is not a legal Tr value (0/1/2 only) — guarantees the next text() on
    // this page always re-emits Tr instead of trusting a stale cached mode
    this.lastTextRenderMode = -1
  }

  output(): Uint8Array {
    // buildDocument appends; calling it twice would emit the whole document a
    // second time into the same buffer rather than replacing it.
    if (this.built) return this.builtBytes!
    this.built = true
    this.buildDocument()
    const out = new Uint8Array(this.byteLen)
    let pos = 0
    for (const p of this.buf) { out.set(p, pos); pos += p.length }
    this.builtBytes = out
    return out
  }

  private buildDocument(): void {
    const ctx = this.ctx
    putPages(ctx)
    const structTreeRootId = putStructTree(ctx)
    const pdfaExtras       = putPdfAExtras(ctx)
    putImages(ctx)
    putFonts(ctx)
    putShadingPatterns(ctx)
    putGradientSoftMasks(ctx)
    putResourceDictionary(ctx)
    packObjStm(ctx)
    const infoId    = putCatalog(ctx, structTreeRootId, pdfaExtras)
    const catalogId = ctx.objectNumber
    const encryptId = putEncryptDict(ctx)
    buildXrefStream(ctx, catalogId, encryptId, infoId)
  }
}
