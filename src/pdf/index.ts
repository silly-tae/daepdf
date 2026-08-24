import { measure_string_width } from '../../engine.js'
import { PdfDoc } from '../pdf_doc/index.js'
import type {
  DrawCommand, TextCommand, RectCommand, LineCommand, LinkCommand,
  ClipCommand, ImageCommand, RawImageCommand, TransformCommand, FieldCommand, PathCommand,
  DocDefinition, AnchorEntry, StructNode,
} from '../types/index.js'
import type { RawImage } from '../images/decode.js'
import { resolvePageSize, resolveRadius, anyRadius } from '../types/index.js'
import { emitShadows } from './shadows.js'
import { applyMetadata, applyBookmarks, applySecurity, resolveSecurityConfig, applyStructTree, applyPdfA } from './finalize.js'

export { rasterizeSVGs } from './svg.js'

export function applyToPDF(
  commands:    DrawCommand[],
  def:         DocDefinition,
  anchors?:    Map<string, AnchorEntry>,
  structRoot?: StructNode,
): Uint8Array {
  const size = resolvePageSize(def.config.size, def.config.orientation)
  const doc  = new PdfDoc(size.width, size.height)

  let currentPage = 1
  const imageCache = new Map<Uint8Array | RawImage, number>()

  if (anchors) {
    for (const [id, entry] of anchors) {
      doc.add_named_dest(id, entry.page, entry.y)
    }
  }

  // No draw-state tracking here: PdfDoc dedupes emissions against the actual
  // content stream it writes to (per page, per q/Q region). A second cache at
  // this level can only disagree with the stream — it already did once, letting
  // text render in the previous box's fill color.
  for (const cmd of commands) {
    if (cmd.page !== currentPage) {
      doc.set_page(cmd.page)
      currentPage = cmd.page
    }

    if (cmd.type === 'text') {
      const c = cmd as TextCommand
      const tagged = c.mcid !== undefined && c.structTag !== undefined
      if (tagged) doc.begin_marked_content(c.structTag!, c.mcid!)
      doc.set_font(c.font, c.style, c.weight)
      doc.set_font_size(c.size)
      doc.set_text_color(c.color[0], c.color[1], c.color[2])
      if (c.letterSpacing) doc.set_char_space(c.letterSpacing)
      if (c.wordSpacing) doc.set_word_spacing(c.wordSpacing)
      const hasTextGState = (c.opacity !== undefined && c.opacity < 1) || !!c.blend
      if (hasTextGState) doc.set_alpha(c.opacity ?? 1, c.blend)
      const stroke = c.stroke ? { color: c.stroke, width: c.strokeWidth ?? 0, strokeOnly: !!c.strokeOnly } : undefined
      if (c.vertical) {
        // align/direction/measure_string_width are horizontal-layout concepts
        // that don't apply to a vertical column — x/y are already the
        // column's own anchor, computed by the caller (walk.ts/emit.ts)
        doc.text_vertical(c.text, c.x, c.y, stroke)
      } else {
        let px = c.x
        if (c.align !== 'left' || c.direction === 'rtl') {
          const w = measure_string_width(c.text, c.font, c.style, c.weight, 0, c.size)
          if (c.align === 'center') px = c.x + c.maxWidth / 2 - w / 2
          else if (c.align === 'right') px = c.x + c.maxWidth - w
          // RTL with left alignment: shift to right edge so text reads right-to-left from maxWidth
          else if (c.direction === 'rtl') px = c.x + c.maxWidth - w
        }
        doc.text(c.text, px, c.y, 'alphabetic', stroke)
      }
      if (c.letterSpacing) doc.set_char_space(0)
      if (c.wordSpacing) doc.set_word_spacing(0)
      if (hasTextGState) doc.set_alpha(1.0)
      if (tagged) doc.end_marked_content()

    } else if (cmd.type === 'link') {
      const c = cmd as LinkCommand
      if (c.href.startsWith('#')) {
        // fragments arrive percent-encoded ("#foo%20bar") but ids are raw
        let frag = c.href.slice(1)
        try { frag = decodeURIComponent(frag) } catch { /* keep raw */ }
        const dest = anchors?.get(frag) ?? anchors?.get(c.href.slice(1))
        if (dest) doc.add_goto_annotation(c.x, c.y, c.w, c.h, dest.page, dest.y)
      } else {
        const lower = c.href.toLowerCase().trimStart()
        if (lower.startsWith('http://') || lower.startsWith('https://') || lower.startsWith('mailto:')) {
          // /URI must be ASCII — unencoded unicode or spaces break the link in
          // some viewers (encodeURI leaves existing %-escapes intact)
          let uri = c.href
          try { uri = encodeURI(c.href) } catch { /* malformed input stays raw */ }
          doc.add_link_annotation(c.x, c.y, c.w, c.h, uri)
        }
      }

    } else if (cmd.type === 'rect') {
      const c = cmd as RectCommand
      // corners resolve to zero pairs when there is no radius — every PdfDoc
      // geometry method treats a {0,0} corner as square, so one resolved shape
      // serves the rounded and square paths alike
      const rr = resolveRadius(c.radius)
      const hasRadius = anyRadius(rr)
      const outerShadows = c.shadow?.filter(s => !s.inset) ?? []
      const insetShadows = c.shadow?.filter(s =>  s.inset) ?? []

      // Outer shadows — before fill so box paints on top
      if (outerShadows.length) {
        emitShadows(doc, outerShadows, c.x, c.y, c.w, c.h, rr)
      }

      const hasRectGState = (c.opacity !== undefined && c.opacity < 1) || !!c.blend
      if (hasRectGState) doc.set_alpha(c.opacity ?? 1, c.blend)
      if (c.gradient) {
        const g = c.gradient
        const stopsFlat = new Float64Array(g.stops.flatMap(s => [s.position, s.color[0], s.color[1], s.color[2], s.color[3]]))
        const isRadial = g.type === 'radial'
        const gradId = doc.add_gradient(
          isRadial ? 1 : 0,
          g.type === 'linear' ? (g.angle ?? 0) : 0,
          stopsFlat,
          isRadial ? (g.cx ?? 0.5) : 0.5,
          isRadial ? (g.cy ?? 0.5) : 0.5,
          isRadial ? (g.fx ?? g.cx ?? 0.5) : 0.5,
          isRadial ? (g.fy ?? g.cy ?? 0.5) : 0.5,
        )
        if (hasRadius) {
          doc.fill_with_gradient_rounded(gradId, c.x, c.y, c.w, c.h, rr.tl, rr.tr, rr.br, rr.bl)
        } else {
          doc.fill_with_gradient(gradId, c.x, c.y, c.w, c.h)
        }
      } else if (c.fill) {
        doc.set_fill_color(c.fill[0], c.fill[1], c.fill[2])
        if (hasRadius) doc.rounded_rect(c.x, c.y, c.w, c.h, rr.tl, rr.tr, rr.br, rr.bl, 'F')
        else           doc.rect(c.x, c.y, c.w, c.h, 'F')
      }

      if (c.stroke) {
        if (c.strokeStyle === 'dashed' || c.strokeStyle === 'dotted') {
          // border_ring's band fill has no way to carry a dash pattern — stroke the
          // rounded-rect path itself instead, centered on the same band border_ring fills
          const sw = c.strokeWidth ?? 0.5
          const dash = c.strokeStyle === 'dashed'
            ? [Math.max(2, sw * 3), Math.max(1.5, sw * 2)]
            : [Math.max(0.5, sw), Math.max(1, sw * 1.5)]
          doc.set_draw_color(c.stroke[0], c.stroke[1], c.stroke[2])
          doc.stroke_rounded_rect_dashed(c.x, c.y, c.w, c.h, rr.tl, rr.tr, rr.br, rr.bl, sw, dash)
        } else {
          // border_ring fills the band between two identically-constructed curves
          // instead of stroking one, so it needs the fill color, not the draw color.
          doc.set_fill_color(c.stroke[0], c.stroke[1], c.stroke[2])
          doc.border_ring(c.x, c.y, c.w, c.h, rr.tl, rr.tr, rr.br, rr.bl, c.strokeWidth ?? 0.5)
        }
      }

      // Inset shadows — after fill so the shadow layers paint over the box background
      if (insetShadows.length) {
        emitShadows(doc, insetShadows, c.x, c.y, c.w, c.h, rr)
      }

      if (hasRectGState) doc.set_alpha(1.0)

    } else if (cmd.type === 'line') {
      const c = cmd as LineCommand
      const hasLineGState = (c.opacity !== undefined && c.opacity < 1) || !!c.blend
      if (hasLineGState) doc.set_alpha(c.opacity ?? 1, c.blend)
      doc.set_draw_color(c.color[0], c.color[1], c.color[2])
      doc.set_line_width(c.width)
      // dash/dot lengths scale with the line width like browser borders do — a fixed
      // pattern turns thick dashed borders into near-square blobs
      if (c.lineStyle === 'dashed') {
        doc.set_line_dash([Math.max(2, c.width * 3), Math.max(1.5, c.width * 2)], 0)
        doc.line(c.x1, c.y1, c.x2, c.y2)
        doc.set_line_dash([], 0)
      } else if (c.lineStyle === 'dotted') {
        doc.set_line_dash([Math.max(0.5, c.width), Math.max(1, c.width * 1.5)], 0)
        doc.line(c.x1, c.y1, c.x2, c.y2)
        doc.set_line_dash([], 0)
      } else if (c.lineStyle === 'wavy') {
        doc.wavy_line(c.x1, c.y1, c.x2, c.y2, Math.max(0.6, c.width * 1.2), Math.max(3, c.width * 4))
      } else {
        doc.line(c.x1, c.y1, c.x2, c.y2)
      }
      if (hasLineGState) doc.set_alpha(1.0)

    } else if (cmd.type === 'clip-push') {
      const c = cmd as ClipCommand
      doc.save_graphics_state()
      if (c.path) {
        doc.set_clip_path(c.path, !!c.evenOdd)
      } else if (c.x !== undefined && c.y !== undefined && c.w !== undefined && c.h !== undefined) {
        const cr = resolveRadius(c.radius)
        if (anyRadius(cr)) {
          doc.set_clip_rounded_rect(c.x, c.y, c.w, c.h, cr.tl, cr.tr, cr.br, cr.bl)
        } else {
          doc.set_clip_rect(c.x, c.y, c.w, c.h)
        }
      }

    } else if (cmd.type === 'clip-pop') {
      doc.restore_graphics_state()

    } else if (cmd.type === 'transform-push') {
      const c = cmd as TransformCommand
      doc.save_graphics_state()
      if (c.matrix) doc.set_transform(c.matrix)

    } else if (cmd.type === 'transform-pop') {
      doc.restore_graphics_state()

    } else if (cmd.type === 'image') {
      const c = cmd as ImageCommand
      if (c.format === 'svg') continue  // rasterizeSVGs() was not called before applyToPDF()
      if (c.w < 0.01 || c.h < 0.01) continue  // degenerate cm matrix; some viewers reject it
      let imageId = imageCache.get(c.src)
      if (imageId === undefined) {
        imageId = doc.embed_image(c.src)
        if (imageId !== 0xFFFFFFFF) imageCache.set(c.src, imageId)
      }
      if (imageId !== undefined && imageId !== 0xFFFFFFFF) {
        const tagged = c.mcid !== undefined && c.structTag !== undefined
        if (tagged) doc.begin_marked_content(c.structTag!, c.mcid!)
        const hasGState = (c.opacity !== undefined && c.opacity < 1) || !!c.blend
        if (hasGState) doc.set_alpha(c.opacity ?? 1, c.blend)
        doc.draw_image(imageId, c.x, c.y, c.w, c.h)
        if (hasGState) doc.set_alpha(1.0)
        if (tagged) doc.end_marked_content()
      }

    } else if (cmd.type === 'raw-image') {
      const c = cmd as RawImageCommand
      if (c.w < 0.01 || c.h < 0.01) continue
      let imageId = imageCache.get(c.raw)
      if (imageId === undefined) {
        imageId = doc.embed_raw_image(c.raw)
        if (imageId !== 0xFFFFFFFF) imageCache.set(c.raw, imageId)
      }
      if (imageId !== undefined && imageId !== 0xFFFFFFFF) {
        const tagged = c.mcid !== undefined && c.structTag !== undefined
        if (tagged) doc.begin_marked_content(c.structTag!, c.mcid!)
        const hasGState = (c.opacity !== undefined && c.opacity < 1) || !!c.blend
        if (hasGState) doc.set_alpha(c.opacity ?? 1, c.blend)
        doc.draw_image(imageId, c.x, c.y, c.w, c.h)
        if (hasGState) doc.set_alpha(1.0)
        if (tagged) doc.end_marked_content()
      }

    } else if (cmd.type === 'field') {
      const c = cmd as FieldCommand
      doc.add_form_field(
        c.x, c.y, c.w, c.h, c.fieldType, c.name,
        c.font, c.style, c.weight, c.size, c.color,
        c.value, c.checked, c.options,
      )

    } else if (cmd.type === 'path') {
      const c = cmd as PathCommand
      const hasPathGState = (c.opacity !== undefined && c.opacity < 1) || !!c.blend
      if (hasPathGState) doc.set_alpha(c.opacity ?? 1, c.blend)
      let gradientFill: { gradientId: number; x: number; y: number; w: number; h: number } | undefined
      if (c.gradient && c.gradientBox) {
        const g = c.gradient
        const stopsFlat = new Float64Array(g.stops.flatMap(s => [s.position, s.color[0], s.color[1], s.color[2], s.color[3]]))
        const isRadial = g.type === 'radial'
        const gradId = doc.add_gradient(
          isRadial ? 1 : 0,
          g.type === 'linear' ? (g.angle ?? 0) : 0,
          stopsFlat,
          isRadial ? (g.cx ?? 0.5) : 0.5,
          isRadial ? (g.cy ?? 0.5) : 0.5,
          isRadial ? (g.fx ?? g.cx ?? 0.5) : 0.5,
          isRadial ? (g.fy ?? g.cy ?? 0.5) : 0.5,
        )
        gradientFill = { gradientId: gradId, x: c.gradientBox.x, y: c.gradientBox.y, w: c.gradientBox.w, h: c.gradientBox.h }
      }
      const stroke = c.stroke
        ? { color: c.stroke, width: c.strokeWidth ?? 1, dash: c.dashArray, lineCap: c.lineCap, lineJoin: c.lineJoin }
        : undefined
      doc.draw_path(c.ops, !!c.evenOdd, c.fill, gradientFill, stroke)
      if (hasPathGState) doc.set_alpha(1.0)
    }
  }

  if (def.metadata)  applyMetadata(doc, def.metadata)
  if (def.bookmarks) applyBookmarks(doc, def.bookmarks)
  if (structRoot)    applyStructTree(doc, structRoot)
  if (def.pdfA)      applyPdfA(doc, def.metadata)

  const sec = resolveSecurityConfig(def.security)
  if (sec) applySecurity(doc, sec)

  return doc.output()
}
