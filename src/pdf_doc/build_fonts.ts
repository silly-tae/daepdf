import type { InternalCtx, DocFont } from './types.js'
import { toPdfName, bboxToPdf, widthsToPdf, w2ToPdf, _te } from './utils.js'
import { toUnicodeCmap } from './cmap.js'
import type { SubsetFontResult } from '../types/index.js'
import {
  get_advance_widths, get_vertical_advance, subset_font_full,
} from '../daepl/wasm/daepl.js'
import { deflate } from './deflate.js'

function embedFont(ctx: InternalCtx, font: DocFont): void {
  const gids   = new Uint16Array([...font.glyphIds].sort((a, b) => a - b))
  const result = subset_font_full(font.fontName, font.style, font.weight, font.opsz, gids) as SubsetFontResult | null

  if (!result) return
  const { fontBytes, glyphMap, isCff, ascender, descender, capHeight, bbox, flags, italicAngle, fontName } = result

  if (!fontBytes) return

  const rawAdvs  = get_advance_widths(font.fontName, font.style, font.weight, font.opsz, gids) as Float64Array
  const widths: [number, number][] = Array.from(gids, (gid, i) => [gid, Math.round(rawAdvs[i]!)] as [number, number])

  const fontTableId = ctx.newObject()
  const compFont    = deflate(fontBytes) as Uint8Array
  ctx.out('<<')
  ctx.out(`/Length ${ctx.encryptedLength(compFont.length)}`)
  if (isCff) {
    ctx.out('/Subtype /CIDFontType0C')
  } else {
    ctx.out(`/Length1 ${fontBytes.length}`)
  }
  ctx.out('/Filter /FlateDecode')
  ctx.out('>>')
  ctx.out('stream')
  ctx.outBytes(compFont)
  ctx.out('endstream')
  ctx.out('endobj')

  const cmapText = toUnicodeCmap(font.glyphToUnicode)
  const compCmap = deflate(_te.encode(cmapText)) as Uint8Array
  const cmapId   = ctx.newObject()
  ctx.out('<<')
  ctx.out(`/Length ${ctx.encryptedLength(compCmap.length)}`)
  ctx.out('/Filter /FlateDecode')
  ctx.out('>>')
  ctx.out('stream')
  ctx.outBytes(compCmap)
  ctx.out('endstream')
  ctx.out('endobj')

  let cidToGidId = 0
  if (!isCff) {
    const maxCid   = gids.length ? Math.max(...gids) : 0
    const mapBytes = new Uint8Array((maxCid + 1) * 2)
    const gm       = glyphMap as Uint16Array
    for (const orig of gids) {
      const compact = (orig < gm.length ? gm[orig]! : 0)
      mapBytes[orig * 2]     = (compact >> 8) & 0xFF
      mapBytes[orig * 2 + 1] =  compact       & 0xFF
    }
    const compMap = deflate(mapBytes) as Uint8Array
    cidToGidId    = ctx.newObject()
    ctx.out('<<')
    ctx.out(`/Length ${ctx.encryptedLength(compMap.length)}`)
    ctx.out('/Filter /FlateDecode')
    ctx.out('>>')
    ctx.out('stream')
    ctx.outBytes(compMap)
    ctx.out('endstream')
    ctx.out('endobj')
  }

  ctx.beginCapture()
  ctx.out('<<')
  ctx.out('/Type /FontDescriptor')
  ctx.out(`/FontName /${toPdfName(fontName)}`)
  ctx.out(`/${isCff ? 'FontFile3' : 'FontFile2'} ${fontTableId} 0 R`)
  ctx.out(`/FontBBox ${bboxToPdf(Array.from(bbox))}`)
  ctx.out(`/Flags ${flags}`)
  ctx.out(`/StemV ${stemV(font.weight)}`)
  ctx.out(`/ItalicAngle ${italicAngle}`)
  ctx.out(`/Ascent ${ascender}`)
  ctx.out(`/Descent ${descender}`)
  ctx.out(`/CapHeight ${capHeight}`)
  ctx.out('>>')
  const fontDescriptorId = ctx.queueForObjStm(ctx.endCapture())

  ctx.beginCapture()
  ctx.out('<<')
  ctx.out('/Type /Font')
  ctx.out(`/BaseFont /${toPdfName(fontName)}`)
  ctx.out(`/FontDescriptor ${fontDescriptorId} 0 R`)
  ctx.out(`/W ${widthsToPdf(widths)}`)
  if (!isCff) ctx.out(`/CIDToGIDMap ${cidToGidId} 0 R`)
  ctx.out('/DW 1000')
  ctx.out(`/Subtype ${isCff ? '/CIDFontType0' : '/CIDFontType2'}`)
  ctx.out('/CIDSystemInfo')
  ctx.out('<<')
  ctx.out('/Supplement 0')
  ctx.out('/Registry (Adobe)')
  ctx.out('/Ordering (Identity)')
  ctx.out('>>')
  ctx.out('>>')
  const descendantId = ctx.queueForObjStm(ctx.endCapture())

  ctx.beginCapture()
  ctx.out('<<')
  ctx.out('/Type /Font')
  ctx.out('/Subtype /Type0')
  ctx.out(`/ToUnicode ${cmapId} 0 R`)
  ctx.out(`/BaseFont /${toPdfName(fontName)}`)
  ctx.out('/Encoding /Identity-H')
  ctx.out(`/DescendantFonts [${descendantId} 0 R]`)
  ctx.out('>>')
  const type0Id = ctx.queueForObjStm(ctx.endCapture())

  font.objectNumber    = type0Id
  font.isAlreadyPutted = true

  // A4 (vertical writing modes): a second, parallel Type0/CIDFont dict pair,
  // built only when this font was actually used vertically — same embedded
  // glyph data (FontDescriptor/CIDToGIDMap reused by reference), but with
  // /W2 + /DW2 (vertical metrics) instead of /W, and /Encoding /Identity-V
  // instead of /Identity-H. Per PDF spec 9.7.4.3, a glyph's position vector
  // (v1x, v1y) — the offset from its horizontal origin to its vertical
  // origin — defaults to (half that glyph's own /W width, DW2's own default
  // vy) when not explicitly overridden per glyph; v1y is applied uniformly
  // from the font's own ascender here (a reasonable, spec-legitimate
  // default absent a real VORG table this engine doesn't parse — no font
  // observed during this work actually carried one).
  if (font.usedVertically) {
    // get_vertical_advance returns 0 for both "this glyph's real vmtx
    // advance is 0" (never true for a real printing glyph) and "the font has
    // no vmtx/vhea table at all" — ambiguous, but only the second case is
    // ever real. Glyphs where it returns 0 are left OUT of /W2 entirely
    // (list form, not a range — a sparse list is valid) so they fall through
    // to /DW2's own default (-1000, a standard full em) instead of a literal
    // false zero-advance override, which would collapse every glyph in a
    // vmtx-less font on top of itself.
    const w2: [number, number, number, number][] = []
    for (const [i, gid] of gids.entries()) {
      const rawV = get_vertical_advance(font.fontName, font.style, font.weight, font.opsz, gid)
      if (rawV <= 0) continue
      const w1y = -Math.round(rawV)
      const v1x = Math.round(widths[i]![1] / 2)
      w2.push([gid, w1y, v1x, ascender])
    }

    ctx.beginCapture()
    ctx.out('<<')
    ctx.out('/Type /Font')
    ctx.out(`/BaseFont /${toPdfName(fontName)}`)
    ctx.out(`/FontDescriptor ${fontDescriptorId} 0 R`)
    ctx.out(`/W2 ${w2ToPdf(w2)}`)
    if (!isCff) ctx.out(`/CIDToGIDMap ${cidToGidId} 0 R`)
    ctx.out(`/DW2 [${ascender} -1000]`)
    ctx.out('/DW 1000')
    ctx.out(`/Subtype ${isCff ? '/CIDFontType0' : '/CIDFontType2'}`)
    ctx.out('/CIDSystemInfo')
    ctx.out('<<')
    ctx.out('/Supplement 0')
    ctx.out('/Registry (Adobe)')
    ctx.out('/Ordering (Identity)')
    ctx.out('>>')
    ctx.out('>>')
    const descendantVId = ctx.queueForObjStm(ctx.endCapture())

    ctx.beginCapture()
    ctx.out('<<')
    ctx.out('/Type /Font')
    ctx.out('/Subtype /Type0')
    ctx.out(`/ToUnicode ${cmapId} 0 R`)
    ctx.out(`/BaseFont /${toPdfName(fontName)}`)
    ctx.out('/Encoding /Identity-V')
    ctx.out(`/DescendantFonts [${descendantVId} 0 R]`)
    ctx.out('>>')
    font.verticalObjectNumber = ctx.queueForObjStm(ctx.endCapture())
  }
}

// /StemV is the dominant vertical stem thickness. Zero says the font has none,
// which is the value readers consult when synthesizing bold and one preflight
// tools flag. The real figure needs the outlines; this is the long-standing
// estimate from the weight, landing near 88 for regular and 166 for bold.
function stemV(weight: number): number {
  const w = Number.isFinite(weight) && weight > 0 ? weight : 400
  return Math.round(50 + (w / 65) ** 2)
}

export function putFonts(ctx: InternalCtx): void {
  for (const font of ctx.fonts) {
    if (!ctx.usedFonts.has(font.id)) continue
    if (font.isAlreadyPutted) continue
    if (font.glyphIds.size <= 1) continue
    embedFont(ctx, font)
  }
}
