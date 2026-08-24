// walks PNG chunks after IHDR, in file order — visit returns true to stop
// early (found what it needed, or hit a boundary chunk it shouldn't cross)
export function forEachChunk(b: Uint8Array, visit: (type: string, data: Uint8Array) => boolean | void): void {
  if (b.length < 33 || b[12] !== 0x49 || b[13] !== 0x48 || b[14] !== 0x44 || b[15] !== 0x52) return
  const u32 = (o: number) => ((b[o]! << 24) | (b[o + 1]! << 16) | (b[o + 2]! << 8) | b[o + 3]!) >>> 0
  const ihdrLen = u32(8)
  let pos = 8 + 4 + 4 + ihdrLen + 4
  while (pos + 8 <= b.length) {
    const clen = u32(pos)
    const type = String.fromCharCode(b[pos + 4]!, b[pos + 5]!, b[pos + 6]!, b[pos + 7]!)
    const dend = pos + 8 + clen
    if (dend > b.length) return
    if (visit(type, b.subarray(pos + 8, dend))) return
    pos = dend + 4
  }
}
