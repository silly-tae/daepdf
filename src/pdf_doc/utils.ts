export const _te = new TextEncoder()

// Every coordinate in the document passes through here, so this is where a
// non-finite value has to be stopped: `toFixed` renders NaN and Infinity
// verbatim, and switches to exponential notation past 1e21, none of which is a
// PDF number. A reader that meets one drops the whole operator silently.
const PDF_NUMBER_LIMIT = 1e15

export function hpf(n: number): string {
  if (!Number.isFinite(n)) return '0'
  const clamped = n > PDF_NUMBER_LIMIT ? PDF_NUMBER_LIMIT
                : n < -PDF_NUMBER_LIMIT ? -PDF_NUMBER_LIMIT
                : n
  return clamped.toFixed(3).replace(/\.?0+$/, '')
}

export function encodeColor(r: number, g: number, b: number, isStroke: boolean, prec = 2): string {
  const opG = isStroke ? 'G' : 'g'
  const opC = isStroke ? 'RG' : 'rg'
  const fmt = (v: number) => (v / 255).toFixed(prec).replace(/\.?0+$/, '')
  if (r === g && g === b) return `${fmt(r)} ${opG}`
  return `${fmt(r)} ${fmt(g)} ${fmt(b)} ${opC}`
}

// A name's regular characters are 0x21-0x7E minus the delimiters and '#';
// everything else has to be written as #XX, over the UTF-8 bytes rather than
// the code units so non-ASCII survives too. Escaping only space and the
// delimiters left tab, form feed and NUL to terminate the name early.
const NAME_DELIMITERS = '()<>[]{}/%#'

export function toPdfName(s: string): string {
  let out = ''
  for (const byte of _te.encode(s)) {
    const c = String.fromCharCode(byte)
    if (byte < 0x21 || byte > 0x7E || NAME_DELIMITERS.includes(c)) {
      out += '#' + byte.toString(16).toUpperCase().padStart(2, '0')
    } else {
      out += c
    }
  }
  return out
}

// CR and LF are escaped rather than passed through: an end-of-line marker
// inside a literal string is defined to read back as a single LF, so a raw CR
// silently rewrites the value and a CRLF collapses to one character.
export function pdfEscape(s: string): string {
  return s.replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)')
          .replace(/\r/g, '\\r').replace(/\n/g, '\\n')
}

// A PDF text string is PDFDocEncoding or UTF-16BE introduced by a U+FEFF BOM.
// ASCII is valid PDFDocEncoding as it stands; anything above it has to be
// UTF-16BE, or the reader decodes the UTF-8 bytes as PDFDocEncoding and the
// value comes back mangled. JS strings are already UTF-16, so the code units
// map straight across, surrogate pairs included.
export function textStringBytes(s: string): Uint8Array {
  if (/^[\x00-\x7F]*$/.test(s)) return _te.encode(s)
  const out = new Uint8Array(2 + s.length * 2)
  out[0] = 0xFE; out[1] = 0xFF
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i)
    out[2 + i * 2] = c >> 8
    out[3 + i * 2] = c & 0xFF
  }
  return out
}

// /URI is a byte string rather than a text string, so it must stay ASCII and
// can never take the UTF-16BE path above – a non-ASCII address is percent-
// encoded UTF-8, which is what a URL was always supposed to be.
export function uriString(s: string): string {
  let out = ''
  for (const b of _te.encode(s)) {
    out += (b < 0x21 || b > 0x7E)
      ? '%' + b.toString(16).toUpperCase().padStart(2, '0')
      : String.fromCharCode(b)
  }
  return out
}

export function widthsToPdf(widths: [number, number][]): string {
  let s = '['
  for (const [i, [cid, w]] of widths.entries()) {
    if (i > 0) s += ' '
    s += `${cid} [${w}]`
  }
  return s + ']'
}

// /W2 (vertical CID widths): [w1y v1x v1y] triples per CID — same list-form
// shape as /W, three numbers per entry instead of one
export function w2ToPdf(entries: [number, number, number, number][]): string {
  let s = '['
  for (const [i, [cid, w1y, v1x, v1y]] of entries.entries()) {
    if (i > 0) s += ' '
    s += `${cid} [${w1y} ${v1x} ${v1y}]`
  }
  return s + ']'
}

export function bboxToPdf(bbox: number[]): string {
  return '[' + bbox.join(' ') + ']'
}

export function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('')
}

export function pdfDate(): string {
  const d = new Date()
  const p = (n: number, w = 2) => n.toString().padStart(w, '0')
  return `D:${d.getUTCFullYear()}${p(d.getUTCMonth()+1)}${p(d.getUTCDate())}${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}+00'00'`
}
