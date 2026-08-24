// The engine surface daepdf calls, over daepl's raw wasm module. Names and signatures match the
// old taetype build so the renderer keeps calling what it already called.

export interface ShapedRun {
  glyphs: Uint16Array
  advances: Float64Array
  clusters: Uint32Array
}

export interface ColrLayer {
  gid: number
  r: number
  g: number
  b: number
  a: number
  isFg: boolean
}

export interface GlyphBitmap {
  png: Uint8Array
  ppem: number
  originX: number
  originY: number
}

export interface SubsetFontResult {
  fontBytes: Uint8Array | null
  glyphMap: Uint16Array | null
  isCff: boolean
  ascender: number
  descender: number
  capHeight: number
  bbox: [number, number, number, number]
  flags: number
  italicAngle: number
  fontName: string
}

interface Exports {
  memory: WebAssembly.Memory
  arg_buffer(len: number): number
  out_ptr(): number
  out_len(): number
  err_ptr(): number
  err_len(): number
  register_raw(): number
  register_ttc(): number
  list_fonts(): number
  has_glyph(): number
  glyph_ids(): number
  shape(): number
  advance_widths(): number
  vertical_advance(): number
  colr_layers(): number
  glyph_bitmap(): number
  measure_width(): number
  subset_full(): number
}

const OK = 0
const FAILED = 1

const utf8 = new TextEncoder()
const decoder = new TextDecoder()

// Mirrors codec.rs: little-endian throughout, a u32 length or count before every variable part.
class Writer {
  #parts: Uint8Array[] = []
  #len = 0

  #push(part: Uint8Array): void {
    this.#parts.push(part)
    this.#len += part.length
  }

  u32(v: number): Writer {
    const b = new Uint8Array(4)
    new DataView(b.buffer).setUint32(0, v >>> 0, true)
    this.#push(b)
    return this
  }

  f64(v: number): Writer {
    const b = new Uint8Array(8)
    new DataView(b.buffer).setFloat64(0, v, true)
    this.#push(b)
    return this
  }

  bytes(v: Uint8Array): Writer {
    this.u32(v.length)
    this.#push(v)
    return this
  }

  string(v: string): Writer {
    return this.bytes(utf8.encode(v))
  }

  u16s(v: ArrayLike<number>): Writer {
    this.u32(v.length)
    const a = new Uint16Array(v.length)
    a.set(v)
    this.#push(new Uint8Array(a.buffer))
    return this
  }

  finish(): Uint8Array {
    const out = new Uint8Array(this.#len)
    let at = 0
    for (const p of this.#parts) {
      out.set(p, at)
      at += p.length
    }
    return out
  }
}

class Reader {
  #view: DataView
  #bytes: Uint8Array
  #at = 0

  constructor(source: Uint8Array) {
    this.#bytes = source
    this.#view = new DataView(source.buffer, source.byteOffset, source.byteLength)
  }

  u32(): number {
    const v = this.#view.getUint32(this.#at, true)
    this.#at += 4
    return v
  }

  f64(): number {
    const v = this.#view.getFloat64(this.#at, true)
    this.#at += 8
    return v
  }

  bytes(): Uint8Array {
    const n = this.u32()
    const v = this.#bytes.slice(this.#at, this.#at + n)
    this.#at += n
    return v
  }

  string(): string {
    return decoder.decode(this.bytes())
  }

  u16s(): Uint16Array {
    const n = this.u32()
    const v = new Uint16Array(n)
    for (let i = 0; i < n; i++) v[i] = this.#view.getUint16(this.#at + i * 2, true)
    this.#at += n * 2
    return v
  }

  u32s(): Uint32Array {
    const n = this.u32()
    const v = new Uint32Array(n)
    for (let i = 0; i < n; i++) v[i] = this.#view.getUint32(this.#at + i * 4, true)
    this.#at += n * 4
    return v
  }

  f64s(): Float64Array {
    const n = this.u32()
    const v = new Float64Array(n)
    for (let i = 0; i < n; i++) v[i] = this.#view.getFloat64(this.#at + i * 8, true)
    this.#at += n * 8
    return v
  }
}

let wasm: Exports | null = null

function engine(): Exports {
  if (!wasm) throw new Error('daepl: initEngine() has not finished')
  return wasm
}

// Any call can grow linear memory, which detaches views taken before it, so each access re-reads
// the buffer. The buffer pointer is claimed on its own line for the same reason.
function bytes(): Uint8Array {
  return new Uint8Array(engine().memory.buffer)
}

function call(fn: () => number, args: Writer): Reader | null {
  const x = engine()
  const blob = args.finish()
  const at = x.arg_buffer(blob.length)
  bytes().set(blob, at)

  const status = fn()
  if (status === FAILED) {
    const e = x.err_ptr()
    throw new Error(decoder.decode(bytes().slice(e, e + x.err_len())))
  }
  if (status !== OK) return null

  const o = x.out_ptr()
  return new Reader(bytes().slice(o, o + x.out_len()))
}

export type InitInput = BufferSource | Response | Promise<Response>

export default async function initEngine(source?: InitInput): Promise<void> {
  if (wasm) return
  const from = source ?? new URL('./daepl.wasm', import.meta.url)
  const streaming = from instanceof URL || from instanceof Response || from instanceof Promise
  const instantiated = streaming
    ? await WebAssembly.instantiateStreaming(
        from instanceof URL ? fetch(from) : (from as Response | Promise<Response>), {})
    : await WebAssembly.instantiate(from as BufferSource, {})
  wasm = instantiated.instance.exports as unknown as Exports
}

export function register_font_raw(name: string, raw_bytes: Uint8Array): void {
  call(() => engine().register_raw(), new Writer().string(name).bytes(raw_bytes))
}

export function register_font_ttc(name: string, ttc_bytes: Uint8Array, index: number): void {
  call(() => engine().register_ttc(), new Writer().string(name).bytes(ttc_bytes).u32(index))
}

// "name:style", lowercased, which is the shape and the casing the renderer parses: it looks the
// family up by `fam.toLowerCase()`, so anything else misses every lookup and the document renders
// with no text at all. Weight is read back but not surfaced, nothing asks for it.
export function list_registered_fonts(): string[] {
  const r = call(() => engine().list_fonts(), new Writer())
  if (!r) return []
  const n = r.u32()
  const out: string[] = []
  for (let i = 0; i < n; i++) {
    const name = r.string()
    const style = r.string()
    r.u32()
    out.push(`${name.toLowerCase()}:${style.toLowerCase()}`)
  }
  return out
}

export function font_has_glyph(font_name: string, style: string, codepoint: number): boolean {
  const r = call(() => engine().has_glyph(), new Writer().string(font_name).string(style).u32(codepoint))
  return r ? r.u32() !== 0 : false
}

export function get_glyph_ids(text: string, font_name: string, style: string, weight: number): Uint16Array {
  const r = call(() => engine().glyph_ids(),
    new Writer().string(text).string(font_name).string(style).u32(weight))
  return r ? r.u16s() : new Uint16Array(0)
}

export function shape_text(
  text: string, font_name: string, style: string, weight: number, opsz: number, vertical: boolean,
): ShapedRun | null {
  const r = call(() => engine().shape(),
    new Writer().string(text).string(font_name).string(style).u32(weight).f64(opsz).u32(vertical ? 1 : 0))
  if (!r) return null
  return { glyphs: r.u16s(), advances: r.f64s(), clusters: r.u32s() }
}

export function get_advance_widths(
  font_name: string, style: string, weight: number, opsz: number, glyph_ids: Uint16Array,
): Float64Array {
  const r = call(() => engine().advance_widths(),
    new Writer().string(font_name).string(style).u32(weight).f64(opsz).u16s(glyph_ids))
  return r ? r.f64s() : new Float64Array(0)
}

export function get_vertical_advance(
  font_name: string, style: string, weight: number, opsz: number, gid: number,
): number {
  const r = call(() => engine().vertical_advance(),
    new Writer().string(font_name).string(style).u32(weight).f64(opsz).u32(gid))
  return r ? r.f64() : 0
}

// Flat, six values per layer, matching what the renderer already unpacks.
export function get_colr_layers(font_name: string, style: string, gid: number): Uint32Array {
  const r = call(() => engine().colr_layers(), new Writer().string(font_name).string(style).u32(gid))
  if (!r) return new Uint32Array(0)
  const n = r.u32()
  const out = new Uint32Array(n * 6)
  for (let i = 0; i < n * 6; i++) out[i] = r.u32()
  return out
}

export function get_glyph_bitmap(
  font_name: string, style: string, gid: number, target_ppem: number,
): GlyphBitmap | null {
  const r = call(() => engine().glyph_bitmap(),
    new Writer().string(font_name).string(style).u32(gid).u32(target_ppem))
  if (!r) return null
  return { ppem: r.u32(), originX: r.f64(), originY: r.f64(), png: r.bytes() }
}

export function measure_string_width(
  text: string, font_name: string, style: string, weight: number, opsz: number, font_size: number,
): number {
  const r = call(() => engine().measure_width(),
    new Writer().string(text).string(font_name).string(style).u32(weight).f64(opsz).f64(font_size))
  return r ? r.f64() : 0
}

export function subset_font_full(
  font_name: string, style: string, weight: number, opsz: number, glyph_ids: Uint16Array,
): SubsetFontResult | null {
  const r = call(() => engine().subset_full(),
    new Writer().string(font_name).string(style).u32(weight).f64(opsz).u16s(glyph_ids))
  if (!r) return null
  const fontBytes = r.bytes()
  const glyphMap = r.u16s()
  const isCff = r.u32() !== 0
  const ascender = r.f64()
  const descender = r.f64()
  const capHeight = r.f64()
  const bbox: [number, number, number, number] = [r.f64(), r.f64(), r.f64(), r.f64()]
  const flags = r.u32()
  const italicAngle = r.f64()
  const fontName = r.string()
  return { fontBytes, glyphMap, isCff, ascender, descender, capHeight, bbox, flags, italicAngle, fontName }
}
