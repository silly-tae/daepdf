export interface ParsedImage {
  width:        number
  height:       number
  colorSpace:   'DeviceRGB' | 'DeviceGray' | 'DeviceCMYK'
  data:         Uint8Array
  smask:        Uint8Array | null
  isJpeg:       boolean
  decodeInvert: boolean
  orientation:  number
}

export interface SubsetFontResult {
  fontBytes:   Uint8Array | null
  glyphMap:    Uint16Array | null
  isCff:       boolean
  ascender:    number
  descender:   number
  capHeight:   number
  bbox:        [number, number, number, number]
  flags:       number
  italicAngle: number
  fontName:    string
}
