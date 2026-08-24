export { applyToPDF, rasterizeSVGs } from './pdf/index.js'
export { fromHTML, fromDOM, previewHTML, renderHTMLtoPDF, invalidateFontMapCache, invalidateImageCache } from './html/index.js'
export type { FontBridgeMap, HTMLCapture, HTMLToPDFOptions } from './html/index.js'

export type {
  Color, ColorAlpha,
  BorderRadius,
  BoxShadow, Gradient, GradientStop,
  PageSize, PageConfig,
  FontRef,
  DocDefinition, PDFMetadata, PDFSecurity, BookmarkEntry, AnchorEntry,
  DrawCommand, TextCommand, RectCommand, LineCommand, LinkCommand,
  ClipCommand, ImageCommand,
  ParsedImage, SubsetFontResult,
} from './types/index.js'

export { resolvePageSize, resolveRadius } from './types/index.js'
