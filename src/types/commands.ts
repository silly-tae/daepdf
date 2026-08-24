import type { Color, Gradient, BorderRadius, Corner, BoxShadow } from './color.js'
import type { RawImage } from '../images/decode.js'

export interface TextCommand {
  type:           'text'
  page:           number
  text:           string
  x:              number
  y:              number
  font:           string
  style:          string
  weight:         number
  size:           number
  color:          Color
  align:          'left' | 'center' | 'right'
  maxWidth:       number
  opacity?:       number
  letterSpacing?: number
  wordSpacing?:   number
  direction?:     'ltr' | 'rtl'
  // -webkit-text-stroke — PDF text render mode 2 (fill+stroke) or 1 (stroke only,
  // when the fill color is transparent)
  stroke?:        Color
  strokeWidth?:   number
  strokeOnly?:    boolean
  blend?:         string
  // A4 (vertical writing modes): draws down a column via PdfDoc.text_vertical
  // instead of the normal horizontal text() — x/y are the column's own
  // top-left anchor in this case, not a baseline position
  vertical?:      boolean
  // D3 (tagged PDF): marked-content ID + owning structure type, linking this
  // run back to its structure-tree element (src/html/types.ts's
  // tagStructContent) — undefined when tagging is off or this run sits
  // outside any tagged ancestor (e.g. an aria-hidden/role=presentation subtree)
  mcid?:          number
  structTag?:     string
}

export interface LinkCommand {
  type:   'link'
  page:   number
  x:      number
  y:      number
  w:      number
  h:      number
  href:   string
}

export interface RectCommand {
  type:         'rect'
  page:         number
  x:            number
  y:            number
  w:            number
  h:            number
  fill?:        Color | null
  gradient?:    Gradient
  stroke?:      Color | null
  strokeWidth?: number
  // dashed/dotted strokes draw as a dashed stroked path instead of the solid
  // border_ring fill — the only way a dash pattern can follow rounded corners
  strokeStyle?: 'solid' | 'dashed' | 'dotted'
  radius?:      BorderRadius
  shadow?:      BoxShadow[]
  opacity?:     number
  blend?:       string
}

export interface LineCommand {
  type:       'line'
  page:       number
  x1:         number
  y1:         number
  x2:         number
  y2:         number
  width:      number
  color:      Color
  lineStyle?: 'solid' | 'dashed' | 'dotted' | 'wavy'
  opacity?:   number
  blend?:     string
}

// clip-path polygon()/path(): a subpath is one 'm' followed by 'l'/'c' segments,
// already in PDF points, container-relative (same convention as x/y elsewhere)
export interface PathSeg {
  op:   'm' | 'l' | 'c'
  args: number[]
}

export interface ClipCommand {
  type:    'clip-push' | 'clip-pop'
  page:    number
  x?:      number
  y?:      number
  w?:      number
  h?:      number
  radius?: BorderRadius | undefined
  // set instead of x/y/w/h/radius for clip-path: polygon()/path() — an arbitrary
  // path clip rather than a (rounded) rect
  path?:    PathSeg[]
  evenOdd?: boolean
}

export interface ImageCommand {
  type:     'image'
  page:     number
  src:      Uint8Array
  format:   'png' | 'jpg' | 'svg'
  x:        number
  y:        number
  w:        number
  h:        number
  opacity?: number
  blend?:   string
  // D3 (tagged PDF) — see TextCommand.mcid/structTag
  mcid?:      number
  structTag?: string
}

// browser-decoded pixels (formats the engine doesn't parse natively) —
// embedded via embed_raw_image instead of the byte-parsing path
export interface RawImageCommand {
  type:     'raw-image'
  page:     number
  raw:      RawImage
  x:        number
  y:        number
  w:        number
  h:        number
  opacity?: number
  blend?:   string
  // D3 (tagged PDF) — see TextCommand.mcid/structTag
  mcid?:      number
  structTag?: string
}

// CSS transforms: matrix is the PDF-native `cm` 6-tuple [a,b,c,d,e,f],
// already adapted for Y-up and pivoted around transform-origin — see
// html/transform.ts's buildPdfTransformMatrix for the derivation
export interface TransformCommand {
  type:    'transform-push' | 'transform-pop'
  page:    number
  matrix?: number[]
}

// D1 (AcroForm): one interactive form control. A merged field+widget (one
// PDF object serves both roles, the common pattern for one-widget-per-field
// forms) — becomes both a page /Annot and a top-level /AcroForm /Fields
// entry. The current value/checked/options ALSO drive a real appearance
// stream, so the value prints statically even without interactive-forms
// support, not just when a viewer chooses to render the widget.
export interface FieldCommand {
  type:      'field'
  page:      number
  x:         number
  y:         number
  w:         number
  h:         number
  fieldType: 'Tx' | 'Btn' | 'Ch'
  name:      string
  font:      string
  style:     string
  weight:    number
  size:      number
  color:     Color
  value?:    string   // Tx: typed text. Ch: the selected <option>'s value/text
  checked?:  boolean  // Btn: checkbox/radio state (radio groups are NOT modeled — each is an independent Btn field, a stated scope limit)
  options?:  string[] // Ch: the <option> list, in DOM order
}

// D5 (SVG as true vectors): a single filled/stroked shape, already resolved
// to page-relative pt (same Y-down convention as ClipCommand.path) — emitted
// instead of an ImageCommand{format:'svg'} whenever src/pdf/svgvector.ts
// can convert the whole source SVG without hitting an unsupported feature.
export interface PathCommand {
  type:         'path'
  page:         number
  ops:          PathSeg[]
  evenOdd?:     boolean
  fill?:        Color
  stroke?:      Color
  strokeWidth?: number
  dashArray?:   number[]
  lineCap?:     number
  lineJoin?:    number
  gradient?:    Gradient
  gradientBox?: { x: number; y: number; w: number; h: number }
  opacity?:     number
  blend?:       string
}

export type DrawCommand =
  | TextCommand
  | RectCommand
  | LineCommand
  | ClipCommand
  | LinkCommand
  | ImageCommand
  | RawImageCommand
  | TransformCommand
  | FieldCommand
  | PathCommand

export interface ResolvedRadius { tl: Corner; tr: Corner; br: Corner; bl: Corner }

export function resolveRadius(r: BorderRadius | undefined): ResolvedRadius {
  const a = r?.all ?? 0
  const c = (x?: Corner): Corner => x ? { h: x.h, v: x.v } : { h: a, v: a }
  return { tl: c(r?.topLeft), tr: c(r?.topRight), br: c(r?.bottomRight), bl: c(r?.bottomLeft) }
}

// a corner only rounds when BOTH components are positive (CSS: either radius
// zero means a square corner) — object truthiness can't stand in for this check
export function anyRadius(rr: ResolvedRadius): boolean {
  const rounded = (c: Corner) => c.h > 0 && c.v > 0
  return rounded(rr.tl) || rounded(rr.tr) || rounded(rr.br) || rounded(rr.bl)
}
