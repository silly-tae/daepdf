// src/daepl/wasm/daepl.ts
var OK = 0;
var FAILED = 1;
var utf8 = new TextEncoder();
var decoder = new TextDecoder();
var Writer = class {
  #parts = [];
  #len = 0;
  #push(part) {
    this.#parts.push(part);
    this.#len += part.length;
  }
  u32(v) {
    const b = new Uint8Array(4);
    new DataView(b.buffer).setUint32(0, v >>> 0, true);
    this.#push(b);
    return this;
  }
  f64(v) {
    const b = new Uint8Array(8);
    new DataView(b.buffer).setFloat64(0, v, true);
    this.#push(b);
    return this;
  }
  bytes(v) {
    this.u32(v.length);
    this.#push(v);
    return this;
  }
  string(v) {
    return this.bytes(utf8.encode(v));
  }
  u16s(v) {
    this.u32(v.length);
    const a = new Uint16Array(v.length);
    a.set(v);
    this.#push(new Uint8Array(a.buffer));
    return this;
  }
  finish() {
    const out = new Uint8Array(this.#len);
    let at = 0;
    for (const p of this.#parts) {
      out.set(p, at);
      at += p.length;
    }
    return out;
  }
};
var Reader = class {
  #view;
  #bytes;
  #at = 0;
  constructor(source) {
    this.#bytes = source;
    this.#view = new DataView(source.buffer, source.byteOffset, source.byteLength);
  }
  u32() {
    const v = this.#view.getUint32(this.#at, true);
    this.#at += 4;
    return v;
  }
  f64() {
    const v = this.#view.getFloat64(this.#at, true);
    this.#at += 8;
    return v;
  }
  bytes() {
    const n = this.u32();
    const v = this.#bytes.slice(this.#at, this.#at + n);
    this.#at += n;
    return v;
  }
  string() {
    return decoder.decode(this.bytes());
  }
  u16s() {
    const n = this.u32();
    const v = new Uint16Array(n);
    for (let i = 0; i < n; i++) v[i] = this.#view.getUint16(this.#at + i * 2, true);
    this.#at += n * 2;
    return v;
  }
  u32s() {
    const n = this.u32();
    const v = new Uint32Array(n);
    for (let i = 0; i < n; i++) v[i] = this.#view.getUint32(this.#at + i * 4, true);
    this.#at += n * 4;
    return v;
  }
  f64s() {
    const n = this.u32();
    const v = new Float64Array(n);
    for (let i = 0; i < n; i++) v[i] = this.#view.getFloat64(this.#at + i * 8, true);
    this.#at += n * 8;
    return v;
  }
};
var wasm = null;
function engine() {
  if (!wasm) throw new Error("daepl: initEngine() has not finished");
  return wasm;
}
function bytes() {
  return new Uint8Array(engine().memory.buffer);
}
function call(fn, args) {
  const x = engine();
  const blob = args.finish();
  const at = x.arg_buffer(blob.length);
  bytes().set(blob, at);
  const status = fn();
  if (status === FAILED) {
    const e = x.err_ptr();
    throw new Error(decoder.decode(bytes().slice(e, e + x.err_len())));
  }
  if (status !== OK) return null;
  const o = x.out_ptr();
  return new Reader(bytes().slice(o, o + x.out_len()));
}
async function initEngine(source) {
  if (wasm) return;
  const from = source ?? new URL("./daepl.wasm", import.meta.url);
  const streaming = from instanceof URL || from instanceof Response || from instanceof Promise;
  const instantiated = streaming ? await WebAssembly.instantiateStreaming(
    from instanceof URL ? fetch(from) : from,
    {}
  ) : await WebAssembly.instantiate(from, {});
  wasm = instantiated.instance.exports;
}
function register_font_raw(name, raw_bytes) {
  call(() => engine().register_raw(), new Writer().string(name).bytes(raw_bytes));
}
function register_font_ttc(name, ttc_bytes, index) {
  call(() => engine().register_ttc(), new Writer().string(name).bytes(ttc_bytes).u32(index));
}
function list_registered_fonts() {
  const r = call(() => engine().list_fonts(), new Writer());
  if (!r) return [];
  const n = r.u32();
  const out = [];
  for (let i = 0; i < n; i++) {
    const name = r.string();
    const style = r.string();
    r.u32();
    out.push(`${name.toLowerCase()}:${style.toLowerCase()}`);
  }
  return out;
}
function font_has_glyph(font_name, style, codepoint) {
  const r = call(() => engine().has_glyph(), new Writer().string(font_name).string(style).u32(codepoint));
  return r ? r.u32() !== 0 : false;
}
function get_glyph_ids(text, font_name, style, weight) {
  const r = call(
    () => engine().glyph_ids(),
    new Writer().string(text).string(font_name).string(style).u32(weight)
  );
  return r ? r.u16s() : new Uint16Array(0);
}
function shape_text(text, font_name, style, weight, opsz, vertical) {
  const r = call(
    () => engine().shape(),
    new Writer().string(text).string(font_name).string(style).u32(weight).f64(opsz).u32(vertical ? 1 : 0)
  );
  if (!r) return null;
  return { glyphs: r.u16s(), advances: r.f64s(), clusters: r.u32s() };
}
function get_advance_widths(font_name, style, weight, opsz, glyph_ids) {
  const r = call(
    () => engine().advance_widths(),
    new Writer().string(font_name).string(style).u32(weight).f64(opsz).u16s(glyph_ids)
  );
  return r ? r.f64s() : new Float64Array(0);
}
function get_vertical_advance(font_name, style, weight, opsz, gid) {
  const r = call(
    () => engine().vertical_advance(),
    new Writer().string(font_name).string(style).u32(weight).f64(opsz).u32(gid)
  );
  return r ? r.f64() : 0;
}
function get_colr_layers(font_name, style, gid) {
  const r = call(() => engine().colr_layers(), new Writer().string(font_name).string(style).u32(gid));
  if (!r) return new Uint32Array(0);
  const n = r.u32();
  const out = new Uint32Array(n * 6);
  for (let i = 0; i < n * 6; i++) out[i] = r.u32();
  return out;
}
function get_glyph_bitmap(font_name, style, gid, target_ppem) {
  const r = call(
    () => engine().glyph_bitmap(),
    new Writer().string(font_name).string(style).u32(gid).u32(target_ppem)
  );
  if (!r) return null;
  return { ppem: r.u32(), originX: r.f64(), originY: r.f64(), png: r.bytes() };
}
function measure_string_width(text, font_name, style, weight, opsz, font_size) {
  const r = call(
    () => engine().measure_width(),
    new Writer().string(text).string(font_name).string(style).u32(weight).f64(opsz).f64(font_size)
  );
  return r ? r.f64() : 0;
}
function subset_font_full(font_name, style, weight, opsz, glyph_ids) {
  const r = call(
    () => engine().subset_full(),
    new Writer().string(font_name).string(style).u32(weight).f64(opsz).u16s(glyph_ids)
  );
  if (!r) return null;
  const fontBytes = r.bytes();
  const glyphMap = r.u16s();
  const isCff = r.u32() !== 0;
  const ascender = r.f64();
  const descender = r.f64();
  const capHeight = r.f64();
  const bbox = [r.f64(), r.f64(), r.f64(), r.f64()];
  const flags = r.u32();
  const italicAngle = r.f64();
  const fontName = r.string();
  return { fontBytes, glyphMap, isCff, ascender, descender, capHeight, bbox, flags, italicAngle, fontName };
}

// engine.ts
var _fetchCache = /* @__PURE__ */ new Map();
var _wasmReady = null;
var _ensureWasm = () => {
  if (!_wasmReady) _wasmReady = initEngine().then(() => void 0);
  return _wasmReady;
};
function _fetchFont(path) {
  if (!_fetchCache.has(path)) {
    const p = fetch(path).then((r) => {
      if (!r.ok) throw new Error(`Failed to fetch font ${path}: ${r.status}`);
      return r.arrayBuffer().then((b) => new Uint8Array(b));
    });
    p.catch(() => _fetchCache.delete(path));
    _fetchCache.set(path, p);
  }
  return _fetchCache.get(path);
}
function _isRawFont(bytes2) {
  if (bytes2.length < 4) return false;
  const sig = (bytes2[0] << 24 | bytes2[1] << 16 | bytes2[2] << 8 | bytes2[3]) >>> 0;
  return sig === 65536 || sig === 1330926671 || sig === 1953658213;
}
async function loadAndRegisterFont(entry) {
  await _ensureWasm();
  const bytes2 = await _fetchFont(entry.path);
  const sig = bytes2.length >= 4 ? (bytes2[0] << 24 | bytes2[1] << 16 | bytes2[2] << 8 | bytes2[3]) >>> 0 : 0;
  if (sig === 1953784678) {
    register_font_ttc(entry.name, bytes2, entry.ttcIndex ?? 0);
    return;
  }
  if (_isRawFont(bytes2)) {
    register_font_raw(entry.name, bytes2);
    return;
  }
  const label = sig === 2001684018 ? "WOFF2" : sig === 2001684038 ? "WOFF" : "an unrecognized format";
  throw new Error(
    `Font ${entry.path} is ${label}. daepdf embeds TTF, OTF and TTC only \u2013 point src at the uncompressed font.`
  );
}
function triggerDownload(bytes2, fileName) {
  const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent) || navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1;
  const blob = new Blob([bytes2], { type: isIOS ? "application/octet-stream" : "application/pdf" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = fileName;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 1e4);
}
var safeName = (s) => s.trim().replace(/\s+/g, "_").replace(/[^\p{L}\p{N}\p{M}_-]/gu, "");

// src/daefl/deflate.ts
var LEN_BASE = new Uint16Array([
  3,
  4,
  5,
  6,
  7,
  8,
  9,
  10,
  11,
  13,
  15,
  17,
  19,
  23,
  27,
  31,
  35,
  43,
  51,
  59,
  67,
  83,
  99,
  115,
  131,
  163,
  195,
  227,
  258
]);
var LEN_EXTRA = new Uint8Array([
  0,
  0,
  0,
  0,
  0,
  0,
  0,
  0,
  1,
  1,
  1,
  1,
  2,
  2,
  2,
  2,
  3,
  3,
  3,
  3,
  4,
  4,
  4,
  4,
  5,
  5,
  5,
  5,
  0
]);
var DIST_BASE = new Uint16Array([
  1,
  2,
  3,
  4,
  5,
  7,
  9,
  13,
  17,
  25,
  33,
  49,
  65,
  97,
  129,
  193,
  257,
  385,
  513,
  769,
  1025,
  1537,
  2049,
  3073,
  4097,
  6145,
  8193,
  12289,
  16385,
  24577
]);
var DIST_EXTRA = new Uint8Array([
  0,
  0,
  0,
  0,
  1,
  1,
  2,
  2,
  3,
  3,
  4,
  4,
  5,
  5,
  6,
  6,
  7,
  7,
  8,
  8,
  9,
  9,
  10,
  10,
  11,
  11,
  12,
  12,
  13,
  13
]);
var CLEN_ORDER = new Uint8Array([16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15]);
var MIN_MATCH = 3;
var MAX_MATCH = 258;
var WINDOW = 32768;
var HASH_BITS = 15;
var HASH_SIZE = 1 << HASH_BITS;
var CHAIN = new Uint16Array([0, 8, 32, 128, 512, 1024, 2048, 4096, 8192, 32768]);
var NICE = new Uint16Array([0, 8, 16, 32, 64, 128, 258, 258, 258, 258]);
var GOOD = new Uint16Array([0, 4, 8, 16, 32, 64, 258, 258, 258, 258]);
var LEN_CODE = new Uint8Array(259);
for (let len = 3, code = 0; len <= 258; len++) {
  while (code < 28 && len >= LEN_BASE[code + 1]) code++;
  LEN_CODE[len] = code;
}
var DIST_CODE_LOW = new Uint8Array(256);
var DIST_CODE_HIGH = new Uint8Array(256);
for (let d = 1, code = 0; d <= 256; d++) {
  while (code < 29 && d >= DIST_BASE[code + 1]) code++;
  DIST_CODE_LOW[d - 1] = code;
}
for (let d = 257, code = 15; d <= 32768; d++) {
  while (code < 29 && d >= DIST_BASE[code + 1]) code++;
  DIST_CODE_HIGH[d - 1 >> 7] = code;
}
var lenCode = (len) => LEN_CODE[len];
var distCode = (dist) => dist <= 256 ? DIST_CODE_LOW[dist - 1] : DIST_CODE_HIGH[dist - 1 >> 7];
var BitWriter = class {
  buf = new Uint8Array(1024);
  len = 0;
  acc = 0;
  nbits = 0;
  room(n) {
    if (this.len + n <= this.buf.length) return;
    let size = this.buf.length;
    while (size < this.len + n) size *= 2;
    const next = new Uint8Array(size);
    next.set(this.buf.subarray(0, this.len));
    this.buf = next;
  }
  // DEFLATE packs bits least-significant-first within each byte.
  write(value, bits) {
    this.acc |= value << this.nbits;
    this.nbits += bits;
    while (this.nbits >= 8) {
      this.room(1);
      this.buf[this.len++] = this.acc & 255;
      this.acc >>>= 8;
      this.nbits -= 8;
    }
  }
  // Codes arrive already reversed from assignCodes, so emitting one is just a
  // write. Reversing per symbol here was the single largest cost in encoding.
  writeCode(code, bits) {
    this.write(code, bits);
  }
  alignToByte() {
    if (this.nbits > 0) {
      this.room(1);
      this.buf[this.len++] = this.acc & 255;
      this.acc = 0;
      this.nbits = 0;
    }
  }
  writeBytes(src) {
    this.room(src.length);
    this.buf.set(src, this.len);
    this.len += src.length;
  }
  result() {
    this.alignToByte();
    return this.buf.subarray(0, this.len);
  }
};
function buildCodes(freqs, maxBits) {
  const n = freqs.length;
  const lengths = new Uint8Array(n);
  const used = [];
  for (let i = 0; i < n; i++) if (freqs[i] > 0) used.push(i);
  if (used.length === 0) return { lengths, codes: new Uint16Array(n) };
  if (used.length === 1) {
    lengths[used[0]] = 1;
    return { lengths, codes: assignCodes(lengths, maxBits) };
  }
  const maxNodes = used.length * 2 - 1;
  const nodeFreq = new Uint32Array(maxNodes);
  const nodeLeft = new Int32Array(maxNodes).fill(-1);
  const nodeRight = new Int32Array(maxNodes).fill(-1);
  const nodeSym = new Int32Array(maxNodes).fill(-1);
  let count = 0;
  for (const s of used) {
    nodeFreq[count] = freqs[s];
    nodeSym[count] = s;
    count++;
  }
  const heap = new Int32Array(maxNodes + 1);
  let hn = 0;
  const less = (x, y) => nodeFreq[x] !== nodeFreq[y] ? nodeFreq[x] < nodeFreq[y] : x < y;
  const up = (start) => {
    let c = start;
    while (c > 1 && less(heap[c], heap[c >> 1])) {
      const t = heap[c];
      heap[c] = heap[c >> 1];
      heap[c >> 1] = t;
      c >>= 1;
    }
  };
  const down = (start) => {
    let parent = start;
    for (; ; ) {
      let best = parent;
      const l = parent << 1, r = l + 1;
      if (l <= hn && less(heap[l], heap[best])) best = l;
      if (r <= hn && less(heap[r], heap[best])) best = r;
      if (best === parent) return;
      const t = heap[parent];
      heap[parent] = heap[best];
      heap[best] = t;
      parent = best;
    }
  };
  const push = (node) => {
    heap[++hn] = node;
    up(hn);
  };
  const pop = () => {
    const top = heap[1];
    heap[1] = heap[hn--];
    if (hn > 0) down(1);
    return top;
  };
  for (let i = 0; i < count; i++) push(i);
  let alive = count;
  while (alive > 1) {
    const a = pop();
    const b = pop();
    nodeFreq[count] = nodeFreq[a] + nodeFreq[b];
    nodeLeft[count] = a;
    nodeRight[count] = b;
    push(count);
    count++;
    alive--;
  }
  const root = count - 1;
  const depth = new Int32Array(count);
  const stack = [root];
  depth[root] = 0;
  while (stack.length) {
    const node = stack.pop();
    const l = nodeLeft[node], r = nodeRight[node];
    if (l < 0) {
      lengths[nodeSym[node]] = Math.max(1, depth[node]);
      continue;
    }
    depth[l] = depth[node] + 1;
    depth[r] = depth[node] + 1;
    stack.push(l, r);
  }
  limitLengths(lengths, used, maxBits);
  return { lengths, codes: assignCodes(lengths, maxBits) };
}
function limitLengths(lengths, used, maxBits) {
  let over = false;
  for (const s of used) if (lengths[s] > maxBits) {
    over = true;
    break;
  }
  if (!over) return;
  for (const s of used) if (lengths[s] > maxBits) lengths[s] = maxBits;
  const total = 1 << maxBits;
  let sum = 0;
  for (const s of used) sum += total >> lengths[s];
  while (sum > total) {
    let pick = -1;
    for (const s of used) {
      if (lengths[s] >= maxBits) continue;
      if (pick < 0 || lengths[s] > lengths[pick]) pick = s;
    }
    if (pick < 0) break;
    sum -= total >> lengths[pick];
    lengths[pick] = lengths[pick] + 1;
    sum += total >> lengths[pick];
  }
  for (; ; ) {
    let pick = -1;
    for (const s of used) {
      if (lengths[s] <= 1) continue;
      const gain = (total >> lengths[s] - 1) - (total >> lengths[s]);
      if (sum + gain <= total && (pick < 0 || lengths[s] > lengths[pick])) pick = s;
    }
    if (pick < 0) break;
    sum += (total >> lengths[pick] - 1) - (total >> lengths[pick]);
    lengths[pick] = lengths[pick] - 1;
  }
}
function assignCodes(lengths, maxBits) {
  const counts = new Uint16Array(maxBits + 1);
  for (const l of lengths) if (l) counts[l] = counts[l] + 1;
  const nextCode = new Uint16Array(maxBits + 2);
  let code = 0;
  for (let bits = 1; bits <= maxBits; bits++) {
    code = code + counts[bits - 1] << 1;
    nextCode[bits] = code;
  }
  const codes = new Uint16Array(lengths.length);
  for (let i = 0; i < lengths.length; i++) {
    const l = lengths[i];
    if (!l) continue;
    const c = nextCode[l];
    nextCode[l] = c + 1;
    let rev = 0;
    for (let b = 0; b < l; b++) rev |= (c >> l - 1 - b & 1) << b;
    codes[i] = rev;
  }
  return codes;
}
function packCodeLengths(all) {
  const syms = [];
  const extra = [];
  const freqs = new Uint32Array(19);
  const push = (s, e = 0, eb = 0) => {
    syms.push(s);
    extra.push(e | eb << 8);
    freqs[s] = freqs[s] + 1;
  };
  for (let i = 0; i < all.length; ) {
    const value = all[i];
    let run = 1;
    while (i + run < all.length && all[i + run] === value) run++;
    if (value === 0) {
      while (run >= 3) {
        const n = Math.min(run, 138);
        if (n <= 10) push(17, n - 3, 3);
        else push(18, n - 11, 7);
        i += n;
        run -= n;
      }
    } else {
      push(value);
      i++;
      run--;
      while (run >= 3) {
        const n = Math.min(run, 6);
        push(16, n - 3, 2);
        i += n;
        run -= n;
      }
    }
    for (let r = 0; r < run; r++) {
      push(value);
      i++;
    }
  }
  return { syms, extra, freqs };
}
function emitStored(bw, data, from, to, final) {
  bw.write(final ? 1 : 0, 1);
  bw.write(0, 2);
  bw.alignToByte();
  const len = to - from;
  bw.write(len & 255, 8);
  bw.write(len >> 8 & 255, 8);
  bw.write(~len & 255, 8);
  bw.write(~len >> 8 & 255, 8);
  bw.writeBytes(data.subarray(from, to));
}
function planDynamic(block) {
  const litFreq = new Uint32Array(286);
  const distFreq = new Uint32Array(30);
  litFreq[256] = 1;
  for (let i = 0; i < block.count; i++) {
    const d = block.dists[i];
    if (d === 0) {
      const l = block.lits[i];
      litFreq[l] = litFreq[l] + 1;
    } else {
      const lc = lenCode(block.lits[i]);
      litFreq[257 + lc] = litFreq[257 + lc] + 1;
      const dc = distCode(d);
      distFreq[dc] = distFreq[dc] + 1;
    }
  }
  const lit = buildCodes(litFreq, 15);
  const dist = buildCodes(distFreq, 15);
  let hlit = 286;
  while (hlit > 257 && lit.lengths[hlit - 1] === 0) hlit--;
  let hdist = 30;
  while (hdist > 1 && dist.lengths[hdist - 1] === 0) hdist--;
  const all = new Uint8Array(hlit + hdist);
  all.set(lit.lengths.subarray(0, hlit), 0);
  all.set(dist.lengths.subarray(0, hdist), hlit);
  const packed = packCodeLengths(all);
  const clen = buildCodes(packed.freqs, 7);
  let hclen = 19;
  while (hclen > 4 && clen.lengths[CLEN_ORDER[hclen - 1]] === 0) hclen--;
  let bits = 3 + 5 + 5 + 4 + hclen * 3;
  for (let i = 0; i < packed.syms.length; i++) {
    const sym = packed.syms[i];
    bits += clen.lengths[sym] + (packed.extra[i] >> 8);
  }
  for (let i = 0; i < 286; i++) if (litFreq[i]) bits += litFreq[i] * lit.lengths[i];
  for (let i = 0; i < 30; i++) if (distFreq[i]) bits += distFreq[i] * dist.lengths[i];
  for (let i = 0; i < block.count; i++) {
    if (block.dists[i] === 0) continue;
    bits += LEN_EXTRA[lenCode(block.lits[i])] + DIST_EXTRA[distCode(block.dists[i])];
  }
  return { lit, dist, clen, packed, hlit, hdist, hclen, bits };
}
function fixedCost(block) {
  let bits = 3 + 7;
  for (let i = 0; i < block.count; i++) {
    const d = block.dists[i];
    if (d === 0) {
      const l = block.lits[i];
      bits += l < 144 ? 8 : l < 256 ? 9 : 0;
    } else {
      const lc = lenCode(block.lits[i]);
      bits += (257 + lc < 280 ? 7 : 8) + LEN_EXTRA[lc];
      bits += 5 + DIST_EXTRA[distCode(d)];
    }
  }
  return bits;
}
function emitSymbols(bw, block, lit, dist) {
  for (let i = 0; i < block.count; i++) {
    const d = block.dists[i];
    if (d === 0) {
      const l = block.lits[i];
      bw.writeCode(lit.codes[l], lit.lengths[l]);
    } else {
      const len = block.lits[i];
      const lc = lenCode(len);
      bw.writeCode(lit.codes[257 + lc], lit.lengths[257 + lc]);
      if (LEN_EXTRA[lc]) bw.write(len - LEN_BASE[lc], LEN_EXTRA[lc]);
      const dc = distCode(d);
      bw.writeCode(dist.codes[dc], dist.lengths[dc]);
      if (DIST_EXTRA[dc]) bw.write(d - DIST_BASE[dc], DIST_EXTRA[dc]);
    }
  }
  bw.writeCode(lit.codes[256], lit.lengths[256]);
}
function emitDynamic(bw, block, plan, final) {
  bw.write(final ? 1 : 0, 1);
  bw.write(2, 2);
  bw.write(plan.hlit - 257, 5);
  bw.write(plan.hdist - 1, 5);
  bw.write(plan.hclen - 4, 4);
  for (let i = 0; i < plan.hclen; i++) bw.write(plan.clen.lengths[CLEN_ORDER[i]], 3);
  for (let i = 0; i < plan.packed.syms.length; i++) {
    const sym = plan.packed.syms[i];
    bw.writeCode(plan.clen.codes[sym], plan.clen.lengths[sym]);
    const e = plan.packed.extra[i];
    const bits = e >> 8;
    if (bits) bw.write(e & 255, bits);
  }
  emitSymbols(bw, block, plan.lit, plan.dist);
}
var FIXED = null;
function fixedCodes() {
  if (!FIXED) {
    const ll = new Uint8Array(288);
    ll.fill(8, 0, 144);
    ll.fill(9, 144, 256);
    ll.fill(7, 256, 280);
    ll.fill(8, 280, 288);
    const dl = new Uint8Array(30).fill(5);
    FIXED = {
      lit: { lengths: ll, codes: assignCodes(ll, 15) },
      dist: { lengths: dl, codes: assignCodes(dl, 15) }
    };
  }
  return FIXED;
}
function emitFixed(bw, block, final) {
  bw.write(final ? 1 : 0, 1);
  bw.write(1, 2);
  const { lit, dist } = fixedCodes();
  emitSymbols(bw, block, lit, dist);
}
function deflateRaw(data, level = 6) {
  const bw = new BitWriter();
  if (data.length === 0) {
    bw.write(1, 1);
    bw.write(1, 2);
    bw.writeCode(0, 7);
    return bw.result();
  }
  const lvl = Math.max(0, Math.min(9, level | 0));
  if (lvl === 0) {
    for (let i2 = 0; i2 < data.length; i2 += 65535) {
      const end = Math.min(i2 + 65535, data.length);
      emitStored(bw, data, i2, end, end === data.length);
    }
    return bw.result();
  }
  const chain = CHAIN[lvl];
  const nice = NICE[lvl];
  const good = GOOD[lvl];
  const head = new Int32Array(HASH_SIZE).fill(-1);
  const prev = new Int32Array(data.length).fill(-1);
  const BLOCK = 1 << 14;
  const CHECK_EVERY = 1 << 12;
  const lits = new Uint16Array(BLOCK);
  const dists = new Uint16Array(BLOCK);
  let n = 0;
  let blockStart = 0;
  const histAll = new Uint32Array(16);
  const histRecent = new Uint32Array(16);
  let sinceCheck = 0;
  const bucketOf = (lit, dist) => dist === 0 ? lit >> 4 & 15 : 8 + (lenCode(lit) >> 2);
  const drifted = () => {
    let totalAll = 0, totalRecent = 0;
    for (let b = 0; b < 16; b++) {
      totalAll += histAll[b];
      totalRecent += histRecent[b];
    }
    if (totalRecent === 0 || totalAll === totalRecent) return false;
    let diff = 0;
    for (let b = 0; b < 16; b++) {
      const a = Math.round(histAll[b] * 1e3 / totalAll);
      const r = Math.round(histRecent[b] * 1e3 / totalRecent);
      diff += Math.abs(a - r);
    }
    return diff > 600;
  };
  const hashAt = (i2) => (data[i2] << 10 ^ data[i2 + 1] << 5 ^ data[i2 + 2]) & HASH_SIZE - 1;
  const flush = (final, pos) => {
    const block = { lits, dists, count: n };
    const plan = planDynamic(block);
    const dynBits = plan.bits;
    const fixBits = fixedCost(block);
    const rawBits = (pos - blockStart + 5) * 8;
    if (rawBits <= dynBits && rawBits <= fixBits) emitStored(bw, data, blockStart, pos, final);
    else if (fixBits <= dynBits) emitFixed(bw, block, final);
    else emitDynamic(bw, block, plan, final);
    n = 0;
    blockStart = pos;
    histAll.fill(0);
    histRecent.fill(0);
    sinceCheck = 0;
  };
  const findMatch = (at, startLen) => {
    let bestLen = startLen, bestDist = 0;
    if (at + MIN_MATCH > data.length) return { len: 0, dist: 0 };
    const h = hashAt(at);
    let candidate = head[h];
    let depth = chain;
    const limit = Math.max(0, at - WINDOW);
    const max = Math.min(MAX_MATCH, data.length - at);
    while (candidate >= limit && candidate >= 0 && depth-- > 0) {
      if (data[candidate + bestLen] === data[at + bestLen] && (bestLen === 0 || data[candidate + bestLen - 1] === data[at + bestLen - 1])) {
        let l = 0;
        while (l < max && data[candidate + l] === data[at + l]) l++;
        if (l > bestLen) {
          bestLen = l;
          bestDist = at - candidate;
          if (l >= nice) break;
          if (l >= good) depth >>= 2;
        }
      }
      candidate = prev[candidate];
    }
    prev[at] = head[h];
    head[h] = at;
    return bestDist === 0 ? { len: 0, dist: 0 } : { len: bestLen, dist: bestDist };
  };
  let i = 0;
  while (i < data.length) {
    const { len: bestLen, dist: bestDist } = findMatch(i, MIN_MATCH - 1);
    if (bestLen >= MIN_MATCH) {
      lits[n] = bestLen;
      dists[n] = bestDist;
      n++;
      for (let k = 1; k < bestLen; k++) {
        const j = i + k;
        if (j + MIN_MATCH <= data.length) {
          const h = hashAt(j);
          prev[j] = head[h];
          head[h] = j;
        }
      }
      i += bestLen;
    } else {
      lits[n] = data[i];
      dists[n] = 0;
      n++;
      i++;
    }
    const bucket = bucketOf(lits[n - 1], dists[n - 1]);
    histAll[bucket] = histAll[bucket] + 1;
    histRecent[bucket] = histRecent[bucket] + 1;
    if (n === BLOCK) {
      flush(false, i);
    } else if (++sinceCheck >= CHECK_EVERY) {
      if (n > CHECK_EVERY && drifted()) flush(false, i);
      else {
        histRecent.fill(0);
        sinceCheck = 0;
      }
    }
  }
  flush(true, data.length);
  return bw.result();
}

// src/daefl/inflate.ts
var LEN_BASE2 = new Uint16Array([
  3,
  4,
  5,
  6,
  7,
  8,
  9,
  10,
  11,
  13,
  15,
  17,
  19,
  23,
  27,
  31,
  35,
  43,
  51,
  59,
  67,
  83,
  99,
  115,
  131,
  163,
  195,
  227,
  258
]);
var LEN_EXTRA2 = new Uint8Array([
  0,
  0,
  0,
  0,
  0,
  0,
  0,
  0,
  1,
  1,
  1,
  1,
  2,
  2,
  2,
  2,
  3,
  3,
  3,
  3,
  4,
  4,
  4,
  4,
  5,
  5,
  5,
  5,
  0
]);
var DIST_BASE2 = new Uint16Array([
  1,
  2,
  3,
  4,
  5,
  7,
  9,
  13,
  17,
  25,
  33,
  49,
  65,
  97,
  129,
  193,
  257,
  385,
  513,
  769,
  1025,
  1537,
  2049,
  3073,
  4097,
  6145,
  8193,
  12289,
  16385,
  24577
]);
var DIST_EXTRA2 = new Uint8Array([
  0,
  0,
  0,
  0,
  1,
  1,
  2,
  2,
  3,
  3,
  4,
  4,
  5,
  5,
  6,
  6,
  7,
  7,
  8,
  8,
  9,
  9,
  10,
  10,
  11,
  11,
  12,
  12,
  13,
  13
]);
var CLEN_ORDER2 = new Uint8Array([16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15]);
var InflateError = class extends Error {
};
var fail = (msg) => {
  throw new InflateError(`daefl: ${msg}`);
};
var FAST_BITS = 9;
var FAST_SIZE = 1 << FAST_BITS;
var FAST_MASK = FAST_SIZE - 1;
function buildHuff(lengths, n) {
  const counts = new Uint16Array(16);
  for (let i = 0; i < n; i++) {
    const l = lengths[i];
    counts[l] = counts[l] + 1;
  }
  counts[0] = 0;
  let max = 0;
  for (let i = 1; i < 16; i++) if (counts[i] > 0) max = i;
  let left = 1;
  for (let i = 1; i < 16; i++) {
    left <<= 1;
    left -= counts[i];
    if (left < 0) fail("over-subscribed Huffman code");
  }
  const offs = new Uint16Array(16);
  for (let i = 1; i < 15; i++) offs[i + 1] = offs[i] + counts[i];
  const symbols = new Uint16Array(n);
  for (let i = 0; i < n; i++) {
    const l = lengths[i];
    if (l) {
      symbols[offs[l]] = i;
      offs[l] = offs[l] + 1;
    }
  }
  const fast = new Int32Array(FAST_SIZE).fill(-1);
  let code = 0;
  const next = new Uint16Array(16);
  for (let len = 1; len <= 15; len++) {
    next[len] = code;
    code = code + counts[len] << 1;
  }
  let idx = 0;
  for (let len = 1; len <= Math.min(max, FAST_BITS); len++) {
    for (let k = 0; k < counts[len]; k++) {
      const sym = symbols[idx + k];
      const c = next[len] + k;
      let rev = 0;
      for (let b = 0; b < len; b++) rev |= (c >> len - 1 - b & 1) << b;
      const entry = len << 16 | sym;
      for (let fill = rev; fill < FAST_SIZE; fill += 1 << len) fast[fill] = entry;
    }
    idx += counts[len];
  }
  return { counts, symbols, fast, max };
}
var BitReader = class {
  constructor(src) {
    this.src = src;
  }
  src;
  pos = 0;
  acc = 0;
  nbits = 0;
  // Keeps at least `need` bits buffered. Capped at 16 per call so `acc` never
  // reaches bit 31, where the sign would leak into the mask below.
  refill(need) {
    while (this.nbits < need) {
      if (this.pos >= this.src.length) fail("unexpected end of stream");
      this.acc |= this.src[this.pos++] << this.nbits;
      this.nbits += 8;
    }
  }
  // Same, but tolerates running out: decoding a short final code only needs
  // the bits that exist, and the length check afterwards catches a real
  // truncation.
  refillSoft(need) {
    while (this.nbits < need && this.pos < this.src.length) {
      this.acc |= this.src[this.pos++] << this.nbits;
      this.nbits += 8;
    }
  }
  bits(n) {
    if (n === 0) return 0;
    this.refill(n);
    const v = this.acc & (1 << n) - 1;
    this.acc >>>= n;
    this.nbits -= n;
    return v;
  }
  symbol(h) {
    this.refillSoft(FAST_BITS);
    const entry = h.fast[this.acc & FAST_MASK];
    if (entry >= 0) {
      const len = entry >>> 16;
      if (len > this.nbits) fail("unexpected end of stream");
      this.acc >>>= len;
      this.nbits -= len;
      return entry & 65535;
    }
    return this.slowSymbol(h);
  }
  // Codes longer than the fast table walk RFC 1951's canonical algorithm,
  // tracking the first code and first symbol index at each length.
  slowSymbol(h) {
    let code = 0, first = 0, index = 0;
    for (let len = 1; len <= h.max; len++) {
      code |= this.bits(1);
      const count = h.counts[len];
      if (code - first < count) return h.symbols[index + (code - first)];
      index += count;
      first = first + count << 1;
      code <<= 1;
    }
    return fail("invalid Huffman symbol");
  }
  alignToByte() {
    const drop = this.nbits & 7;
    this.acc >>>= drop;
    this.nbits -= drop;
  }
  // Whole buffered bytes have been read from `src` but not consumed, so they
  // come back off the position.
  get offset() {
    return this.pos - (this.nbits >> 3);
  }
  takeBytes(n) {
    this.alignToByte();
    const start = this.pos - (this.nbits >> 3);
    this.acc = 0;
    this.nbits = 0;
    if (start + n > this.src.length) fail("unexpected end of stored block");
    this.pos = start + n;
    return this.src.subarray(start, start + n);
  }
};
var Sink = class {
  buf;
  len = 0;
  fixed;
  constructor(cap, hint) {
    this.fixed = cap !== void 0;
    this.buf = cap ?? new Uint8Array(Math.max(hint, 64));
  }
  room(n) {
    if (this.len + n <= this.buf.length) return;
    if (this.fixed) fail("output exceeds the provided buffer");
    let size = this.buf.length;
    while (size < this.len + n) size *= 2;
    const next = new Uint8Array(size);
    next.set(this.buf.subarray(0, this.len));
    this.buf = next;
  }
  push(b) {
    this.room(1);
    this.buf[this.len++] = b;
  }
  pushBytes(src) {
    this.room(src.length);
    this.buf.set(src, this.len);
    this.len += src.length;
  }
  // Overlapping copies are the normal case in LZ77 (a run of one byte is
  // encoded as distance 1, length n), so this must copy byte by byte forward.
  copyBack(dist, len) {
    if (dist > this.len) fail("distance beyond start of output");
    this.room(len);
    let from = this.len - dist;
    for (let i = 0; i < len; i++) this.buf[this.len++] = this.buf[from++];
  }
  result() {
    return this.len === this.buf.length ? this.buf : this.buf.subarray(0, this.len);
  }
};
var FIXED_LIT = null;
var FIXED_DIST = null;
function fixedTables() {
  if (!FIXED_LIT || !FIXED_DIST) {
    const lit = new Uint8Array(288);
    lit.fill(8, 0, 144);
    lit.fill(9, 144, 256);
    lit.fill(7, 256, 280);
    lit.fill(8, 280, 288);
    FIXED_LIT = buildHuff(lit, 288);
    FIXED_DIST = buildHuff(new Uint8Array(30).fill(5), 30);
  }
  return [FIXED_LIT, FIXED_DIST];
}
function readDynamicTables(br) {
  const hlit = br.bits(5) + 257;
  const hdist = br.bits(5) + 1;
  const hclen = br.bits(4) + 4;
  const clens = new Uint8Array(19);
  for (let i = 0; i < hclen; i++) clens[CLEN_ORDER2[i]] = br.bits(3);
  const clenHuff = buildHuff(clens, 19);
  const lengths = new Uint8Array(hlit + hdist);
  for (let i = 0; i < hlit + hdist; ) {
    const sym = br.symbol(clenHuff);
    if (sym < 16) {
      lengths[i++] = sym;
      continue;
    }
    let repeat, value = 0;
    if (sym === 16) {
      if (i === 0) fail("repeat with no previous code length");
      value = lengths[i - 1];
      repeat = 3 + br.bits(2);
    } else if (sym === 17) {
      repeat = 3 + br.bits(3);
    } else {
      repeat = 11 + br.bits(7);
    }
    if (i + repeat > hlit + hdist) fail("code length repeat overflows the table");
    for (let r = 0; r < repeat; r++) lengths[i++] = value;
  }
  return [buildHuff(lengths.subarray(0, hlit), hlit), buildHuff(lengths.subarray(hlit), hdist)];
}
function inflateRawWithEnd(src, out, sizeHint = 0) {
  const br = new BitReader(src);
  const sink = new Sink(out, sizeHint || src.length * 4);
  for (; ; ) {
    const final = br.bits(1);
    const type = br.bits(2);
    if (type === 0) {
      br.alignToByte();
      const len = br.bits(16);
      const nlen = br.bits(16);
      if ((len ^ 65535) !== nlen) fail("stored block length check failed");
      sink.pushBytes(br.takeBytes(len));
    } else if (type === 1 || type === 2) {
      const [lit, dist] = type === 1 ? fixedTables() : readDynamicTables(br);
      for (; ; ) {
        const sym = br.symbol(lit);
        if (sym < 256) {
          sink.push(sym);
          continue;
        }
        if (sym === 256) break;
        const li = sym - 257;
        if (li >= LEN_BASE2.length) fail("invalid length symbol");
        const length = LEN_BASE2[li] + br.bits(LEN_EXTRA2[li]);
        const dsym = br.symbol(dist);
        if (dsym >= DIST_BASE2.length) fail("invalid distance symbol");
        const distance = DIST_BASE2[dsym] + br.bits(DIST_EXTRA2[dsym]);
        sink.copyBack(distance, length);
      }
    } else {
      fail("reserved block type");
    }
    if (final) break;
  }
  br.alignToByte();
  return { bytes: sink.result(), end: br.offset };
}

// src/daefl/index.ts
function adler32(data) {
  let a = 1, b = 0;
  let i = 0;
  const n = data.length;
  while (i < n) {
    const end = Math.min(i + 5552, n);
    const blocks = end - (end - i) % 16;
    for (; i < blocks; i += 16) {
      a += data[i];
      b += a;
      a += data[i + 1];
      b += a;
      a += data[i + 2];
      b += a;
      a += data[i + 3];
      b += a;
      a += data[i + 4];
      b += a;
      a += data[i + 5];
      b += a;
      a += data[i + 6];
      b += a;
      a += data[i + 7];
      b += a;
      a += data[i + 8];
      b += a;
      a += data[i + 9];
      b += a;
      a += data[i + 10];
      b += a;
      a += data[i + 11];
      b += a;
      a += data[i + 12];
      b += a;
      a += data[i + 13];
      b += a;
      a += data[i + 14];
      b += a;
      a += data[i + 15];
      b += a;
    }
    for (; i < end; i++) {
      a += data[i];
      b += a;
    }
    a %= 65521;
    b %= 65521;
  }
  return (b << 16 | a) >>> 0;
}
function zlib(data, level = 6) {
  const body = deflateRaw(data, level);
  const out = new Uint8Array(body.length + 6);
  const cmf = 120;
  let flg = (level >= 7 ? 3 : level >= 6 ? 2 : level >= 2 ? 1 : 0) << 6;
  flg |= 31 - (cmf << 8 | flg) % 31;
  out[0] = cmf;
  out[1] = flg;
  out.set(body, 2);
  const sum = adler32(data);
  out[body.length + 2] = sum >>> 24 & 255;
  out[body.length + 3] = sum >>> 16 & 255;
  out[body.length + 4] = sum >>> 8 & 255;
  out[body.length + 5] = sum & 255;
  return out;
}
function unzlib(data, out) {
  if (data.length < 2) throw new InflateError("daefl: stream too short for a zlib header");
  const cmf = data[0];
  const flg = data[1];
  if ((cmf & 15) !== 8) throw new InflateError("daefl: not deflate-compressed");
  if ((cmf << 8 | flg) % 31 !== 0) throw new InflateError("daefl: bad zlib header check");
  if (flg & 32) throw new InflateError("daefl: preset dictionaries are not supported");
  const { bytes: bytes2, end } = inflateRawWithEnd(data.subarray(2), out, out?.length ?? 0);
  const trailer = 2 + end;
  if (trailer + 4 <= data.length) {
    const want = (data[trailer] << 24 | data[trailer + 1] << 16 | data[trailer + 2] << 8 | data[trailer + 3]) >>> 0;
    if (adler32(bytes2) !== want) throw new InflateError("daefl: adler32 mismatch");
  }
  return bytes2;
}

// src/pdf_doc/deflate.ts
var deflate = (bytes2) => zlib(bytes2, 6);

// src/images/pngchunks.ts
function forEachChunk(b, visit) {
  if (b.length < 33 || b[12] !== 73 || b[13] !== 72 || b[14] !== 68 || b[15] !== 82) return;
  const u32 = (o) => (b[o] << 24 | b[o + 1] << 16 | b[o + 2] << 8 | b[o + 3]) >>> 0;
  const ihdrLen = u32(8);
  let pos = 8 + 4 + 4 + ihdrLen + 4;
  while (pos + 8 <= b.length) {
    const clen = u32(pos);
    const type = String.fromCharCode(b[pos + 4], b[pos + 5], b[pos + 6], b[pos + 7]);
    const dend = pos + 8 + clen;
    if (dend > b.length) return;
    if (visit(type, b.subarray(pos + 8, dend))) return;
    pos = dend + 4;
  }
}

// src/images/sniff.ts
function sniffFormat(b) {
  if (b.length >= 2 && b[0] === 255 && b[1] === 216) return "jpeg";
  if (b.length >= 8 && b[0] === 137 && b[1] === 80 && b[2] === 78 && b[3] === 71) return "png";
  if (b.length >= 4 && (b[0] === 73 && b[1] === 73 && b[2] === 42 && b[3] === 0 || b[0] === 77 && b[1] === 77 && b[2] === 0 && b[3] === 42)) return "tiff";
  if (b.length >= 4 && b[0] === 71 && b[1] === 73 && b[2] === 70 && b[3] === 56) return "gif";
  if (b.length >= 2 && b[0] === 66 && b[1] === 77) return "bmp";
  if (b.length >= 4 && b[0] === 0 && b[1] === 0 && b[2] === 1 && b[3] === 0) return "ico";
  const tag = (o) => o + 4 <= b.length ? String.fromCharCode(b[o], b[o + 1], b[o + 2], b[o + 3]) : "";
  if (b.length >= 12 && tag(0) === "RIFF" && tag(8) === "WEBP") return "webp";
  if (b.length >= 12 && tag(4) === "ftyp") {
    if (tag(8) === "avif" || tag(8) === "avis") return "avif";
    const boxSize = b.length >= 4 ? (b[0] << 24 | b[1] << 16 | b[2] << 8 | b[3]) >>> 0 : 0;
    const end = boxSize > 0 ? Math.min(boxSize, b.length) : b.length;
    for (let o = 16; o + 4 <= end; o += 4) {
      if (tag(o) === "avif" || tag(o) === "avis") return "avif";
    }
  }
  return "unknown";
}
function pngNeedsBrowserDecode(b) {
  if (b.length < 33) return false;
  if (b[12] !== 73 || b[13] !== 72 || b[14] !== 68 || b[15] !== 82) return false;
  const bpc = b[24], ct = b[25], interlace = b[28];
  if (interlace !== 0 || bpc !== 8) return true;
  if (ct !== 0 && ct !== 2 && ct !== 3 && ct !== 4 && ct !== 6) return true;
  return ct !== 3 && hasTrnsChunk(b);
}
function hasTrnsChunk(b) {
  let found = false;
  forEachChunk(b, (type) => {
    if (type === "tRNS") {
      found = true;
      return true;
    }
    return type === "IDAT" || type === "IEND";
  });
  return found;
}

// src/images/parse.ts
function parseImage(bytes2) {
  if (bytes2.length >= 2 && bytes2[0] === 255 && bytes2[1] === 216) return parseJpeg(bytes2);
  return parsePng(bytes2);
}
function matchAscii(b, o, s) {
  if (o + s.length > b.length) return false;
  for (let k = 0; k < s.length; k++) if (b[o + k] !== s.charCodeAt(k)) return false;
  return true;
}
function isSofMarker(m) {
  return m === 192 || m === 193 || m === 194 || m === 195 || m === 197 || m === 198 || m === 199 || m === 201 || m === 202 || m === 203 || m === 205 || m === 206 || m === 207;
}
function exifOrientation(tiff) {
  let le;
  if (tiff.length >= 2 && tiff[0] === 73 && tiff[1] === 73) le = true;
  else if (tiff.length >= 2 && tiff[0] === 77 && tiff[1] === 77) le = false;
  else return null;
  const u16 = (o) => {
    if (o + 2 > tiff.length) return null;
    return le ? tiff[o] | tiff[o + 1] << 8 : tiff[o] << 8 | tiff[o + 1];
  };
  const u32 = (o) => {
    if (o + 4 > tiff.length) return null;
    const b0 = tiff[o], b1 = tiff[o + 1], b2 = tiff[o + 2], b3 = tiff[o + 3];
    return le ? (b3 << 24 | b2 << 16 | b1 << 8 | b0) >>> 0 : (b0 << 24 | b1 << 16 | b2 << 8 | b3) >>> 0;
  };
  if (u16(2) !== 42) return null;
  const ifd0 = u32(4);
  if (ifd0 === null) return null;
  const count = u16(ifd0);
  if (count === null) return null;
  for (let e = 0; e < Math.min(count, 512); e++) {
    const entry = ifd0 + 2 + e * 12;
    const tag = u16(entry);
    if (tag === null) return null;
    if (tag === 274) {
      const v = u16(entry + 8);
      return v !== null && v >= 1 && v <= 8 ? v : null;
    }
  }
  return null;
}
function parseJpeg(bytes2) {
  const dims = parseJpegDims(bytes2);
  if (!dims) return null;
  return {
    width: dims.width,
    height: dims.height,
    colorSpace: dims.colorSpace,
    data: bytes2,
    smask: null,
    isJpeg: true,
    decodeInvert: dims.invert,
    orientation: dims.orientation
  };
}
function parseJpegDims(bytes2) {
  if (bytes2.length < 4 || bytes2[0] !== 255 || bytes2[1] !== 216) return null;
  let i = 2;
  let adobe = false;
  let orientation = 1;
  while (i + 3 < bytes2.length) {
    if (bytes2[i] !== 255) return null;
    while (i + 1 < bytes2.length && bytes2[i + 1] === 255) i++;
    if (i + 3 >= bytes2.length) return null;
    const marker = bytes2[i + 1];
    i += 2;
    if (marker === 217 || marker >= 208 && marker <= 215 || marker === 1) continue;
    if (i + 1 >= bytes2.length) return null;
    const segLen = bytes2[i] << 8 | bytes2[i + 1];
    if (segLen < 2) return null;
    if (marker === 238 && matchAscii(bytes2, i + 2, "Adobe")) adobe = true;
    if (marker === 225 && segLen >= 8 && matchAscii(bytes2, i + 2, "Exif\0\0")) {
      const o = exifOrientation(bytes2.subarray(i + 8, Math.min(i + segLen, bytes2.length)));
      if (o !== null) orientation = o;
    }
    if (isSofMarker(marker) && i + 8 < bytes2.length) {
      const h = bytes2[i + 3] << 8 | bytes2[i + 4];
      const w = bytes2[i + 5] << 8 | bytes2[i + 6];
      const csByte = bytes2[i + 7];
      const colorSpace = csByte === 1 ? "DeviceGray" : csByte === 4 ? "DeviceCMYK" : "DeviceRGB";
      return { width: w, height: h, colorSpace, invert: adobe && colorSpace === "DeviceCMYK", orientation };
    }
    if (i + segLen > bytes2.length) return null;
    i += segLen;
  }
  return null;
}
function paethPredictor(a, b, c) {
  const p = a + b - c;
  const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  if (pb <= pc) return b;
  return c;
}
function readPlteChunk(b) {
  let out = null;
  forEachChunk(b, (type, data) => {
    if (type === "PLTE") {
      if (data.length % 3 !== 0) {
        out = null;
        return true;
      }
      const entries = [];
      for (let o = 0; o < data.length; o += 3) entries.push(data.subarray(o, o + 3));
      out = entries;
      return true;
    }
    return type === "IDAT" || type === "IEND";
  });
  return out;
}
function readTrnsIndexed(b) {
  let out = null;
  forEachChunk(b, (type, data) => {
    if (type === "tRNS") {
      out = data;
      return true;
    }
    return type === "IDAT" || type === "IEND";
  });
  return out;
}
function collectIdat(b) {
  const parts = [];
  forEachChunk(b, (type, data) => {
    if (type === "IDAT") parts.push(data);
    return type === "IEND";
  });
  if (!parts.length) return null;
  let total = 0;
  for (const p of parts) total += p.length;
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
}
function parsePng(bytes2) {
  const SIG = [137, 80, 78, 71, 13, 10, 26, 10];
  if (bytes2.length < 33) return null;
  for (let k = 0; k < 8; k++) if (bytes2[k] !== SIG[k]) return null;
  if (!(bytes2[12] === 73 && bytes2[13] === 72 && bytes2[14] === 68 && bytes2[15] === 82)) return null;
  const u32 = (o) => (bytes2[o] << 24 | bytes2[o + 1] << 16 | bytes2[o + 2] << 8 | bytes2[o + 3]) >>> 0;
  const w = u32(16);
  const h = u32(20);
  if (w === 0 || h === 0) return null;
  const bpc = bytes2[24];
  const ct = bytes2[25];
  if (bytes2[28] !== 0) return null;
  if (bpc !== 8) return null;
  let chIn, chOut, colorSpace, hasAlpha;
  if (ct === 0) {
    chIn = 1;
    chOut = 1;
    colorSpace = "DeviceGray";
    hasAlpha = false;
  } else if (ct === 2) {
    chIn = 3;
    chOut = 3;
    colorSpace = "DeviceRGB";
    hasAlpha = false;
  } else if (ct === 3) {
    chIn = 1;
    chOut = 3;
    colorSpace = "DeviceRGB";
    hasAlpha = false;
  } else if (ct === 4) {
    chIn = 2;
    chOut = 1;
    colorSpace = "DeviceGray";
    hasAlpha = true;
  } else if (ct === 6) {
    chIn = 4;
    chOut = 3;
    colorSpace = "DeviceRGB";
    hasAlpha = true;
  } else return null;
  if (ct !== 3 && hasTrnsChunk(bytes2)) return null;
  let paletteRgb = null;
  let paletteAlpha = null;
  if (ct === 3) {
    paletteRgb = readPlteChunk(bytes2);
    if (!paletteRgb || !paletteRgb.length) return null;
    paletteAlpha = new Uint8Array(paletteRgb.length).fill(255);
    const trns = readTrnsIndexed(bytes2);
    if (trns) {
      hasAlpha = false;
      for (let idx = 0; idx < trns.length; idx++) {
        if (trns[idx] !== 255) hasAlpha = true;
        if (idx < paletteAlpha.length) paletteAlpha[idx] = trns[idx];
      }
    }
  }
  const idat = collectIdat(bytes2);
  if (!idat || !idat.length) return null;
  const stride = w * chIn;
  const rowLen = stride + 1;
  const needed = h * rowLen;
  const MAX_DECODED_BYTES = 512 * 1024 * 1024;
  if (needed > MAX_DECODED_BYTES || w * h * chOut > MAX_DECODED_BYTES) return null;
  let raw;
  try {
    raw = unzlib(idat, new Uint8Array(needed));
  } catch {
    return null;
  }
  if (raw.length < needed) return null;
  const pixels = new Uint8Array(w * h * chOut);
  let pixelsOff = 0;
  const smask = hasAlpha ? new Uint8Array(w * h) : null;
  let smaskOff = 0;
  let prev = new Uint8Array(stride);
  let row = new Uint8Array(stride);
  for (let r = 0; r < h; r++) {
    const base = r * rowLen;
    const ft = raw[base];
    const src = raw.subarray(base + 1, base + 1 + stride);
    if (ft === 0) {
      row.set(src);
    } else if (ft === 1) {
      for (let j = 0; j < stride; j++) {
        const a = j >= chIn ? row[j - chIn] : 0;
        row[j] = src[j] + a & 255;
      }
    } else if (ft === 2) {
      for (let j = 0; j < stride; j++) row[j] = src[j] + prev[j] & 255;
    } else if (ft === 3) {
      for (let j = 0; j < stride; j++) {
        const a = j >= chIn ? row[j - chIn] : 0;
        row[j] = src[j] + (a + prev[j] >> 1) & 255;
      }
    } else if (ft === 4) {
      for (let j = 0; j < stride; j++) {
        const a = j >= chIn ? row[j - chIn] : 0;
        const c = j >= chIn ? prev[j - chIn] : 0;
        row[j] = src[j] + paethPredictor(a, prev[j], c) & 255;
      }
    } else {
      row.set(src);
    }
    if (paletteRgb) {
      for (let j = 0; j < stride; j++) {
        const idx = row[j];
        if (idx >= paletteRgb.length) return null;
        const rgb = paletteRgb[idx];
        pixels[pixelsOff++] = rgb[0];
        pixels[pixelsOff++] = rgb[1];
        pixels[pixelsOff++] = rgb[2];
        if (smask) smask[smaskOff++] = paletteAlpha[idx];
      }
    } else if (chIn !== chOut) {
      for (let j = 0; j < stride; j += chIn) {
        for (let k = 0; k < chOut; k++) pixels[pixelsOff++] = row[j + k];
        if (smask) smask[smaskOff++] = row[j + chIn - 1];
      }
    } else {
      pixels.set(row, pixelsOff);
      pixelsOff += stride;
    }
    const tmp = row;
    row = prev;
    prev = tmp;
  }
  return { width: w, height: h, colorSpace, data: pixels, smask, isJpeg: false, decodeInvert: false, orientation: 1 };
}

// src/pdf_doc/utils.ts
var _te = new TextEncoder();
var PDF_NUMBER_LIMIT = 1e15;
function hpf(n) {
  if (!Number.isFinite(n)) return "0";
  const clamped = n > PDF_NUMBER_LIMIT ? PDF_NUMBER_LIMIT : n < -PDF_NUMBER_LIMIT ? -PDF_NUMBER_LIMIT : n;
  return clamped.toFixed(3).replace(/\.?0+$/, "");
}
function encodeColor(r, g, b, isStroke, prec = 2) {
  const opG = isStroke ? "G" : "g";
  const opC = isStroke ? "RG" : "rg";
  const fmt = (v) => (v / 255).toFixed(prec).replace(/\.?0+$/, "");
  if (r === g && g === b) return `${fmt(r)} ${opG}`;
  return `${fmt(r)} ${fmt(g)} ${fmt(b)} ${opC}`;
}
var NAME_DELIMITERS = "()<>[]{}/%#";
function toPdfName(s) {
  let out = "";
  for (const byte of _te.encode(s)) {
    const c = String.fromCharCode(byte);
    if (byte < 33 || byte > 126 || NAME_DELIMITERS.includes(c)) {
      out += "#" + byte.toString(16).toUpperCase().padStart(2, "0");
    } else {
      out += c;
    }
  }
  return out;
}
function pdfEscape(s) {
  return s.replace(/\\/g, "\\\\").replace(/\(/g, "\\(").replace(/\)/g, "\\)").replace(/\r/g, "\\r").replace(/\n/g, "\\n");
}
function textStringBytes(s) {
  if (/^[\x00-\x7F]*$/.test(s)) return _te.encode(s);
  const out = new Uint8Array(2 + s.length * 2);
  out[0] = 254;
  out[1] = 255;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    out[2 + i * 2] = c >> 8;
    out[3 + i * 2] = c & 255;
  }
  return out;
}
function uriString(s) {
  let out = "";
  for (const b of _te.encode(s)) {
    out += b < 33 || b > 126 ? "%" + b.toString(16).toUpperCase().padStart(2, "0") : String.fromCharCode(b);
  }
  return out;
}
function widthsToPdf(widths) {
  let s = "[";
  for (const [i, [cid, w]] of widths.entries()) {
    if (i > 0) s += " ";
    s += `${cid} [${w}]`;
  }
  return s + "]";
}
function w2ToPdf(entries) {
  let s = "[";
  for (const [i, [cid, w1y, v1x, v1y]] of entries.entries()) {
    if (i > 0) s += " ";
    s += `${cid} [${w1y} ${v1x} ${v1y}]`;
  }
  return s + "]";
}
function bboxToPdf(bbox) {
  return "[" + bbox.join(" ") + "]";
}
function bytesToHex(bytes2) {
  return Array.from(bytes2, (b) => b.toString(16).padStart(2, "0")).join("");
}
function pdfDate() {
  const d = /* @__PURE__ */ new Date();
  const p = (n, w = 2) => n.toString().padStart(w, "0");
  return `D:${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}+00'00'`;
}

// src/pdf_doc/sha2.ts
var H256 = [
  1779033703,
  3144134277,
  1013904242,
  2773480762,
  1359893119,
  2600822924,
  528734635,
  1541459225
];
var K256 = new Uint32Array([
  1116352408,
  1899447441,
  3049323471,
  3921009573,
  961987163,
  1508970993,
  2453635748,
  2870763221,
  3624381080,
  310598401,
  607225278,
  1426881987,
  1925078388,
  2162078206,
  2614888103,
  3248222580,
  3835390401,
  4022224774,
  264347078,
  604807628,
  770255983,
  1249150122,
  1555081692,
  1996064986,
  2554220882,
  2821834349,
  2952996808,
  3210313671,
  3336571891,
  3584528711,
  113926993,
  338241895,
  666307205,
  773529912,
  1294757372,
  1396182291,
  1695183700,
  1986661051,
  2177026350,
  2456956037,
  2730485921,
  2820302411,
  3259730800,
  3345764771,
  3516065817,
  3600352804,
  4094571909,
  275423344,
  430227734,
  506948616,
  659060556,
  883997877,
  958139571,
  1322822218,
  1537002063,
  1747873779,
  1955562222,
  2024104815,
  2227730452,
  2361852424,
  2428436474,
  2756734187,
  3204031479,
  3329325298
]);
function rotr32(x, n) {
  return (x >>> n | x << 32 - n) >>> 0;
}
function sha256(data) {
  const bitLen = BigInt(data.length) * 8n;
  const padLen = (56 - (data.length + 1) % 64 + 64) % 64;
  const msg = new Uint8Array(data.length + 1 + padLen + 8);
  msg.set(data);
  msg[data.length] = 128;
  const lenView = new DataView(msg.buffer, msg.length - 8, 8);
  lenView.setBigUint64(0, bitLen, false);
  let [h0, h1, h2, h3, h4, h5, h6, h7] = H256;
  const w = new Uint32Array(64);
  const view = new DataView(msg.buffer);
  for (let base = 0; base < msg.length; base += 64) {
    for (let t = 0; t < 16; t++) w[t] = view.getUint32(base + t * 4, false);
    for (let t = 16; t < 64; t++) {
      const x15 = w[t - 15], x2 = w[t - 2];
      const s0 = rotr32(x15, 7) ^ rotr32(x15, 18) ^ x15 >>> 3;
      const s1 = rotr32(x2, 17) ^ rotr32(x2, 19) ^ x2 >>> 10;
      w[t] = w[t - 16] + s0 + w[t - 7] + s1 | 0;
    }
    let a = h0, b = h1, c = h2, d = h3, e = h4, f = h5, g = h6, hh = h7;
    for (let t = 0; t < 64; t++) {
      const S1 = rotr32(e, 6) ^ rotr32(e, 11) ^ rotr32(e, 25);
      const ch = e & f ^ ~e & g;
      const t1 = hh + S1 + ch + K256[t] + w[t] | 0;
      const S0 = rotr32(a, 2) ^ rotr32(a, 13) ^ rotr32(a, 22);
      const maj = a & b ^ a & c ^ b & c;
      const t2 = S0 + maj | 0;
      hh = g;
      g = f;
      f = e;
      e = d + t1 | 0;
      d = c;
      c = b;
      b = a;
      a = t1 + t2 | 0;
    }
    h0 = h0 + a | 0;
    h1 = h1 + b | 0;
    h2 = h2 + c | 0;
    h3 = h3 + d | 0;
    h4 = h4 + e | 0;
    h5 = h5 + f | 0;
    h6 = h6 + g | 0;
    h7 = h7 + hh | 0;
  }
  const out = new Uint8Array(32);
  const outView = new DataView(out.buffer);
  for (const [i, v] of [h0, h1, h2, h3, h4, h5, h6, h7].entries()) {
    outView.setUint32(i * 4, v >>> 0, false);
  }
  return out;
}
var MASK64 = (1n << 64n) - 1n;
var H512 = [
  0x6a09e667f3bcc908n,
  0xbb67ae8584caa73bn,
  0x3c6ef372fe94f82bn,
  0xa54ff53a5f1d36f1n,
  0x510e527fade682d1n,
  0x9b05688c2b3e6c1fn,
  0x1f83d9abfb41bd6bn,
  0x5be0cd19137e2179n
];
var H384 = [
  0xcbbb9d5dc1059ed8n,
  0x629a292a367cd507n,
  0x9159015a3070dd17n,
  0x152fecd8f70e5939n,
  0x67332667ffc00b31n,
  0x8eb44a8768581511n,
  0xdb0c2e0d64f98fa7n,
  0x47b5481dbefa4fa4n
];
var K512 = [
  0x428a2f98d728ae22n,
  0x7137449123ef65cdn,
  0xb5c0fbcfec4d3b2fn,
  0xe9b5dba58189dbbcn,
  0x3956c25bf348b538n,
  0x59f111f1b605d019n,
  0x923f82a4af194f9bn,
  0xab1c5ed5da6d8118n,
  0xd807aa98a3030242n,
  0x12835b0145706fben,
  0x243185be4ee4b28cn,
  0x550c7dc3d5ffb4e2n,
  0x72be5d74f27b896fn,
  0x80deb1fe3b1696b1n,
  0x9bdc06a725c71235n,
  0xc19bf174cf692694n,
  0xe49b69c19ef14ad2n,
  0xefbe4786384f25e3n,
  0x0fc19dc68b8cd5b5n,
  0x240ca1cc77ac9c65n,
  0x2de92c6f592b0275n,
  0x4a7484aa6ea6e483n,
  0x5cb0a9dcbd41fbd4n,
  0x76f988da831153b5n,
  0x983e5152ee66dfabn,
  0xa831c66d2db43210n,
  0xb00327c898fb213fn,
  0xbf597fc7beef0ee4n,
  0xc6e00bf33da88fc2n,
  0xd5a79147930aa725n,
  0x06ca6351e003826fn,
  0x142929670a0e6e70n,
  0x27b70a8546d22ffcn,
  0x2e1b21385c26c926n,
  0x4d2c6dfc5ac42aedn,
  0x53380d139d95b3dfn,
  0x650a73548baf63den,
  0x766a0abb3c77b2a8n,
  0x81c2c92e47edaee6n,
  0x92722c851482353bn,
  0xa2bfe8a14cf10364n,
  0xa81a664bbc423001n,
  0xc24b8b70d0f89791n,
  0xc76c51a30654be30n,
  0xd192e819d6ef5218n,
  0xd69906245565a910n,
  0xf40e35855771202an,
  0x106aa07032bbd1b8n,
  0x19a4c116b8d2d0c8n,
  0x1e376c085141ab53n,
  0x2748774cdf8eeb99n,
  0x34b0bcb5e19b48a8n,
  0x391c0cb3c5c95a63n,
  0x4ed8aa4ae3418acbn,
  0x5b9cca4f7763e373n,
  0x682e6ff3d6b2b8a3n,
  0x748f82ee5defb2fcn,
  0x78a5636f43172f60n,
  0x84c87814a1f0ab72n,
  0x8cc702081a6439ecn,
  0x90befffa23631e28n,
  0xa4506cebde82bde9n,
  0xbef9a3f7b2c67915n,
  0xc67178f2e372532bn,
  0xca273eceea26619cn,
  0xd186b8c721c0c207n,
  0xeada7dd6cde0eb1en,
  0xf57d4f7fee6ed178n,
  0x06f067aa72176fban,
  0x0a637dc5a2c898a6n,
  0x113f9804bef90daen,
  0x1b710b35131c471bn,
  0x28db77f523047d84n,
  0x32caab7b40c72493n,
  0x3c9ebe0a15c9bebcn,
  0x431d67c49c100d4cn,
  0x4cc5d4becb3e42b6n,
  0x597f299cfc657e2an,
  0x5fcb6fab3ad6faecn,
  0x6c44198c4a475817n
];
function rotr64(x, n) {
  return (x >> n | x << 64n - n) & MASK64;
}
function sha512Core(data, init) {
  const bitLen = BigInt(data.length) * 8n;
  const padLen = (112 - (data.length + 1) % 128 + 128) % 128;
  const msg = new Uint8Array(data.length + 1 + padLen + 16);
  msg.set(data);
  msg[data.length] = 128;
  const lenView = new DataView(msg.buffer, msg.length - 8, 8);
  lenView.setBigUint64(0, bitLen, false);
  let [h0, h1, h2, h3, h4, h5, h6, h7] = init;
  const w = new Array(80);
  const view = new DataView(msg.buffer);
  for (let base = 0; base < msg.length; base += 128) {
    for (let t = 0; t < 16; t++) w[t] = view.getBigUint64(base + t * 8, false);
    for (let t = 16; t < 80; t++) {
      const x15 = w[t - 15], x2 = w[t - 2];
      const s0 = (rotr64(x15, 1n) ^ rotr64(x15, 8n) ^ x15 >> 7n) & MASK64;
      const s1 = (rotr64(x2, 19n) ^ rotr64(x2, 61n) ^ x2 >> 6n) & MASK64;
      w[t] = w[t - 16] + s0 + w[t - 7] + s1 & MASK64;
    }
    let a = h0, b = h1, c = h2, d = h3, e = h4, f = h5, g = h6, hh = h7;
    for (let t = 0; t < 80; t++) {
      const S1 = (rotr64(e, 14n) ^ rotr64(e, 18n) ^ rotr64(e, 41n)) & MASK64;
      const ch = e & f ^ ~e & MASK64 & g;
      const t1 = hh + S1 + ch + K512[t] + w[t] & MASK64;
      const S0 = (rotr64(a, 28n) ^ rotr64(a, 34n) ^ rotr64(a, 39n)) & MASK64;
      const maj = a & b ^ a & c ^ b & c;
      const t2 = S0 + maj & MASK64;
      hh = g;
      g = f;
      f = e;
      e = d + t1 & MASK64;
      d = c;
      c = b;
      b = a;
      a = t1 + t2 & MASK64;
    }
    h0 = h0 + a & MASK64;
    h1 = h1 + b & MASK64;
    h2 = h2 + c & MASK64;
    h3 = h3 + d & MASK64;
    h4 = h4 + e & MASK64;
    h5 = h5 + f & MASK64;
    h6 = h6 + g & MASK64;
    h7 = h7 + hh & MASK64;
  }
  return [h0, h1, h2, h3, h4, h5, h6, h7];
}
function bigintsToBytes(words, byteLen) {
  const out = new Uint8Array(words.length * 8);
  const view = new DataView(out.buffer);
  for (const [i, v] of words.entries()) view.setBigUint64(i * 8, v, false);
  return out.subarray(0, byteLen);
}
function sha512(data) {
  return bigintsToBytes(sha512Core(data, H512), 64);
}
function sha384(data) {
  return bigintsToBytes(sha512Core(data, H384), 48);
}

// src/pdf_doc/aes.ts
function gmul(a, b) {
  let p = 0;
  for (let i = 0; i < 8; i++) {
    if (b & 1) p ^= a;
    const hi = a & 128;
    a = a << 1 & 255;
    if (hi) a ^= 27;
    b >>= 1;
  }
  return p;
}
function gf256Inverse(a) {
  if (a === 0) return 0;
  for (let x = 1; x < 256; x++) if (gmul(a, x) === 1) return x;
  return 0;
}
function affineTransform(b) {
  let out = 0;
  for (let i = 0; i < 8; i++) {
    const bit = b >> i & 1 ^ b >> (i + 4) % 8 & 1 ^ b >> (i + 5) % 8 & 1 ^ b >> (i + 6) % 8 & 1 ^ b >> (i + 7) % 8 & 1 ^ 99 >> i & 1;
    out |= bit << i;
  }
  return out;
}
var SBOX = new Uint8Array(256);
for (let i = 0; i < 256; i++) SBOX[i] = affineTransform(gf256Inverse(i));
var RCON = new Uint8Array(15);
{
  let r = 1;
  for (let i = 1; i <= 14; i++) {
    RCON[i] = r;
    r = gmul(r, 2);
  }
}
var sbox = (b) => SBOX[b & 255];
function subWord(w) {
  return sbox(w >>> 24) << 24 | sbox(w >>> 16) << 16 | sbox(w >>> 8) << 8 | sbox(w);
}
function rotWord(w) {
  return (w << 8 | w >>> 24) >>> 0;
}
function keyExpansion(key, nk, nr) {
  const nb = 4;
  const w = new Uint32Array(nb * (nr + 1));
  const view = new DataView(key.buffer, key.byteOffset, key.byteLength);
  for (let i = 0; i < nk; i++) w[i] = view.getUint32(i * 4, false);
  for (let i = nk; i < w.length; i++) {
    let temp = w[i - 1];
    if (i % nk === 0) {
      temp = (subWord(rotWord(temp)) ^ RCON[i / nk] << 24) >>> 0;
    } else if (nk > 6 && i % nk === 4) {
      temp = subWord(temp);
    }
    w[i] = (w[i - nk] ^ temp) >>> 0;
  }
  return w;
}
function addRoundKey(state, w, round) {
  for (let c = 0; c < 4; c++) {
    const word = w[round * 4 + c];
    const i = c * 4;
    state[i] = state[i] ^ word >>> 24 & 255;
    state[i + 1] = state[i + 1] ^ word >>> 16 & 255;
    state[i + 2] = state[i + 2] ^ word >>> 8 & 255;
    state[i + 3] = state[i + 3] ^ word & 255;
  }
}
function subBytes(state) {
  for (let i = 0; i < 16; i++) state[i] = sbox(state[i]);
}
function shiftRows(state) {
  const s = state.slice();
  for (let r = 1; r < 4; r++) {
    for (let c = 0; c < 4; c++) {
      state[c * 4 + r] = s[(c + r) % 4 * 4 + r];
    }
  }
}
function mixColumns(state) {
  for (let c = 0; c < 4; c++) {
    const i = c * 4;
    const a0 = state[i], a1 = state[i + 1], a2 = state[i + 2], a3 = state[i + 3];
    state[i] = gmul(a0, 2) ^ gmul(a1, 3) ^ a2 ^ a3;
    state[i + 1] = a0 ^ gmul(a1, 2) ^ gmul(a2, 3) ^ a3;
    state[i + 2] = a0 ^ a1 ^ gmul(a2, 2) ^ gmul(a3, 3);
    state[i + 3] = gmul(a0, 3) ^ a1 ^ a2 ^ gmul(a3, 2);
  }
}
var cachedKey = null;
var cachedSchedule = null;
var cachedNr = 0;
function scheduleFor(key) {
  if (cachedKey !== key) {
    const nk = key.length / 4;
    cachedNr = nk + 6;
    cachedSchedule = keyExpansion(key, nk, cachedNr);
    cachedKey = key;
  }
  return { w: cachedSchedule, nr: cachedNr };
}
function encryptBlock(block, key) {
  const { w, nr } = scheduleFor(key);
  const state = block.slice();
  addRoundKey(state, w, 0);
  for (let round = 1; round < nr; round++) {
    subBytes(state);
    shiftRows(state);
    mixColumns(state);
    addRoundKey(state, w, round);
  }
  subBytes(state);
  shiftRows(state);
  addRoundKey(state, w, nr);
  block.set(state);
}
function xorInto(a, b) {
  for (let i = 0; i < a.length; i++) a[i] = a[i] ^ b[i];
}
function pkcs7Pad(data) {
  const padLen = 16 - data.length % 16;
  const out = new Uint8Array(data.length + padLen);
  out.set(data);
  out.fill(padLen, data.length);
  return out;
}
function aesCbcEncrypt(key, iv, data, pad) {
  const input = pad ? pkcs7Pad(data) : data;
  const out = new Uint8Array(input.length);
  let prev = iv.slice();
  for (let off = 0; off < input.length; off += 16) {
    const block = input.slice(off, off + 16);
    xorInto(block, prev);
    encryptBlock(block, key);
    out.set(block, off);
    prev = block;
  }
  return out;
}
function aesEcbEncryptBlock(key, block) {
  const out = block.slice();
  encryptBlock(out, key);
  return out;
}

// src/pdf_doc/crypto_r6.ts
var _te2 = new TextEncoder();
function concatBytes(...parts) {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
}
function preparePassword(pw) {
  const b = _te2.encode(pw);
  return b.length > 127 ? b.slice(0, 127) : b;
}
function randomBytes(n) {
  return crypto.getRandomValues(new Uint8Array(n));
}
function hardenedHash(password, salt, extra) {
  let k = sha256(concatBytes(password, salt, extra));
  let round = 0;
  for (; ; ) {
    const k1Unit = concatBytes(password, k, extra);
    const k1 = new Uint8Array(k1Unit.length * 64);
    for (let i = 0; i < 64; i++) k1.set(k1Unit, i * k1Unit.length);
    const aesKey = k.slice(0, 16);
    const iv = k.slice(16, 32);
    const e = aesCbcEncrypt(aesKey, iv, k1, false);
    let sum = 0;
    for (let i = 0; i < 16; i++) sum += e[i];
    const mod3 = sum % 3;
    k = mod3 === 0 ? sha256(e) : mod3 === 1 ? sha384(e) : sha512(e);
    round++;
    if (round >= 64 && e[e.length - 1] <= round - 32) break;
  }
  return k.slice(0, 32);
}
function computeR6Security(userPw, ownerPw, permissions) {
  const userPassword = preparePassword(userPw);
  const ownerPassword = preparePassword(ownerPw);
  const fileKey = randomBytes(32);
  const uValidationSalt = randomBytes(8);
  const uKeySalt = randomBytes(8);
  const uHash = hardenedHash(userPassword, uValidationSalt, new Uint8Array(0));
  const u = concatBytes(uHash, uValidationSalt, uKeySalt);
  const uIntermediateKey = hardenedHash(userPassword, uKeySalt, new Uint8Array(0));
  const ue = aesCbcEncrypt(uIntermediateKey, new Uint8Array(16), fileKey, false);
  const oValidationSalt = randomBytes(8);
  const oKeySalt = randomBytes(8);
  const oHash = hardenedHash(ownerPassword, oValidationSalt, u);
  const o = concatBytes(oHash, oValidationSalt, oKeySalt);
  const oIntermediateKey = hardenedHash(ownerPassword, oKeySalt, u);
  const oe = aesCbcEncrypt(oIntermediateKey, new Uint8Array(16), fileKey, false);
  const permsBlock = new Uint8Array(16);
  new DataView(permsBlock.buffer).setUint32(0, permissions >>> 0, true);
  permsBlock[4] = 255;
  permsBlock[5] = 255;
  permsBlock[6] = 255;
  permsBlock[7] = 255;
  permsBlock[8] = 84;
  permsBlock[9] = 97;
  permsBlock[10] = 100;
  permsBlock[11] = 98;
  permsBlock.set(randomBytes(4), 12);
  const perms = aesEcbEncryptBlock(fileKey, permsBlock);
  return { fileKey, o, u, oe, ue, perms, permissions };
}

// src/pdf_doc/build_pages.ts
function putCompressedStream(ctx, data) {
  const comp = deflate(data);
  ctx.out("<<");
  ctx.out(`/Length ${ctx.encryptedLength(comp.length)}`);
  ctx.out("/Filter /FlateDecode");
  ctx.out(">>");
  ctx.out("stream");
  ctx.outBytes(comp);
  ctx.out("endstream");
}
function putAppearanceStream(ctx, w, h, body) {
  const oid = ctx.newObjectDeferred();
  ctx.newObjectDeferredBegin(oid, true);
  const bytes2 = _te.encode(body);
  ctx.out("<<");
  ctx.out("/Type /XObject");
  ctx.out("/Subtype /Form");
  ctx.out("/FormType 1");
  ctx.out(`/BBox [0 0 ${hpf(w)} ${hpf(h)}]`);
  ctx.out(`/Resources ${ctx.resourceDictObjId} 0 R`);
  ctx.out(`/Length ${ctx.encryptedLength(bytes2.length)}`);
  ctx.out(">>");
  ctx.out("stream");
  ctx.outBytes(bytes2);
  ctx.out("endstream");
  ctx.out("endobj");
  return oid;
}
function putFieldWidget(ctx, oid, pageObjId, ann, apIds) {
  ctx.newObjectDeferredBegin(oid, true);
  ctx.out("<<");
  ctx.out("/Type /Annot");
  ctx.out("/Subtype /Widget");
  ctx.out(`/FT /${ann.fieldType}`);
  ctx.out(`/T ${ctx.strLit(ann.fieldName ?? "")}`);
  ctx.out(`/P ${pageObjId} 0 R`);
  ctx.out(`/Rect [${hpf(ann.rect[0])} ${hpf(ann.rect[1])} ${hpf(ann.rect[2])} ${hpf(ann.rect[3])}]`);
  ctx.out("/Border [0 0 0]");
  if (ann.fieldDA) ctx.out(`/DA ${ctx.strLit(ann.fieldDA)}`);
  if (ann.fieldType === "Btn") {
    ctx.out(`/AP << /N << /On ${apIds.onId} 0 R /Off ${apIds.offId} 0 R >> >>`);
    ctx.out(`/AS /${ann.fieldChecked ? "On" : "Off"}`);
    ctx.out(`/V /${ann.fieldChecked ? "On" : "Off"}`);
  } else {
    ctx.out(`/AP << /N ${apIds.onId} 0 R >>`);
    ctx.out(`/V ${ctx.strLit(ann.fieldValue ?? "")}`);
    if (ann.fieldType === "Ch" && ann.fieldOptions) {
      ctx.out(`/Opt [${ann.fieldOptions.map((o) => ctx.strLit(o)).join(" ")}]`);
    }
  }
  ctx.out(">>");
  ctx.out("endobj");
}
function putPages(ctx) {
  const pageCount = ctx.allPageBufs.length;
  const rootId = ctx.rootDictObjId;
  const resId = ctx.resourceDictObjId;
  const fmtW = ctx.formatW;
  const fmtH = ctx.formatH;
  const pageObjIds = [];
  const contentObjIds = [];
  for (let i = 0; i < pageCount; i++) {
    pageObjIds.push(ctx.newObjectDeferred());
    contentObjIds.push(ctx.newObjectDeferred());
  }
  ctx.pageObjIds = pageObjIds;
  const annotObjIdsList = [];
  for (let n = 0; n < pageCount; n++) {
    const annots = ctx.pageAnnots[n] ?? [];
    annotObjIdsList.push(annots.map(() => ctx.newObjectDeferred()));
  }
  for (let n = 0; n < pageCount; n++) {
    const pageObjId = pageObjIds[n];
    const contObjId = contentObjIds[n];
    const annots = ctx.pageAnnots[n] ?? [];
    const annotIds = annotObjIdsList[n] ?? [];
    ctx.newObjectDeferredBegin(pageObjId, true);
    ctx.out("<</Type /Page");
    ctx.out(`/Parent ${rootId} 0 R`);
    ctx.out(`/Resources ${resId} 0 R`);
    ctx.out(`/MediaBox [0 0 ${hpf(fmtW)} ${hpf(fmtH)}]`);
    ctx.out(`/Contents ${contObjId} 0 R`);
    if (ctx.structRoot) ctx.out(`/StructParents ${n}`);
    if (annotIds.length) {
      ctx.out(`/Annots [${annotIds.map((id) => `${id} 0 R`).join(" ")}]`);
    }
    ctx.out(">>");
    ctx.out("endobj");
    ctx.newObjectDeferredBegin(contObjId, true);
    putCompressedStream(ctx, _te.encode((ctx.allPageBufs[n] ?? []).join("\n")));
    ctx.out("endobj");
    for (const [i, ann] of annots.entries()) {
      const oid = annotIds[i];
      if (ann.fieldType) {
        const w = ann.rect[2] - ann.rect[0];
        const h = ann.rect[3] - ann.rect[1];
        const onId = putAppearanceStream(ctx, w, h, ann.fieldApOn ?? "");
        const offId = ann.fieldType === "Btn" ? putAppearanceStream(ctx, w, h, ann.fieldApOff ?? "") : void 0;
        putFieldWidget(ctx, oid, pageObjId, ann, { onId, offId });
        ctx.formFieldObjIds.push(oid);
        continue;
      }
      ctx.newObjectDeferredBegin(oid, true);
      ctx.out("<<");
      ctx.out("/Type /Annot");
      ctx.out("/Subtype /Link");
      ctx.out(`/Rect [${hpf(ann.rect[0])} ${hpf(ann.rect[1])} ${hpf(ann.rect[2])} ${hpf(ann.rect[3])}]`);
      ctx.out("/Border [0 0 0]");
      if (ann.href !== void 0) {
        const lit = ctx.strLit(uriString(ann.href));
        ctx.out(`/A <</S /URI /URI ${lit}>>`);
      } else if (ann.destPage !== void 0) {
        const pg = Math.min(Math.max(0, ann.destPage - 1), ctx.pageObjIds.length - 1);
        const ref = ctx.pageObjIds[pg] ?? 0;
        ctx.out(`/A <</S /GoTo /D [${ref} 0 R /XYZ null ${hpf(ann.destY ?? 0)} null]>>`);
      }
      ctx.out(">>");
      ctx.out("endobj");
    }
  }
  ctx.newObjectDeferredBegin(rootId, true);
  ctx.out("<</Type /Pages");
  ctx.out(`/Kids [${pageObjIds.map((id) => `${id} 0 R`).join(" ")}]`);
  ctx.out(`/Count ${pageCount}`);
  ctx.out(">>");
  ctx.out("endobj");
}

// src/pdf_doc/cmap.ts
function toUnicodeCmap(glyphToUnicode) {
  const codes = [...glyphToUnicode.keys()].sort((a, b) => a - b);
  const ranges = [];
  const singles = [];
  const single = (g) => {
    const v = glyphToUnicode.get(g);
    return v.length === 1 ? v[0] : null;
  };
  let i = 0;
  while (i < codes.length) {
    const sg = codes[i];
    const sc = single(sg);
    let end = i;
    const MAX_BFRANGE_SPAN = 256;
    const startCompressible = sc !== null && sc <= 65535;
    if (startCompressible) {
      while (end + 1 < codes.length && end - i + 1 < MAX_BFRANGE_SPAN) {
        const ng = codes[end + 1];
        const nc = single(ng);
        const ec = single(codes[end]);
        if (nc === null || ec === null || ng !== codes[end] + 1 || nc !== ec + 1 || ec >= 65535) break;
        end++;
      }
    }
    if (end > i && sc !== null && sc <= 65535) ranges.push([sg, codes[end], sc]);
    else singles.push([sg, glyphToUnicode.get(sg)]);
    i = end + 1;
  }
  const h4 = (n) => n.toString(16).padStart(4, "0");
  const cpHex = (cp) => {
    if (cp <= 65535) return h4(cp);
    const hi = 55296 + (cp - 65536 >> 10);
    const lo = 56320 + (cp - 65536 & 1023);
    return h4(hi) + h4(lo);
  };
  const cpsHex = (cps) => cps.map(cpHex).join("");
  let map = "/CIDInit /ProcSet findresource begin\n12 dict begin\nbegincmap\n/CIDSystemInfo <<\n  /Registry (Adobe)\n  /Ordering (UCS)\n  /Supplement 0\n>> def\n/CMapName /Adobe-Identity-UCS def\n/CMapType 2 def\n1 begincodespacerange\n<0000><ffff>\nendcodespacerange";
  for (let r = 0; r < ranges.length; r += 100) {
    const batch = ranges.slice(r, r + 100);
    map += `
${batch.length} beginbfrange
`;
    for (const [s, e, cp] of batch) map += `<${h4(s)}><${h4(e)}><${cpHex(cp)}>
`;
    map += "endbfrange";
  }
  for (let r = 0; r < singles.length; r += 100) {
    const batch = singles.slice(r, r + 100);
    map += `
${batch.length} beginbfchar
`;
    for (const [g, cps] of batch) map += `<${h4(g)}><${cpsHex(cps)}>
`;
    map += "endbfchar";
  }
  map += "\nendcmap\nCMapName currentdict /CMap defineresource pop\nend\nend";
  return map;
}

// src/pdf_doc/build_fonts.ts
function embedFont(ctx, font) {
  const gids = new Uint16Array([...font.glyphIds].sort((a, b) => a - b));
  const result = subset_font_full(font.fontName, font.style, font.weight, font.opsz, gids);
  if (!result) return;
  const { fontBytes, glyphMap, isCff, ascender, descender, capHeight, bbox, flags, italicAngle, fontName } = result;
  if (!fontBytes) return;
  const rawAdvs = get_advance_widths(font.fontName, font.style, font.weight, font.opsz, gids);
  const widths = Array.from(gids, (gid, i) => [gid, Math.round(rawAdvs[i])]);
  const fontTableId = ctx.newObject();
  const compFont = deflate(fontBytes);
  ctx.out("<<");
  ctx.out(`/Length ${ctx.encryptedLength(compFont.length)}`);
  if (isCff) {
    ctx.out("/Subtype /CIDFontType0C");
  } else {
    ctx.out(`/Length1 ${fontBytes.length}`);
  }
  ctx.out("/Filter /FlateDecode");
  ctx.out(">>");
  ctx.out("stream");
  ctx.outBytes(compFont);
  ctx.out("endstream");
  ctx.out("endobj");
  const cmapText = toUnicodeCmap(font.glyphToUnicode);
  const compCmap = deflate(_te.encode(cmapText));
  const cmapId = ctx.newObject();
  ctx.out("<<");
  ctx.out(`/Length ${ctx.encryptedLength(compCmap.length)}`);
  ctx.out("/Filter /FlateDecode");
  ctx.out(">>");
  ctx.out("stream");
  ctx.outBytes(compCmap);
  ctx.out("endstream");
  ctx.out("endobj");
  let cidToGidId = 0;
  if (!isCff) {
    const maxCid = gids.length ? Math.max(...gids) : 0;
    const mapBytes = new Uint8Array((maxCid + 1) * 2);
    const gm = glyphMap;
    for (const orig of gids) {
      const compact = orig < gm.length ? gm[orig] : 0;
      mapBytes[orig * 2] = compact >> 8 & 255;
      mapBytes[orig * 2 + 1] = compact & 255;
    }
    const compMap = deflate(mapBytes);
    cidToGidId = ctx.newObject();
    ctx.out("<<");
    ctx.out(`/Length ${ctx.encryptedLength(compMap.length)}`);
    ctx.out("/Filter /FlateDecode");
    ctx.out(">>");
    ctx.out("stream");
    ctx.outBytes(compMap);
    ctx.out("endstream");
    ctx.out("endobj");
  }
  ctx.beginCapture();
  ctx.out("<<");
  ctx.out("/Type /FontDescriptor");
  ctx.out(`/FontName /${toPdfName(fontName)}`);
  ctx.out(`/${isCff ? "FontFile3" : "FontFile2"} ${fontTableId} 0 R`);
  ctx.out(`/FontBBox ${bboxToPdf(Array.from(bbox))}`);
  ctx.out(`/Flags ${flags}`);
  ctx.out(`/StemV ${stemV(font.weight)}`);
  ctx.out(`/ItalicAngle ${italicAngle}`);
  ctx.out(`/Ascent ${ascender}`);
  ctx.out(`/Descent ${descender}`);
  ctx.out(`/CapHeight ${capHeight}`);
  ctx.out(">>");
  const fontDescriptorId = ctx.queueForObjStm(ctx.endCapture());
  ctx.beginCapture();
  ctx.out("<<");
  ctx.out("/Type /Font");
  ctx.out(`/BaseFont /${toPdfName(fontName)}`);
  ctx.out(`/FontDescriptor ${fontDescriptorId} 0 R`);
  ctx.out(`/W ${widthsToPdf(widths)}`);
  if (!isCff) ctx.out(`/CIDToGIDMap ${cidToGidId} 0 R`);
  ctx.out("/DW 1000");
  ctx.out(`/Subtype ${isCff ? "/CIDFontType0" : "/CIDFontType2"}`);
  ctx.out("/CIDSystemInfo");
  ctx.out("<<");
  ctx.out("/Supplement 0");
  ctx.out("/Registry (Adobe)");
  ctx.out("/Ordering (Identity)");
  ctx.out(">>");
  ctx.out(">>");
  const descendantId = ctx.queueForObjStm(ctx.endCapture());
  ctx.beginCapture();
  ctx.out("<<");
  ctx.out("/Type /Font");
  ctx.out("/Subtype /Type0");
  ctx.out(`/ToUnicode ${cmapId} 0 R`);
  ctx.out(`/BaseFont /${toPdfName(fontName)}`);
  ctx.out("/Encoding /Identity-H");
  ctx.out(`/DescendantFonts [${descendantId} 0 R]`);
  ctx.out(">>");
  const type0Id = ctx.queueForObjStm(ctx.endCapture());
  font.objectNumber = type0Id;
  font.isAlreadyPutted = true;
  if (font.usedVertically) {
    const w2 = [];
    for (const [i, gid] of gids.entries()) {
      const rawV = get_vertical_advance(font.fontName, font.style, font.weight, font.opsz, gid);
      if (rawV <= 0) continue;
      const w1y = -Math.round(rawV);
      const v1x = Math.round(widths[i][1] / 2);
      w2.push([gid, w1y, v1x, ascender]);
    }
    ctx.beginCapture();
    ctx.out("<<");
    ctx.out("/Type /Font");
    ctx.out(`/BaseFont /${toPdfName(fontName)}`);
    ctx.out(`/FontDescriptor ${fontDescriptorId} 0 R`);
    ctx.out(`/W2 ${w2ToPdf(w2)}`);
    if (!isCff) ctx.out(`/CIDToGIDMap ${cidToGidId} 0 R`);
    ctx.out(`/DW2 [${ascender} -1000]`);
    ctx.out("/DW 1000");
    ctx.out(`/Subtype ${isCff ? "/CIDFontType0" : "/CIDFontType2"}`);
    ctx.out("/CIDSystemInfo");
    ctx.out("<<");
    ctx.out("/Supplement 0");
    ctx.out("/Registry (Adobe)");
    ctx.out("/Ordering (Identity)");
    ctx.out(">>");
    ctx.out(">>");
    const descendantVId = ctx.queueForObjStm(ctx.endCapture());
    ctx.beginCapture();
    ctx.out("<<");
    ctx.out("/Type /Font");
    ctx.out("/Subtype /Type0");
    ctx.out(`/ToUnicode ${cmapId} 0 R`);
    ctx.out(`/BaseFont /${toPdfName(fontName)}`);
    ctx.out("/Encoding /Identity-V");
    ctx.out(`/DescendantFonts [${descendantVId} 0 R]`);
    ctx.out(">>");
    font.verticalObjectNumber = ctx.queueForObjStm(ctx.endCapture());
  }
}
function stemV(weight) {
  const w = Number.isFinite(weight) && weight > 0 ? weight : 400;
  return Math.round(50 + (w / 65) ** 2);
}
function putFonts(ctx) {
  for (const font of ctx.fonts) {
    if (!ctx.usedFonts.has(font.id)) continue;
    if (font.isAlreadyPutted) continue;
    if (font.glyphIds.size <= 1) continue;
    embedFont(ctx, font);
  }
}

// src/pdf_doc/build_resources.ts
function putImages(ctx) {
  for (const img of ctx.images) {
    let smaskObjId = 0;
    if (img.smask) {
      const smaskData = deflate(img.smask);
      smaskObjId = ctx.newObject();
      ctx.out("<<");
      ctx.out("/Type /XObject");
      ctx.out("/Subtype /Image");
      ctx.out(`/Width ${img.width}`);
      ctx.out(`/Height ${img.height}`);
      ctx.out("/ColorSpace /DeviceGray");
      ctx.out("/BitsPerComponent 8");
      ctx.out("/Filter /FlateDecode");
      ctx.out(`/Length ${ctx.encryptedLength(smaskData.length)}`);
      ctx.out(">>");
      ctx.out("stream");
      ctx.outBytes(smaskData);
      ctx.out("endstream");
      ctx.out("endobj");
    }
    const oid = ctx.newObject();
    img.objectNumber = oid;
    ctx.out("<<");
    ctx.out("/Type /XObject");
    ctx.out("/Subtype /Image");
    ctx.out(`/Width ${img.width}`);
    ctx.out(`/Height ${img.height}`);
    ctx.out(`/ColorSpace /${img.colorSpace}`);
    ctx.out("/BitsPerComponent 8");
    ctx.out(`/Filter ${img.filter}`);
    ctx.out(`/Length ${ctx.encryptedLength(img.data.length)}`);
    if (img.decodeInvert) ctx.out("/Decode [1 0 1 0 1 0 1 0]");
    if (smaskObjId) ctx.out(`/SMask ${smaskObjId} 0 R`);
    ctx.out(">>");
    ctx.out("stream");
    ctx.outBytes(img.data);
    ctx.out("endstream");
    ctx.out("endobj");
  }
}
var BOUND_MIN_GAP = 1e-6;
var boundFmt = (n) => (Number.isFinite(n) ? n : 0).toFixed(6).replace(/\.?0+$/, "");
function normalizeStops(rawStops) {
  const sp = rawStops.map((st) => [...st]);
  let prev = 0;
  for (const st of sp) {
    st[0] = Math.max(prev, Math.min(1, Math.max(0, st[0])));
    prev = st[0];
  }
  const head = sp[0];
  if (head && head[0] > 0) sp.unshift([0, head[1], head[2], head[3], head[4]]);
  const tail = sp.at(-1);
  if (tail && tail[0] < 1) sp.push([1, tail[1], tail[2], tail[3], tail[4]]);
  const last = sp.length - 1;
  for (let k = 1; k < last; k++) {
    const cur = sp[k], before = sp[k - 1];
    const ceiling = 1 - (last - k) * BOUND_MIN_GAP;
    const floor = before[0] + BOUND_MIN_GAP;
    cur[0] = Math.min(Math.max(cur[0], floor), ceiling);
  }
  return sp;
}
function buildFunction(stops, pick) {
  const comps = (s) => pick(s).map(hpf).join(" ");
  if (stops.length <= 1) {
    const c = comps(stops[0] ?? [0, 0, 0, 0, 0]);
    return `/Function << /FunctionType 2 /Domain [0 1] /C0 [${c}] /C1 [${c}] /N 1 >>`;
  }
  if (stops.length === 2) {
    const s0 = stops[0], s1 = stops[1];
    return `/Function << /FunctionType 2 /Domain [0 1] /C0 [${comps(s0)}] /C1 [${comps(s1)}] /N 1 >>`;
  }
  const n = stops.length;
  const bounds = stops.slice(1, n - 1).map((s) => boundFmt(s[0])).join(" ");
  const encode = Array.from({ length: n - 1 }, () => "0 1").join(" ");
  const funcs = stops.slice(0, n - 1).map((s0, j) => {
    const s1 = stops[j + 1];
    return `<< /FunctionType 2 /Domain [0 1] /C0 [${comps(s0)}] /C1 [${comps(s1)}] /N 1 >>`;
  }).join(" ");
  return `/Function << /FunctionType 3 /Domain [0 1] /Bounds [${bounds}] /Encode [${encode}] /Functions [${funcs}] >>`;
}
function shadingCoordLines(def, pat) {
  const cx = pat.x + pat.w / 2;
  const cyp = pat.pageH - pat.y - pat.h / 2;
  if (def.gradType === 0) {
    const rad = def.angle * Math.PI / 180;
    const dx = Math.sin(rad), dy = Math.cos(rad);
    const hw = pat.w / 2, hh = pat.h / 2;
    const projs = [-hw * dx - hh * dy, hw * dx - hh * dy, -hw * dx + hh * dy, hw * dx + hh * dy];
    const tMin = Math.min(...projs), tMax = Math.max(...projs);
    return [
      "/ShadingType 2",
      `/Coords [${hpf(cx + tMin * dx)} ${hpf(cyp + tMin * dy)} ${hpf(cx + tMax * dx)} ${hpf(cyp + tMax * dy)}]`
    ];
  }
  const gcx = pat.x + pat.w * def.cx;
  const gcyp = pat.pageH - (pat.y + pat.h * def.cy);
  const dxMax = Math.max(gcx - pat.x, pat.x + pat.w - gcx);
  const dyMax = Math.max(pat.pageH - pat.y - gcyp, gcyp - (pat.pageH - pat.y - pat.h));
  const r = Math.hypot(dxMax, dyMax);
  const gfx = pat.x + pat.w * (def.fx ?? def.cx);
  const gfyp = pat.pageH - (pat.y + pat.h * (def.fy ?? def.cy));
  return [
    "/ShadingType 3",
    `/Coords [${hpf(gfx)} ${hpf(gfyp)} 0 ${hpf(gcx)} ${hpf(gcyp)} ${hpf(r)}]`
  ];
}
function putShadingPatterns(ctx) {
  if (!ctx.shadPats.length) return;
  for (const pat of ctx.shadPats) {
    const def = ctx.gradDefs[pat.defIdx];
    if (!def) continue;
    const oid = ctx.newObject();
    pat.objId = oid;
    const stops = normalizeStops(def.stops);
    ctx.out("<<");
    ctx.out("/PatternType 2");
    ctx.out("/Matrix [1 0 0 1 0 0]");
    ctx.out("/Shading <<");
    ctx.out("/ColorSpace /DeviceRGB");
    ctx.out("/Extend [true true]");
    for (const line of shadingCoordLines(def, pat)) ctx.out(line);
    ctx.out(buildFunction(stops, (s) => [s[1], s[2], s[3]]));
    ctx.out(">>");
    ctx.out(">>");
    ctx.out("endobj");
  }
}
function putGradientSoftMasks(ctx) {
  for (const [i, sm] of ctx.gradSoftMasks.entries()) {
    const def = ctx.gradDefs[sm.defIdx];
    if (!def) continue;
    const stops = normalizeStops(def.stops);
    const shadingOid = ctx.newObject();
    ctx.out("<<");
    ctx.out("/ShadingType " + (def.gradType === 0 ? "2" : "3"));
    ctx.out(shadingCoordLines(def, sm)[1]);
    ctx.out("/ColorSpace /DeviceGray");
    ctx.out("/Extend [true true]");
    ctx.out(buildFunction(stops, (s) => [s[4]]));
    ctx.out(">>");
    ctx.out("endobj");
    const yp = sm.pageH - sm.y - sm.h;
    const formOid = ctx.newObject();
    const formBody = _te.encode(`/ShM${i} sh`);
    ctx.out("<<");
    ctx.out("/Type /XObject");
    ctx.out("/Subtype /Form");
    ctx.out("/FormType 1");
    ctx.out(`/BBox [${hpf(sm.x)} ${hpf(yp)} ${hpf(sm.x + sm.w)} ${hpf(yp + sm.h)}]`);
    ctx.out("/Group << /Type /Group /S /Transparency /CS /DeviceGray >>");
    ctx.out(`/Resources << /Shading << /ShM${i} ${shadingOid} 0 R >> >>`);
    ctx.out(`/Length ${ctx.encryptedLength(formBody.length)}`);
    ctx.out(">>");
    ctx.out("stream");
    ctx.outBytes(formBody);
    ctx.out("endstream");
    ctx.out("endobj");
    const gsOid = ctx.newObject();
    ctx.out("<<");
    ctx.out("/Type /ExtGState");
    ctx.out(`/SMask << /Type /Mask /S /Luminosity /G ${formOid} 0 R >>`);
    ctx.out(">>");
    ctx.out("endobj");
    sm.objId = gsOid;
  }
}
function putResourceDictionary(ctx) {
  ctx.newObjectDeferredBegin(ctx.resourceDictObjId, true);
  ctx.out("<<");
  ctx.out("/ProcSet [/PDF /Text /ImageB /ImageC /ImageI]");
  ctx.out("/Font <<");
  for (const font of ctx.fonts) {
    if (!ctx.usedFonts.has(font.id)) continue;
    if (font.objectNumber > 0) ctx.out(`/${font.id} ${font.objectNumber} 0 R`);
    if (font.usedVertically && font.verticalObjectNumber > 0) {
      ctx.out(`/${font.id}V ${font.verticalObjectNumber} 0 R`);
    }
  }
  ctx.out(">>");
  if (ctx.images.length) {
    ctx.out("/XObject <<");
    for (const img of ctx.images) ctx.out(`/${img.name} ${img.objectNumber} 0 R`);
    ctx.out(">>");
  }
  if (ctx.shadPats.length) {
    ctx.out("/Pattern <<");
    for (const p of ctx.shadPats) if (p.objId) ctx.out(`/${p.patName} ${p.objId} 0 R`);
    ctx.out(">>");
  }
  if (ctx.extGStates.length || ctx.gradSoftMasks.length) {
    ctx.out("/ExtGState <<");
    for (const [i, st] of ctx.extGStates.entries()) {
      const v = hpf(st.alpha);
      ctx.out(`/GS${i} << /Type /ExtGState /ca ${v} /CA ${v} /BM /${st.blend} >>`);
    }
    for (const sm of ctx.gradSoftMasks) {
      if (sm.objId) ctx.out(`/${sm.gsName} ${sm.objId} 0 R`);
    }
    ctx.out(">>");
  }
  ctx.out(">>");
  ctx.out("endobj");
}
function packObjStm(ctx) {
  if (!ctx.objStmQueue.length) return;
  const items = ctx.objStmQueue.splice(0);
  const hparts = [];
  const bparts = [];
  let boff = 0;
  for (const { oid, content } of items) {
    hparts.push(`${oid} ${boff}`);
    boff += content.length + 1;
    bparts.push(content);
  }
  const hstr = hparts.join(" ");
  const body = `${hstr}
${bparts.join("\n")}`;
  const comp = deflate(_te.encode(body));
  const stmId = ctx.newObject();
  ctx.out("<<");
  ctx.out("/Type /ObjStm");
  ctx.out(`/N ${items.length}`);
  ctx.out(`/First ${hstr.length + 1}`);
  ctx.out(`/Length ${ctx.encryptedLength(comp.length)}`);
  ctx.out("/Filter /FlateDecode");
  ctx.out(">>");
  ctx.out("stream");
  ctx.outBytes(comp);
  ctx.out("endstream");
  ctx.out("endobj");
  for (const [qi, it] of items.entries()) {
    ctx.objStmMembers.push([it.oid, stmId, qi]);
  }
}

// package.json
var package_default = {
  name: "daeepdf",
  version: "1.0.1",
  description: "Real PDFs from the layout your browser already rendered. No server, no headless Chrome, no screenshots.",
  type: "module",
  license: "MIT",
  author: "silly-tae",
  repository: {
    type: "git",
    url: "git+https://github.com/silly-tae/daepdf.git"
  },
  homepage: "https://github.com/silly-tae/daepdf#readme",
  bugs: {
    url: "https://github.com/silly-tae/daepdf/issues"
  },
  keywords: [
    "html-to-pdf",
    "html2pdf"
  ],
  sideEffects: false,
  main: "./dist/index.js",
  types: "./dist/index.d.ts",
  exports: {
    ".": {
      types: "./dist/index.d.ts",
      import: "./dist/index.js",
      default: "./dist/index.js"
    },
    "./daepl.wasm": "./dist/daepl.wasm"
  },
  files: [
    "dist"
  ],
  publishConfig: {
    access: "public"
  },
  scripts: {
    build: "node build.mjs",
    typecheck: "tsc --noEmit -p tsconfig.json",
    check: "npm run typecheck",
    prepack: "npm run check && npm run build"
  },
  devDependencies: {
    "dts-bundle-generator": "^9.5.1",
    esbuild: "^0.28.1",
    typescript: "^5.9.3"
  }
};

// src/pdf_doc/build_catalog.ts
function putOutline(ctx) {
  if (!ctx.bookmarks.length) return null;
  const bms = ctx.bookmarks;
  const n = bms.length;
  const fmtH = ctx.formatH;
  const NO = -1;
  const parent = new Array(n).fill(NO);
  const prevSib = new Array(n).fill(NO);
  const nextSib = new Array(n).fill(NO);
  const firstChild = new Array(n).fill(NO);
  const lastChild = new Array(n).fill(NO);
  const ancestry = [];
  for (const [i, bm] of bms.entries()) {
    let level = bm.level;
    while (level > 0 && (level - 1 >= ancestry.length || ancestry[level - 1] === NO)) level--;
    while (ancestry.length <= level) ancestry.push(NO);
    for (let l = level + 1; l < ancestry.length; l++) ancestry[l] = NO;
    const par = level === 0 ? NO : ancestry[level - 1];
    const prv = ancestry[level];
    parent[i] = par;
    prevSib[i] = prv;
    if (prv !== NO) nextSib[prv] = i;
    if (par !== NO) {
      if (firstChild[par] === NO) firstChild[par] = i;
      lastChild[par] = i;
    }
    ancestry[level] = i;
  }
  const topFirst = [...Array(n).keys()].find((i) => parent[i] === NO) ?? NO;
  const topLast = [...Array(n).keys()].reverse().find((i) => parent[i] === NO) ?? NO;
  const topCount = [...Array(n).keys()].filter((i) => parent[i] === NO).length;
  const totalDescendants = new Array(n).fill(0);
  for (let i = n - 1; i >= 0; i--) {
    const par = parent[i];
    if (par !== NO) totalDescendants[par] = totalDescendants[par] + 1 + totalDescendants[i];
  }
  const rootId = ctx.newObjectDeferred();
  const objIds = Array.from({ length: n }, () => ctx.newObjectDeferred());
  for (const [i, bm] of bms.entries()) {
    const pg = Math.min(Math.max(0, bm.page - 1), ctx.pageObjIds.length - 1);
    const pgRef = ctx.pageObjIds[pg] ?? 0;
    const yPdf = fmtH - bm.y;
    const parRef = parent[i] === NO ? `${rootId} 0 R` : `${objIds[parent[i]]} 0 R`;
    ctx.newObjectDeferredBegin(objIds[i], true);
    const titleLit = ctx.strLit(bm.title);
    ctx.out("<<");
    ctx.out(`/Title ${titleLit}`);
    ctx.out(`/Parent ${parRef}`);
    if (prevSib[i] !== NO) ctx.out(`/Prev ${objIds[prevSib[i]]} 0 R`);
    if (nextSib[i] !== NO) ctx.out(`/Next ${objIds[nextSib[i]]} 0 R`);
    if (firstChild[i] !== NO) {
      ctx.out(`/First ${objIds[firstChild[i]]} 0 R`);
      ctx.out(`/Last ${objIds[lastChild[i]]} 0 R`);
      ctx.out(`/Count -${totalDescendants[i]}`);
    } else {
      ctx.out("/Count 0");
    }
    ctx.out(`/Dest [${pgRef} 0 R /XYZ null ${hpf(yPdf)} null]`);
    ctx.out(">>");
    ctx.out("endobj");
  }
  ctx.newObjectDeferredBegin(rootId, true);
  ctx.out("<<");
  ctx.out("/Type /Outlines");
  if (topFirst !== NO) {
    ctx.out(`/First ${objIds[topFirst]} 0 R`);
    ctx.out(`/Last ${objIds[topLast]} 0 R`);
  }
  ctx.out(`/Count ${topCount}`);
  ctx.out(">>");
  ctx.out("endobj");
  return rootId;
}
function putCatalog(ctx, structTreeRootId, pdfaExtras) {
  const infoId = ctx.newObject();
  ctx.out("<<");
  ctx.out(`/Producer ${ctx.strLit(`daepdf ${package_default.version}`)}`);
  ctx.out(`/CreationDate ${ctx.strLit(ctx.creationDate)}`);
  for (const [k, v] of ctx.metadata) ctx.out(`/${toPdfName(k)} ${ctx.strLit(v)}`);
  ctx.out(">>");
  ctx.out("endobj");
  let namesObjId = null;
  if (ctx.namedDests.length) {
    const oid = ctx.newObjectDeferred();
    const pairs = ctx.namedDests.map(([name, page, y]) => {
      const pg = Math.min(Math.max(0, page - 1), ctx.pageObjIds.length - 1);
      const ref = ctx.pageObjIds[pg] ?? 0;
      const yp = ctx.formatH - y;
      return `${ctx.strLit(name)} [${ref} 0 R /XYZ null ${hpf(yp)} null]`;
    });
    ctx.newObjectDeferredBegin(oid, true);
    ctx.out("<<");
    ctx.out("/Type /Names");
    ctx.out(`/Names [${pairs.join(" ")}]`);
    ctx.out(">>");
    ctx.out("endobj");
    namesObjId = oid;
  }
  const outlineId = putOutline(ctx);
  const rootId = ctx.rootDictObjId;
  ctx.newObject();
  ctx.out("<<");
  ctx.out("/Type /Catalog");
  ctx.out(`/Pages ${rootId} 0 R`);
  ctx.out(`/OpenAction [${ctx.pageObjIds[0]} 0 R /FitH null]`);
  ctx.out("/PageLayout /OneColumn");
  if (namesObjId !== null) ctx.out(`/Names << /Dests ${namesObjId} 0 R >>`);
  if (outlineId !== null) {
    ctx.out(`/Outlines ${outlineId} 0 R`);
    ctx.out("/PageMode /UseOutlines");
  }
  if (structTreeRootId !== null) {
    ctx.out("/MarkInfo << /Marked true >>");
    ctx.out(`/StructTreeRoot ${structTreeRootId} 0 R`);
  }
  if (ctx.pdfA && !ctx.metadata.some(([k]) => k === "Lang")) {
    ctx.out(`/Lang ${ctx.strLit(ctx.pdfaLang ?? "en-US")}`);
  }
  if (pdfaExtras) {
    ctx.out(`/Metadata ${pdfaExtras.metadataId} 0 R`);
    ctx.out(`/OutputIntents [${pdfaExtras.outputIntentId} 0 R]`);
  }
  if (ctx.formFieldObjIds.length) {
    ctx.out(`/AcroForm << /Fields [${ctx.formFieldObjIds.map((id) => `${id} 0 R`).join(" ")}] /DR ${ctx.resourceDictObjId} 0 R /NeedAppearances false >>`);
  }
  ctx.out(">>");
  ctx.out("endobj");
  return infoId;
}
function putEncryptDict(ctx) {
  if (!ctx.security) return null;
  const oid = ctx.newObject();
  ctx.out("<<");
  ctx.out("/Filter /Standard");
  ctx.out("/V 5");
  ctx.out("/R 6");
  ctx.out("/Length 256");
  ctx.out("/CF << /StdCF << /CFM /AESV3 /AuthEvent /DocOpen /Length 32 >> >>");
  ctx.out("/StmF /StdCF");
  ctx.out("/StrF /StdCF");
  ctx.out(`/O <${bytesToHex(ctx.security.o)}>`);
  ctx.out(`/U <${bytesToHex(ctx.security.u)}>`);
  ctx.out(`/OE <${bytesToHex(ctx.security.oe)}>`);
  ctx.out(`/UE <${bytesToHex(ctx.security.ue)}>`);
  ctx.out(`/Perms <${bytesToHex(ctx.security.perms)}>`);
  ctx.out(`/P ${ctx.security.permissions | 0}`);
  ctx.out(">>");
  ctx.out("endobj");
  return oid;
}
function buildXrefStream(ctx, catalogId, encryptId, infoId) {
  const xrefOffset = ctx.byteLen;
  const xrefObjId = ctx.objectNumber + 1;
  const total = xrefObjId + 1;
  const stmMap = /* @__PURE__ */ new Map();
  for (const [oid, stmId, idx] of ctx.objStmMembers) stmMap.set(oid, [stmId, idx]);
  const raw = new Uint8Array(total * 7);
  raw[5] = 255;
  raw[6] = 255;
  for (let i = 1; i <= xrefObjId; i++) {
    const b = i * 7;
    if (i === xrefObjId) {
      raw[b] = 1;
      raw[b + 1] = xrefOffset >>> 24 & 255;
      raw[b + 2] = xrefOffset >>> 16 & 255;
      raw[b + 3] = xrefOffset >>> 8 & 255;
      raw[b + 4] = xrefOffset & 255;
    } else if (stmMap.has(i)) {
      const [stmId, idx] = stmMap.get(i);
      raw[b] = 2;
      raw[b + 1] = stmId >>> 24 & 255;
      raw[b + 2] = stmId >>> 16 & 255;
      raw[b + 3] = stmId >>> 8 & 255;
      raw[b + 4] = stmId & 255;
      raw[b + 5] = idx >>> 8 & 255;
      raw[b + 6] = idx & 255;
    } else if (i < ctx.offsets.length) {
      const off = ctx.offsets[i];
      if (off && off !== Number.MAX_SAFE_INTEGER) {
        raw[b] = 1;
        raw[b + 1] = off >>> 24 & 255;
        raw[b + 2] = off >>> 16 & 255;
        raw[b + 3] = off >>> 8 & 255;
        raw[b + 4] = off & 255;
      }
    }
  }
  const comp = deflate(raw);
  const idHex = bytesToHex(ctx.fileId);
  const encPart = encryptId !== null ? `
/Encrypt ${encryptId} 0 R` : "";
  const header = `${xrefObjId} 0 obj
<<
/Type /XRef
/Size ${total}
/W [1 4 2]
/Filter /FlateDecode
/Length ${comp.length}
/Root ${catalogId} 0 R${encPart}
/Info ${infoId} 0 R
/ID [<${idHex}><${idHex}>]
>>
stream
`;
  ctx.write(header);
  ctx.writeBytes(comp);
  ctx.write(`
endstream
endobj
startxref
${xrefOffset}
%%EOF`);
}

// src/types/page.ts
function resolvePageSize(size, orientation) {
  let w, h;
  if (typeof size === "object") {
    w = size.width;
    h = size.height;
    if (!Number.isFinite(w) || !Number.isFinite(h) || w <= 0 || h <= 0) {
      throw new Error(`[daepdf] Invalid custom page size {width: ${w}, height: ${h}} \u2014 both must be finite, positive numbers.`);
    }
  } else {
    const A4 = [595.28, 841.89];
    const presets = {
      A3: [841.89, 1190.55],
      A4,
      A5: [419.53, 595.28],
      Letter: [612, 792],
      Legal: [612, 1008],
      Tabloid: [792, 1224]
    };
    const [pw, ph] = presets[size] ?? A4;
    w = pw;
    h = ph;
  }
  if (orientation === "landscape") return { width: Math.max(w, h), height: Math.min(w, h) };
  return { width: w, height: h };
}

// src/types/doc.ts
function isMcrRef(k) {
  return "mcid" in k;
}

// src/types/commands.ts
function resolveRadius(r) {
  const a = r?.all ?? 0;
  const c = (x) => x ? { h: x.h, v: x.v } : { h: a, v: a };
  return { tl: c(r?.topLeft), tr: c(r?.topRight), br: c(r?.bottomRight), bl: c(r?.bottomLeft) };
}
function anyRadius(rr) {
  const rounded = (c) => c.h > 0 && c.v > 0;
  return rounded(rr.tl) || rounded(rr.tr) || rounded(rr.br) || rounded(rr.bl);
}

// src/pdf_doc/build_structtree.ts
function putStructTree(ctx) {
  const root = ctx.structRoot;
  if (!root || root.kids.length === 0) return null;
  const ids = /* @__PURE__ */ new Map();
  const assign = (node) => {
    ids.set(node, ctx.newObjectDeferred());
    for (const kid of node.kids) if (!isMcrRef(kid)) assign(kid);
  };
  for (const kid of root.kids) if (!isMcrRef(kid)) assign(kid);
  const structTreeRootId = ctx.newObjectDeferred();
  const perPage = /* @__PURE__ */ new Map();
  const writeNode = (node, parentRef) => {
    const id = ids.get(node);
    const kidStrs = [];
    for (const kid of node.kids) {
      if (isMcrRef(kid)) {
        const pageRef = ctx.pageObjIds[kid.page - 1];
        kidStrs.push(`<< /Type /MCR /Pg ${pageRef} 0 R /MCID ${kid.mcid} >>`);
        let arr = perPage.get(kid.page);
        if (!arr) {
          arr = [];
          perPage.set(kid.page, arr);
        }
        arr[kid.mcid] = id;
      } else {
        kidStrs.push(`${ids.get(kid)} 0 R`);
      }
    }
    ctx.newObjectDeferredBegin(id, true);
    ctx.out("<<");
    ctx.out("/Type /StructElem");
    ctx.out(`/S /${toPdfName(node.tag)}`);
    ctx.out(`/P ${parentRef}`);
    ctx.out(kidStrs.length === 1 ? `/K ${kidStrs[0]}` : `/K [${kidStrs.join(" ")}]`);
    if (node.alt) ctx.out(`/Alt ${ctx.strLit(node.alt)}`);
    if (node.lang) ctx.out(`/Lang ${ctx.strLit(node.lang)}`);
    ctx.out(">>");
    ctx.out("endobj");
    for (const kid of node.kids) if (!isMcrRef(kid)) writeNode(kid, `${id} 0 R`);
  };
  const topKids = [];
  for (const kid of root.kids) {
    if (isMcrRef(kid)) continue;
    writeNode(kid, `${structTreeRootId} 0 R`);
    topKids.push(`${ids.get(kid)} 0 R`);
  }
  const numsParts = [];
  for (const [page, arr] of [...perPage.entries()].sort((a, b) => a[0] - b[0])) {
    const arrId = ctx.newObjectDeferred();
    ctx.newObjectDeferredBegin(arrId, true);
    ctx.out(`[${arr.map((id) => id === void 0 ? "null" : `${id} 0 R`).join(" ")}]`);
    ctx.out("endobj");
    numsParts.push(`${page - 1} ${arrId} 0 R`);
  }
  const parentTreeId = ctx.newObjectDeferred();
  ctx.newObjectDeferredBegin(parentTreeId, true);
  ctx.out(`<< /Nums [${numsParts.join(" ")}] >>`);
  ctx.out("endobj");
  ctx.newObjectDeferredBegin(structTreeRootId, true);
  ctx.out("<<");
  ctx.out("/Type /StructTreeRoot");
  ctx.out(`/K [${topKids.join(" ")}]`);
  ctx.out(`/ParentTree ${parentTreeId} 0 R`);
  ctx.out(`/ParentTreeNextKey ${ctx.pageObjIds.length}`);
  ctx.out(">>");
  ctx.out("endobj");
  return structTreeRootId;
}

// src/pdf_doc/icc.ts
function be32(v) {
  const b = new Uint8Array(4);
  new DataView(b.buffer).setUint32(0, v >>> 0, false);
  return b;
}
function be16(v) {
  const b = new Uint8Array(2);
  new DataView(b.buffer).setUint16(0, v & 65535, false);
  return b;
}
function s15Fixed16(v) {
  const b = new Uint8Array(4);
  new DataView(b.buffer).setInt32(0, Math.round(v * 65536), false);
  return b;
}
function tag4(s) {
  return new TextEncoder().encode(s);
}
function concat(...parts) {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
}
function pad4(buf) {
  const rem = buf.length % 4;
  return rem === 0 ? buf : concat(buf, new Uint8Array(4 - rem));
}
function descType(ascii) {
  const asciiBuf = concat(tag4(ascii), new Uint8Array([0]));
  return pad4(concat(
    tag4("desc"),
    be32(0),
    be32(asciiBuf.length),
    asciiBuf,
    be32(0),
    be32(0),
    // unicode language code, unicode count
    be16(0),
    new Uint8Array([0]),
    // scriptcode code, scriptcode count
    new Uint8Array(67)
    // 67-byte macintosh field
  ));
}
function textType(ascii) {
  const asciiBuf = concat(tag4(ascii), new Uint8Array([0]));
  return pad4(concat(tag4("text"), be32(0), asciiBuf));
}
function xyzType(x, y, z) {
  return pad4(concat(tag4("XYZ "), be32(0), s15Fixed16(x), s15Fixed16(y), s15Fixed16(z)));
}
function curvType(gamma) {
  return pad4(concat(tag4("curv"), be32(0), be32(1), be16(Math.round(gamma * 256))));
}
var cached = null;
function buildSRGBProfile() {
  if (cached) return cached;
  const tags = [
    ["cprt", textType("Public Domain, generated by daepdf (approximate sRGB, single-gamma TRC)")],
    ["desc", descType("daepdf approximate sRGB")],
    ["wtpt", xyzType(0.9642, 1, 0.8249)],
    ["rXYZ", xyzType(0.436, 0.2225, 0.0139)],
    ["gXYZ", xyzType(0.3851, 0.7169, 0.0971)],
    ["bXYZ", xyzType(0.1431, 0.0606, 0.7139)],
    ["rTRC", curvType(2.2)],
    ["gTRC", curvType(2.2)],
    ["bTRC", curvType(2.2)]
  ];
  const headerSize = 128;
  const tagTableSize = 4 + tags.length * 12;
  let offset = headerSize + tagTableSize;
  const tagTableEntries = [];
  const tagDataParts = [];
  for (const [sig, data] of tags) {
    tagTableEntries.push(concat(tag4(sig), be32(offset), be32(data.length)));
    tagDataParts.push(data);
    offset += data.length;
  }
  const totalSize = offset;
  const header = new Uint8Array(128);
  const hv = new DataView(header.buffer);
  hv.setUint32(0, totalSize, false);
  hv.setUint32(8, 34603008, false);
  header.set(tag4("mntr"), 12);
  header.set(tag4("RGB "), 16);
  header.set(tag4("XYZ "), 20);
  header.set(tag4("acsp"), 36);
  hv.setUint32(64, 0, false);
  header.set(s15Fixed16(0.9642), 68);
  header.set(s15Fixed16(1), 72);
  header.set(s15Fixed16(0.8249), 76);
  const profile = concat(header, be32(tags.length), concat(...tagTableEntries), concat(...tagDataParts));
  cached = profile;
  return profile;
}

// src/pdf_doc/build_pdfa.ts
function xmlEscape(s) {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;");
}
function putPdfAExtras(ctx) {
  if (!ctx.pdfA) return null;
  const profile = buildSRGBProfile();
  const iccId = ctx.newObject();
  ctx.out("<<");
  ctx.out("/N 3");
  ctx.out(`/Length ${ctx.encryptedLength(profile.length)}`);
  ctx.out(">>");
  ctx.out("stream");
  ctx.outBytes(profile);
  ctx.out("endstream");
  ctx.out("endobj");
  const outputIntentId = ctx.newObject();
  ctx.out("<<");
  ctx.out("/Type /OutputIntent");
  ctx.out("/S /GTS_PDFA1");
  ctx.out(`/OutputConditionIdentifier ${ctx.strLit("sRGB IEC61966-2.1")}`);
  ctx.out(`/Info ${ctx.strLit("sRGB IEC61966-2.1")}`);
  ctx.out(`/DestOutputProfile ${iccId} 0 R`);
  ctx.out(">>");
  ctx.out("endobj");
  const lang = ctx.pdfaLang ?? "en-US";
  const title = ctx.metadata.find(([k]) => k === "Title")?.[1];
  const author = ctx.metadata.find(([k]) => k === "Author")?.[1];
  const titleXml = title ? `<dc:title><rdf:Alt><rdf:li xml:lang="x-default">${xmlEscape(title)}</rdf:li></rdf:Alt></dc:title>` : "";
  const authorXml = author ? `<dc:creator><rdf:Seq><rdf:li>${xmlEscape(author)}</rdf:li></rdf:Seq></dc:creator>` : "";
  const xmp = `<?xpacket begin="\uFEFF" id="W5M0MpCehiHzreSzNTczkc9d"?>
<x:xmpmeta xmlns:x="adobe:ns:meta/">
<rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">
<rdf:Description rdf:about="" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:pdf="http://ns.adobe.com/pdf/1.3/" xmlns:xmp="http://ns.adobe.com/xap/1.0/" xmlns:pdfaid="http://www.aiim.org/pdfa/ns/id/">
${titleXml}${authorXml}<dc:language><rdf:Bag><rdf:li>${xmlEscape(lang)}</rdf:li></rdf:Bag></dc:language>
<pdf:Producer>${xmlEscape(`daepdf ${package_default.version}`)}</pdf:Producer>
<xmp:CreateDate>${(/* @__PURE__ */ new Date()).toISOString()}</xmp:CreateDate>
<pdfaid:part>2</pdfaid:part>
<pdfaid:conformance>A</pdfaid:conformance>
</rdf:Description>
</rdf:RDF>
</x:xmpmeta>
<?xpacket end="w"?>`;
  const xmpBytes = new TextEncoder().encode(xmp);
  const metadataId = ctx.newObject();
  ctx.out("<<");
  ctx.out("/Type /Metadata");
  ctx.out("/Subtype /XML");
  ctx.out(`/Length ${ctx.encryptedLength(xmpBytes.length)}`);
  ctx.out(">>");
  ctx.out("stream");
  ctx.outBytes(xmpBytes);
  ctx.out("endstream");
  ctx.out("endobj");
  return { outputIntentId, metadataId };
}

// src/pdf_doc/index.ts
var Z = { h: 0, v: 0 };
function rounds(c) {
  return c.h > 0 && c.v > 0;
}
function insetCorner(c, by) {
  return { h: Math.max(0, c.h - by), v: Math.max(0, c.v - by) };
}
var PdfDoc = class {
  buf = [];
  byteLen = 0;
  objectNumber = 0;
  offsets = [0];
  fonts = [];
  fontMap = /* @__PURE__ */ new Map();
  usedFonts = /* @__PURE__ */ new Set();
  images = [];
  gradDefs = [];
  shadPats = [];
  gradSoftMasks = [];
  extGStates = [];
  allPageBufs = [];
  pageAnnots = [];
  currentPageIdx = -1;
  pageObjIds = [];
  formFieldObjIds = [];
  // D1 (AcroForm): while set, pageOut() redirects to this scratch buffer
  // instead of the current page's own — lets an appearance stream reuse
  // set_font/set_font_size/set_text_color/text() (with all their correct
  // glyph-shaping/hex-CID/ToUnicode machinery) without touching real page
  // content. captureAppearance() is the only thing that sets/clears it.
  apBuf = null;
  rootDictObjId;
  resourceDictObjId;
  security = void 0;
  fileId;
  metadata = [];
  bookmarks = [];
  namedDests = [];
  objStmQueue = [];
  objStmMembers = [];
  captureStack = [];
  structRoot = void 0;
  pdfA = false;
  pdfaLang = void 0;
  formatW;
  formatH;
  creationDate;
  built = false;
  builtBytes = null;
  activeFontKey = "";
  activeFontSize = 16;
  activeCharSpace = 0;
  activeWordSpace = 0;
  strokeColor = "0 G";
  textColor = "0 g";
  lineWidth = 0.200025;
  // Stream-emission caches: what the CURRENT page's content stream last had written
  // to it. They are per-stream state, so they must be invalidated on any page switch
  // and restored on Q (which reverts font/color/spacing per the PDF graphics-state
  // model). Fill and text colors share the single non-stroke operator (rg/g), so
  // they share one cache — tracking them separately let a box fill silently change
  // the color under a deduped text op (and vice versa).
  lastFontKey = "";
  lastFontSize = -1;
  lastLeading = -1;
  lastNonstroke = "";
  lastStroke = "";
  lastLineWidth = -1;
  lastCharSpace = 0;
  lastWordSpace = 0;
  // PDF text rendering mode (Tr) — 0 fill, 1 stroke, 2 fill+stroke. Persists
  // across BT/ET blocks like the other text-state operators above, so it needs
  // the same page-start reset and q/Q reversion, not just a per-call value.
  lastTextRenderMode = 0;
  // emoji/color-font glyphs (A1): a bitmap glyph repeated across a document
  // (the same emoji reused) would otherwise re-embed identical PNG bytes on
  // every occurrence — keyed by the exact inputs get_glyph_bitmap itself uses
  glyphImageCache = /* @__PURE__ */ new Map();
  // a font's own COLR/bitmap coverage never changes once registered — every
  // ordinary glyph in ordinary text would otherwise pay 1-2 WASM boundary
  // crossings (get_colr_layers + get_glyph_bitmap) on EVERY occurrence, not
  // just the first. Memoized per (font, style, gid[, ppem for bitmap]) so a
  // real document's heavy glyph repetition (the same letters over and over)
  // costs this check exactly once per unique glyph, not once per character.
  colrCache = /* @__PURE__ */ new Map();
  bitmapCache = /* @__PURE__ */ new Map();
  gsStack = [];
  constructor(width, height) {
    this.formatW = width;
    this.formatH = height;
    this.fileId = crypto.getRandomValues(new Uint8Array(16));
    this.creationDate = pdfDate();
    this.write("%PDF-1.6\n");
    this.writeBytes(new Uint8Array([37, 186, 223, 172, 224, 10]));
    this.rootDictObjId = this.newObjectDeferred();
    this.resourceDictObjId = this.newObjectDeferred();
    this.addPageInternal();
  }
  get ctx() {
    return this;
  }
  write(s) {
    const enc = _te.encode(s);
    this.buf.push(enc);
    this.byteLen += enc.length;
  }
  writeBytes(b) {
    this.buf.push(b);
    this.byteLen += b.length;
  }
  newObjectDeferred() {
    this.objectNumber++;
    while (this.offsets.length <= this.objectNumber) this.offsets.push(0);
    this.offsets[this.objectNumber] = Number.MAX_SAFE_INTEGER;
    return this.objectNumber;
  }
  newObjectDeferredBegin(oid, doOutput) {
    while (this.offsets.length <= oid) this.offsets.push(0);
    this.offsets[oid] = this.byteLen;
    if (doOutput) this.out(`${oid} 0 obj`);
  }
  newObject() {
    const oid = this.newObjectDeferred();
    this.newObjectDeferredBegin(oid, true);
    return oid;
  }
  out(s) {
    const top = this.captureStack.at(-1);
    if (top) top.push(s + "\n");
    else this.write(s + "\n");
  }
  outBytes(b) {
    const data = this.encBytes(b);
    this.writeBytes(data);
    this.write("\n");
  }
  // Every stream's /Length dict entry is written BEFORE outBytes() runs
  // (PDF syntax requires the dict to precede the `stream` keyword), so a
  // caller computing /Length from its own plaintext buffer's length is
  // silently wrong the moment encryption is on: encBytes() grows the
  // written bytes by a 16-byte IV plus 1-16 bytes of PKCS#7 padding, which
  // the dict never accounted for. Every /Length-then-outBytes call site
  // must run its plaintext length through this first.
  encryptedLength(plainLen) {
    if (!this.security) return plainLen;
    const paddedLen = Math.ceil((plainLen + 1) / 16) * 16;
    return 16 + paddedLen;
  }
  beginCapture() {
    this.captureStack.push([]);
  }
  endCapture() {
    return (this.captureStack.pop() ?? []).join("");
  }
  queueForObjStm(content) {
    const oid = this.newObjectDeferred();
    this.objStmQueue.push({ oid, content });
    return oid;
  }
  // V5/R6 (AESV3): every object is encrypted with the SAME file key — no
  // per-object key derivation like the R3 handler this replaced needed —
  // just a fresh random IV per string/stream, prepended to the ciphertext
  strLit(s) {
    const bytes2 = textStringBytes(s);
    if (this.security) {
      const iv = crypto.getRandomValues(new Uint8Array(16));
      const ct = aesCbcEncrypt(this.security.fileKey, iv, bytes2, true);
      return `<${bytesToHex(iv)}${bytesToHex(ct)}>`;
    }
    if (bytes2.length >= 2 && bytes2[0] === 254 && bytes2[1] === 255) return `<${bytesToHex(bytes2)}>`;
    return `(${pdfEscape(s)})`;
  }
  encBytes(data) {
    if (!this.security) return data;
    const iv = crypto.getRandomValues(new Uint8Array(16));
    const ct = aesCbcEncrypt(this.security.fileKey, iv, data, true);
    const out = new Uint8Array(iv.length + ct.length);
    out.set(iv);
    out.set(ct, iv.length);
    return out;
  }
  pageOut(s) {
    if (this.apBuf) {
      this.apBuf.push(s);
      return;
    }
    this.allPageBufs[this.currentPageIdx]?.push(s);
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
  captureAppearance(draw) {
    const saved = this.apBuf;
    this.apBuf = [];
    const savedFontKey = this.lastFontKey, savedFontSize = this.lastFontSize, savedLeading = this.lastLeading;
    const savedNonstroke = this.lastNonstroke, savedStroke = this.lastStroke, savedLineWidth = this.lastLineWidth;
    const savedCharSpace = this.lastCharSpace, savedWordSpace = this.lastWordSpace;
    const savedTextRenderMode = this.lastTextRenderMode;
    this.lastFontKey = "";
    this.lastFontSize = -1;
    this.lastLeading = -1;
    this.lastNonstroke = "";
    this.lastStroke = "";
    this.lastLineWidth = -1;
    this.lastCharSpace = -1;
    this.lastWordSpace = -1;
    this.lastTextRenderMode = -1;
    this.save_graphics_state();
    draw();
    this.restore_graphics_state();
    this.lastFontKey = savedFontKey;
    this.lastFontSize = savedFontSize;
    this.lastLeading = savedLeading;
    this.lastNonstroke = savedNonstroke;
    this.lastStroke = savedStroke;
    this.lastLineWidth = savedLineWidth;
    this.lastCharSpace = savedCharSpace;
    this.lastWordSpace = savedWordSpace;
    this.lastTextRenderMode = savedTextRenderMode;
    const result = this.apBuf.join("\n");
    this.apBuf = saved;
    return result;
  }
  putStyle(style) {
    this.pageOut(style === "F" ? "f" : "S");
  }
  addPageInternal() {
    this.allPageBufs.push([]);
    this.pageAnnots.push([]);
    this.currentPageIdx = this.allPageBufs.length - 1;
    this.lastFontKey = "";
    this.lastFontSize = -1;
    this.lastLeading = -1;
    this.lastNonstroke = "";
    this.lastCharSpace = 0;
    this.lastWordSpace = 0;
    this.lastTextRenderMode = 0;
    this.pageOut(`${hpf(this.lineWidth)} w`);
    this.pageOut(this.strokeColor);
    this.lastLineWidth = this.lineWidth;
    this.lastStroke = this.strokeColor;
  }
  getOrCreateFont(name, style, weight) {
    const key = `${name.toLowerCase()}|${style}:${weight}`;
    const existing = this.fontMap.get(key);
    if (existing !== void 0) return this.fonts[existing];
    const id = `F${this.fonts.length + 1}`;
    const idx = this.fonts.length;
    this.fonts.push({
      id,
      fontName: name,
      style,
      weight,
      opsz: 0,
      glyphIds: /* @__PURE__ */ new Set([0]),
      glyphToUnicode: /* @__PURE__ */ new Map(),
      objectNumber: 0,
      isAlreadyPutted: false,
      usedVertically: false,
      verticalObjectNumber: 0
    });
    this.fontMap.set(key, idx);
    return this.fonts[idx];
  }
  set_font(fontName, fontStyle, cssWeight) {
    this.activeFontKey = this.getOrCreateFont(fontName, fontStyle, cssWeight).id;
  }
  set_font_size(size) {
    this.activeFontSize = size;
  }
  set_char_space(space) {
    this.activeCharSpace = space;
  }
  set_word_spacing(pt) {
    this.activeWordSpace = pt;
  }
  // 3 decimals to match set_text_color — at 2, a box and text in the same subtle
  // hex shade can encode to visibly different grays (1/255 ≈ 0.004)
  set_draw_color(r, g, b) {
    const c = encodeColor(r, g, b, true, 3);
    this.strokeColor = c;
    if (c !== this.lastStroke) {
      this.pageOut(c);
      this.lastStroke = c;
    }
  }
  set_fill_color(r, g, b) {
    const c = encodeColor(r, g, b, false, 3);
    if (c !== this.lastNonstroke) {
      this.pageOut(c);
      this.lastNonstroke = c;
    }
  }
  set_text_color(r, g, b) {
    this.textColor = encodeColor(r, g, b, false, 3);
  }
  set_line_width(width) {
    this.lineWidth = width;
    if (width !== this.lastLineWidth) {
      this.pageOut(`${hpf(width)} w`);
      this.lastLineWidth = width;
    }
  }
  set_line_dash(dashArray, dashPhase) {
    const arr = dashArray && dashArray.length ? dashArray.map(hpf).join(" ") : "";
    this.pageOut(`[${arr}] ${hpf(dashPhase)} d`);
  }
  // PDF line cap (J): 0 butt (default), 1 round, 2 projecting square —
  // matches SVG stroke-linecap's butt/round/square 1:1
  set_line_cap(cap) {
    this.pageOut(`${cap} J`);
  }
  // PDF line join (j): 0 miter (default), 1 round, 2 bevel — matches SVG
  // stroke-linejoin's miter/round/bevel (miter-clip/arcs, SVG2 additions
  // with no PDF equivalent, degrade to the miter default)
  set_line_join(join) {
    this.pageOut(`${join} j`);
  }
  save_graphics_state() {
    this.gsStack.push({
      activeKey: this.activeFontKey,
      activeSize: this.activeFontSize,
      textColor: this.textColor,
      strokeColor: this.strokeColor,
      lineWidth: this.lineWidth,
      activeCharSpace: this.activeCharSpace,
      activeWordSpace: this.activeWordSpace,
      lastFontKey: this.lastFontKey,
      lastFontSize: this.lastFontSize,
      lastLeading: this.lastLeading,
      lastNonstroke: this.lastNonstroke,
      lastStroke: this.lastStroke,
      lastLineWidth: this.lastLineWidth,
      lastCharSpace: this.lastCharSpace,
      lastWordSpace: this.lastWordSpace,
      lastTextRenderMode: this.lastTextRenderMode
    });
    this.pageOut("q");
  }
  // Q reverts the stream's font/size/color/spacing to their values at the matching q
  // — the emission caches must revert with it, or the next op that happens to match
  // the inside-the-region value gets deduped away and renders with the reverted state
  restore_graphics_state() {
    this.pageOut("Q");
    const st = this.gsStack.pop();
    if (st) {
      this.activeFontKey = st.activeKey;
      this.activeFontSize = st.activeSize;
      this.textColor = st.textColor;
      this.strokeColor = st.strokeColor;
      this.lineWidth = st.lineWidth;
      this.activeCharSpace = st.activeCharSpace;
      this.activeWordSpace = st.activeWordSpace;
      this.lastFontKey = st.lastFontKey;
      this.lastFontSize = st.lastFontSize;
      this.lastLeading = st.lastLeading;
      this.lastNonstroke = st.lastNonstroke;
      this.lastStroke = st.lastStroke;
      this.lastLineWidth = st.lastLineWidth;
      this.lastCharSpace = st.lastCharSpace;
      this.lastWordSpace = st.lastWordSpace;
      this.lastTextRenderMode = st.lastTextRenderMode;
    } else {
      this.lastFontKey = "";
      this.lastFontSize = -1;
      this.lastLeading = -1;
      this.lastNonstroke = "";
      this.lastStroke = "";
      this.lastLineWidth = -1;
      this.lastCharSpace = -1;
      this.lastWordSpace = -1;
      this.lastTextRenderMode = -1;
    }
  }
  // blend defaults to Normal (never omitted from the dict) — an ExtGState's /BM
  // key that's merely absent means "leave blend mode unchanged" per spec, which
  // would leak a prior non-Normal mode into whatever draws next instead of resetting it
  set_alpha(opacity, blend) {
    const bm = blend ?? "Normal";
    const rounded = Math.round(Math.max(0, Math.min(1, opacity)) * 1e3);
    let idx = this.extGStates.findIndex((v) => Math.round(v.alpha * 1e3) === rounded && v.blend === bm);
    if (idx < 0) {
      idx = this.extGStates.length;
      this.extGStates.push({ alpha: opacity, blend: bm });
    }
    this.pageOut(`/GS${idx} gs`);
  }
  set_clip_rect(x, y, w, h) {
    const yp = this.formatH - y - h;
    this.pageOut(`${hpf(x)} ${hpf(yp)} ${hpf(w)} ${hpf(h)} re W n`);
  }
  // even-odd clip to everything OUTSIDE the given rounded rect — outer box-shadows
  // must not paint under the box itself (the spec clips them out of the border box)
  set_clip_outside_rounded_rect(x, y, w, h, tl, tr, br, bl) {
    this.pathRect(0, 0, this.formatW, this.formatH);
    this.pathRoundedRect(x, y, w, h, tl, tr, br, bl);
    this.pageOut("W* n");
  }
  set_clip_rounded_rect(x, y, w, h, tl, tr, br, bl) {
    if (!rounds(tl) && !rounds(tr) && !rounds(br) && !rounds(bl)) {
      this.set_clip_rect(x, y, w, h);
      return;
    }
    this.pathRoundedRect(x, y, w, h, tl, tr, br, bl);
    this.pageOut("W n");
  }
  // shared by set_clip_path and draw_path (D5) — every PathSeg-consuming
  // caller needs the identical DOM-Y-down-to-PDF-Y-up flip, on just the Y
  // component of each point, applied exactly once at this one boundary.
  emitPathOps(ops) {
    const ph = this.formatH;
    for (const seg of ops) {
      const [a0 = 0, a1 = 0, a2 = 0, a3 = 0, a4 = 0, a5 = 0] = seg.args;
      if (seg.op === "m") this.pageOut(`${hpf(a0)} ${hpf(ph - a1)} m`);
      else if (seg.op === "l") this.pageOut(`${hpf(a0)} ${hpf(ph - a1)} l`);
      else this.pageOut(`${hpf(a0)} ${hpf(ph - a1)} ${hpf(a2)} ${hpf(ph - a3)} ${hpf(a4)} ${hpf(ph - a5)} c`);
    }
  }
  // clip-path: polygon()/path() — an arbitrary path clip (nonzero or even-odd
  // winding) rather than a (rounded) rect. `m`ove starts each subpath; a path
  // clip-path is always effectively closed (the clip region is well-defined
  // even for an open subpath, per PDF's own W/W* semantics), so no explicit
  // closepath operator is needed before W/W*.
  set_clip_path(ops, evenOdd) {
    this.emitPathOps(ops);
    this.pageOut(evenOdd ? "W* n" : "W n");
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
  draw_path(ops, evenOdd, fill, gradientFill, stroke) {
    const hasFill = fill !== void 0 || gradientFill !== void 0;
    const hasStroke = stroke !== void 0;
    if (!hasFill && !hasStroke) return;
    if (gradientFill) {
      this.save_graphics_state();
      const patName = `Sh${this.shadPats.length}`;
      const gsOp = this.registerSoftMaskIfNeeded(
        gradientFill.gradientId,
        gradientFill.x,
        gradientFill.y,
        gradientFill.w,
        gradientFill.h
      );
      if (gsOp) this.pageOut(gsOp.trimEnd());
      this.shadPats.push({
        patName,
        defIdx: gradientFill.gradientId,
        x: gradientFill.x,
        y: gradientFill.y,
        w: gradientFill.w,
        h: gradientFill.h,
        pageH: this.formatH,
        objId: 0
      });
      this.pageOut("/Pattern cs");
      this.pageOut(`/${patName} scn`);
      this.emitPathOps(ops);
      this.pageOut(evenOdd ? "f*" : "f");
      this.restore_graphics_state();
    } else if (fill) {
      this.set_fill_color(fill[0], fill[1], fill[2]);
      if (!hasStroke) {
        this.emitPathOps(ops);
        this.pageOut(evenOdd ? "f*" : "f");
      }
    }
    if (hasStroke) {
      this.set_draw_color(stroke.color[0], stroke.color[1], stroke.color[2]);
      this.set_line_width(stroke.width);
      if (stroke.dash?.length) this.set_line_dash(stroke.dash, 0);
      if (stroke.lineCap) this.set_line_cap(stroke.lineCap);
      if (stroke.lineJoin) this.set_line_join(stroke.lineJoin);
      this.emitPathOps(ops);
      this.pageOut(fill && !gradientFill ? evenOdd ? "B*" : "B" : "S");
      if (stroke.dash?.length) this.set_line_dash([], 0);
      if (stroke.lineCap) this.set_line_cap(0);
      if (stroke.lineJoin) this.set_line_join(0);
    }
  }
  // CSS transforms: matrix is the PDF-native cm 6-tuple, already Y-adapted and
  // origin-pivoted by html/transform.ts. Callers pair this with
  // save_graphics_state()/restore_graphics_state() the same way clip-push/pop
  // do — cm concatenates onto the CTM, so it must be scoped by q/Q or it leaks
  // into every draw for the rest of the page.
  set_transform(matrix) {
    this.pageOut(`${matrix.map(hpf).join(" ")} cm`);
  }
  // D3 (tagged PDF): wraps content in BDC/EMC so it can be traced back to a
  // /StructTreeRoot element via (page, mcid) — the inline << /MCID n >>
  // dict needs no /Properties resource entry (that's only required when
  // BDC's 2nd operand is a NAME reference into the resource dict instead of
  // an inline dict, per PDF 32000-1 §14.6.2)
  begin_marked_content(structTag, mcid) {
    this.pageOut(`/${toPdfName(structTag)} << /MCID ${mcid} >> BDC`);
  }
  end_marked_content() {
    this.pageOut("EMC");
  }
  // stroke: -webkit-text-stroke — strokeOnly picks Tr 1 (stroke only), otherwise
  // Tr 2 (fill+stroke). Stroke color/width reuse the same graphics-state operators
  // (RG/w) path and rect strokes already use — it's the same PDF state either way.
  text(text, x, y, baseline, stroke) {
    if (!text) return;
    const height = this.activeFontSize;
    const leading = height * 1.15;
    const descent = height * 0.15;
    let adjY = y;
    if (baseline === "bottom") adjY = y - descent;
    else if (baseline === "top") adjY = y + height - descent;
    else if (baseline === "hanging") adjY = y + height - 2 * descent;
    else if (baseline === "middle") adjY = y + height / 2 - descent;
    const font = this.fonts.find((f) => f.id === this.activeFontKey);
    if (!font) return;
    if (stroke) {
      this.set_draw_color(stroke.color[0], stroke.color[1], stroke.color[2]);
      this.set_line_width(stroke.width);
    }
    const textRenderMode = stroke ? stroke.strokeOnly ? 1 : 2 : 0;
    const posY = this.formatH - adjY;
    this.usedFonts.add(this.activeFontKey);
    const chars = [...text];
    let body = null;
    const shaped = shape_text(text, font.fontName, font.style, font.weight, font.opsz, false);
    if (shaped && shaped.glyphs.length) {
      const gids = shaped.glyphs;
      const hmtx = get_advance_widths(font.fontName, font.style, font.weight, font.opsz, gids);
      const sorted = [...new Set(shaped.clusters)].sort((a, b) => a - b);
      const nextOf = /* @__PURE__ */ new Map();
      for (const [s, c] of sorted.entries()) nextOf.set(c, sorted[s + 1] ?? chars.length);
      const colrOf = new Array(gids.length).fill(null);
      const bitmapOf = new Array(gids.length).fill(null);
      let hasSpecial = false;
      const targetPpem = Math.max(1, Math.round(height * 3));
      for (const [i, gid] of gids.entries()) {
        const colrKey = `${font.fontName}|${font.style}|${gid}`;
        let layers = this.colrCache.get(colrKey);
        if (layers === void 0) {
          const layersRaw = get_colr_layers(font.fontName, font.style, gid);
          layers = layersRaw.length ? [] : null;
          if (layers) {
            for (let k = 0; k + 5 < layersRaw.length; k += 6) {
              layers.push({ gid: layersRaw[k], r: layersRaw[k + 1], g: layersRaw[k + 2], b: layersRaw[k + 3], isFg: layersRaw[k + 5] !== 0 });
            }
          }
          this.colrCache.set(colrKey, layers);
        }
        if (layers) {
          colrOf[i] = layers;
          hasSpecial = true;
          continue;
        }
        const bmKey = `${colrKey}|${targetPpem}`;
        let bm = this.bitmapCache.get(bmKey);
        if (bm === void 0) {
          bm = get_glyph_bitmap(font.fontName, font.style, gid, targetPpem);
          this.bitmapCache.set(bmKey, bm);
        }
        if (bm) {
          bitmapOf[i] = bm;
          hasSpecial = true;
        }
      }
      if (!hasSpecial) {
        const parts = [];
        let run = "";
        for (const [i, gid] of gids.entries()) {
          font.glyphIds.add(gid);
          if (!font.glyphToUnicode.has(gid)) {
            const c0 = shaped.clusters[i];
            const cps = chars.slice(c0, nextOf.get(c0)).map((ch) => ch.codePointAt(0));
            font.glyphToUnicode.set(gid, cps.length ? cps : [65533]);
          }
          run += gid.toString(16).padStart(4, "0");
          const adj = (hmtx[i] ?? 0) - shaped.advances[i];
          if (Math.abs(adj) >= 0.5 && i < gids.length - 1) {
            parts.push(`<${run}>`, hpf(adj));
            run = "";
          }
        }
        if (run) parts.push(`<${run}>`);
        body = parts.length === 1 ? `${parts[0]} Tj` : `[${parts.join(" ")}] TJ`;
      } else {
        this.emitColorGlyphRun(
          gids,
          hmtx,
          shaped,
          chars,
          nextOf,
          colrOf,
          bitmapOf,
          font,
          height,
          x,
          adjY,
          posY,
          stroke
        );
        return;
      }
    }
    if (body === null) {
      const gidArr = get_glyph_ids(text, font.fontName, font.style, font.weight);
      let hexStr = "";
      for (const [i, ch] of chars.entries()) {
        const gid = gidArr[i] ?? 0;
        const cp = ch.codePointAt(0);
        font.glyphIds.add(gid);
        if (!font.glyphToUnicode.has(gid)) font.glyphToUnicode.set(gid, [cp]);
        hexStr += gid.toString(16).padStart(4, "0");
      }
      body = `<${hexStr}> Tj`;
    }
    const charSpace = this.activeCharSpace;
    const wordSpace = this.activeWordSpace;
    let result = "BT\n";
    if (this.activeFontKey !== this.lastFontKey || height !== this.lastFontSize || leading !== this.lastLeading) {
      result += `/${this.activeFontKey} ${height} Tf
${hpf(leading)} TL
`;
      this.lastFontKey = this.activeFontKey;
      this.lastFontSize = height;
      this.lastLeading = leading;
    }
    if (this.textColor !== this.lastNonstroke) {
      result += this.textColor + "\n";
      this.lastNonstroke = this.textColor;
    }
    if (charSpace !== this.lastCharSpace) {
      result += `${hpf(charSpace)} Tc
`;
      this.lastCharSpace = charSpace;
    }
    if (wordSpace !== this.lastWordSpace) {
      result += `${hpf(wordSpace)} Tw
`;
      this.lastWordSpace = wordSpace;
    }
    if (textRenderMode !== this.lastTextRenderMode) {
      result += `${textRenderMode} Tr
`;
      this.lastTextRenderMode = textRenderMode;
    }
    result += `${hpf(x)} ${hpf(posY)} Td
${body}
ET`;
    this.pageOut(result);
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
  emitColorGlyphRun(gids, hmtx, shaped, chars, nextOf, colrOf, bitmapOf, font, height, x, adjY, posY, stroke) {
    const textRenderMode = stroke ? stroke.strokeOnly ? 1 : 2 : 0;
    const leading = height * 1.15;
    const charSpace = this.activeCharSpace;
    const wordSpace = this.activeWordSpace;
    let setup = "";
    if (this.activeFontKey !== this.lastFontKey || height !== this.lastFontSize || leading !== this.lastLeading) {
      setup += `/${this.activeFontKey} ${height} Tf
${hpf(leading)} TL
`;
      this.lastFontKey = this.activeFontKey;
      this.lastFontSize = height;
      this.lastLeading = leading;
    }
    if (this.textColor !== this.lastNonstroke) {
      setup += this.textColor + "\n";
      this.lastNonstroke = this.textColor;
    }
    if (charSpace !== this.lastCharSpace) {
      setup += `${hpf(charSpace)} Tc
`;
      this.lastCharSpace = charSpace;
    }
    if (wordSpace !== this.lastWordSpace) {
      setup += `${hpf(wordSpace)} Tw
`;
      this.lastWordSpace = wordSpace;
    }
    if (textRenderMode !== this.lastTextRenderMode) {
      setup += `${textRenderMode} Tr
`;
      this.lastTextRenderMode = textRenderMode;
    }
    if (setup) this.pageOut(setup.replace(/\n$/, ""));
    let cum = 0;
    const cumBefore = new Float64Array(gids.length);
    for (let i = 0; i < gids.length; i++) {
      cumBefore[i] = cum;
      cum += shaped.advances[i];
    }
    const xAt = (i) => x + cumBefore[i] * height / 1e3;
    const trackUnicode = (gid, clusterGid) => {
      font.glyphIds.add(gid);
      if (!font.glyphToUnicode.has(gid)) {
        const c0 = shaped.clusters[clusterGid];
        const cps = chars.slice(c0, nextOf.get(c0)).map((ch) => ch.codePointAt(0));
        font.glyphToUnicode.set(gid, cps.length ? cps : [65533]);
      }
    };
    const buildRunBody = (from, to) => {
      const parts = [];
      let run = "";
      for (let i = from; i < to; i++) {
        const gid = gids[i];
        trackUnicode(gid, i);
        run += gid.toString(16).padStart(4, "0");
        const adj = (hmtx[i] ?? 0) - shaped.advances[i];
        if (Math.abs(adj) >= 0.5 && i < to - 1) {
          parts.push(`<${run}>`, hpf(adj));
          run = "";
        }
      }
      if (run) parts.push(`<${run}>`);
      return parts.length === 1 ? parts[0] + " Tj" : `[${parts.join(" ")}] TJ`;
    };
    let runStart = -1;
    for (let i = 0; i <= gids.length; i++) {
      const atEnd = i >= gids.length;
      const special = !atEnd && (colrOf[i] || bitmapOf[i]);
      if (!special && !atEnd) {
        if (runStart < 0) runStart = i;
        continue;
      }
      if (runStart >= 0) {
        this.pageOut(`BT
${hpf(xAt(runStart))} ${hpf(posY)} Td
${buildRunBody(runStart, i)}
ET`);
        runStart = -1;
      }
      if (atEnd) break;
      if (colrOf[i]) {
        trackUnicode(gids[i], i);
        const lines = ["BT", `${hpf(xAt(i))} ${hpf(posY)} Td`];
        for (const layer of colrOf[i]) {
          trackUnicode(layer.gid, i);
          lines.push(layer.isFg ? this.textColor : encodeColor(layer.r, layer.g, layer.b, false));
          lines.push(`<${layer.gid.toString(16).padStart(4, "0")}> Tj`);
        }
        lines.push("ET");
        this.pageOut(lines.join("\n"));
        this.lastNonstroke = "";
      } else if (bitmapOf[i]) {
        const bm = bitmapOf[i];
        font.glyphIds.add(gids[i]);
        const cacheKey = `${font.fontName}|${font.style}|${gids[i]}|${bm.ppem}`;
        let imgId = this.glyphImageCache.get(cacheKey);
        if (imgId === void 0) {
          imgId = this.embed_image(bm.png);
          if (imgId !== 4294967295) this.glyphImageCache.set(cacheKey, imgId);
        }
        const img = imgId === void 0 ? void 0 : this.images[imgId];
        if (img && imgId !== void 0) {
          const scale = height / bm.ppem;
          const wPt = img.width * scale;
          const hPt = img.height * scale;
          const drawX = xAt(i) + bm.originX * scale;
          const topY = adjY - bm.originY * scale - hPt;
          this.draw_image(imgId, drawX, topY, wPt, hPt);
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
  text_vertical(text, x, yTop, stroke) {
    if (!text) return;
    const height = this.activeFontSize;
    const leading = height * 1.15;
    const font = this.fonts.find((f) => f.id === this.activeFontKey);
    if (!font) return;
    font.usedVertically = true;
    if (stroke) {
      this.set_draw_color(stroke.color[0], stroke.color[1], stroke.color[2]);
      this.set_line_width(stroke.width);
    }
    const textRenderMode = stroke ? stroke.strokeOnly ? 1 : 2 : 0;
    this.usedFonts.add(this.activeFontKey);
    const vFontKey = `${this.activeFontKey}V`;
    const chars = [...text];
    const shaped = shape_text(text, font.fontName, font.style, font.weight, font.opsz, true);
    let body;
    if (shaped && shaped.glyphs.length) {
      const gids = shaped.glyphs;
      const vAdvs = Float64Array.from(gids, (gid) => {
        const raw = get_vertical_advance(font.fontName, font.style, font.weight, font.opsz, gid);
        return raw > 0 ? raw : 1e3;
      });
      const sorted = [...new Set(shaped.clusters)].sort((a, b) => a - b);
      const nextOf = /* @__PURE__ */ new Map();
      for (const [s, c] of sorted.entries()) nextOf.set(c, sorted[s + 1] ?? chars.length);
      const parts = [];
      let run = "";
      for (const [i, gid] of gids.entries()) {
        font.glyphIds.add(gid);
        if (!font.glyphToUnicode.has(gid)) {
          const c0 = shaped.clusters[i];
          const cps = chars.slice(c0, nextOf.get(c0)).map((ch) => ch.codePointAt(0));
          font.glyphToUnicode.set(gid, cps.length ? cps : [65533]);
        }
        run += gid.toString(16).padStart(4, "0");
        const adj = (vAdvs[i] ?? 0) - shaped.advances[i];
        if (Math.abs(adj) >= 0.5 && i < gids.length - 1) {
          parts.push(`<${run}>`, hpf(adj));
          run = "";
        }
      }
      if (run) parts.push(`<${run}>`);
      body = parts.length === 1 ? `${parts[0]} Tj` : `[${parts.join(" ")}] TJ`;
    } else {
      const gidArr = get_glyph_ids(text, font.fontName, font.style, font.weight);
      let hexStr = "";
      for (const [i, ch] of chars.entries()) {
        const gid = gidArr[i] ?? 0;
        const cp = ch.codePointAt(0);
        font.glyphIds.add(gid);
        if (!font.glyphToUnicode.has(gid)) font.glyphToUnicode.set(gid, [cp]);
        hexStr += gid.toString(16).padStart(4, "0");
      }
      body = `<${hexStr}> Tj`;
    }
    const charSpace = this.activeCharSpace;
    const wordSpace = this.activeWordSpace;
    const adjY = yTop + height * 0.85;
    const posY = this.formatH - adjY;
    let result = "BT\n";
    if (vFontKey !== this.lastFontKey || height !== this.lastFontSize || leading !== this.lastLeading) {
      result += `/${vFontKey} ${height} Tf
${hpf(leading)} TL
`;
      this.lastFontKey = vFontKey;
      this.lastFontSize = height;
      this.lastLeading = leading;
    }
    if (this.textColor !== this.lastNonstroke) {
      result += this.textColor + "\n";
      this.lastNonstroke = this.textColor;
    }
    if (charSpace !== this.lastCharSpace) {
      result += `${hpf(charSpace)} Tc
`;
      this.lastCharSpace = charSpace;
    }
    if (wordSpace !== this.lastWordSpace) {
      result += `${hpf(wordSpace)} Tw
`;
      this.lastWordSpace = wordSpace;
    }
    if (textRenderMode !== this.lastTextRenderMode) {
      result += `${textRenderMode} Tr
`;
      this.lastTextRenderMode = textRenderMode;
    }
    result += `${hpf(x)} ${hpf(posY)} Td
${body}
ET`;
    this.pageOut(result);
  }
  pathRect(x, y, w, h) {
    this.pageOut(`${hpf(x)} ${hpf(this.formatH - y)} ${hpf(w)} ${hpf(-h)} re`);
  }
  // Elliptical corners: the K=0.5523 bezier quadrant approximation applies
  // independently per axis — control-point x offsets scale with the corner's h
  // radius, y offsets with its v radius. rounds() gates each corner: CSS says a
  // corner with EITHER component zero is square, so a degenerate corner (h>0,
  // v=0 after insetting) must not emit a lopsided curve.
  pathRoundedRect(x, y, w, h, tl, tr, br, bl) {
    const TL = rounds(tl) ? tl : Z, TR = rounds(tr) ? tr : Z;
    const BR = rounds(br) ? br : Z, BL = rounds(bl) ? bl : Z;
    if (TL === Z && TR === Z && BR === Z && BL === Z) {
      this.pathRect(x, y, w, h);
      return;
    }
    const ph = this.formatH, yt = ph - y, yb = ph - y - h, K = 0.5523;
    this.pageOut(`${hpf(x + TL.h)} ${hpf(yt)} m`);
    this.pageOut(`${hpf(x + w - TR.h)} ${hpf(yt)} l`);
    if (TR !== Z) this.pageOut(`${hpf(x + w - TR.h + TR.h * K)} ${hpf(yt)} ${hpf(x + w)} ${hpf(yt - TR.v + TR.v * K)} ${hpf(x + w)} ${hpf(yt - TR.v)} c`);
    this.pageOut(`${hpf(x + w)} ${hpf(yb + BR.v)} l`);
    if (BR !== Z) this.pageOut(`${hpf(x + w)} ${hpf(yb + BR.v - BR.v * K)} ${hpf(x + w - BR.h + BR.h * K)} ${hpf(yb)} ${hpf(x + w - BR.h)} ${hpf(yb)} c`);
    this.pageOut(`${hpf(x + BL.h)} ${hpf(yb)} l`);
    if (BL !== Z) this.pageOut(`${hpf(x + BL.h - BL.h * K)} ${hpf(yb)} ${hpf(x)} ${hpf(yb + BL.v - BL.v * K)} ${hpf(x)} ${hpf(yb + BL.v)} c`);
    this.pageOut(`${hpf(x)} ${hpf(yt - TL.v)} l`);
    if (TL !== Z) this.pageOut(`${hpf(x)} ${hpf(yt - TL.v + TL.v * K)} ${hpf(x + TL.h - TL.h * K)} ${hpf(yt)} ${hpf(x + TL.h)} ${hpf(yt)} c`);
    this.pageOut("h");
  }
  rect(x, y, w, h, style) {
    this.pathRect(x, y, w, h);
    this.putStyle(style);
  }
  rounded_rect(x, y, w, h, tl, tr, br, bl, style) {
    this.pathRoundedRect(x, y, w, h, tl, tr, br, bl);
    this.putStyle(style);
  }
  // Fills the exact band between an outer and inner rounded-rect path (even-odd winding),
  // rather than stroking a single centered path. This makes the border's outer curve use
  // the identical construction as an overflow:hidden clip at the same radius — a stroke's
  // curve-offset approximation and a directly-built curve can disagree by a hair at the
  // arc itself (never on straight edges), which is visible wherever a border meets a clip.
  border_ring(x, y, w, h, tl, tr, br, bl, strokeWidth) {
    const sw = strokeWidth;
    const ix = x + sw, iy = y + sw;
    const iw = Math.max(0, w - 2 * sw), ih = Math.max(0, h - 2 * sw);
    this.pathRoundedRect(x, y, w, h, tl, tr, br, bl);
    if (iw > 0 && ih > 0) {
      this.pathRoundedRect(ix, iy, iw, ih, insetCorner(tl, sw), insetCorner(tr, sw), insetCorner(br, sw), insetCorner(bl, sw));
    }
    this.pageOut("f*");
  }
  // Dashed/dotted borders and outlines: border_ring's even-odd band fill has no
  // way to carry a dash pattern, so this strokes the rounded-rect path itself,
  // centered on the same band (inset by half the stroke width) that border_ring
  // fills solid — the straight-line dashed branch already centers its strokes
  // the same way, so a rounded and a straight dashed border land on one band.
  stroke_rounded_rect_dashed(x, y, w, h, tl, tr, br, bl, strokeWidth, dashArray) {
    const half = strokeWidth / 2;
    const ix = x + half, iy = y + half;
    const iw = Math.max(0, w - strokeWidth), ih = Math.max(0, h - strokeWidth);
    this.set_line_width(strokeWidth);
    this.set_line_dash(dashArray, 0);
    this.pathRoundedRect(ix, iy, iw, ih, insetCorner(tl, half), insetCorner(tr, half), insetCorner(br, half), insetCorner(bl, half));
    this.pageOut("S");
    this.set_line_dash([], 0);
  }
  line(x1, y1, x2, y2) {
    const ph = this.formatH;
    this.pageOut(`${hpf(x1)} ${hpf(ph - y1)} m`);
    this.pageOut(`${hpf(x2)} ${hpf(ph - y2)} l`);
    this.pageOut("S");
  }
  // text-decoration-style: wavy — approximated as a sine-like squiggle of cubic
  // bezier bumps, alternating above/below the line at each half-wavelength. Only
  // meaningful for horizontal decoration lines (underline/overline/line-through),
  // which is the only shape this is ever called with.
  wavy_line(x1, y1, x2, y2, amplitude, wavelength) {
    const len = x2 - x1;
    if (len <= 0 || wavelength <= 0) {
      this.line(x1, y1, x2, y2);
      return;
    }
    const yTop = this.formatH - y1;
    const halfWave = wavelength / 2;
    const steps = Math.max(1, Math.round(len / halfWave));
    const stepLen = len / steps;
    this.pageOut(`${hpf(x1)} ${hpf(yTop)} m`);
    for (let i = 0; i < steps; i++) {
      const dir = i % 2 === 0 ? 1 : -1;
      const xStart = x1 + i * stepLen;
      const xEnd = xStart + stepLen;
      const yPeak = yTop + dir * amplitude;
      this.pageOut(`${hpf(xStart + stepLen * 0.25)} ${hpf(yPeak)} ${hpf(xStart + stepLen * 0.75)} ${hpf(yPeak)} ${hpf(xEnd)} ${hpf(yTop)} c`);
    }
    this.pageOut("S");
  }
  add_gradient(gradType, angle, stops, cx = 0.5, cy = 0.5, fx = cx, fy = cy) {
    const parsed = [];
    for (let i = 0; i + 4 < stops.length; i += 5)
      parsed.push([stops[i], stops[i + 1] / 255, stops[i + 2] / 255, stops[i + 3] / 255, stops[i + 4] / 255]);
    this.gradDefs.push({ gradType, angle, cx, cy, fx, fy, stops: parsed });
    return this.gradDefs.length - 1;
  }
  // PDF shading patterns have no native alpha channel — a gradient with any
  // stop below full opacity needs a separate luminosity soft mask (a
  // grayscale shading of the same geometry, composited via an ExtGState)
  // applied right before the color pattern fills. Registered lazily, by
  // predictable name, the same way patName is derived from shadPats.length —
  // a fully-opaque gradient (every case before this fix) costs nothing extra.
  registerSoftMaskIfNeeded(gradientId, x, y, w, h) {
    const def = this.gradDefs[gradientId];
    if (!def || !def.stops.some((s) => s[4] < 1)) return "";
    const gsName = `GSM${this.gradSoftMasks.length}`;
    this.gradSoftMasks.push({ gsName, defIdx: gradientId, x, y, w, h, pageH: this.formatH, objId: 0 });
    return `/${gsName} gs
`;
  }
  fill_with_gradient(gradientId, x, y, w, h) {
    if (gradientId < 0 || gradientId >= this.gradDefs.length) return;
    const patName = `Sh${this.shadPats.length}`;
    const yp = this.formatH - y - h;
    const gsOp = this.registerSoftMaskIfNeeded(gradientId, x, y, w, h);
    this.shadPats.push({ patName, defIdx: gradientId, x, y, w, h, pageH: this.formatH, objId: 0 });
    this.pageOut(`q
${gsOp}/Pattern cs
/${patName} scn
${hpf(x)} ${hpf(yp)} ${hpf(w)} ${hpf(h)} re
f
Q`);
  }
  fill_with_gradient_rounded(gradientId, x, y, w, h, tl, tr, br, bl) {
    if (!rounds(tl) && !rounds(tr) && !rounds(br) && !rounds(bl)) {
      this.fill_with_gradient(gradientId, x, y, w, h);
      return;
    }
    if (gradientId < 0 || gradientId >= this.gradDefs.length) return;
    const patName = `Sh${this.shadPats.length}`;
    const yb = this.formatH - y - h;
    const gsOp = this.registerSoftMaskIfNeeded(gradientId, x, y, w, h);
    this.shadPats.push({ patName, defIdx: gradientId, x, y, w, h, pageH: this.formatH, objId: 0 });
    this.pageOut("q");
    this.pathRoundedRect(x, y, w, h, tl, tr, br, bl);
    this.pageOut("W n");
    this.pageOut(`${gsOp}/Pattern cs
/${patName} scn
${hpf(x)} ${hpf(yb)} ${hpf(w)} ${hpf(h)} re
f
Q`);
  }
  embed_image(bytes2) {
    const raw = parseImage(bytes2);
    if (!raw) return 4294967295;
    const idx = this.images.length;
    const data = raw.isJpeg ? raw.data : deflate(raw.data);
    this.images.push({
      name: `Im${idx}`,
      width: raw.width,
      height: raw.height,
      colorSpace: raw.colorSpace,
      filter: raw.isJpeg ? "/DCTDecode" : "/FlateDecode",
      data,
      smask: raw.smask,
      decodeInvert: !!raw.decodeInvert,
      orientation: raw.orientation || 1,
      objectNumber: 0
    });
    return idx;
  }
  // browser-decoded pixels skip the WASM parser entirely
  embed_raw_image(raw) {
    if (!raw.width || !raw.height || !raw.data.length) return 4294967295;
    const idx = this.images.length;
    this.images.push({
      name: `Im${idx}`,
      width: raw.width,
      height: raw.height,
      colorSpace: raw.colorSpace,
      filter: "/FlateDecode",
      data: deflate(raw.data),
      smask: raw.smask,
      decodeInvert: false,
      orientation: 1,
      objectNumber: 0
    });
    return idx;
  }
  // EXIF orientation is corrected here via the cm matrix — the browser already
  // laid the box out at corrected dimensions (naturalWidth is EXIF-aware), and
  // DCT passthrough can't rotate pixels. Derivation: stored image unit square
  // (s right, t up, row 0 at t=1) mapped so the DISPLAYED image is upright.
  draw_image(imageId, x, y, w, h) {
    const img = this.images[imageId];
    if (!img) return;
    const yp = this.formatH - y - h;
    const o = img.orientation;
    const m = o === 2 ? [-w, 0, 0, h, x + w, yp] : o === 3 ? [-w, 0, 0, -h, x + w, yp + h] : o === 4 ? [w, 0, 0, -h, x, yp + h] : o === 5 ? [0, -h, -w, 0, x + w, yp + h] : o === 6 ? [0, -h, w, 0, x, yp + h] : o === 7 ? [0, h, w, 0, x, yp] : o === 8 ? [0, h, -w, 0, x + w, yp] : [w, 0, 0, h, x, yp];
    this.pageOut(`q
${m.map(hpf).join(" ")} cm
/${img.name} Do
Q`);
  }
  add_link_annotation(x, y, w, h, url) {
    const ph = this.formatH;
    this.pageAnnots[this.currentPageIdx]?.push({ rect: [x, ph - y - h, x + w, ph - y], href: url });
  }
  add_goto_annotation(x, y, w, h, destPage, destY) {
    const ph = this.formatH;
    this.pageAnnots[this.currentPageIdx]?.push({ rect: [x, ph - y - h, x + w, ph - y], destPage, destY: ph - destY });
  }
  // D1 (AcroForm): builds the field's appearance stream(s) immediately (the
  // font registry / emission-cache state captureAppearance depends on is
  // only correct RIGHT NOW, during normal command processing — not
  // reconstructable later during buildDocument), and records everything
  // else build_pages.ts needs to emit the actual Widget/Field PDF object
  // once page content is finalized.
  add_form_field(x, y, w, h, fieldType, name, fontName, fontStyle, weight, size, color, value, checked, options) {
    const ph = this.formatH;
    let da;
    let apOn, apOff;
    if (fieldType === "Btn") {
      const built = this.buildCheckboxAppearances(w, h, color);
      apOn = built.on;
      apOff = built.off;
    } else if (!fontName) {
      apOn = "";
    } else {
      const fontId = this.getOrCreateFont(fontName, fontStyle, weight).id;
      this.usedFonts.add(fontId);
      da = `/${fontId} ${hpf(size)} Tf ${encodeColor(color[0], color[1], color[2], false, 3)}`;
      const savedFormatH = this.formatH;
      this.formatH = h;
      apOn = this.captureAppearance(() => {
        this.set_clip_rect(0, 0, w, h);
        this.set_font(fontName, fontStyle, weight);
        this.set_font_size(size);
        this.set_text_color(color[0], color[1], color[2]);
        this.text(value ?? "", 2, h / 2, "middle");
      });
      this.formatH = savedFormatH;
    }
    this.pageAnnots[this.currentPageIdx]?.push({
      rect: [x, ph - y - h, x + w, ph - y],
      fieldType,
      fieldName: name,
      fieldDA: da,
      fieldValue: value,
      fieldChecked: checked,
      fieldOptions: options,
      fieldApOn: apOn,
      fieldApOff: apOff
    });
  }
  // A simple two-line checkmark, scaled to the field's own box — plain
  // vector geometry, so unlike the text appearance above this needs no
  // captureAppearance detour (a bare content-stream string is already in
  // the AP's own local, Y-up coordinate system with no page-relative flip
  // to account for). The "off" state is a deliberately empty stream — a
  // valid, zero-length content stream, not a placeholder.
  buildCheckboxAppearances(w, h, color) {
    const stroke = encodeColor(color[0], color[1], color[2], true, 3);
    const lw = Math.max(1, Math.min(w, h) * 0.12);
    const on = [
      "q",
      `${hpf(lw)} w`,
      stroke,
      `${hpf(w * 0.2)} ${hpf(h * 0.5)} m`,
      `${hpf(w * 0.42)} ${hpf(h * 0.25)} l`,
      `${hpf(w * 0.8)} ${hpf(h * 0.78)} l`,
      "S",
      "Q"
    ].join("\n");
    return { on, off: "" };
  }
  add_named_dest(name, page, y) {
    this.namedDests.push([name, page, y]);
  }
  set_metadata(key, value) {
    this.metadata.push([key, value]);
  }
  add_bookmark(title, page, y, level) {
    this.bookmarks.push({ title, page, y, level });
  }
  set_security(userPw, ownerPw, permissions) {
    this.security = computeR6Security(userPw, ownerPw, permissions);
  }
  set_struct_tree(root) {
    this.structRoot = root;
  }
  set_pdfa(lang) {
    this.pdfA = true;
    this.pdfaLang = lang;
  }
  add_page() {
    this.addPageInternal();
  }
  // Random-access page targeting: creates any missing pages up to n, then switches
  // to it. Content spanning a page break needs to append to a page it already
  // finished visiting earlier in DOM order, not just monotonically advance.
  // Switching to an already-started page invalidates the emission caches — they
  // describe the page we just left, not the stream we're appending to now.
  set_page(n) {
    if (!Number.isInteger(n) || n < 1) return;
    while (this.allPageBufs.length < n) this.addPageInternal();
    if (this.currentPageIdx === n - 1) return;
    this.currentPageIdx = n - 1;
    this.lastFontKey = "";
    this.lastFontSize = -1;
    this.lastLeading = -1;
    this.lastNonstroke = "";
    this.lastStroke = "";
    this.lastLineWidth = -1;
    this.lastCharSpace = -1;
    this.lastWordSpace = -1;
    this.lastTextRenderMode = -1;
  }
  output() {
    if (this.built) return this.builtBytes;
    this.built = true;
    this.buildDocument();
    const out = new Uint8Array(this.byteLen);
    let pos = 0;
    for (const p of this.buf) {
      out.set(p, pos);
      pos += p.length;
    }
    this.builtBytes = out;
    return out;
  }
  buildDocument() {
    const ctx = this.ctx;
    putPages(ctx);
    const structTreeRootId = putStructTree(ctx);
    const pdfaExtras = putPdfAExtras(ctx);
    putImages(ctx);
    putFonts(ctx);
    putShadingPatterns(ctx);
    putGradientSoftMasks(ctx);
    putResourceDictionary(ctx);
    packObjStm(ctx);
    const infoId = putCatalog(ctx, structTreeRootId, pdfaExtras);
    const catalogId = ctx.objectNumber;
    const encryptId = putEncryptDict(ctx);
    buildXrefStream(ctx, catalogId, encryptId, infoId);
  }
};

// src/pdf/shadows.ts
function grownCorner(c, by) {
  if (c.h <= 0 || c.v <= 0) return { h: 0, v: 0 };
  return { h: Math.max(0, c.h + by), v: Math.max(0, c.v + by) };
}
function emitShadows(doc, shadows, x, y, w, h, rr) {
  const rounded = anyRadius(rr);
  for (const sh of shadows) {
    const sx = x + sh.x, sy = y + sh.y;
    const ext = sh.spread ?? 0;
    const steps = Math.min(60, Math.max(1, Math.ceil(sh.blur / 2)));
    const layerAlpha = (i) => (sh.color[3] ?? 255) / 255 * (steps === 1 ? 1 : i / steps * 0.4);
    if (sh.inset) {
      doc.save_graphics_state();
      if (rounded) {
        doc.set_clip_rounded_rect(x, y, w, h, rr.tl, rr.tr, rr.br, rr.bl);
      } else {
        doc.set_clip_rect(x, y, w, h);
      }
    } else {
      doc.save_graphics_state();
      doc.set_clip_outside_rounded_rect(x, y, w, h, rr.tl, rr.tr, rr.br, rr.bl);
    }
    doc.set_fill_color(sh.color[0], sh.color[1], sh.color[2]);
    if (sh.inset) {
      for (let i = steps; i >= 1; i--) {
        const alpha = layerAlpha(i);
        const band = Math.max(0, sh.blur / steps * (steps - i + 1) * 0.5 + ext);
        if (!band) continue;
        doc.set_alpha(alpha);
        doc.border_ring(sx, sy, w, h, rr.tl, rr.tr, rr.br, rr.bl, band);
      }
    } else {
      for (let i = steps; i >= 1; i--) {
        const alpha = layerAlpha(i);
        const expand = sh.blur / steps * (steps - i + 1) * 0.5;
        const grow = expand + ext;
        const gw = w + grow * 2, gh = h + grow * 2;
        if (gw <= 0 || gh <= 0) continue;
        doc.set_alpha(alpha);
        if (rounded) {
          doc.rounded_rect(
            sx - grow,
            sy - grow,
            gw,
            gh,
            grownCorner(rr.tl, grow),
            grownCorner(rr.tr, grow),
            grownCorner(rr.br, grow),
            grownCorner(rr.bl, grow),
            "F"
          );
        } else {
          doc.rect(sx - grow, sy - grow, gw, gh, "F");
        }
      }
    }
    doc.set_alpha(1);
    doc.restore_graphics_state();
  }
}

// src/pdf/finalize.ts
function applyMetadata(doc, m) {
  if (m.title) doc.set_metadata("Title", m.title);
  if (m.author) doc.set_metadata("Author", m.author);
  if (m.subject) doc.set_metadata("Subject", m.subject);
  if (m.keywords) doc.set_metadata("Keywords", m.keywords.join(", "));
  if (m.creator) doc.set_metadata("Creator", m.creator);
  if (m.language) doc.set_metadata("Lang", m.language);
}
function applyBookmarks(doc, bookmarks) {
  const safeLevel = (raw) => Number.isFinite(raw) ? Math.max(0, Math.floor(raw)) : 0;
  for (const bm of bookmarks) doc.add_bookmark(bm.title, bm.page, bm.y ?? 0, safeLevel(bm.level));
}
function applySecurity(doc, sec) {
  const p = sec.permissions;
  let perm = 4294967292;
  if (p?.print === false) perm &= ~4;
  if (p?.modify === false) perm &= ~8;
  if (p?.copy === false) perm &= ~16;
  if (p?.annotate === false) perm &= ~32;
  if (p?.fillForms === false) perm &= ~256;
  doc.set_security(sec.userPassword ?? "", sec.ownerPassword ?? "", perm >>> 0);
}
function applyStructTree(doc, structRoot) {
  doc.set_struct_tree(structRoot);
}
function applyPdfA(doc, metadata) {
  doc.set_pdfa(metadata?.language);
}
function resolveSecurityConfig(security) {
  if (security === void 0) {
    return {
      userPassword: "",
      ownerPassword: Array.from(crypto.getRandomValues(new Uint8Array(16))).map((b) => b.toString(16).padStart(2, "0")).join(""),
      permissions: { print: true, copy: true, modify: false, annotate: false, fillForms: false }
    };
  }
  return security;
}

// src/pdf/svg.ts
function _hashBytes(bytes2) {
  let h1 = 5381, h2 = 52711;
  for (let i = 0; i < bytes2.length; i++) {
    const b = bytes2[i];
    h1 = (Math.imul(h1, 33) ^ b) >>> 0;
    h2 = h2 * 31 + b | 0;
  }
  return bytes2.length + ":" + h1.toString(36) + ":" + (h2 >>> 0).toString(36);
}
function svgToPng(svgBytes, drawW, drawH) {
  return new Promise((resolve, reject) => {
    const blob = new Blob([svgBytes], { type: "image/svg+xml" });
    const url = URL.createObjectURL(blob);
    const img = new Image();
    const dpr = 3;
    img.onload = () => {
      URL.revokeObjectURL(url);
      try {
        const canvas = document.createElement("canvas");
        canvas.width = Math.round(drawW * dpr);
        canvas.height = Math.round(drawH * dpr);
        const ctx = canvas.getContext("2d");
        ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
        canvas.toBlob((rasterized) => {
          if (!rasterized) {
            reject(new Error("SVG rasterization failed"));
            return;
          }
          rasterized.arrayBuffer().then((buf) => resolve(new Uint8Array(buf))).catch(reject);
        }, "image/png");
      } catch (err) {
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error("SVG load failed"));
    };
    img.src = url;
  });
}
async function rasterizeSVGs(commands) {
  const byContent = /* @__PURE__ */ new Map();
  const keyOf = (c) => `${_hashBytes(c.src)}|${c.w}|${c.h}`;
  const jobs = [];
  for (const cmd of commands) {
    if (cmd.type !== "image") continue;
    const c = cmd;
    if (c.format !== "svg") continue;
    const key = keyOf(c);
    if (!byContent.has(key)) {
      byContent.set(key, svgToPng(c.src, c.w, c.h).catch((err) => {
        console.warn("[daepdf] SVG rasterization failed \u2014 image skipped.", err);
        return new Uint8Array(0);
      }));
    }
    jobs.push({ cmd: c, key });
  }
  await Promise.all(byContent.values());
  for (const { cmd, key } of jobs) {
    const png = await byContent.get(key);
    if (png.length > 0) {
      ;
      cmd["src"] = png;
      cmd["format"] = "png";
    }
  }
}

// src/pdf/index.ts
function applyToPDF(commands, def, anchors, structRoot) {
  const size = resolvePageSize(def.config.size, def.config.orientation);
  const doc = new PdfDoc(size.width, size.height);
  let currentPage = 1;
  const imageCache = /* @__PURE__ */ new Map();
  if (anchors) {
    for (const [id, entry] of anchors) {
      doc.add_named_dest(id, entry.page, entry.y);
    }
  }
  for (const cmd of commands) {
    if (cmd.page !== currentPage) {
      doc.set_page(cmd.page);
      currentPage = cmd.page;
    }
    if (cmd.type === "text") {
      const c = cmd;
      const tagged = c.mcid !== void 0 && c.structTag !== void 0;
      if (tagged) doc.begin_marked_content(c.structTag, c.mcid);
      doc.set_font(c.font, c.style, c.weight);
      doc.set_font_size(c.size);
      doc.set_text_color(c.color[0], c.color[1], c.color[2]);
      if (c.letterSpacing) doc.set_char_space(c.letterSpacing);
      if (c.wordSpacing) doc.set_word_spacing(c.wordSpacing);
      const hasTextGState = c.opacity !== void 0 && c.opacity < 1 || !!c.blend;
      if (hasTextGState) doc.set_alpha(c.opacity ?? 1, c.blend);
      const stroke = c.stroke ? { color: c.stroke, width: c.strokeWidth ?? 0, strokeOnly: !!c.strokeOnly } : void 0;
      if (c.vertical) {
        doc.text_vertical(c.text, c.x, c.y, stroke);
      } else {
        let px = c.x;
        if (c.align !== "left" || c.direction === "rtl") {
          const w = measure_string_width(c.text, c.font, c.style, c.weight, 0, c.size);
          if (c.align === "center") px = c.x + c.maxWidth / 2 - w / 2;
          else if (c.align === "right") px = c.x + c.maxWidth - w;
          else if (c.direction === "rtl") px = c.x + c.maxWidth - w;
        }
        doc.text(c.text, px, c.y, "alphabetic", stroke);
      }
      if (c.letterSpacing) doc.set_char_space(0);
      if (c.wordSpacing) doc.set_word_spacing(0);
      if (hasTextGState) doc.set_alpha(1);
      if (tagged) doc.end_marked_content();
    } else if (cmd.type === "link") {
      const c = cmd;
      if (c.href.startsWith("#")) {
        let frag = c.href.slice(1);
        try {
          frag = decodeURIComponent(frag);
        } catch {
        }
        const dest = anchors?.get(frag) ?? anchors?.get(c.href.slice(1));
        if (dest) doc.add_goto_annotation(c.x, c.y, c.w, c.h, dest.page, dest.y);
      } else {
        const lower = c.href.toLowerCase().trimStart();
        if (lower.startsWith("http://") || lower.startsWith("https://") || lower.startsWith("mailto:")) {
          let uri = c.href;
          try {
            uri = encodeURI(c.href);
          } catch {
          }
          doc.add_link_annotation(c.x, c.y, c.w, c.h, uri);
        }
      }
    } else if (cmd.type === "rect") {
      const c = cmd;
      const rr = resolveRadius(c.radius);
      const hasRadius = anyRadius(rr);
      const outerShadows = c.shadow?.filter((s) => !s.inset) ?? [];
      const insetShadows = c.shadow?.filter((s) => s.inset) ?? [];
      if (outerShadows.length) {
        emitShadows(doc, outerShadows, c.x, c.y, c.w, c.h, rr);
      }
      const hasRectGState = c.opacity !== void 0 && c.opacity < 1 || !!c.blend;
      if (hasRectGState) doc.set_alpha(c.opacity ?? 1, c.blend);
      if (c.gradient) {
        const g = c.gradient;
        const stopsFlat = new Float64Array(g.stops.flatMap((s) => [s.position, s.color[0], s.color[1], s.color[2], s.color[3]]));
        const isRadial = g.type === "radial";
        const gradId = doc.add_gradient(
          isRadial ? 1 : 0,
          g.type === "linear" ? g.angle ?? 0 : 0,
          stopsFlat,
          isRadial ? g.cx ?? 0.5 : 0.5,
          isRadial ? g.cy ?? 0.5 : 0.5,
          isRadial ? g.fx ?? g.cx ?? 0.5 : 0.5,
          isRadial ? g.fy ?? g.cy ?? 0.5 : 0.5
        );
        if (hasRadius) {
          doc.fill_with_gradient_rounded(gradId, c.x, c.y, c.w, c.h, rr.tl, rr.tr, rr.br, rr.bl);
        } else {
          doc.fill_with_gradient(gradId, c.x, c.y, c.w, c.h);
        }
      } else if (c.fill) {
        doc.set_fill_color(c.fill[0], c.fill[1], c.fill[2]);
        if (hasRadius) doc.rounded_rect(c.x, c.y, c.w, c.h, rr.tl, rr.tr, rr.br, rr.bl, "F");
        else doc.rect(c.x, c.y, c.w, c.h, "F");
      }
      if (c.stroke) {
        if (c.strokeStyle === "dashed" || c.strokeStyle === "dotted") {
          const sw = c.strokeWidth ?? 0.5;
          const dash = c.strokeStyle === "dashed" ? [Math.max(2, sw * 3), Math.max(1.5, sw * 2)] : [Math.max(0.5, sw), Math.max(1, sw * 1.5)];
          doc.set_draw_color(c.stroke[0], c.stroke[1], c.stroke[2]);
          doc.stroke_rounded_rect_dashed(c.x, c.y, c.w, c.h, rr.tl, rr.tr, rr.br, rr.bl, sw, dash);
        } else {
          doc.set_fill_color(c.stroke[0], c.stroke[1], c.stroke[2]);
          doc.border_ring(c.x, c.y, c.w, c.h, rr.tl, rr.tr, rr.br, rr.bl, c.strokeWidth ?? 0.5);
        }
      }
      if (insetShadows.length) {
        emitShadows(doc, insetShadows, c.x, c.y, c.w, c.h, rr);
      }
      if (hasRectGState) doc.set_alpha(1);
    } else if (cmd.type === "line") {
      const c = cmd;
      const hasLineGState = c.opacity !== void 0 && c.opacity < 1 || !!c.blend;
      if (hasLineGState) doc.set_alpha(c.opacity ?? 1, c.blend);
      doc.set_draw_color(c.color[0], c.color[1], c.color[2]);
      doc.set_line_width(c.width);
      if (c.lineStyle === "dashed") {
        doc.set_line_dash([Math.max(2, c.width * 3), Math.max(1.5, c.width * 2)], 0);
        doc.line(c.x1, c.y1, c.x2, c.y2);
        doc.set_line_dash([], 0);
      } else if (c.lineStyle === "dotted") {
        doc.set_line_dash([Math.max(0.5, c.width), Math.max(1, c.width * 1.5)], 0);
        doc.line(c.x1, c.y1, c.x2, c.y2);
        doc.set_line_dash([], 0);
      } else if (c.lineStyle === "wavy") {
        doc.wavy_line(c.x1, c.y1, c.x2, c.y2, Math.max(0.6, c.width * 1.2), Math.max(3, c.width * 4));
      } else {
        doc.line(c.x1, c.y1, c.x2, c.y2);
      }
      if (hasLineGState) doc.set_alpha(1);
    } else if (cmd.type === "clip-push") {
      const c = cmd;
      doc.save_graphics_state();
      if (c.path) {
        doc.set_clip_path(c.path, !!c.evenOdd);
      } else if (c.x !== void 0 && c.y !== void 0 && c.w !== void 0 && c.h !== void 0) {
        const cr = resolveRadius(c.radius);
        if (anyRadius(cr)) {
          doc.set_clip_rounded_rect(c.x, c.y, c.w, c.h, cr.tl, cr.tr, cr.br, cr.bl);
        } else {
          doc.set_clip_rect(c.x, c.y, c.w, c.h);
        }
      }
    } else if (cmd.type === "clip-pop") {
      doc.restore_graphics_state();
    } else if (cmd.type === "transform-push") {
      const c = cmd;
      doc.save_graphics_state();
      if (c.matrix) doc.set_transform(c.matrix);
    } else if (cmd.type === "transform-pop") {
      doc.restore_graphics_state();
    } else if (cmd.type === "image") {
      const c = cmd;
      if (c.format === "svg") continue;
      if (c.w < 0.01 || c.h < 0.01) continue;
      let imageId = imageCache.get(c.src);
      if (imageId === void 0) {
        imageId = doc.embed_image(c.src);
        if (imageId !== 4294967295) imageCache.set(c.src, imageId);
      }
      if (imageId !== void 0 && imageId !== 4294967295) {
        const tagged = c.mcid !== void 0 && c.structTag !== void 0;
        if (tagged) doc.begin_marked_content(c.structTag, c.mcid);
        const hasGState = c.opacity !== void 0 && c.opacity < 1 || !!c.blend;
        if (hasGState) doc.set_alpha(c.opacity ?? 1, c.blend);
        doc.draw_image(imageId, c.x, c.y, c.w, c.h);
        if (hasGState) doc.set_alpha(1);
        if (tagged) doc.end_marked_content();
      }
    } else if (cmd.type === "raw-image") {
      const c = cmd;
      if (c.w < 0.01 || c.h < 0.01) continue;
      let imageId = imageCache.get(c.raw);
      if (imageId === void 0) {
        imageId = doc.embed_raw_image(c.raw);
        if (imageId !== 4294967295) imageCache.set(c.raw, imageId);
      }
      if (imageId !== void 0 && imageId !== 4294967295) {
        const tagged = c.mcid !== void 0 && c.structTag !== void 0;
        if (tagged) doc.begin_marked_content(c.structTag, c.mcid);
        const hasGState = c.opacity !== void 0 && c.opacity < 1 || !!c.blend;
        if (hasGState) doc.set_alpha(c.opacity ?? 1, c.blend);
        doc.draw_image(imageId, c.x, c.y, c.w, c.h);
        if (hasGState) doc.set_alpha(1);
        if (tagged) doc.end_marked_content();
      }
    } else if (cmd.type === "field") {
      const c = cmd;
      doc.add_form_field(
        c.x,
        c.y,
        c.w,
        c.h,
        c.fieldType,
        c.name,
        c.font,
        c.style,
        c.weight,
        c.size,
        c.color,
        c.value,
        c.checked,
        c.options
      );
    } else if (cmd.type === "path") {
      const c = cmd;
      const hasPathGState = c.opacity !== void 0 && c.opacity < 1 || !!c.blend;
      if (hasPathGState) doc.set_alpha(c.opacity ?? 1, c.blend);
      let gradientFill;
      if (c.gradient && c.gradientBox) {
        const g = c.gradient;
        const stopsFlat = new Float64Array(g.stops.flatMap((s) => [s.position, s.color[0], s.color[1], s.color[2], s.color[3]]));
        const isRadial = g.type === "radial";
        const gradId = doc.add_gradient(
          isRadial ? 1 : 0,
          g.type === "linear" ? g.angle ?? 0 : 0,
          stopsFlat,
          isRadial ? g.cx ?? 0.5 : 0.5,
          isRadial ? g.cy ?? 0.5 : 0.5,
          isRadial ? g.fx ?? g.cx ?? 0.5 : 0.5,
          isRadial ? g.fy ?? g.cy ?? 0.5 : 0.5
        );
        gradientFill = { gradientId: gradId, x: c.gradientBox.x, y: c.gradientBox.y, w: c.gradientBox.w, h: c.gradientBox.h };
      }
      const stroke = c.stroke ? { color: c.stroke, width: c.strokeWidth ?? 1, dash: c.dashArray, lineCap: c.lineCap, lineJoin: c.lineJoin } : void 0;
      doc.draw_path(c.ops, !!c.evenOdd, c.fill, gradientFill, stroke);
      if (hasPathGState) doc.set_alpha(1);
    }
  }
  if (def.metadata) applyMetadata(doc, def.metadata);
  if (def.bookmarks) applyBookmarks(doc, def.bookmarks);
  if (structRoot) applyStructTree(doc, structRoot);
  if (def.pdfA) applyPdfA(doc, def.metadata);
  const sec = resolveSecurityConfig(def.security);
  if (sec) applySecurity(doc, sec);
  return doc.output();
}

// src/html/types.ts
var PX_PER_PT = 96 / 72;
function domRectToPt(r, cRect) {
  return {
    x: (r.left - cRect.left) / PX_PER_PT,
    y: (r.top - cRect.top) / PX_PER_PT,
    w: r.width / PX_PER_PT,
    h: r.height / PX_PER_PT
  };
}
function paginate(yPt, pageH) {
  const page = Math.max(1, Math.floor(yPt / pageH) + 1);
  return { page, y: yPt - (page - 1) * pageH };
}
function paginateSpan(yPt, h, pageH) {
  const startPage = Math.max(1, Math.floor(yPt / pageH) + 1);
  const endYPt = yPt + h;
  const epsilon = 1e-6;
  const endPage = Math.max(startPage, Math.floor((endYPt - epsilon) / pageH) + 1);
  const spans = [];
  for (let p = startPage; p <= endPage; p++) {
    spans.push({ page: p, y: yPt - (p - 1) * pageH });
  }
  return spans;
}
function stackOpacity(ctx) {
  if (!ctx.opacityStack.length) return void 0;
  const o = ctx.opacityStack.reduce((a, b) => a * b, 1);
  return o < 1 ? o : void 0;
}
var CSS_TO_PDF_BLEND = {
  "multiply": "Multiply",
  "screen": "Screen",
  "overlay": "Overlay",
  "darken": "Darken",
  "lighten": "Lighten",
  "color-dodge": "ColorDodge",
  "color-burn": "ColorBurn",
  "hard-light": "HardLight",
  "soft-light": "SoftLight",
  "difference": "Difference",
  "exclusion": "Exclusion",
  "hue": "Hue",
  "saturation": "Saturation",
  "color": "Color",
  "luminosity": "Luminosity"
};
function cssBlendToPdf(v) {
  return v ? CSS_TO_PDF_BLEND[v] : void 0;
}
function stackBlend(ctx) {
  return ctx.blendStack.length ? ctx.blendStack[ctx.blendStack.length - 1] : void 0;
}
function structTagFor(el, tag) {
  const role = el.getAttribute("role");
  if (role === "presentation" || role === "none") return "Artifact";
  if (el.getAttribute("aria-hidden") === "true") return "Artifact";
  switch (tag) {
    case "H1":
    case "H2":
    case "H3":
    case "H4":
    case "H5":
    case "H6":
      return tag;
    case "P":
      return "P";
    case "UL":
    case "OL":
      return "L";
    case "LI":
      return "LI";
    case "TABLE":
      return "Table";
    case "THEAD":
      return "THead";
    case "TBODY":
      return "TBody";
    case "TFOOT":
      return "TFoot";
    case "TR":
      return "TR";
    case "TD":
      return "TD";
    case "TH":
      return "TH";
    case "IMG":
    case "SVG":
      return "Figure";
    case "A":
      return "Link";
    case "SPAN":
      return "Span";
    default:
      return "Div";
  }
}
function enterStruct(el, tag, ctx) {
  if (!ctx.struct) return void 0;
  const structTag = structTagFor(el, tag);
  if (structTag === "Artifact") {
    ctx.struct.artifactDepth++;
    return "artifact";
  }
  const node = { tag: structTag, kids: [] };
  if (structTag === "Figure") {
    const alt = el.getAttribute("alt");
    if (alt) node.alt = alt;
  }
  const lang = el.lang;
  if (lang) node.lang = lang;
  ctx.struct.stack.at(-1)?.kids.push(node);
  ctx.struct.stack.push(node);
  return node;
}
function exitStruct(ctx, entry) {
  if (!ctx.struct || entry === void 0) return;
  if (entry === "artifact") {
    ctx.struct.artifactDepth--;
    return;
  }
  ctx.struct.stack.pop();
  if (entry.kids.length === 0) {
    const parent = ctx.struct.stack.at(-1);
    const idx = parent?.kids.indexOf(entry) ?? -1;
    if (parent && idx >= 0) parent.kids.splice(idx, 1);
  }
}
function tagStructContent(ctx, page) {
  if (!ctx.struct || ctx.struct.artifactDepth > 0) return void 0;
  const parent = ctx.struct.stack.at(-1);
  if (!parent) return void 0;
  const mcid = ctx.struct.mcidCounters.get(page) ?? 0;
  ctx.struct.mcidCounters.set(page, mcid + 1);
  parent.kids.push({ mcid, page });
  return { mcid, tag: parent.tag };
}
function pruneStructTreePages(node, pageCount) {
  node.kids = node.kids.filter((kid) => isMcrRef(kid) ? kid.page <= pageCount : true);
  for (const kid of node.kids) {
    if (!isMcrRef(kid)) pruneStructTreePages(kid, pageCount);
  }
  node.kids = node.kids.filter((kid) => isMcrRef(kid) || kid.kids.length > 0);
}

// src/html/fonts.ts
var _fontMapCache = null;
var _glyphCache = /* @__PURE__ */ new Map();
function invalidateFontMapCache() {
  _fontMapCache = null;
  _glyphCache = /* @__PURE__ */ new Map();
}
function hasGlyphCached(name, style, codepoint) {
  const key = `${name}|${style}|${codepoint}`;
  let hit = _glyphCache.get(key);
  if (hit === void 0) {
    hit = font_has_glyph(name, style, codepoint);
    _glyphCache.set(key, hit);
  }
  return hit;
}
function buildRegisteredFontMap() {
  if (_fontMapCache) return _fontMapCache;
  const map = /* @__PURE__ */ new Map();
  const list = list_registered_fonts();
  for (const entry of list) {
    const colon = entry.indexOf(":");
    if (colon < 0) continue;
    const name = entry.slice(0, colon);
    const style = entry.slice(colon + 1);
    const arr = map.get(name) ?? [];
    arr.push(style);
    map.set(name, arr);
  }
  _fontMapCache = map;
  return map;
}
function cssWeightNum(w) {
  if (w === "bold") return 700;
  if (w === "normal") return 400;
  const n = parseInt(w, 10);
  return isNaN(n) ? 400 : n;
}
function pickStyle(name, weight, italic, reg) {
  const styles = reg.get(name);
  if (!styles || !styles.length) return null;
  if (styles.length === 1) return styles[0];
  const isBold = (x) => x.includes("bold") || x.includes("semi") || x.includes("medium") || x.includes("heavy");
  const isItalic = (x) => x.includes("italic") || x.includes("oblique");
  if (italic && weight >= 500) {
    const s = styles.find((x) => isItalic(x) && isBold(x));
    if (s) return s;
  }
  if (italic) {
    const s = styles.find((x) => isItalic(x));
    if (s) return s;
  }
  if (weight >= 500) {
    const s = styles.find((x) => x === "bold" || isBold(x));
    if (s) return s;
  } else {
    const s = styles.find((x) => x === "normal" || x === "regular" || x === "light" || x === "thin");
    if (s) return s;
  }
  return styles[0];
}
function resolveOneFamily(fam, weight, italic, fontMap, reg) {
  const override = fontMap[fam] ?? fontMap[fam.toLowerCase()];
  if (override) return { name: override.name, style: override.style, weight: override.weight };
  if (!fam || ["sans-serif", "serif", "monospace", "system-ui", "cursive", "fantasy", "math"].includes(fam.toLowerCase())) return null;
  const lname = fam.toLowerCase();
  const style = pickStyle(lname, weight, italic, reg);
  return style !== null ? { name: fam, style, weight } : null;
}
function resolveFontRef(family, weight, fStyle, fontMap, reg) {
  const cssWeight = cssWeightNum(weight);
  const italic = fStyle === "italic" || fStyle === "oblique";
  const families = family.split(",").map((f) => f.trim().replace(/^["']|["']$/g, "").trim());
  for (const fam of families) {
    const ref = resolveOneFamily(fam, cssWeight, italic, fontMap, reg);
    if (ref) return ref;
  }
  return null;
}
function resolveGlyphFallback(codepoint, primary, family, weight, fStyle, fontMap, reg) {
  const cssWeight = cssWeightNum(weight);
  const italic = fStyle === "italic" || fStyle === "oblique";
  const families = family.split(",").map((f) => f.trim().replace(/^["']|["']$/g, "").trim());
  const sameAsPrimary = (ref) => ref.name.toLowerCase() === primary.name.toLowerCase() && ref.style === primary.style;
  for (const fam of families) {
    const ref = resolveOneFamily(fam, cssWeight, italic, fontMap, reg);
    if (ref && !sameAsPrimary(ref) && hasGlyphCached(ref.name, ref.style, codepoint)) return ref;
  }
  for (const [name, styles] of reg) {
    for (const style of styles) {
      if (name.toLowerCase() === primary.name.toLowerCase() && style === primary.style) continue;
      if (hasGlyphCached(name, style, codepoint)) return { name, style, weight: cssWeight };
    }
  }
  return null;
}
function splitByFontCoverage(text, primary, family, weight, fStyle, fontMap, reg) {
  const chars = [...text];
  const fontFor = /* @__PURE__ */ new Map();
  let allPrimary = true;
  for (const ch of chars) {
    const cp = ch.codePointAt(0);
    if (fontFor.has(cp)) continue;
    if (hasGlyphCached(primary.name, primary.style, cp)) {
      fontFor.set(cp, primary);
      continue;
    }
    allPrimary = false;
    const fallback = resolveGlyphFallback(cp, primary, family, weight, fStyle, fontMap, reg);
    fontFor.set(cp, fallback ?? primary);
  }
  if (allPrimary) return [{ text, font: primary }];
  const runs = [];
  let runStart = 0;
  let runFont = fontFor.get(chars[0].codePointAt(0));
  const sameRef = (a, b) => a.name === b.name && a.style === b.style && a.weight === b.weight;
  for (let i = 1; i <= chars.length; i++) {
    const nextFont = i < chars.length ? fontFor.get(chars[i].codePointAt(0)) : null;
    if (nextFont && sameRef(nextFont, runFont)) continue;
    runs.push({ text: chars.slice(runStart, i).join(""), font: runFont });
    runStart = i;
    if (nextFont) runFont = nextFont;
  }
  return runs;
}

// src/html/css.ts
function parseColorAlpha(css, keepZeroAlpha = false) {
  if (!css || css === "transparent") return keepZeroAlpha ? [0, 0, 0, 0] : null;
  const m = css.match(/^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)(?:\s*,\s*([\d.]+))?/);
  if (!m) {
    const modern = parseColor4(css);
    if (modern) return modern[3] === 0 && !keepZeroAlpha ? null : modern;
    return namedColor(css);
  }
  const a = m[4] !== void 0 ? Math.round(+m[4] * 255) : 255;
  if (a === 0 && !keepZeroAlpha) return null;
  return [+m[1], +m[2], +m[3], a];
}
var clamp255 = (v) => Math.max(0, Math.min(255, Math.round(v * 255)));
var gam = (v) => v <= 31308e-7 ? 12.92 * v : 1.055 * Math.pow(v, 1 / 2.4) - 0.055;
function linearSrgbToBytes(r, g, b, a) {
  return [clamp255(gam(r)), clamp255(gam(g)), clamp255(gam(b)), Math.max(0, Math.min(255, Math.round(a * 255)))];
}
function oklabToLinearSrgb(L, aa, bb) {
  const l = (L + 0.3963377774 * aa + 0.2158037573 * bb) ** 3;
  const m = (L - 0.1055613458 * aa - 0.0638541728 * bb) ** 3;
  const s = (L - 0.0894841775 * aa - 1.291485548 * bb) ** 3;
  return [
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s
  ];
}
function labToLinearSrgb(L, aa, bb) {
  const K = 24389 / 27, E = 216 / 24389;
  const fy = (L + 16) / 116, fx = fy + aa / 500, fz = fy - bb / 200;
  const f = (t, w) => (t ** 3 > E ? t ** 3 : (116 * t - 16) / K) * w;
  const x = f(fx, 0.9642956764295677), y = L > K * E ? ((L + 16) / 116) ** 3 : L / K, z = f(fz, 0.8251046025104602);
  return [
    3.1341359569958707 * x - 1.6173863321612538 * y - 0.4906619460083532 * z,
    -0.978795502912089 * x + 1.9161404054726447 * y + 0.03344273116131949 * z,
    0.07195537988411677 * x - 0.2289768264158322 * y + 1.4053400825966043 * z
  ];
}
function p3ToLinearSrgb(r, g, b) {
  const lin = (v) => v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  const [R, G, B] = [lin(r), lin(g), lin(b)];
  return [
    1.2249401762805587 * R - 0.2249401762805586 * G,
    -0.04205697751790684 * R + 1.0420569775179067 * G,
    -0.019637081008086 * R - 0.07863825739195 * G + 1.0982753384000616 * B
  ];
}
var num = (t, pctOf = 1) => t === void 0 ? NaN : t.endsWith("%") ? parseFloat(t) / 100 * pctOf : parseFloat(t);
function components(inner) {
  const [main = "", alphaPart] = inner.split("/");
  const c = main.trim().split(/[\s,]+/).filter(Boolean);
  if (c.length < 3) return null;
  const alpha = alphaPart !== void 0 ? num(alphaPart.trim()) : c.length > 3 ? num(c[3]) : 1;
  if (!Number.isFinite(alpha)) return null;
  return { c, alpha: Math.max(0, Math.min(1, alpha)) };
}
function parseColor4(css) {
  const m = css.trim().match(/^([a-z]+)\(([^)]*)\)$/i);
  if (!m) return null;
  const fn = (m[1] ?? "").toLowerCase();
  const parts = components(m[2] ?? "");
  if (!parts) return null;
  const { c, alpha } = parts;
  const n = (i, pctOf = 1) => num(c[i], pctOf);
  if (fn === "color") {
    const space = (c[0] ?? "").toLowerCase();
    const v = components((m[2] ?? "").replace(/^\s*[a-zA-Z0-9-]+\s*/, ""));
    if (!v || !v.c.slice(0, 3).every((t) => Number.isFinite(parseFloat(t)))) return null;
    const [r, g, b] = [num(v.c[0]), num(v.c[1]), num(v.c[2])];
    const toLinear = (x) => x <= 0.04045 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4;
    if (space === "srgb") return linearSrgbToBytes(toLinear(r), toLinear(g), toLinear(b), v.alpha);
    if (space === "srgb-linear") return linearSrgbToBytes(r, g, b, v.alpha);
    if (space === "display-p3") return linearSrgbToBytes(...p3ToLinearSrgb(r, g, b), v.alpha);
    return null;
  }
  if (!c.slice(0, 3).every((t) => Number.isFinite(parseFloat(t)))) return null;
  if (fn === "rgb" || fn === "rgba") {
    const v = (i) => {
      const t = c[i] ?? "";
      return t.endsWith("%") ? parseFloat(t) / 100 * 255 : parseFloat(t);
    };
    return [
      Math.max(0, Math.min(255, Math.round(v(0)))),
      Math.max(0, Math.min(255, Math.round(v(1)))),
      Math.max(0, Math.min(255, Math.round(v(2)))),
      Math.round(alpha * 255)
    ];
  }
  if (fn === "oklab") return linearSrgbToBytes(...oklabToLinearSrgb(n(0), n(1), n(2)), alpha);
  if (fn === "oklch") {
    const h = n(2) * Math.PI / 180;
    return linearSrgbToBytes(...oklabToLinearSrgb(n(0), n(1) * Math.cos(h), n(1) * Math.sin(h)), alpha);
  }
  if (fn === "lab") return linearSrgbToBytes(...labToLinearSrgb(n(0, 100), n(1), n(2)), alpha);
  if (fn === "lch") {
    const h = n(2) * Math.PI / 180;
    return linearSrgbToBytes(...labToLinearSrgb(n(0, 100), n(1) * Math.cos(h), n(1) * Math.sin(h)), alpha);
  }
  return null;
}
var _namedColors = {
  black: [0, 0, 0, 255],
  white: [255, 255, 255, 255],
  red: [255, 0, 0, 255],
  green: [0, 128, 0, 255],
  blue: [0, 0, 255, 255],
  gray: [128, 128, 128, 255],
  grey: [128, 128, 128, 255],
  yellow: [255, 255, 0, 255],
  orange: [255, 165, 0, 255],
  purple: [128, 0, 128, 255],
  pink: [255, 192, 203, 255],
  brown: [165, 42, 42, 255],
  cyan: [0, 255, 255, 255],
  magenta: [255, 0, 255, 255],
  lime: [0, 255, 0, 255],
  navy: [0, 0, 128, 255],
  teal: [0, 128, 128, 255],
  maroon: [128, 0, 0, 255],
  silver: [192, 192, 192, 255],
  indigo: [75, 0, 130, 255],
  violet: [238, 130, 238, 255],
  transparent: [0, 0, 0, 0]
};
function namedColor(name) {
  return _namedColors[name.toLowerCase()] ?? null;
}
function splitByTopLevelComma(s) {
  const parts = [];
  let depth = 0, cur = "";
  for (const ch of s) {
    if (ch === "(") depth++;
    else if (ch === ")") depth--;
    if (ch === "," && depth === 0) {
      if (cur.trim()) parts.push(cur.trim());
      cur = "";
    } else cur += ch;
  }
  if (cur.trim()) parts.push(cur.trim());
  return parts;
}
function splitPositionPair(v) {
  return v.trim().split(/\s+(?![^()]*\))/);
}
function parseCSSGradientStops(s) {
  const parts = splitByTopLevelComma(s);
  const stops = [];
  for (const [i, part] of parts.entries()) {
    const toks = splitPositionPair(part);
    const c = parseColorAlpha(toks[0] ?? "", true);
    if (!c) continue;
    const fallback = i / Math.max(1, parts.length - 1);
    const posToks = toks.slice(1, 3);
    if (!posToks.length) {
      stops.push({ color: c, position: fallback });
      continue;
    }
    for (const tok of posToks) {
      const pctM = tok.match(/^(-?[\d.]+)%$/);
      const pxM = tok.match(/^(-?[\d.]+)px$/);
      if (pctM) stops.push({ color: c, position: +pctM[1] / 100 });
      else if (pxM) stops.push({ color: c, position: fallback, posPx: +pxM[1] });
      else stops.push({ color: c, position: fallback });
    }
  }
  return stops;
}
function tileStops(stops, repeating) {
  if (!repeating || stops.length < 2) return stops;
  const pat = stops;
  const s0 = pat[0].position;
  const period = pat.at(-1).position - s0;
  if (period <= 1e-4) return stops;
  const MAX_TILED_STOPS = 2e3;
  const out = [];
  let done = false;
  for (let k = Math.floor(-s0 / period); !done && out.length < MAX_TILED_STOPS; k++) {
    for (const st of pat) {
      const p = st.position + k * period;
      out.push({ color: st.color, position: p });
      if (p >= 1) {
        done = true;
        break;
      }
    }
  }
  const tail = out.at(-1);
  if (!done && tail) out[out.length - 1] = { ...tail, position: 1 };
  const firstIdx = Math.max(0, out.findIndex((st) => st.position > 0) - 1);
  return out.slice(firstIdx);
}
function parseCSSGradient(css) {
  const linM = css.match(/^(repeating-)?linear-gradient\((.+)\)$/s);
  if (linM) {
    const repeating = !!linM[1];
    const inner = (linM[2] ?? "").trim();
    let angle = 180;
    let corner;
    let rest = inner;
    const degMatch = inner.match(/^(-?[\d.]+)deg\s*,\s*/);
    const toMatch = inner.match(/^to\s+(top|bottom|left|right)(?:\s+(top|bottom|left|right))?\s*,\s*/);
    if (degMatch) {
      angle = +degMatch[1];
      rest = inner.slice(degMatch[0].length);
    } else if (toMatch) {
      const words = [toMatch[1], toMatch[2]].filter(Boolean);
      const vert = words.find((kw) => kw === "top" || kw === "bottom");
      const horiz = words.find((kw) => kw === "left" || kw === "right");
      if (vert && horiz) {
        corner = `${vert} ${horiz}`;
        angle = { "top right": 45, "bottom right": 135, "bottom left": 225, "top left": 315 }[corner];
      } else {
        angle = { bottom: 180, top: 0, right: 90, left: 270 }[words[0] ?? ""] ?? 180;
      }
      rest = inner.slice(toMatch[0].length);
    }
    const stops = parseCSSGradientStops(rest);
    if (stops.length >= 2) return { type: "linear", angle, corner, repeating: repeating || void 0, stops };
  }
  const radM = css.match(/^(repeating-)?radial-gradient\((.+)\)$/s);
  if (radM) {
    const repeating = !!radM[1];
    const inner = (radM[2] ?? "").trim();
    let cx = 0.5, cy = 0.5, rest = inner;
    const atPos = inner.match(/^[^,]*\bat\s+([\d.]+%?)\s+([\d.]+%?)\s*,\s*/);
    if (atPos) {
      cx = parseFloat(atPos[1]) / (atPos[1].endsWith("%") ? 100 : 1);
      cy = parseFloat(atPos[2]) / (atPos[2].endsWith("%") ? 100 : 1);
      rest = inner.slice(atPos[0].length);
    } else {
      const shapeTok = /circle|ellipse|closest-side|closest-corner|farthest-side|farthest-corner|[\d.]+(?:px|%)/;
      const shapeM = new RegExp(`^(?:${shapeTok.source})(?:\\s+(?:${shapeTok.source}))*\\s*,\\s*`).exec(inner);
      if (shapeM) rest = inner.slice(shapeM[0].length);
    }
    const stops = parseCSSGradientStops(rest);
    if (stops.length >= 2) return { type: "radial", cx, cy, repeating: repeating || void 0, stops };
  }
  return null;
}
function parseCSSConicGradient(css) {
  const m = css.match(/^(repeating-)?conic-gradient\((.+)\)$/s);
  if (!m) return null;
  const repeating = !!m[1];
  let inner = (m[2] ?? "").trim();
  let fromDeg = 0, cx = 0.5, cy = 0.5;
  const pre = inner.match(/^(?:from\s+(-?[\d.]+)deg\s*)?(?:at\s+([\d.]+)%\s+([\d.]+)%\s*)?,\s*/);
  if (pre && (pre[1] !== void 0 || pre[2] !== void 0)) {
    if (pre[1] !== void 0) fromDeg = +pre[1];
    if (pre[2] !== void 0) {
      cx = +pre[2] / 100;
      cy = +(pre[3] ?? 0) / 100;
    }
    inner = inner.slice(pre[0].length);
  }
  const parts = splitByTopLevelComma(inner);
  const stops = [];
  for (const [i, part] of parts.entries()) {
    const toks = splitPositionPair(part);
    const c = parseColorAlpha(toks[0] ?? "", true);
    if (!c) continue;
    const fallback = i / Math.max(1, parts.length - 1);
    const posToks = toks.slice(1, 3);
    if (!posToks.length) {
      stops.push({ color: c, position: fallback });
      continue;
    }
    for (const tok of posToks) {
      const degM = tok.match(/^(-?[\d.]+)deg$/);
      const pctM = tok.match(/^(-?[\d.]+)%$/);
      if (degM) stops.push({ color: c, position: +degM[1] / 360 });
      else if (pctM) stops.push({ color: c, position: +pctM[1] / 100 });
      else stops.push({ color: c, position: fallback });
    }
  }
  if (stops.length < 2) return null;
  return { fromDeg, cx, cy, repeating: repeating || void 0, stops };
}
function parseCSSBoxShadow(css) {
  if (!css || css === "none") return [];
  const shadows = [];
  for (const part of splitByTopLevelComma(css)) {
    const tokens = part.trim().split(/\s+/);
    let inset = false;
    const lengths = [];
    const colorTokens = [];
    for (const tok of tokens) {
      if (tok === "inset") {
        inset = true;
        continue;
      }
      const pxM = tok.match(/^-?[\d.]+px$/);
      if (pxM) {
        lengths.push(parseFloat(tok) / PX_PER_PT);
        continue;
      }
      colorTokens.push(tok);
    }
    const colorStr = colorTokens.join(" ");
    const color = parseColorAlpha(colorStr) ?? [0, 0, 0, 180];
    if (lengths.length >= 2) {
      shadows.push({
        x: lengths[0],
        y: lengths[1],
        blur: lengths[2] ?? 0,
        spread: lengths[3],
        color,
        inset
      });
    }
  }
  return shadows;
}
function radiusComponent(str, ref) {
  const pxM = str.match(/^(-?[\d.]+)px$/);
  if (pxM) return Math.max(0, +pxM[1] / PX_PER_PT);
  const ptM = str.match(/^(-?[\d.]+)pt$/);
  if (ptM) return Math.max(0, +ptM[1]);
  const pctM = str.match(/^(-?[\d.]+)%$/);
  if (pctM) return Math.max(0, +pctM[1] / 100 * ref);
  return 0;
}
function overlapScale(tl, tr, br, bl, w, h) {
  return Math.min(
    1,
    ...[[w, tl.h + tr.h], [w, bl.h + br.h], [h, tl.v + bl.v], [h, tr.v + br.v]].filter(([, sum]) => sum > 0).map(([limit, sum]) => limit / sum)
  );
}
function parseBorderRadius(s, el, dims) {
  const rect = el?.getBoundingClientRect();
  const elW = rect ? rect.width / PX_PER_PT : dims?.w ?? 0;
  const elH = rect ? rect.height / PX_PER_PT : dims?.h ?? 0;
  const parseCorner = (val) => {
    const parts = val.trim().split(/\s+/);
    const hStr = parts[0] ?? val;
    const vStr = parts[1] ?? hStr;
    return { h: radiusComponent(hStr, elW), v: radiusComponent(vStr, elH) };
  };
  const tl = parseCorner(s.borderTopLeftRadius);
  const tr = parseCorner(s.borderTopRightRadius);
  const br = parseCorner(s.borderBottomRightRadius);
  const bl = parseCorner(s.borderBottomLeftRadius);
  if (elW > 0 && elH > 0) {
    const f = overlapScale(tl, tr, br, bl, elW, elH);
    if (f < 1) {
      for (const c of [tl, tr, br, bl]) {
        c.h *= f;
        c.v *= f;
      }
    }
  }
  const corners = [tl, tr, br, bl];
  if (corners.every((c) => c.h === 0 && c.v === 0)) return void 0;
  if (corners.every((c) => c.h === tl.h && c.v === tl.h)) return { all: tl.h };
  return { topLeft: tl, topRight: tr, bottomRight: br, bottomLeft: bl };
}
function clampRadiusToBox(radius, w, h) {
  if (!radius || w <= 0 || h <= 0) return radius;
  const a = radius.all ?? 0;
  const c = (x) => x ? { h: x.h, v: x.v } : { h: a, v: a };
  const tl = c(radius.topLeft), tr = c(radius.topRight);
  const br = c(radius.bottomRight), bl = c(radius.bottomLeft);
  const f = overlapScale(tl, tr, br, bl, w, h);
  if (f >= 1) return radius;
  for (const corner of [tl, tr, br, bl]) {
    corner.h *= f;
    corner.v *= f;
  }
  return { topLeft: tl, topRight: tr, bottomRight: br, bottomLeft: bl };
}
function insetBorderRadius(radius, iT, iR, iB, iL) {
  if (!radius) return void 0;
  const a = radius.all ?? 0;
  const inset = (c, ih, iv) => {
    const base = c ?? { h: a, v: a };
    return { h: Math.max(0, base.h - ih), v: Math.max(0, base.v - iv) };
  };
  const tl = inset(radius.topLeft, iL, iT);
  const tr = inset(radius.topRight, iR, iT);
  const br = inset(radius.bottomRight, iR, iB);
  const bl = inset(radius.bottomLeft, iL, iB);
  if ([tl, tr, br, bl].every((c) => c.h <= 0 || c.v <= 0)) return void 0;
  return { topLeft: tl, topRight: tr, bottomRight: br, bottomLeft: bl };
}
function isTransparentColor(css) {
  if (css === "transparent") return true;
  const m = css.match(/^rgba\([^)]*,\s*([\d.]+)\s*\)$/);
  return !!m && parseFloat(m[1]) === 0;
}
function pxToPt(s) {
  const m = s.match(/^(-?[\d.]+)px$/);
  return m ? +m[1] / PX_PER_PT : 0;
}

// src/html/clippath.ts
var RADIUS_TOK = "(closest-side|farthest-side|closest-corner|farthest-corner|[\\d.]+(?:px|%))";
function lengthPct(tok, ref) {
  if (!tok) return 0;
  const px = tok.match(/^(-?[\d.]+)px$/)?.[1];
  if (px !== void 0) return +px / PX_PER_PT;
  const pct = tok.match(/^(-?[\d.]+)%$/)?.[1];
  if (pct !== void 0) return +pct / 100 * ref;
  return 0;
}
function circleKeywordRadius(kw, cx, cy, w, h) {
  const sides = [cx, w - cx, cy, h - cy];
  const corners = [Math.hypot(cx, cy), Math.hypot(w - cx, cy), Math.hypot(cx, h - cy), Math.hypot(w - cx, h - cy)];
  if (kw === "closest-side") return Math.min(...sides);
  if (kw === "farthest-side") return Math.max(...sides);
  if (kw === "closest-corner") return Math.min(...corners);
  return Math.max(...corners);
}
function ellipseAxisRadius(kw, centerAlongAxis, extent) {
  const near = centerAlongAxis, far = extent - centerAlongAxis;
  if (kw === "closest-side" || kw === "closest-corner") return Math.min(near, far);
  return Math.max(near, far);
}
function resolvePosition(atClause, w, h) {
  if (!atClause) return { cx: w / 2, cy: h / 2 };
  const [xTok, yTok] = atClause.trim().split(/\s+/);
  return { cx: lengthPct(xTok, w), cy: lengthPct(yTok, h) };
}
function parseInset(inner, w, h) {
  const roundM = inner.match(/^(.*?)(?:\s+round\s+(.+))?$/s);
  const sideStr = (roundM?.[1] ?? inner).trim();
  const roundStr = roundM?.[2]?.trim();
  const toks = sideStr.split(/\s+/).filter(Boolean);
  if (!toks.length || toks.length > 4) return null;
  const top = lengthPct(toks[0], h);
  const right = lengthPct(toks[1] ?? toks[0], w);
  const bottom = lengthPct(toks[2] ?? toks[0], h);
  const left = lengthPct(toks[3] ?? toks[1] ?? toks[0], w);
  const x = left, y = top;
  const rw = Math.max(0, w - left - right);
  const rh = Math.max(0, h - top - bottom);
  let radius;
  if (roundStr) {
    const [hPart = "", vPart] = roundStr.split("/").map((s) => s.trim());
    const hToks = hPart.split(/\s+/);
    const vToks = (vPart ?? hPart).split(/\s+/);
    const at = (arr, i) => arr[i] ?? arr[(i + 2) % arr.length] ?? arr[0];
    const corner = (i) => ({
      h: lengthPct(at(hToks, i), rw),
      v: lengthPct(at(vToks, i), rh)
    });
    radius = { topLeft: corner(0), topRight: corner(1), bottomRight: corner(2), bottomLeft: corner(3) };
  }
  return { kind: "rect", x, y, w: rw, h: rh, radius };
}
function parseCircle(inner, w, h) {
  const re = new RegExp(`^\\s*(?:${RADIUS_TOK}\\s*)?(?:at\\s+(.+))?\\s*$`);
  const m = re.exec(inner);
  if (!m) return null;
  const { cx, cy } = resolvePosition(m[2], w, h);
  const radTok = m[1];
  const r = !radTok ? circleKeywordRadius("closest-side", cx, cy, w, h) : /px$|%$/.test(radTok) ? lengthPct(radTok, Math.sqrt((w * w + h * h) / 2)) : circleKeywordRadius(radTok, cx, cy, w, h);
  return { kind: "rect", x: cx - r, y: cy - r, w: r * 2, h: r * 2, radius: { all: r } };
}
function parseEllipse(inner, w, h) {
  const re = new RegExp(`^\\s*(?:${RADIUS_TOK}\\s+${RADIUS_TOK}\\s*)?(?:at\\s+(.+))?\\s*$`);
  const m = re.exec(inner);
  if (!m) return null;
  const { cx, cy } = resolvePosition(m[3], w, h);
  const rxTok = m[1], ryTok = m[2];
  const rx = !rxTok ? ellipseAxisRadius("closest-side", cx, w) : /px$|%$/.test(rxTok) ? lengthPct(rxTok, w) : ellipseAxisRadius(rxTok, cx, w);
  const ry = !ryTok ? ellipseAxisRadius("closest-side", cy, h) : /px$|%$/.test(ryTok) ? lengthPct(ryTok, h) : ellipseAxisRadius(ryTok, cy, h);
  const corner = { h: rx, v: ry };
  return { kind: "rect", x: cx - rx, y: cy - ry, w: rx * 2, h: ry * 2, radius: { topLeft: corner, topRight: corner, bottomRight: corner, bottomLeft: corner } };
}
function parsePolygon(inner, w, h) {
  let rest = inner.trim();
  let evenOdd = false;
  const ruleM = rest.match(/^(nonzero|evenodd)\s*,\s*/);
  if (ruleM) {
    evenOdd = ruleM[1] === "evenodd";
    rest = rest.slice(ruleM[0].length);
  }
  const points = splitByTopLevelComma(rest).map((pair) => {
    const [xTok, yTok] = pair.trim().split(/\s+/);
    return [lengthPct(xTok, w), lengthPct(yTok, h)];
  });
  if (points.length < 3) return null;
  const [start, ...rest2] = points;
  if (!start) return null;
  const ops = [{ op: "m", args: start }];
  for (const pt of rest2) ops.push({ op: "l", args: pt });
  return { kind: "path", ops, evenOdd };
}
function tokenizePathNumbers(s) {
  return (s.match(/-?\d*\.?\d+(?:[eE][-+]?\d+)?/g) ?? []).map(Number);
}
function tokenizeArcArgs(s) {
  const out = [];
  let i = 0;
  const numRe = /-?\d*\.?\d+(?:[eE][-+]?\d+)?/y;
  const skipSep = () => {
    while (i < s.length && /[\s,]/.test(s[i])) i++;
  };
  const readNumber = () => {
    skipSep();
    numRe.lastIndex = i;
    const m = numRe.exec(s);
    if (!m) return void 0;
    i = numRe.lastIndex;
    return Number(m[0]);
  };
  const readFlag = () => {
    skipSep();
    const c = s[i];
    if (c !== "0" && c !== "1") return void 0;
    i++;
    return Number(c);
  };
  for (; ; ) {
    const rx = readNumber();
    if (rx === void 0) break;
    const ry = readNumber();
    if (ry === void 0) break;
    const rot = readNumber();
    if (rot === void 0) break;
    const laf = readFlag();
    if (laf === void 0) break;
    const sf = readFlag();
    if (sf === void 0) break;
    const x = readNumber();
    if (x === void 0) break;
    const y = readNumber();
    if (y === void 0) break;
    out.push(rx, ry, rot, laf, sf, x, y);
  }
  return out;
}
function quadToCubic(x0, y0, qx, qy, x, y) {
  return [
    x0 + 2 / 3 * (qx - x0),
    y0 + 2 / 3 * (qy - y0),
    x + 2 / 3 * (qx - x),
    y + 2 / 3 * (qy - y),
    x,
    y
  ];
}
function arcToCubics(x0, y0, rx, ry, phiDeg, largeArc, sweep, x, y) {
  if (rx === 0 || ry === 0) return [[x0 + (x - x0) / 3, y0 + (y - y0) / 3, x0 + 2 * (x - x0) / 3, y0 + 2 * (y - y0) / 3, x, y]];
  rx = Math.abs(rx);
  ry = Math.abs(ry);
  const phi = phiDeg * Math.PI / 180;
  const cosP = Math.cos(phi), sinP = Math.sin(phi);
  const dx2 = (x0 - x) / 2, dy2 = (y0 - y) / 2;
  const x1p = cosP * dx2 + sinP * dy2;
  const y1p = -sinP * dx2 + cosP * dy2;
  const lambda = x1p * x1p / (rx * rx) + y1p * y1p / (ry * ry);
  if (lambda > 1) {
    const s = Math.sqrt(lambda);
    rx *= s;
    ry *= s;
  }
  const sign = largeArc === sweep ? -1 : 1;
  const num2 = rx * rx * ry * ry - rx * rx * y1p * y1p - ry * ry * x1p * x1p;
  const den = rx * rx * y1p * y1p + ry * ry * x1p * x1p;
  const co = sign * Math.sqrt(Math.max(0, num2) / (den || 1e-9));
  const cxp = co * (rx * y1p / ry);
  const cyp = co * -(ry * x1p / rx);
  const cx = cosP * cxp - sinP * cyp + (x0 + x) / 2;
  const cy = sinP * cxp + cosP * cyp + (y0 + y) / 2;
  const angle = (ux, uy, vx, vy) => {
    const dot = ux * vx + uy * vy;
    const len = Math.hypot(ux, uy) * Math.hypot(vx, vy);
    const a = Math.acos(Math.min(1, Math.max(-1, dot / (len || 1e-9))));
    return (ux * vy - uy * vx < 0 ? -1 : 1) * a;
  };
  const theta1 = angle(1, 0, (x1p - cxp) / rx, (y1p - cyp) / ry);
  let dtheta = angle((x1p - cxp) / rx, (y1p - cyp) / ry, (-x1p - cxp) / rx, (-y1p - cyp) / ry);
  if (!sweep && dtheta > 0) dtheta -= 2 * Math.PI;
  if (sweep && dtheta < 0) dtheta += 2 * Math.PI;
  const segments = Math.max(1, Math.ceil(Math.abs(dtheta) / (Math.PI / 2)));
  const delta = dtheta / segments;
  const out = [];
  for (let i = 0; i < segments; i++) {
    const a1 = theta1 + i * delta, a2 = a1 + delta;
    const k = 4 / 3 * Math.tan(delta / 4);
    const p0 = [Math.cos(a1), Math.sin(a1)];
    const p3 = [Math.cos(a2), Math.sin(a2)];
    const p1 = [p0[0] - k * Math.sin(a1), p0[1] + k * Math.cos(a1)];
    const p2 = [p3[0] + k * Math.sin(a2), p3[1] - k * Math.cos(a2)];
    const tf = (px, py) => [cx + cosP * rx * px - sinP * ry * py, cy + sinP * rx * px + cosP * ry * py];
    const [x1, y1] = tf(p1[0], p1[1]);
    const [x2, y2] = tf(p2[0], p2[1]);
    const [x3, y3] = tf(p3[0], p3[1]);
    out.push([x1, y1, x2, y2, x3, y3]);
  }
  return out;
}
function parseSvgPath(d) {
  const ops = [];
  let cx = 0, cy = 0, startX = 0, startY = 0;
  let lastCubicCtrl = null;
  let lastQuadCtrl = null;
  const cmdRe = /([MLHVCSQTAZmlhvcsqtaz])([^MLHVCSQTAZmlhvcsqtaz]*)/g;
  let m;
  while ((m = cmdRe.exec(d)) !== null) {
    const cmd = m[1];
    const rel = cmd === cmd.toLowerCase();
    const C = cmd.toUpperCase();
    const args = C === "A" ? tokenizeArcArgs(m[2] ?? "") : tokenizePathNumbers(m[2] ?? "");
    let ai = 0;
    const next = () => args[ai++] ?? 0;
    const emitLine = (x, y) => {
      ops.push({ op: "l", args: [x, y] });
      cx = x;
      cy = y;
    };
    const emitCubic = (x1, y1, x2, y2, x3, y3) => {
      ops.push({ op: "c", args: [x1, y1, x2, y2, x3, y3] });
      cx = x3;
      cy = y3;
    };
    do {
      if (C === "M") {
        const x = next(), y = next();
        if (x === void 0) break;
        cx = rel ? cx + x : x;
        cy = rel ? cy + y : y;
        startX = cx;
        startY = cy;
        ops.push({ op: "m", args: [cx, cy] });
        while (args[ai] !== void 0) {
          const lx = next(), ly = next();
          emitLine(rel ? cx + lx : lx, rel ? cy + ly : ly);
        }
      } else if (C === "L") {
        const x = next(), y = next();
        if (x === void 0) break;
        emitLine(rel ? cx + x : x, rel ? cy + y : y);
      } else if (C === "H") {
        const x = next();
        if (x === void 0) break;
        emitLine(rel ? cx + x : x, cy);
      } else if (C === "V") {
        const y = next();
        if (y === void 0) break;
        emitLine(cx, rel ? cy + y : y);
      } else if (C === "C") {
        const x1 = next(), y1 = next(), x2 = next(), y2 = next(), x = next(), y = next();
        if (x === void 0) break;
        const X1 = rel ? cx + x1 : x1, Y1 = rel ? cy + y1 : y1;
        const X2 = rel ? cx + x2 : x2, Y2 = rel ? cy + y2 : y2;
        const X = rel ? cx + x : x, Y = rel ? cy + y : y;
        lastCubicCtrl = [X2, Y2];
        lastQuadCtrl = null;
        emitCubic(X1, Y1, X2, Y2, X, Y);
      } else if (C === "S") {
        const x2 = next(), y2 = next(), x = next(), y = next();
        if (x === void 0) break;
        const X2 = rel ? cx + x2 : x2, Y2 = rel ? cy + y2 : y2;
        const X = rel ? cx + x : x, Y = rel ? cy + y : y;
        const rx1 = lastCubicCtrl ? 2 * cx - lastCubicCtrl[0] : cx;
        const ry1 = lastCubicCtrl ? 2 * cy - lastCubicCtrl[1] : cy;
        lastCubicCtrl = [X2, Y2];
        lastQuadCtrl = null;
        emitCubic(rx1, ry1, X2, Y2, X, Y);
      } else if (C === "Q") {
        const qx = next(), qy = next(), x = next(), y = next();
        if (x === void 0) break;
        const QX = rel ? cx + qx : qx, QY = rel ? cy + qy : qy;
        const X = rel ? cx + x : x, Y = rel ? cy + y : y;
        lastQuadCtrl = [QX, QY];
        lastCubicCtrl = null;
        emitCubic(...quadToCubic(cx, cy, QX, QY, X, Y));
      } else if (C === "T") {
        const x = next(), y = next();
        if (x === void 0) break;
        const X = rel ? cx + x : x, Y = rel ? cy + y : y;
        const tqx = lastQuadCtrl ? 2 * cx - lastQuadCtrl[0] : cx;
        const tqy = lastQuadCtrl ? 2 * cy - lastQuadCtrl[1] : cy;
        lastQuadCtrl = [tqx, tqy];
        lastCubicCtrl = null;
        emitCubic(...quadToCubic(cx, cy, tqx, tqy, X, Y));
      } else if (C === "A") {
        const rx = next(), ry = next(), rot = next(), laf = next(), sf = next(), x = next(), y = next();
        if (x === void 0) break;
        const X = rel ? cx + x : x, Y = rel ? cy + y : y;
        const x0 = cx, y0 = cy;
        for (const seg of arcToCubics(x0, y0, rx, ry, rot, !!laf, !!sf, X, Y)) {
          ops.push({ op: "c", args: seg });
        }
        cx = X;
        cy = Y;
        lastCubicCtrl = null;
        lastQuadCtrl = null;
      } else if (C === "Z") {
        ops.push({ op: "l", args: [startX, startY] });
        cx = startX;
        cy = startY;
        lastCubicCtrl = null;
        lastQuadCtrl = null;
        break;
      }
    } while (C === "M" ? false : args[ai] !== void 0 && C !== "Z");
  }
  return ops;
}
function parsePathFn(inner) {
  let rest = inner.trim();
  let evenOdd = false;
  const ruleM = rest.match(/^(nonzero|evenodd)\s*,\s*/);
  if (ruleM) {
    evenOdd = ruleM[1] === "evenodd";
    rest = rest.slice(ruleM[0].length);
  }
  const strM = rest.match(/^"((?:[^"\\]|\\.)*)"$/) ?? rest.match(/^'((?:[^'\\]|\\.)*)'$/);
  if (!strM) return null;
  const ops = parseSvgPath((strM[1] ?? "").replace(/\\(.)/g, "$1"));
  if (!ops.length) return null;
  const toPt = (seg) => ({ op: seg.op, args: seg.args.map((v) => v / PX_PER_PT) });
  return { kind: "path", ops: ops.map(toPt), evenOdd };
}
function parseClipPath(value, box) {
  const v = value.trim();
  if (!v || v === "none") return null;
  const fnM = v.match(/^(inset|circle|ellipse|polygon|path)\((.+)\)$/s);
  if (!fnM) return null;
  const [, fn, argsRaw = ""] = fnM;
  let shape = null;
  if (fn === "inset") shape = parseInset(argsRaw, box.w, box.h);
  if (fn === "circle") shape = parseCircle(argsRaw, box.w, box.h);
  if (fn === "ellipse") shape = parseEllipse(argsRaw, box.w, box.h);
  if (fn === "polygon") shape = parsePolygon(argsRaw, box.w, box.h);
  if (fn === "path") shape = parsePathFn(argsRaw);
  if (!shape) return null;
  if (shape.kind === "rect") return { ...shape, x: shape.x + box.x, y: shape.y + box.y };
  return { ...shape, ops: shape.ops.map((seg) => ({ op: seg.op, args: offsetArgs(seg.args, box.x, box.y) })) };
}
function offsetArgs(args, dx, dy) {
  return args.map((v, i) => v + (i % 2 === 0 ? dx : dy));
}

// src/html/counters.ts
function parseCounterList(v, def) {
  if (!v || v === "none") return [];
  const out = [];
  const toks = v.trim().split(/\s+/);
  for (let i = 0; i < toks.length; i++) {
    const name = toks[i];
    if (!/^[A-Za-z_-]/.test(name)) continue;
    let val = def;
    if (i + 1 < toks.length && /^-?\d+$/.test(toks[i + 1])) val = parseInt(toks[++i], 10);
    out.push([name, val]);
  }
  return out;
}
function applyCounters(counters, s) {
  const pushed = [];
  const push = (name, val) => {
    const st = counters.get(name) ?? [];
    st.push(val);
    counters.set(name, st);
    pushed.push(name);
  };
  for (const [name, val] of parseCounterList(s.counterReset, 0)) push(name, val);
  for (const [name, val] of parseCounterList(s.counterSet, 0)) {
    const st = counters.get(name);
    if (st?.length) st[st.length - 1] = val;
    else push(name, val);
  }
  for (const [name, val] of parseCounterList(s.counterIncrement, 1)) {
    const st = counters.get(name);
    if (st?.length) st[st.length - 1] = (st.at(-1) ?? 0) + val;
    else push(name, val);
  }
  return pushed;
}
function popCounters(counters, pushed) {
  for (const name of pushed) counters.get(name)?.pop();
}
var COUNTER_LIMIT = 1e5;
function countable(n) {
  if (!Number.isFinite(n)) return null;
  const i = Math.trunc(n);
  return i >= 1 && i <= COUNTER_LIMIT ? i : null;
}
function romanNumeral(n) {
  const table = [
    [1e3, "M"],
    [900, "CM"],
    [500, "D"],
    [400, "CD"],
    [100, "C"],
    [90, "XC"],
    [50, "L"],
    [40, "XL"],
    [10, "X"],
    [9, "IX"],
    [5, "V"],
    [4, "IV"],
    [1, "I"]
  ];
  let rest = countable(n);
  if (rest === null) return "";
  let out = "";
  for (const [v, sym] of table) while (rest >= v) {
    out += sym;
    rest -= v;
  }
  return out;
}
function alphaLabel(n) {
  let rest = countable(n);
  if (rest === null) return "";
  let out = "";
  while (rest > 0) {
    rest--;
    out = String.fromCharCode(97 + rest % 26) + out;
    rest = Math.floor(rest / 26);
  }
  return out;
}
function counterText(n, style) {
  const orDecimal = (v) => v === "" ? String(n) : v;
  switch (style) {
    case "lower-alpha":
    case "lower-latin":
      return orDecimal(alphaLabel(n));
    case "upper-alpha":
    case "upper-latin":
      return orDecimal(alphaLabel(n).toUpperCase());
    case "lower-roman":
      return orDecimal(romanNumeral(n).toLowerCase());
    case "upper-roman":
      return orDecimal(romanNumeral(n));
    case "decimal-leading-zero":
      return `${n < 10 && n >= 0 ? "0" : ""}${n}`;
    default:
      return String(n);
  }
}
function resolveContentList(content, counters) {
  const s = content.trim();
  let out = "";
  let i = 0;
  while (i < s.length) {
    if (s[i] === " ") {
      i++;
      continue;
    }
    const q = s[i];
    if (q === '"' || q === "'") {
      let j = i + 1, lit = "";
      while (j < s.length && s[j] !== q) {
        if (s[j] === "\\" && j + 1 < s.length) {
          lit += s[j + 1];
          j += 2;
        } else {
          lit += s[j];
          j++;
        }
      }
      if (j >= s.length) return null;
      out += lit;
      i = j + 1;
      continue;
    }
    const fnM = s.slice(i).match(/^(counters?)\(/);
    if (!fnM) return null;
    const close = s.indexOf(")", i);
    if (close < 0) return null;
    const parts = s.slice(i + fnM[0].length, close).split(",").map((p) => p.trim());
    const name = parts[0];
    if (!name) return null;
    const stack = counters.get(name);
    if (fnM[1] === "counters") {
      const sepM = (parts[1] ?? "").match(/^"((?:[^"\\]|\\.)*)"$/) ?? (parts[1] ?? "").match(/^'((?:[^'\\]|\\.)*)'$/);
      if (!sepM) return null;
      const sep = (sepM[1] ?? "").replace(/\\(.)/g, "$1");
      out += (stack?.length ? stack : [0]).map((v) => counterText(v, parts[2])).join(sep);
    } else {
      out += counterText(stack?.at(-1) ?? 0, parts[1]);
    }
    i = close + 1;
  }
  return out;
}

// src/images/decode.ts
var _decodeCache = /* @__PURE__ */ new Map();
function decodeToRaw(bytes2) {
  if (_decodeCache.has(bytes2)) return _decodeCache.get(bytes2);
  const p = decodeToRawUncached(bytes2);
  _decodeCache.set(bytes2, p);
  return p;
}
async function decodeToRawUncached(bytes2) {
  try {
    const blob = new Blob([bytes2]);
    let bmp;
    try {
      bmp = await createImageBitmap(blob, { premultiplyAlpha: "none", colorSpaceConversion: "none" });
    } catch {
      bmp = await createImageBitmap(blob);
    }
    const w = bmp.width, h = bmp.height;
    if (!w || !h) {
      bmp.close();
      return null;
    }
    const canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = h;
    const c2d = canvas.getContext("2d", { willReadFrequently: true });
    if (!c2d) {
      bmp.close();
      return null;
    }
    c2d.drawImage(bmp, 0, 0);
    bmp.close();
    const rgba = c2d.getImageData(0, 0, w, h).data;
    const n = w * h;
    let hasAlpha = false;
    let isGray = true;
    for (let i = 0; i < n; i++) {
      const o = i * 4;
      if (rgba[o + 3] !== 255) hasAlpha = true;
      if (rgba[o] !== rgba[o + 1] || rgba[o + 1] !== rgba[o + 2]) isGray = false;
      if (hasAlpha && !isGray) break;
    }
    const data = new Uint8Array(isGray ? n : n * 3);
    for (let i = 0; i < n; i++) {
      const o = i * 4;
      if (isGray) {
        data[i] = rgba[o];
      } else {
        data[i * 3] = rgba[o];
        data[i * 3 + 1] = rgba[o + 1];
        data[i * 3 + 2] = rgba[o + 2];
      }
    }
    let smask = null;
    if (hasAlpha) {
      smask = new Uint8Array(n);
      for (let i = 0; i < n; i++) smask[i] = rgba[i * 4 + 3];
    }
    return { width: w, height: h, colorSpace: isGray ? "DeviceGray" : "DeviceRGB", data, smask };
  } catch {
    return null;
  }
}

// src/pdf/svgvector.ts
var IDENTITY = [1, 0, 0, 1, 0, 0];
function composeAffine(m2, m1) {
  const [a1, b1, c1, d1, e1, f1] = m1;
  const [a2, b2, c2, d2, e2, f2] = m2;
  return [
    a2 * a1 + c2 * b1,
    b2 * a1 + d2 * b1,
    a2 * c1 + c2 * d1,
    b2 * c1 + d2 * d1,
    a2 * e1 + c2 * f1 + e2,
    b2 * e1 + d2 * f1 + f2
  ];
}
function transformOps(ops, m) {
  return ops.map((seg) => {
    const args = seg.args;
    const out = new Array(args.length);
    for (let i = 0; i < args.length; i += 2) {
      const ax = args[i] ?? 0, ay = args[i + 1] ?? 0;
      out[i] = m[0] * ax + m[2] * ay + m[4];
      out[i + 1] = m[1] * ax + m[3] * ay + m[5];
    }
    return { op: seg.op, args: out };
  });
}
function parseSvgTransformAttr(attr) {
  let m = IDENTITY;
  const re = /(\w+)\s*\(([^)]*)\)/g;
  let mm;
  while ((mm = re.exec(attr)) !== null) {
    const fn = mm[1];
    const args = (mm[2] ?? "").split(/[\s,]+/).filter(Boolean).map(Number);
    let fm = IDENTITY;
    if (fn === "translate") {
      fm = [1, 0, 0, 1, args[0] ?? 0, args[1] ?? 0];
    } else if (fn === "scale") {
      fm = [args[0] ?? 1, 0, 0, args[1] ?? args[0] ?? 1, 0, 0];
    } else if (fn === "rotate") {
      const rad = (args[0] ?? 0) * Math.PI / 180;
      const cos = Math.cos(rad), sin = Math.sin(rad);
      const cx = args[1] ?? 0, cy = args[2] ?? 0;
      const rot = [cos, sin, -sin, cos, 0, 0];
      fm = composeAffine([1, 0, 0, 1, cx, cy], composeAffine(rot, [1, 0, 0, 1, -cx, -cy]));
    }
    if (fn === "skewX") fm = [1, 0, Math.tan((args[0] ?? 0) * Math.PI / 180), 1, 0, 0];
    if (fn === "skewY") fm = [1, Math.tan((args[0] ?? 0) * Math.PI / 180), 0, 1, 0, 0];
    if (fn === "matrix") fm = [args[0] ?? 1, args[1] ?? 0, args[2] ?? 0, args[3] ?? 1, args[4] ?? 0, args[5] ?? 0];
    m = composeAffine(m, fm);
  }
  return m;
}
var NAMED = {
  black: [0, 0, 0, 255],
  white: [255, 255, 255, 255],
  red: [255, 0, 0, 255],
  green: [0, 128, 0, 255],
  blue: [0, 0, 255, 255],
  gray: [128, 128, 128, 255],
  grey: [128, 128, 128, 255],
  yellow: [255, 255, 0, 255],
  orange: [255, 165, 0, 255],
  purple: [128, 0, 128, 255],
  pink: [255, 192, 203, 255],
  brown: [165, 42, 42, 255],
  cyan: [0, 255, 255, 255],
  magenta: [255, 0, 255, 255],
  lime: [0, 255, 0, 255],
  navy: [0, 0, 128, 255],
  teal: [0, 128, 128, 255],
  maroon: [128, 0, 0, 255],
  silver: [192, 192, 192, 255],
  none: [0, 0, 0, 0],
  transparent: [0, 0, 0, 0]
};
function parseSvgColor(v, currentColor) {
  if (!v) return null;
  const s = v.trim().toLowerCase();
  if (s === "none") return null;
  if (s === "currentcolor") return currentColor;
  const hex6 = s.match(/^#([0-9a-f]{6})$/);
  if (hex6) {
    const n = parseInt(hex6[1], 16);
    return [n >> 16 & 255, n >> 8 & 255, n & 255, 255];
  }
  const hex3 = s.match(/^#([0-9a-f]{3})$/);
  if (hex3) {
    const [r = "0", g = "0", b = "0"] = hex3[1];
    return [parseInt(r + r, 16), parseInt(g + g, 16), parseInt(b + b, 16), 255];
  }
  const rgbM = s.match(/^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)(?:\s*,\s*([\d.]+))?\s*\)$/);
  if (rgbM) return [+rgbM[1], +rgbM[2], +rgbM[3], rgbM[4] !== void 0 ? Math.round(+rgbM[4] * 255) : 255];
  return NAMED[s] ?? null;
}
function parseNumOr(v, fallback) {
  if (v === void 0 || v === null) return fallback;
  const n = parseFloat(v);
  return Number.isFinite(n) ? n : fallback;
}
function parsePercentOrNum(v, fallback) {
  if (!v) return fallback;
  const s = v.trim();
  if (s.endsWith("%")) return parseFloat(s) / 100;
  const n = parseFloat(s);
  return Number.isNaN(n) ? fallback : n;
}
var BAIL_TAGS = ["filter", "mask", "pattern", "clipPath", "foreignObject", "text", "style", "image", "tspan", "textPath"];
function hasBailFeature(doc) {
  for (const tag of BAIL_TAGS) if (doc.getElementsByTagName(tag).length) return true;
  for (const el of Array.from(doc.getElementsByTagName("*"))) {
    for (const attr of ["filter", "mask", "clip-path"]) {
      const v = el.getAttribute(attr);
      if (v && v.trim().startsWith("url(")) return true;
    }
  }
  return false;
}
function applyAffine(m, x, y) {
  return [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];
}
function parseGradientDefs(doc, currentColor) {
  const defs = /* @__PURE__ */ new Map();
  for (const tag of ["linearGradient", "radialGradient"]) {
    for (const el of Array.from(doc.getElementsByTagName(tag))) {
      const id = el.getAttribute("id");
      if (!id) continue;
      const stops = [];
      for (const stopEl of Array.from(el.getElementsByTagName("stop"))) {
        const offset = parsePercentOrNum(stopEl.getAttribute("offset"), 0);
        const style = stopEl.getAttribute("style") ?? "";
        const styleColor = style.match(/stop-color\s*:\s*([^;]+)/)?.[1];
        const styleOpacity = style.match(/stop-opacity\s*:\s*([^;]+)/)?.[1];
        const color = parseSvgColor(styleColor ?? stopEl.getAttribute("stop-color") ?? "black", currentColor) ?? [0, 0, 0, 255];
        const opacity = parseFloat(styleOpacity ?? stopEl.getAttribute("stop-opacity") ?? "1");
        stops.push({ position: Math.max(0, Math.min(1, offset)), color: [color[0], color[1], color[2], Math.round(opacity * 255)] });
      }
      if (stops.length < 2) continue;
      const cx = parsePercentOrNum(el.getAttribute("cx"), 0.5);
      const cy = parsePercentOrNum(el.getAttribute("cy"), 0.5);
      defs.set(id, {
        isRadial: tag === "radialGradient",
        cx,
        cy,
        r: parsePercentOrNum(el.getAttribute("r"), 0.5),
        fx: el.hasAttribute("fx") ? parsePercentOrNum(el.getAttribute("fx"), cx) : cx,
        fy: el.hasAttribute("fy") ? parsePercentOrNum(el.getAttribute("fy"), cy) : cy,
        x1: parsePercentOrNum(el.getAttribute("x1"), 0),
        y1: parsePercentOrNum(el.getAttribute("y1"), 0),
        x2: parsePercentOrNum(el.getAttribute("x2"), 1),
        y2: parsePercentOrNum(el.getAttribute("y2"), 0),
        stops,
        userSpaceOnUse: el.getAttribute("gradientUnits") === "userSpaceOnUse",
        gradientTransform: el.hasAttribute("gradientTransform") ? parseSvgTransformAttr(el.getAttribute("gradientTransform")) : IDENTITY
      });
    }
  }
  return defs;
}
var CAP_MAP = { butt: 0, round: 1, square: 2 };
var JOIN_MAP = { miter: 0, round: 1, bevel: 2 };
function readStyle(el, inherited, currentColor) {
  const style = el.getAttribute("style") ?? "";
  const styleAttr = (name) => style.match(new RegExp(`${name}\\s*:\\s*([^;]+)`))?.[1]?.trim();
  const fillRaw = styleAttr("fill") ?? el.getAttribute("fill");
  const strokeRaw = styleAttr("stroke") ?? el.getAttribute("stroke");
  const swRaw = styleAttr("stroke-width") ?? el.getAttribute("stroke-width");
  const foRaw = styleAttr("fill-opacity") ?? el.getAttribute("fill-opacity");
  const soRaw = styleAttr("stroke-opacity") ?? el.getAttribute("stroke-opacity");
  const dashRaw = styleAttr("stroke-dasharray") ?? el.getAttribute("stroke-dasharray");
  const capRaw = styleAttr("stroke-linecap") ?? el.getAttribute("stroke-linecap");
  const joinRaw = styleAttr("stroke-linejoin") ?? el.getAttribute("stroke-linejoin");
  let dash = inherited.dash;
  if (dashRaw !== void 0 && dashRaw !== null) {
    if (dashRaw === "none") dash = null;
    else {
      const nums = dashRaw.trim().split(/[\s,]+/).map(Number).filter((n) => !Number.isNaN(n) && n >= 0);
      dash = nums.length ? nums : null;
    }
  }
  return {
    fill: fillRaw !== null ? fillRaw === "none" ? null : parseSvgColor(fillRaw, currentColor) ?? inherited.fill : inherited.fill,
    stroke: strokeRaw !== null ? strokeRaw === "none" ? null : parseSvgColor(strokeRaw, currentColor) ?? inherited.stroke : inherited.stroke,
    // through the same NaN-guarding helper the rest of this file uses: a bare
    // parseFloat here let stroke-width="thin" reach the content stream as the
    // literal token NaN, which a reader drops along with the whole operator
    strokeWidth: parseNumOr(swRaw, inherited.strokeWidth),
    fillOpacity: parseNumOr(foRaw, inherited.fillOpacity),
    strokeOpacity: parseNumOr(soRaw, inherited.strokeOpacity),
    dash,
    lineCap: capRaw != null && CAP_MAP[capRaw] !== void 0 ? CAP_MAP[capRaw] : inherited.lineCap,
    lineJoin: joinRaw != null && JOIN_MAP[joinRaw] !== void 0 ? JOIN_MAP[joinRaw] : inherited.lineJoin
  };
}
function fillUrlRef(el) {
  const style = el.getAttribute("style") ?? "";
  const raw = style.match(/fill\s*:\s*url\(([^)]+)\)/)?.[1] ?? el.getAttribute("fill");
  const m = raw?.match(/^url\((.+)\)$/);
  if (!m) return null;
  return (m[1] ?? "").replace(/^["']|["']$/g, "").replace(/^#/, "");
}
function bboxOfOps(ops) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const seg of ops) {
    for (let i = 0; i + 1 < seg.args.length; i += 2) {
      const px = seg.args[i], py = seg.args[i + 1];
      minX = Math.min(minX, px);
      maxX = Math.max(maxX, px);
      minY = Math.min(minY, py);
      maxY = Math.max(maxY, py);
    }
  }
  if (!Number.isFinite(minX)) return { x: 0, y: 0, w: 0, h: 0 };
  return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
}
function rectPathD(x, y, w, h, rx, ry) {
  if (rx <= 0 || ry <= 0) return `M ${x} ${y} H ${x + w} V ${y + h} H ${x} Z`;
  rx = Math.min(rx, w / 2);
  ry = Math.min(ry, h / 2);
  return `M ${x + rx} ${y} H ${x + w - rx} A ${rx} ${ry} 0 0 1 ${x + w} ${y + ry} V ${y + h - ry} A ${rx} ${ry} 0 0 1 ${x + w - rx} ${y + h} H ${x + rx} A ${rx} ${ry} 0 0 1 ${x} ${y + h - ry} V ${y + ry} A ${rx} ${ry} 0 0 1 ${x + rx} ${y} Z`;
}
function ellipsePathD(cx, cy, rx, ry) {
  return `M ${cx - rx} ${cy} A ${rx} ${ry} 0 1 0 ${cx + rx} ${cy} A ${rx} ${ry} 0 1 0 ${cx - rx} ${cy} Z`;
}
function shapeToOps(el) {
  const tag = el.tagName;
  const num2 = (name, fallback = 0) => parseFloat(el.getAttribute(name) ?? "") || fallback;
  if (tag === "path") {
    const d = el.getAttribute("d");
    return d ? parseSvgPath(d) : null;
  }
  if (tag === "rect") {
    const w = num2("width"), h = num2("height");
    if (w <= 0 || h <= 0) return null;
    let rx = el.hasAttribute("rx") ? num2("rx") : el.hasAttribute("ry") ? num2("ry") : 0;
    let ry = el.hasAttribute("ry") ? num2("ry") : rx;
    return parseSvgPath(rectPathD(num2("x"), num2("y"), w, h, rx, ry));
  }
  if (tag === "circle") {
    const r = num2("r");
    if (r <= 0) return null;
    return parseSvgPath(ellipsePathD(num2("cx"), num2("cy"), r, r));
  }
  if (tag === "ellipse") {
    const rx = num2("rx"), ry = num2("ry");
    if (rx <= 0 || ry <= 0) return null;
    return parseSvgPath(ellipsePathD(num2("cx"), num2("cy"), rx, ry));
  }
  if (tag === "line") {
    return [{ op: "m", args: [num2("x1"), num2("y1")] }, { op: "l", args: [num2("x2"), num2("y2")] }];
  }
  if (tag === "polyline" || tag === "polygon") {
    const pts = (el.getAttribute("points") ?? "").trim().split(/[\s,]+/).map(Number);
    if (pts.length < 4) return null;
    const ops = [{ op: "m", args: [pts[0], pts[1]] }];
    for (let i = 2; i + 1 < pts.length; i += 2) ops.push({ op: "l", args: [pts[i], pts[i + 1]] });
    if (tag === "polygon") ops.push({ op: "l", args: [pts[0], pts[1]] });
    return ops;
  }
  return null;
}
var MAX_USE_DEPTH = 12;
var XLINK_NS = "http://www.w3.org/1999/xlink";
function walk(el, matrix, inherited, gradientDefs, out, currentColor, useDepth = 0) {
  const tag = el.tagName;
  if (tag === "defs") return;
  const local = el.getAttribute("transform");
  const m = local ? composeAffine(matrix, parseSvgTransformAttr(local)) : matrix;
  const style = readStyle(el, inherited, currentColor);
  const elOpacity = parsePercentOrNum(el.getAttribute("opacity"), 1);
  if (tag === "g" || tag === "svg" || tag === "a") {
    for (const child of Array.from(el.children)) walk(child, m, style, gradientDefs, out, currentColor, useDepth);
    return;
  }
  if (tag === "use") {
    if (useDepth >= MAX_USE_DEPTH) return;
    const href = el.getAttributeNS(XLINK_NS, "href") || el.getAttribute("href") || el.getAttribute("xlink:href");
    if (!href || !href.startsWith("#")) return;
    const target = el.ownerDocument.getElementById(href.slice(1));
    if (!target) return;
    const x = parseFloat(el.getAttribute("x") ?? "") || 0;
    const y = parseFloat(el.getAttribute("y") ?? "") || 0;
    const um = x || y ? composeAffine(m, [1, 0, 0, 1, x, y]) : m;
    walk(target, um, style, gradientDefs, out, currentColor, useDepth + 1);
    return;
  }
  const rawOps = shapeToOps(el);
  if (!rawOps || !rawOps.length) return;
  const ops = transformOps(rawOps, m);
  const isLine = tag === "line";
  const fillRef = !isLine ? fillUrlRef(el) : null;
  const shape = {
    ops,
    evenOdd: (el.getAttribute("fill-rule") ?? "") === "evenodd",
    opacity: elOpacity
  };
  if (fillRef && gradientDefs.has(fillRef)) {
    const g = gradientDefs.get(fillRef);
    if (g.userSpaceOnUse) return;
    const bbox = bboxOfOps(ops);
    const gStops = g.stops.map((s) => ({ position: s.position, color: s.color }));
    if (g.isRadial) {
      const [tcx, tcy] = applyAffine(g.gradientTransform, g.cx, g.cy);
      const [tfx, tfy] = applyAffine(g.gradientTransform, g.fx, g.fy);
      shape.gradient = { type: "radial", cx: tcx, cy: tcy, fx: tfx, fy: tfy, stops: gStops };
    } else {
      const [tx1, ty1] = applyAffine(g.gradientTransform, g.x1, g.y1);
      const [tx2, ty2] = applyAffine(g.gradientTransform, g.x2, g.y2);
      const dx = tx2 - tx1, dy = -(ty2 - ty1);
      const angle = Math.atan2(dx, dy) * 180 / Math.PI;
      shape.gradient = { type: "linear", angle, stops: gStops };
    }
    shape.gradientBox = bbox;
  } else if (!isLine && style.fill) {
    shape.fill = [style.fill[0], style.fill[1], style.fill[2]];
  }
  if (style.stroke) {
    shape.stroke = [style.stroke[0], style.stroke[1], style.stroke[2]];
    const scale = (Math.hypot(m[0], m[1]) + Math.hypot(m[2], m[3])) / 2;
    shape.strokeWidth = style.strokeWidth * scale;
    if (style.dash) shape.dashArray = style.dash.map((n) => n * scale);
    if (style.lineCap) shape.lineCap = style.lineCap;
    if (style.lineJoin) shape.lineJoin = style.lineJoin;
  }
  if (!shape.fill && !shape.gradient && !shape.stroke) return;
  const propOpacity = shape.fill || shape.gradient ? style.fillOpacity : style.strokeOpacity;
  shape.opacity = elOpacity * propOpacity;
  out.push(shape);
}
function svgToVectorShapes(svgStr, boxX, boxY, boxW, boxH, currentColor = [0, 0, 0, 255]) {
  if (boxW <= 0 || boxH <= 0) return null;
  let doc;
  try {
    doc = new DOMParser().parseFromString(svgStr, "image/svg+xml");
  } catch {
    return null;
  }
  if (doc.getElementsByTagName("parsererror").length) return null;
  const root = doc.documentElement;
  if (!root || root.tagName !== "svg") return null;
  if (hasBailFeature(doc)) return null;
  const viewBoxAttr = root.getAttribute("viewBox");
  let vbX = 0, vbY = 0, vbW, vbH;
  if (viewBoxAttr) {
    const parts = viewBoxAttr.trim().split(/[\s,]+/).map(Number);
    if (parts.length !== 4 || parts.some(Number.isNaN) || parts[2] <= 0 || parts[3] <= 0) return null;
    [vbX, vbY, vbW, vbH] = parts;
  } else {
    vbW = parseFloat(root.getAttribute("width") ?? "") || boxW;
    vbH = parseFloat(root.getAttribute("height") ?? "") || boxH;
  }
  const parAttr = (root.getAttribute("preserveAspectRatio") ?? "xMidYMid meet").trim();
  const parTokens = parAttr.split(/\s+/);
  const align = parTokens.find((t) => t !== "defer") ?? "xMidYMid";
  let scaleX, scaleY, tx = 0, ty = 0;
  if (align === "none") {
    scaleX = boxW / vbW;
    scaleY = boxH / vbH;
  } else {
    const scale = Math.min(boxW / vbW, boxH / vbH);
    scaleX = scale;
    scaleY = scale;
    const extraX = boxW - vbW * scale;
    const extraY = boxH - vbH * scale;
    if (align.startsWith("xMid")) tx = extraX / 2;
    else if (align.startsWith("xMax")) tx = extraX;
    if (align.endsWith("YMid")) ty = extraY / 2;
    else if (align.endsWith("YMax")) ty = extraY;
  }
  const base = composeAffine(
    [1, 0, 0, 1, boxX + tx, boxY + ty],
    composeAffine([scaleX, 0, 0, scaleY, 0, 0], [1, 0, 0, 1, -vbX, -vbY])
  );
  const gradientDefs = parseGradientDefs(doc, currentColor);
  const defaultStyle = { fill: [0, 0, 0, 255], stroke: null, strokeWidth: 1, fillOpacity: 1, strokeOpacity: 1, dash: null, lineCap: 0, lineJoin: 0 };
  const rootStyle = readStyle(root, defaultStyle, currentColor);
  const out = [];
  for (const child of Array.from(root.children)) walk(child, base, rootStyle, gradientDefs, out, currentColor);
  return out;
}

// src/html/images.ts
function pushVectorShapes(ctx, page, shapes, dy, opacity) {
  for (const shape of shapes) {
    const ops = dy === 0 ? shape.ops : shape.ops.map((seg) => ({
      op: seg.op,
      args: seg.args.map((v, i) => i % 2 === 1 ? v + dy : v)
    }));
    const gradientBox = shape.gradientBox && (dy === 0 ? shape.gradientBox : { ...shape.gradientBox, y: shape.gradientBox.y + dy });
    ctx.commands.push({
      type: "path",
      page,
      ops,
      evenOdd: shape.evenOdd,
      fill: shape.fill,
      stroke: shape.stroke,
      strokeWidth: shape.strokeWidth,
      dashArray: shape.dashArray,
      lineCap: shape.lineCap,
      lineJoin: shape.lineJoin,
      gradient: shape.gradient,
      gradientBox,
      opacity: opacity !== void 0 && shape.opacity !== void 0 ? opacity * shape.opacity : opacity ?? shape.opacity
    });
  }
}
var _imageCache = /* @__PURE__ */ new Map();
var _dataUriCache = /* @__PURE__ */ new Map();
function _dataUriKey(uri) {
  let h1 = 5381, h2 = 52711;
  for (let i = 0; i < uri.length; i++) {
    const c = uri.charCodeAt(i);
    h1 = h1 * 33 ^ c;
    h2 = h2 * 31 + c | 0;
  }
  return uri.length + ":" + (h1 >>> 0).toString(36) + ":" + (h2 >>> 0).toString(36);
}
function _fetchImageCached(url) {
  if (!_imageCache.has(url)) {
    const p = fetch(url).then((r) => r.ok ? r.arrayBuffer().then((b) => new Uint8Array(b)) : null).catch(() => null);
    p.then((result) => {
      if (!result) _imageCache.delete(url);
    });
    _imageCache.set(url, p);
  }
  return _imageCache.get(url);
}
async function resolveImage(srcUrl) {
  let src = null;
  let format = "png";
  if (srcUrl.startsWith("data:")) {
    const comma = srcUrl.indexOf(",");
    if (comma < 0) return null;
    const header = srcUrl.slice(0, comma);
    if (header.includes("svg")) format = "svg";
    else if (header.includes("jpeg") || header.includes("jpg")) format = "jpg";
    const duKey = _dataUriKey(srcUrl);
    if (_dataUriCache.has(duKey)) {
      src = _dataUriCache.get(duKey);
    } else if (header.includes(";base64")) {
      try {
        const bin = atob(srcUrl.slice(comma + 1));
        src = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) src[i] = bin.charCodeAt(i);
      } catch {
        _dataUriCache.set(duKey, null);
        return null;
      }
      _dataUriCache.set(duKey, src);
    } else {
      try {
        src = new TextEncoder().encode(decodeURIComponent(srcUrl.slice(comma + 1)));
      } catch {
        _dataUriCache.set(duKey, null);
        return null;
      }
      _dataUriCache.set(duKey, src);
    }
  } else {
    const ext = (srcUrl.split("?")[0] ?? "").split(".").pop()?.toLowerCase();
    if (ext === "svg") format = "svg";
    else if (ext === "jpg" || ext === "jpeg") format = "jpg";
    src = await _fetchImageCached(srcUrl);
  }
  if (!src) return null;
  if (format !== "svg") {
    const f = sniffFormat(src);
    const wasmHandles = f === "jpeg" || f === "png" && !pngNeedsBrowserDecode(src);
    if (!wasmHandles) {
      if (f !== "png" && f !== "webp" && f !== "avif") return null;
      const raw = await decodeToRaw(src);
      return raw ? { kind: "raw", raw } : null;
    }
  }
  return { kind: "bytes", src, format };
}
function extractBgUrl(layer) {
  const m = layer.match(/^url\(["']?([^"')]+)["']?\)$/);
  return m ? m[1] ?? null : null;
}
function parsePositionComponent(val, availableSpace) {
  if (!val) return availableSpace / 2;
  const pctM = val.match(/^(-?[\d.]+)%$/);
  if (pctM) return availableSpace * (+pctM[1] / 100);
  const pxM = val.match(/^(-?[\d.]+)px$/);
  if (pxM) return +pxM[1] / PX_PER_PT;
  const calcM = val.match(/^calc\((-?[\d.]+)%\s*([+-])\s*(-?[\d.]+)px\)$/);
  if (calcM) {
    const base = availableSpace * (+calcM[1] / 100);
    const off = +calcM[3] / PX_PER_PT;
    return calcM[2] === "+" ? base + off : base - off;
  }
  return availableSpace / 2;
}
function computeObjectFitRect(fit, position, boxX, boxY, boxW, boxH, naturalW, naturalH) {
  if (fit === "fill" || !naturalW || !naturalH) {
    return { x: boxX, y: boxY, w: boxW, h: boxH, needsClip: false };
  }
  let drawW, drawH;
  if (fit === "none") {
    drawW = naturalW;
    drawH = naturalH;
  } else {
    const scaleContain = Math.min(boxW / naturalW, boxH / naturalH);
    const scaleCover = Math.max(boxW / naturalW, boxH / naturalH);
    const scale = fit === "cover" ? scaleCover : scaleContain;
    drawW = naturalW * scale;
    drawH = naturalH * scale;
    if (fit === "scale-down" && naturalW <= drawW && naturalH <= drawH) {
      drawW = naturalW;
      drawH = naturalH;
    }
  }
  const [posXRaw, posYRaw] = splitPositionPair(position || "50% 50%");
  const offX = parsePositionComponent(posXRaw, boxW - drawW);
  const offY = parsePositionComponent(posYRaw, boxH - drawH);
  const eps = 0.01;
  const needsClip = drawW > boxW + eps || drawH > boxH + eps;
  return { x: boxX + offX, y: boxY + offY, w: drawW, h: drawH, needsClip };
}
async function emitImage(el, ctx) {
  const domRect = el.getBoundingClientRect();
  if (domRect.width < 1 || domRect.height < 1) return;
  const { x, y, w, h } = domRectToPt(domRect, ctx.containerRect);
  const srcUrl = el.currentSrc || el.src || "";
  if (!srcUrl) return;
  const img = await resolveImage(srcUrl);
  if (!img) {
    console.warn(`[daepdf] Could not fetch image: ${srcUrl}`);
    return;
  }
  const cs = getComputedStyle(el);
  const insL = pxToPt(cs.borderLeftWidth || "0px") + pxToPt(cs.paddingLeft || "0px");
  const insT = pxToPt(cs.borderTopWidth || "0px") + pxToPt(cs.paddingTop || "0px");
  const insR = pxToPt(cs.borderRightWidth || "0px") + pxToPt(cs.paddingRight || "0px");
  const insB = pxToPt(cs.borderBottomWidth || "0px") + pxToPt(cs.paddingBottom || "0px");
  const cbX = x + insL, cbY = y + insT;
  const cbW = Math.max(0, w - insL - insR);
  const cbH = Math.max(0, h - insT - insB);
  if (cbW <= 0 || cbH <= 0) return;
  const naturalW = (el.naturalWidth || 0) / PX_PER_PT;
  const naturalH = (el.naturalHeight || 0) / PX_PER_PT;
  const fit = computeObjectFitRect(cs.objectFit || "fill", cs.objectPosition, cbX, cbY, cbW, cbH, naturalW, naturalH);
  const clipRadius = insetBorderRadius(parseBorderRadius(cs, el), insT, insR, insB, insL);
  const needsClip = fit.needsClip || !!clipRadius;
  const opacity = stackOpacity(ctx);
  let vectorShapes = null;
  if (img.kind === "bytes" && img.format === "svg") {
    const svgStr = new TextDecoder().decode(img.src);
    const currentColor = parseColorAlpha(cs.color) ?? [0, 0, 0, 255];
    vectorShapes = svgToVectorShapes(svgStr, fit.x, fit.y, fit.w, fit.h, currentColor);
  }
  for (const { page, y: boxLy } of paginateSpan(cbY, cbH, ctx.pageH)) {
    const pageOffset = cbY - boxLy;
    const imgLy = fit.y - pageOffset;
    if (needsClip) ctx.commands.push({ type: "clip-push", page, x: cbX, y: boxLy, w: cbW, h: cbH, radius: clipRadius });
    if (vectorShapes) {
      pushVectorShapes(ctx, page, vectorShapes, imgLy - fit.y, opacity);
    } else {
      ctx.commands.push(img.kind === "raw" ? { type: "raw-image", page, raw: img.raw, x: fit.x, y: imgLy, w: fit.w, h: fit.h, opacity } : { type: "image", page, src: img.src, format: img.format, x: fit.x, y: imgLy, w: fit.w, h: fit.h, opacity });
    }
    if (needsClip) ctx.commands.push({ type: "clip-pop", page });
  }
}
function emitCanvas(el, ctx) {
  const domRect = el.getBoundingClientRect();
  if (domRect.width < 1 || domRect.height < 1) return;
  if (!el.width || !el.height) return;
  let dataUrl;
  try {
    dataUrl = el.toDataURL("image/png");
  } catch {
    return;
  }
  const comma = dataUrl.indexOf(",");
  if (comma < 0) return;
  const bin = atob(dataUrl.slice(comma + 1));
  const src = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) src[i] = bin.charCodeAt(i);
  const { x, y, w, h } = domRectToPt(domRect, ctx.containerRect);
  const cs = getComputedStyle(el);
  const insL = pxToPt(cs.borderLeftWidth || "0px") + pxToPt(cs.paddingLeft || "0px");
  const insT = pxToPt(cs.borderTopWidth || "0px") + pxToPt(cs.paddingTop || "0px");
  const insR = pxToPt(cs.borderRightWidth || "0px") + pxToPt(cs.paddingRight || "0px");
  const insB = pxToPt(cs.borderBottomWidth || "0px") + pxToPt(cs.paddingBottom || "0px");
  const cbX = x + insL, cbY = y + insT;
  const cbW = Math.max(0, w - insL - insR);
  const cbH = Math.max(0, h - insT - insB);
  if (cbW <= 0 || cbH <= 0) return;
  const clipRadius = insetBorderRadius(parseBorderRadius(cs, el), insT, insR, insB, insL);
  const opacity = stackOpacity(ctx);
  for (const { page, y: ly } of paginateSpan(cbY, cbH, ctx.pageH)) {
    if (clipRadius) ctx.commands.push({ type: "clip-push", page, x: cbX, y: ly, w: cbW, h: cbH, radius: clipRadius });
    ctx.commands.push({
      type: "image",
      page,
      src,
      format: "png",
      x: cbX,
      y: ly,
      w: cbW,
      h: cbH,
      opacity
    });
    if (clipRadius) ctx.commands.push({ type: "clip-pop", page });
  }
}
async function emitInlineSVG(el, ctx) {
  const domRect = el.getBoundingClientRect();
  if (domRect.width < 1 || domRect.height < 1) return;
  const { x, y, w, h } = domRectToPt(domRect, ctx.containerRect);
  const cs = getComputedStyle(el);
  const clone = el.cloneNode(true);
  clone.style.color = cs.color;
  clone.style.fontFamily = cs.fontFamily;
  clone.style.fontSize = cs.fontSize;
  clone.setAttribute("width", String(domRect.width));
  clone.setAttribute("height", String(domRect.height));
  const svgStr = new XMLSerializer().serializeToString(clone);
  const opacity = stackOpacity(ctx);
  const currentColor = parseColorAlpha(cs.color) ?? [0, 0, 0, 255];
  const shapes = svgToVectorShapes(svgStr, x, y, w, h, currentColor);
  if (shapes) {
    for (const { page, y: ly } of paginateSpan(y, h, ctx.pageH)) {
      pushVectorShapes(ctx, page, shapes, ly - y, opacity);
    }
    return;
  }
  const src = new TextEncoder().encode(svgStr);
  for (const { page, y: ly } of paginateSpan(y, h, ctx.pageH)) {
    ctx.commands.push({
      type: "image",
      page,
      src,
      format: "svg",
      x,
      y: ly,
      w,
      h,
      opacity
    });
  }
}
var _naturalSizeCache = /* @__PURE__ */ new Map();
async function getNaturalSize(bytes2) {
  if (_naturalSizeCache.has(bytes2)) return _naturalSizeCache.get(bytes2);
  const p = createImageBitmap(new Blob([bytes2])).then((bmp) => {
    const size = { w: bmp.width, h: bmp.height };
    bmp.close();
    return size;
  }).catch(() => null);
  _naturalSizeCache.set(bytes2, p);
  return p;
}
function nthCyclic(list, i) {
  return list[i % list.length]?.trim() ?? "";
}
function parseBgSize(sizeStr, boxW, boxH, naturalW, naturalH) {
  const val = sizeStr || "auto";
  if (val === "cover" || val === "contain") {
    if (!naturalW || !naturalH) return { tileW: boxW, tileH: boxH };
    const scale = val === "cover" ? Math.max(boxW / naturalW, boxH / naturalH) : Math.min(boxW / naturalW, boxH / naturalH);
    return { tileW: naturalW * scale, tileH: naturalH * scale };
  }
  const parseComponent = (v, ref) => {
    if (!v || v === "auto") return null;
    const pctM = v.match(/^(-?[\d.]+)%$/);
    if (pctM) return ref * (+pctM[1] / 100);
    const pxM = v.match(/^(-?[\d.]+)px$/);
    if (pxM) return +pxM[1] / PX_PER_PT;
    return null;
  };
  const [wRaw, hRaw] = val.split(/\s+/);
  let tw = parseComponent(wRaw, boxW);
  let th = parseComponent(hRaw, boxH);
  if (tw === null && th === null) {
    tw = naturalW || boxW;
    th = naturalH || boxH;
  } else if (tw === null && th !== null) {
    tw = naturalW && naturalH ? naturalW / naturalH * th : boxW;
  } else if (th === null && tw !== null) {
    th = naturalW && naturalH ? naturalH / naturalW * tw : boxH;
  }
  return { tileW: tw ?? boxW, tileH: th ?? boxH };
}
function parseBgRepeat(repeatStr) {
  const parts = (repeatStr || "repeat").trim().split(/\s+/);
  let rx, ry;
  if (parts.length === 1) {
    const v = parts[0] ?? "";
    if (v === "repeat-x") {
      rx = "repeat";
      ry = "no-repeat";
    } else if (v === "repeat-y") {
      rx = "no-repeat";
      ry = "repeat";
    } else {
      rx = v;
      ry = v;
    }
  } else {
    rx = parts[0] ?? "";
    ry = parts[1] ?? "";
  }
  return { repeatX: rx !== "no-repeat", repeatY: ry !== "no-repeat" };
}
var MAX_BG_TILES = 500;
async function emitBgImage(el, srcUrl, ctx, layerIndex = 0, layerCount = 1) {
  const domRect = el.getBoundingClientRect();
  if (domRect.width < 1 || domRect.height < 1) return;
  const { x, y, w, h } = domRectToPt(domRect, ctx.containerRect);
  const img = await resolveImage(srcUrl);
  if (!img) {
    console.warn(`[daepdf] Could not resolve background-image: ${srcUrl}`);
    return;
  }
  const cs = getComputedStyle(el);
  const pick = (list, fallback) => (layerCount > 1 ? nthCyclic(list, layerIndex) : list[0]?.trim() ?? fallback) || fallback;
  const sizeStr = pick(splitByTopLevelComma(cs.backgroundSize || "auto"), "auto");
  const positionStr = pick(splitByTopLevelComma(cs.backgroundPosition || "0% 0%"), "0% 0%");
  const repeatStr = pick(splitByTopLevelComma(cs.backgroundRepeat || "repeat"), "repeat");
  const originStr = pick(splitByTopLevelComma(cs.backgroundOrigin || "padding-box"), "padding-box");
  const clipStr = pick(splitByTopLevelComma(cs.backgroundClip || "border-box"), "border-box");
  const fixed = pick(splitByTopLevelComma(cs.backgroundAttachment || "scroll"), "scroll") === "fixed";
  if (clipStr === "text") return;
  const bT = pxToPt(cs.borderTopWidth || "0px"), bR = pxToPt(cs.borderRightWidth || "0px");
  const bB = pxToPt(cs.borderBottomWidth || "0px"), bL = pxToPt(cs.borderLeftWidth || "0px");
  const pT = pxToPt(cs.paddingTop || "0px"), pR = pxToPt(cs.paddingRight || "0px");
  const pB = pxToPt(cs.paddingBottom || "0px"), pL = pxToPt(cs.paddingLeft || "0px");
  const boxFor = (kind) => {
    if (kind === "border-box") return { x, y, w, h };
    if (kind === "content-box") return {
      x: x + bL + pL,
      y: y + bT + pT,
      w: Math.max(0, w - bL - bR - pL - pR),
      h: Math.max(0, h - bT - bB - pT - pB)
    };
    return { x: x + bL, y: y + bT, w: Math.max(0, w - bL - bR), h: Math.max(0, h - bT - bB) };
  };
  const origin = fixed ? { x: 0, y: 0, w: ctx.pageW, h: ctx.pageH } : boxFor(originStr);
  const clip = boxFor(clipStr);
  if (clip.w <= 0 || clip.h <= 0) return;
  const natural = img.kind === "raw" ? { w: img.raw.width, h: img.raw.height } : img.format === "svg" ? null : await getNaturalSize(img.src);
  const naturalW = (natural?.w ?? 0) / PX_PER_PT;
  const naturalH = (natural?.h ?? 0) / PX_PER_PT;
  const { tileW, tileH } = parseBgSize(sizeStr, origin.w, origin.h, naturalW, naturalH);
  const { repeatX, repeatY } = parseBgRepeat(repeatStr);
  const [posXRaw, posYRaw] = splitPositionPair(positionStr);
  const refX = origin.x + parsePositionComponent(posXRaw, origin.w - tileW);
  const refY = origin.y + parsePositionComponent(posYRaw, origin.h - tileH);
  const coverX0 = fixed ? 0 : clip.x, coverX1 = fixed ? ctx.pageW : clip.x + clip.w;
  const coverY0 = fixed ? 0 : clip.y, coverY1 = fixed ? ctx.pageH : clip.y + clip.h;
  const tileXs = [];
  if (tileW > 0.01 && repeatX) {
    const first = refX - Math.ceil((refX - coverX0) / tileW) * tileW;
    for (let tx = first; tx < coverX1 && tileXs.length < MAX_BG_TILES; tx += tileW) tileXs.push(tx);
  } else {
    tileXs.push(refX);
  }
  const tileYs = [];
  if (tileH > 0.01 && repeatY) {
    const first = refY - Math.ceil((refY - coverY0) / tileH) * tileH;
    for (let ty = first; ty < coverY1 && tileYs.length < MAX_BG_TILES; ty += tileH) tileYs.push(ty);
  } else {
    tileYs.push(refY);
  }
  const MAX_BG_TILE_PRODUCT = 2e3;
  if (tileXs.length * tileYs.length > MAX_BG_TILE_PRODUCT) {
    const scale = Math.sqrt(MAX_BG_TILE_PRODUCT / (tileXs.length * tileYs.length));
    tileXs.length = Math.max(1, Math.floor(tileXs.length * scale));
    tileYs.length = Math.max(1, Math.floor(tileYs.length * scale));
  }
  const clipRadius = insetBorderRadius(
    parseBorderRadius(cs, el),
    clipStr === "border-box" ? 0 : clipStr === "content-box" ? bT + pT : bT,
    clipStr === "border-box" ? 0 : clipStr === "content-box" ? bR + pR : bR,
    clipStr === "border-box" ? 0 : clipStr === "content-box" ? bB + pB : bB,
    clipStr === "border-box" ? 0 : clipStr === "content-box" ? bL + pL : bL
  );
  const opacity = stackOpacity(ctx);
  const needsClip = repeatX || repeatY || tileW !== clip.w || tileH !== clip.h || !!clipRadius;
  for (const { page, y: boxLy } of paginateSpan(clip.y, clip.h, ctx.pageH)) {
    const pageOffset = fixed ? 0 : clip.y - boxLy;
    const yLo = fixed ? boxLy : clip.y, yHi = fixed ? boxLy + clip.h : clip.y + clip.h;
    if (needsClip) ctx.commands.push({ type: "clip-push", page, x: clip.x, y: boxLy, w: clip.w, h: clip.h, radius: clipRadius });
    for (const tx of tileXs) {
      if (tx + tileW < clip.x || tx > clip.x + clip.w) continue;
      for (const ty of tileYs) {
        if (ty + tileH < yLo || ty > yHi) continue;
        ctx.commands.push(img.kind === "raw" ? { type: "raw-image", page, raw: img.raw, x: tx, y: ty - pageOffset, w: tileW, h: tileH, opacity } : { type: "image", page, src: img.src, format: img.format, x: tx, y: ty - pageOffset, w: tileW, h: tileH, opacity });
      }
    }
    if (needsClip) ctx.commands.push({ type: "clip-pop", page });
  }
}

// src/html/borderimage.ts
function parseSideValues(v) {
  const toks = v.trim().split(/\s+/).filter(Boolean);
  const t0 = toks[0] ?? "";
  return [t0, toks[1] ?? t0, toks[2] ?? t0, toks[3] ?? toks[1] ?? t0];
}
function parseSlice(v, naturalW, naturalH) {
  const fill = /\bfill\b/.test(v);
  const clean = v.replace(/\bfill\b/, "").trim();
  const [t, r, b, l] = parseSideValues(clean);
  const resolve = (tok, ref) => {
    const pctM = tok.match(/^(-?[\d.]+)%$/);
    if (pctM) return +pctM[1] / 100 * ref;
    return parseFloat(tok) || 0;
  };
  return { top: resolve(t, naturalH), right: resolve(r, naturalW), bottom: resolve(b, naturalH), left: resolve(l, naturalW), fill };
}
function parseWidth(v, borderW, boxW, boxH) {
  const [t, r, b, l] = parseSideValues(v);
  const resolve = (tok, side, ref) => {
    const pctM = tok.match(/^(-?[\d.]+)%$/);
    if (pctM) return +pctM[1] / 100 * ref;
    const pxM = tok.match(/^(-?[\d.]+)px$/);
    if (pxM) return +pxM[1] / PX_PER_PT;
    const n = parseFloat(tok);
    return isNaN(n) ? side : n * side;
  };
  return { top: resolve(t, borderW.top, boxH), right: resolve(r, borderW.right, boxW), bottom: resolve(b, borderW.bottom, boxH), left: resolve(l, borderW.left, boxW) };
}
function parseOutset(v, borderW) {
  const [t, r, b, l] = parseSideValues(v);
  const resolve = (tok, side) => {
    const pxM = tok.match(/^(-?[\d.]+)px$/);
    if (pxM) return +pxM[1] / PX_PER_PT;
    const n = parseFloat(tok);
    return isNaN(n) ? 0 : n * side;
  };
  return { top: resolve(t, borderW.top), right: resolve(r, borderW.right), bottom: resolve(b, borderW.bottom), left: resolve(l, borderW.left) };
}
function parseRepeat(v) {
  const toks = v.trim().split(/\s+/);
  const h = toks[0] || "stretch";
  const w = toks[1] || h;
  return [h, w];
}
function loadImageElement(url) {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => resolve(null);
    img.src = url;
  });
}
function paintGradientToCanvas(canvas, g) {
  const ctx = canvas.getContext("2d");
  const w = canvas.width, h = canvas.height;
  let grad;
  if (g.type === "linear") {
    const rad = g.angle * Math.PI / 180;
    const dx = Math.sin(rad), dy = -Math.cos(rad);
    const half = Math.abs(w * dx) / 2 + Math.abs(h * dy) / 2;
    const cx = w / 2, cy = h / 2;
    grad = ctx.createLinearGradient(cx - dx * half, cy - dy * half, cx + dx * half, cy + dy * half);
  } else {
    const cx = (g.cx ?? 0.5) * w, cy = (g.cy ?? 0.5) * h;
    const r = Math.hypot(Math.max(cx, w - cx), Math.max(cy, h - cy));
    grad = ctx.createRadialGradient(cx, cy, 0, cx, cy, r);
  }
  for (const st of g.stops) {
    const [r, gr, b, a] = st.color;
    grad.addColorStop(Math.min(1, Math.max(0, st.position)), `rgba(${r},${gr},${b},${a / 255})`);
  }
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, w, h);
}
function paintConicToCanvas(canvas, cg) {
  const ctx = canvas.getContext("2d");
  if (!ctx || typeof ctx.createConicGradient !== "function") return;
  const grad = ctx.createConicGradient((cg.fromDeg - 90) * Math.PI / 180, cg.cx * canvas.width, cg.cy * canvas.height);
  for (const st of cg.stops) {
    const [r, g, b, a] = st.color;
    grad.addColorStop(Math.min(1, Math.max(0, st.position)), `rgba(${r},${g},${b},${a / 255})`);
  }
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, canvas.width, canvas.height);
}
async function resolveSourceCanvas(source, boxWpx, boxHpx) {
  const url = extractBgUrl(source);
  if (url) {
    const img = await loadImageElement(url);
    if (!img || !img.naturalWidth || !img.naturalHeight) return null;
    const canvas2 = document.createElement("canvas");
    canvas2.width = img.naturalWidth;
    canvas2.height = img.naturalHeight;
    canvas2.getContext("2d").drawImage(img, 0, 0);
    return { canvas: canvas2, w: canvas2.width, h: canvas2.height };
  }
  const w = Math.max(1, Math.round(boxWpx)), h = Math.max(1, Math.round(boxHpx));
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const g = parseCSSGradient(source);
  if (g) {
    paintGradientToCanvas(canvas, g);
    return { canvas, w, h };
  }
  const cg = parseCSSConicGradient(source);
  if (cg) {
    paintConicToCanvas(canvas, cg);
    return { canvas, w, h };
  }
  return null;
}
function cropToPng(src, sx, sy, sw, sh) {
  if (sw <= 0 || sh <= 0) return null;
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(sw));
  canvas.height = Math.max(1, Math.round(sh));
  const ctx = canvas.getContext("2d");
  ctx.drawImage(src.canvas, sx, sy, sw, sh, 0, 0, canvas.width, canvas.height);
  const dataUrl = canvas.toDataURL("image/png");
  const comma = dataUrl.indexOf(",");
  if (comma < 0) return null;
  const bin = atob(dataUrl.slice(comma + 1));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
var MAX_BORDER_TILES = 500;
function tilePositions(mode, length, tileSize) {
  if (mode === "stretch" || tileSize <= 0.01) return { positions: [0], size: length };
  if (mode === "round") {
    const count2 = Math.min(MAX_BORDER_TILES, Math.max(1, Math.round(length / tileSize)));
    return { positions: Array.from({ length: count2 }, (_, i) => i * (length / count2)), size: length / count2 };
  }
  if (mode === "space") {
    const count2 = Math.min(MAX_BORDER_TILES, Math.max(1, Math.floor(length / tileSize)));
    if (count2 <= 1) return { positions: [(length - tileSize) / 2], size: tileSize };
    const gap = (length - count2 * tileSize) / (count2 - 1);
    return { positions: Array.from({ length: count2 }, (_, i) => i * (tileSize + gap)), size: tileSize };
  }
  const count = Math.min(MAX_BORDER_TILES, Math.max(1, Math.ceil(length / tileSize)));
  return { positions: Array.from({ length: count }, (_, i) => i * tileSize), size: tileSize };
}
function hasBorderImage(s) {
  const src = s.borderImageSource;
  return !!src && src !== "none";
}
async function emitBorderImage(el, s, ctx) {
  const source = s.borderImageSource;
  if (!source || source === "none") return;
  const domRect = el.getBoundingClientRect();
  const { x, y, w, h } = domRectToPt(domRect, ctx.containerRect);
  if (w <= 0 || h <= 0) return;
  const borderW = {
    top: pxToPt(s.borderTopWidth || "0px"),
    right: pxToPt(s.borderRightWidth || "0px"),
    bottom: pxToPt(s.borderBottomWidth || "0px"),
    left: pxToPt(s.borderLeftWidth || "0px")
  };
  const src = await resolveSourceCanvas(source, w * PX_PER_PT, h * PX_PER_PT);
  if (!src) return;
  const slice = parseSlice(s.borderImageSlice || "100%", src.w, src.h);
  const width = parseWidth(s.borderImageWidth || "1", borderW, w, h);
  const outset = parseOutset(s.borderImageOutset || "0", borderW);
  const [repeatH, repeatV] = parseRepeat(s.borderImageRepeat || "stretch");
  const X = x - outset.left, Y = y - outset.top;
  const W = w + outset.left + outset.right, H = h + outset.top + outset.bottom;
  const { top: wt, right: wr, bottom: wb, left: wl } = width;
  const midW = Math.max(0, W - wl - wr), midH = Math.max(0, H - wt - wb);
  const sT = slice.top, sR = slice.right, sB = slice.bottom, sL = slice.left;
  const srcMidW = Math.max(0, src.w - sL - sR), srcMidH = Math.max(0, src.h - sT - sB);
  const regions = [
    { sx: 0, sy: 0, sw: sL, sh: sT, dx: X, dy: Y, dw: wl, dh: wt },
    { sx: src.w - sR, sy: 0, sw: sR, sh: sT, dx: X + W - wr, dy: Y, dw: wr, dh: wt },
    { sx: 0, sy: src.h - sB, sw: sL, sh: sB, dx: X, dy: Y + H - wb, dw: wl, dh: wb },
    { sx: src.w - sR, sy: src.h - sB, sw: sR, sh: sB, dx: X + W - wr, dy: Y + H - wb, dw: wr, dh: wb },
    { sx: sL, sy: 0, sw: srcMidW, sh: sT, dx: X + wl, dy: Y, dw: midW, dh: wt, repeatX: repeatH },
    { sx: sL, sy: src.h - sB, sw: srcMidW, sh: sB, dx: X + wl, dy: Y + H - wb, dw: midW, dh: wb, repeatX: repeatH },
    { sx: 0, sy: sT, sw: sL, sh: srcMidH, dx: X, dy: Y + wt, dw: wl, dh: midH, repeatY: repeatV },
    { sx: src.w - sR, sy: sT, sw: sR, sh: srcMidH, dx: X + W - wr, dy: Y + wt, dw: wr, dh: midH, repeatY: repeatV }
  ];
  if (slice.fill) {
    regions.push({ sx: sL, sy: sT, sw: srcMidW, sh: srcMidH, dx: X + wl, dy: Y + wt, dw: midW, dh: midH, repeatX: repeatH, repeatY: repeatV });
  }
  const opacity = stackOpacity(ctx);
  for (const r of regions) {
    if (r.dw <= 0.01 || r.dh <= 0.01 || r.sw <= 0 || r.sh <= 0) continue;
    const png = cropToPng(src, r.sx, r.sy, r.sw, r.sh);
    if (!png) continue;
    const naturalTileW = r.repeatX ? r.sw * (r.dh / r.sh) : r.dw;
    const naturalTileH = r.repeatY ? r.sh * (r.dw / r.sw) : r.dh;
    const tx = r.repeatX ? tilePositions(r.repeatX, r.dw, naturalTileW) : { positions: [0], size: r.dw };
    const ty = r.repeatY ? tilePositions(r.repeatY, r.dh, naturalTileH) : { positions: [0], size: r.dh };
    const needsTileClip = !!(r.repeatX || r.repeatY);
    for (const { page, y: boxLy } of paginateSpan(r.dy, r.dh, ctx.pageH)) {
      if (needsTileClip) ctx.commands.push({ type: "clip-push", page, x: r.dx, y: boxLy, w: r.dw, h: r.dh });
      for (const px of tx.positions) {
        for (const py of ty.positions) {
          ctx.commands.push({
            type: "image",
            page,
            src: png,
            format: "png",
            x: r.dx + px,
            y: boxLy + py,
            w: tx.size,
            h: ty.size,
            opacity
          });
        }
      }
      if (needsTileClip) ctx.commands.push({ type: "clip-pop", page });
    }
  }
}

// src/html/transform.ts
function parseCSSMatrix(transformStr) {
  const m = transformStr.match(/^matrix\(([^)]+)\)$/);
  if (!m) return null;
  const parts = (m[1] ?? "").split(",").map((v) => parseFloat(v.trim()));
  if (parts.length !== 6 || parts.some(Number.isNaN)) return null;
  return parts;
}
function composeAffine2(m2, m1) {
  const [a1, b1, c1, d1, e1, f1] = m1;
  const [a2, b2, c2, d2, e2, f2] = m2;
  return [
    a2 * a1 + c2 * b1,
    b2 * a1 + d2 * b1,
    a2 * c1 + c2 * d1,
    b2 * c1 + d2 * d1,
    a2 * e1 + c2 * f1 + e2,
    b2 * e1 + d2 * f1 + f2
  ];
}
function buildPdfTransformMatrix(css, originPageX, originPageY, pageH) {
  const [a, b, c, d, e, f] = css;
  const flipped = [a, -b, -c, d, e, -f];
  const pdfOriginX = originPageX;
  const pdfOriginY = pageH - originPageY;
  const toOrigin = [1, 0, 0, 1, -pdfOriginX, -pdfOriginY];
  const fromOrigin = [1, 0, 0, 1, pdfOriginX, pdfOriginY];
  return composeAffine2(fromOrigin, composeAffine2(flipped, toOrigin));
}

// src/html/canvaspaint.ts
var TRANSPARENT = /* @__PURE__ */ new Set(["rgba(0, 0, 0, 0)", "transparent"]);
function paintBoxDecoration(c, x, y, w, h, cs, dpr) {
  if (w <= 0 || h <= 0) return;
  const radius = Math.min(parseFloat(cs.borderTopLeftRadius) || 0, w / 2, h / 2) * dpr;
  c.beginPath();
  if (radius > 0) c.roundRect(x, y, w, h, radius);
  else c.rect(x, y, w, h);
  const bg = cs.backgroundColor;
  if (bg && !TRANSPARENT.has(bg)) {
    c.fillStyle = bg;
    c.fill();
  }
  const bw = parseFloat(cs.borderTopWidth) || 0;
  if (bw > 0 && cs.borderTopStyle !== "none") {
    c.lineWidth = bw * dpr;
    c.strokeStyle = cs.borderTopColor;
    c.stroke();
  }
}
function paintText(c, node, x, y, w, h, cs, dpr) {
  const text = (node.textContent ?? "").replace(/\s+/g, " ").trim();
  if (!text) return;
  c.font = `${cs.fontStyle} ${cs.fontWeight} ${parseFloat(cs.fontSize) * dpr}px ${cs.fontFamily}`;
  c.fillStyle = cs.color;
  c.textBaseline = "middle";
  c.textAlign = cs.textAlign === "center" ? "center" : cs.textAlign === "right" ? "right" : "left";
  const tx = cs.textAlign === "center" ? x + w / 2 : cs.textAlign === "right" ? x + w : x;
  c.fillText(text, tx, y + h / 2);
}
function paintImage(c, img, x, y, w, h) {
  if (!img.complete || img.naturalWidth === 0) return;
  try {
    c.drawImage(img, x, y, w, h);
  } catch {
  }
}
function paintNode(node, c, rootRect, dpr) {
  const cs = getComputedStyle(node);
  if (cs.display === "none" || cs.visibility === "hidden") return;
  const r = node.getBoundingClientRect();
  const x = (r.left - rootRect.left) * dpr;
  const y = (r.top - rootRect.top) * dpr;
  const w = r.width * dpr;
  const h = r.height * dpr;
  if (node.tagName === "IMG") {
    paintImage(c, node, x, y, w, h);
    return;
  }
  c.save();
  paintBoxDecoration(c, x, y, w, h, cs, dpr);
  c.restore();
  for (const child of Array.from(node.childNodes)) {
    if (child.nodeType === Node.ELEMENT_NODE) paintNode(child, c, rootRect, dpr);
    else if (child.nodeType === Node.TEXT_NODE) paintText(c, child, x, y, w, h, cs, dpr);
  }
}
function canvasToPngBytes(canvas) {
  let dataUrl;
  try {
    dataUrl = canvas.toDataURL("image/png");
  } catch {
    return null;
  }
  const comma = dataUrl.indexOf(",");
  if (comma < 0) return null;
  const bin = atob(dataUrl.slice(comma + 1));
  const bytes2 = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes2[i] = bin.charCodeAt(i);
  return bytes2;
}

// src/html/filters.ts
function hasFilter(s) {
  return !!s.filter && s.filter !== "none";
}
function emitFilteredElement(el, s, ctx) {
  const domRect = el.getBoundingClientRect();
  if (domRect.width < 1 || domRect.height < 1) return;
  const { x, y, w, h } = domRectToPt(domRect, ctx.containerRect);
  const dpr = 3;
  const cw = Math.max(1, Math.round(domRect.width * dpr));
  const ch = Math.max(1, Math.round(domRect.height * dpr));
  const source = document.createElement("canvas");
  source.width = cw;
  source.height = ch;
  paintNode(el, source.getContext("2d"), domRect, dpr);
  const filtered = document.createElement("canvas");
  filtered.width = cw;
  filtered.height = ch;
  const fctx = filtered.getContext("2d");
  fctx.filter = s.filter;
  fctx.drawImage(source, 0, 0);
  const src = canvasToPngBytes(filtered);
  if (!src) return;
  const opacity = stackOpacity(ctx);
  for (const { page, y: ly } of paginateSpan(y, h, ctx.pageH)) {
    ctx.commands.push({ type: "image", page, src, format: "png", x, y: ly, w, h, opacity });
  }
}

// src/html/emit.ts
var perSide = (f) => [f("Top"), f("Right"), f("Bottom"), f("Left")];
function normBorderStyle(s) {
  if (s === "dashed") return "dashed";
  if (s === "dotted") return "dotted";
  if (s === "wavy") return "wavy";
  return "solid";
}
var RTL_RANGES = [
  [1425, 2303],
  // Hebrew through Arabic Extended-A
  [64285, 65023],
  // Hebrew + Arabic presentation forms-A
  [65136, 65279]
  // Arabic presentation forms-B
];
function isStrongRTL(cp) {
  return RTL_RANGES.some(([a, b]) => cp >= a && cp <= b);
}
function hasBidiMix(text) {
  let sawRTL = false, sawLTR = false;
  for (const ch of text) {
    const cp = ch.codePointAt(0);
    if (isStrongRTL(cp)) sawRTL = true;
    else if (/\p{L}/u.test(ch)) sawLTR = true;
    if (sawRTL && sawLTR) return true;
  }
  return false;
}
function splitColorAlpha(ca) {
  if (!ca) return { color: null, alpha: 1 };
  return { color: [ca[0], ca[1], ca[2]], alpha: ca[3] / 255 };
}
function combineOpacity(base, extra) {
  const combined = (base ?? 1) * extra;
  return combined < 1 ? combined : void 0;
}
function resolveGradientBox(gradient, w, h) {
  if (w <= 0 || h <= 0) return gradient;
  if (gradient.type === "linear" && gradient.corner) {
    const a = Math.atan2(h, w) * 180 / Math.PI;
    const cornerAngle = {
      "top right": a,
      "bottom right": 180 - a,
      "bottom left": 180 + a,
      "top left": 360 - a
    };
    gradient = { ...gradient, angle: cornerAngle[gradient.corner] ?? gradient.angle };
  }
  if (gradient.stops.some((st) => st.posPx !== void 0)) {
    let linePt;
    if (gradient.type === "linear") {
      const rad = gradient.angle * Math.PI / 180;
      linePt = Math.abs(w * Math.sin(rad)) + Math.abs(h * Math.cos(rad));
    } else {
      const cxPt = (gradient.cx ?? 0.5) * w;
      const cyPt = (gradient.cy ?? 0.5) * h;
      linePt = Math.hypot(Math.max(cxPt, w - cxPt), Math.max(cyPt, h - cyPt));
    }
    if (linePt > 0) {
      gradient = { ...gradient, stops: gradient.stops.map(
        (st) => st.posPx !== void 0 ? { color: st.color, position: st.posPx / PX_PER_PT / linePt } : st
      ) };
    }
  }
  if (gradient.repeating) {
    gradient = { ...gradient, repeating: void 0, stops: tileStops(gradient.stops, true) };
  }
  return gradient;
}
var _conicCache = /* @__PURE__ */ new Map();
function rasterizeConic(cg, wPt, hPt) {
  if (wPt <= 0 || hPt <= 0) return null;
  const key = `${cg.fromDeg}|${cg.cx}|${cg.cy}|${cg.repeating ?? false}|${cg.stops.map((st) => `${st.position}:${st.color}`).join(",")}|${wPt.toFixed(2)}|${hPt.toFixed(2)}`;
  const hit = _conicCache.get(key);
  if (hit !== void 0) return hit;
  let out = null;
  try {
    const dpr = 3;
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(wPt * dpr));
    canvas.height = Math.max(1, Math.round(hPt * dpr));
    const c2d = canvas.getContext("2d");
    if (c2d && typeof c2d.createConicGradient === "function") {
      const grad = c2d.createConicGradient(
        (cg.fromDeg - 90) * Math.PI / 180,
        cg.cx * canvas.width,
        cg.cy * canvas.height
      );
      const stops = tileStops(cg.stops, cg.repeating);
      for (const st of stops) {
        const [r, g, b, a] = st.color;
        grad.addColorStop(Math.min(1, Math.max(0, st.position)), `rgba(${r},${g},${b},${a / 255})`);
      }
      c2d.fillStyle = grad;
      c2d.fillRect(0, 0, canvas.width, canvas.height);
      const dataUrl = canvas.toDataURL("image/png");
      const comma = dataUrl.indexOf(",");
      if (comma >= 0) {
        const bin = atob(dataUrl.slice(comma + 1));
        out = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
      }
    }
  } catch {
    out = null;
  }
  _conicCache.set(key, out);
  return out;
}
function suppressRadiusSide(radius, suppressLeft, suppressRight) {
  if (!radius || !suppressLeft && !suppressRight) return radius;
  const a = radius.all ?? 0;
  const c = (x) => x ? { h: x.h, v: x.v } : { h: a, v: a };
  const tl = c(radius.topLeft), tr = c(radius.topRight);
  const br = c(radius.bottomRight), bl = c(radius.bottomLeft);
  if (suppressLeft) {
    tl.h = 0;
    tl.v = 0;
    bl.h = 0;
    bl.v = 0;
  }
  if (suppressRight) {
    tr.h = 0;
    tr.v = 0;
    br.h = 0;
    br.v = 0;
  }
  return { topLeft: tl, topRight: tr, bottomRight: br, bottomLeft: bl };
}
function emitBox(el, s, ctx) {
  const isInline = s.display === "inline";
  const rects = isInline ? Array.from(el.getClientRects()) : [el.getBoundingClientRect()];
  const opacity = stackOpacity(ctx);
  const blend = stackBlend(ctx);
  const boxDecorationBreak = s.boxDecorationBreak === "clone" ? "clone" : "slice";
  for (const [rectIndex, domRect] of rects.entries()) {
    if (domRect.width < 0.5 && domRect.height < 0.5) continue;
    const { x, y, w, h } = domRectToPt(domRect, ctx.containerRect);
    const { color: bgColor, alpha: bgAlpha } = splitColorAlpha(parseColorAlpha(s.backgroundColor));
    const baseRadius = isInline ? clampRadiusToBox(parseBorderRadius(s, el), w, h) : parseBorderRadius(s, el);
    const shadows = parseCSSBoxShadow(s.boxShadow);
    const bgImg = s.backgroundImage;
    const fragmented = isInline && rects.length > 1 && boxDecorationBreak === "slice";
    const suppressLeft = fragmented && rectIndex > 0;
    const suppressRight = fragmented && rectIndex < rects.length - 1;
    const radius = suppressRadiusSide(baseRadius, suppressLeft, suppressRight);
    const bWidths = perSide((d) => pxToPt(s[`border${d}Width`] ?? "0px"));
    const bColorAlphas = perSide((d) => parseColorAlpha(s[`border${d}Color`] ?? ""));
    const bStyles = perSide((d) => s[`border${d}Style`] ?? "none");
    const allSame = bWidths.every((v) => v === bWidths[0]) && bStyles.every((v) => v === bStyles[0]) && bColorAlphas.every((c) => JSON.stringify(c) === JSON.stringify(bColorAlphas[0]));
    const uniformSolid = !fragmented && allSame && bStyles[0] !== "dashed" && bStyles[0] !== "dotted" && bStyles[0] !== "double";
    const bgClipList = String(s.webkitBackgroundClip || s.backgroundClip || "border-box").split(",").map((t) => t.trim());
    const bgClipText = bgClipList[bgClipList.length - 1] === "text";
    const paintsFill = !bgClipText && !!bgColor;
    const oWidth = pxToPt(s.outlineWidth || "0px");
    const oStyle = s.outlineStyle;
    const oColorA = oWidth > 0 && oStyle && oStyle !== "none" ? parseColorAlpha(s.outlineColor) : null;
    const oGrow = oColorA ? pxToPt(s.outlineOffset || "0px") + oWidth : 0;
    let oRadius;
    if (oColorA && radius) {
      const a = radius.all ?? 0;
      const grown = (c) => {
        const base = c ?? { h: a, v: a };
        if (base.h <= 0 || base.v <= 0) return { h: 0, v: 0 };
        return { h: Math.max(0, base.h + oGrow), v: Math.max(0, base.v + oGrow) };
      };
      oRadius = {
        topLeft: grown(radius.topLeft),
        topRight: grown(radius.topRight),
        bottomRight: grown(radius.bottomRight),
        bottomLeft: grown(radius.bottomLeft)
      };
    }
    const computeGeom = (effH) => {
      const clipBoxFor = (kind) => {
        const box = { dx: 0, dy: 0, w, h: effH, radius };
        if (kind !== "padding-box" && kind !== "content-box") return box;
        const pad = kind === "content-box";
        const iT = bWidths[0] + (pad ? pxToPt(s.paddingTop || "0px") : 0);
        const iR = bWidths[1] + (pad ? pxToPt(s.paddingRight || "0px") : 0);
        const iB = bWidths[2] + (pad ? pxToPt(s.paddingBottom || "0px") : 0);
        const iL = bWidths[3] + (pad ? pxToPt(s.paddingLeft || "0px") : 0);
        if (!iT && !iR && !iB && !iL) return box;
        return {
          dx: iL,
          dy: iT,
          w: Math.max(0, w - iL - iR),
          h: Math.max(0, effH - iT - iB),
          radius: insetBorderRadius(radius, iT, iR, iB, iL)
        };
      };
      const colorClip = bgClipList.at(-1) ?? "border-box";
      const fillBox = clipBoxFor(colorClip);
      const fillInset = fillBox.dx !== 0 || fillBox.dy !== 0 || fillBox.w !== w || fillBox.h !== effH;
      const bgLayers = [];
      if (bgImg && bgImg !== "none") {
        const layerList = splitByTopLevelComma(bgImg);
        for (let i = layerList.length - 1; i >= 0; i--) {
          const kind = bgClipList[i % bgClipList.length] ?? "border-box";
          if (kind === "text") continue;
          const layer = (layerList[i] ?? "").trim();
          const g = parseCSSGradient(layer);
          if (g) {
            const box = clipBoxFor(kind);
            if (box.w > 0 && box.h > 0) bgLayers.push({ gradient: resolveGradientBox(g, box.w, box.h), box });
            continue;
          }
          const cg = parseCSSConicGradient(layer);
          if (cg) {
            const box = clipBoxFor(kind);
            const src = rasterizeConic(cg, box.w, box.h);
            if (src) bgLayers.push({ conicSrc: src, box });
          }
        }
      }
      return { fillBox, fillInset, bgLayers };
    };
    const spans = paginateSpan(y, h, ctx.pageH);
    const blockClone = !isInline && boxDecorationBreak === "clone" && spans.length > 1;
    const defaultGeom = blockClone ? null : computeGeom(h);
    for (const { page, y: ly } of spans) {
      let by = ly, bh = h;
      if (blockClone) {
        const fragTop = Math.max(0, ly);
        const fragBottom = Math.min(ctx.pageH, ly + h);
        bh = fragBottom - fragTop;
        if (bh <= 0.01) continue;
        by = fragTop;
      }
      const { fillBox, fillInset, bgLayers } = blockClone ? computeGeom(bh) : defaultGeom;
      const splitShadow = shadows.length > 0 && (bgClipText || fillInset);
      if (splitShadow) {
        ctx.commands.push({
          type: "rect",
          page,
          x,
          y: by,
          w,
          h: bh,
          fill: null,
          shadow: shadows,
          radius,
          opacity,
          blend
        });
      }
      if (paintsFill || shadows.length && !splitShadow) {
        ctx.commands.push({
          type: "rect",
          page,
          x: x + fillBox.dx,
          y: by + fillBox.dy,
          w: fillBox.w,
          h: fillBox.h,
          fill: paintsFill ? bgColor ?? null : null,
          shadow: splitShadow ? void 0 : shadows.length ? shadows : void 0,
          radius: fillBox.radius,
          opacity: combineOpacity(opacity, bgAlpha),
          blend
        });
      }
      for (const L of bgLayers) {
        const lx = x + L.box.dx, lyy = by + L.box.dy;
        if (L.gradient) {
          ctx.commands.push({
            type: "rect",
            page,
            x: lx,
            y: lyy,
            w: L.box.w,
            h: L.box.h,
            fill: null,
            gradient: L.gradient,
            radius: L.box.radius,
            opacity,
            blend
          });
        } else if (L.conicSrc) {
          const rounded = !!L.box.radius;
          if (rounded) ctx.commands.push({ type: "clip-push", page, x: lx, y: lyy, w: L.box.w, h: L.box.h, radius: L.box.radius });
          ctx.commands.push({
            type: "image",
            page,
            src: L.conicSrc,
            format: "png",
            x: lx,
            y: lyy,
            w: L.box.w,
            h: L.box.h,
            opacity,
            blend
          });
          if (rounded) ctx.commands.push({ type: "clip-pop", page });
        }
      }
      if (!hasBorderImage(s)) {
        if (uniformSolid && bWidths[0] > 0 && bStyles[0] !== "none" && bColorAlphas[0]) {
          const { color: strokeColor, alpha: strokeAlpha } = splitColorAlpha(bColorAlphas[0]);
          ctx.commands.push({
            type: "rect",
            page,
            x,
            y: by,
            w,
            h: bh,
            fill: null,
            stroke: strokeColor,
            strokeWidth: bWidths[0],
            radius,
            opacity: combineOpacity(opacity, strokeAlpha),
            blend
          });
        } else if (!fragmented && allSame && radius && bWidths[0] > 0 && bColorAlphas[0] && (bStyles[0] === "dashed" || bStyles[0] === "dotted")) {
          const { color: strokeColor, alpha: strokeAlpha } = splitColorAlpha(bColorAlphas[0]);
          ctx.commands.push({
            type: "rect",
            page,
            x,
            y: by,
            w,
            h: bh,
            fill: null,
            stroke: strokeColor,
            strokeWidth: bWidths[0],
            strokeStyle: bStyles[0],
            radius,
            opacity: combineOpacity(opacity, strokeAlpha),
            blend
          });
        } else {
          const sideLine = (i, off) => i === 0 ? { x1: x, y1: by + off, x2: x + w, y2: by + off } : i === 1 ? { x1: x + w - off, y1: by, x2: x + w - off, y2: by + bh } : i === 2 ? { x1: x, y1: by + bh - off, x2: x + w, y2: by + bh - off } : { x1: x + off, y1: by, x2: x + off, y2: by + bh };
          for (let i = 0; i < 4; i++) {
            if (i === 3 && suppressLeft || i === 1 && suppressRight) continue;
            const bw = bWidths[i], bStyle = bStyles[i], bCA = bColorAlphas[i];
            if (bw > 0 && bStyle !== "none" && bCA) {
              const { color: lineColor, alpha: lineAlpha } = splitColorAlpha(bCA);
              const lineOpacity = combineOpacity(opacity, lineAlpha);
              if (bStyle === "double" && bw >= 2) {
                const t = bw;
                for (const off of [t / 6, t * 5 / 6]) {
                  ctx.commands.push({
                    type: "line",
                    page,
                    ...sideLine(i, off),
                    width: t / 3,
                    color: lineColor,
                    lineStyle: "solid",
                    opacity: lineOpacity,
                    blend
                  });
                }
                continue;
              }
              ctx.commands.push({
                type: "line",
                page,
                ...sideLine(i, bw / 2),
                width: bw,
                color: lineColor,
                lineStyle: normBorderStyle(bStyle),
                opacity: lineOpacity,
                blend
              });
            }
          }
        }
      }
      if (oColorA && w + oGrow * 2 > 0 && bh + oGrow * 2 > 0) {
        const { color: oc, alpha: oa } = splitColorAlpha(oColorA);
        ctx.commands.push({
          type: "rect",
          page,
          x: x - oGrow,
          y: by - oGrow,
          w: w + oGrow * 2,
          h: bh + oGrow * 2,
          fill: null,
          stroke: oc,
          strokeWidth: oWidth,
          strokeStyle: oStyle === "dashed" || oStyle === "dotted" ? oStyle : void 0,
          radius: oRadius,
          opacity: combineOpacity(opacity, oa),
          blend
        });
      }
    }
  }
}
function applyTextTransform(text, transform) {
  if (transform === "uppercase") return text.toUpperCase();
  if (transform === "lowercase") return text.toLowerCase();
  if (transform === "capitalize") return text.replace(/(^|[^\p{L}\p{N}'’])(\p{L})/gu, (_, p, c) => p + c.toUpperCase());
  return text;
}
function isFirstContentOfBlock(textNode) {
  let n = textNode.previousSibling;
  while (n) {
    if (n.nodeType === Node.ELEMENT_NODE) return false;
    if (n.nodeType === Node.TEXT_NODE && (n.textContent ?? "").trim()) return false;
    n = n.previousSibling;
  }
  return true;
}
function pseudoTextOverride(el, which, s) {
  const p = getComputedStyle(el, which);
  const differs = p.fontSize !== s.fontSize || p.fontFamily !== s.fontFamily || p.fontWeight !== s.fontWeight || p.fontStyle !== s.fontStyle || p.color !== s.color || p.letterSpacing !== s.letterSpacing || p.textTransform !== s.textTransform || which === "::first-letter" && p.cssFloat !== "none";
  return differs ? p : null;
}
function baselineNeedsWrapper(parentEl) {
  const d = getComputedStyle(parentEl).display;
  return d === "flex" || d === "inline-flex" || d === "grid" || d === "inline-grid";
}
function measureBaselineY(parentEl, textNode, before) {
  const anchor = document.createElement("span");
  anchor.style.cssText = "display:inline;font-size:0;line-height:0;vertical-align:baseline;";
  if (!baselineNeedsWrapper(parentEl)) {
    parentEl.insertBefore(anchor, before ? textNode : textNode.nextSibling);
    const y2 = anchor.getBoundingClientRect().top;
    parentEl.removeChild(anchor);
    return y2;
  }
  const wrapper = document.createElement("span");
  wrapper.style.cssText = "display:inline;";
  parentEl.insertBefore(wrapper, textNode);
  if (before) {
    wrapper.appendChild(anchor);
    wrapper.appendChild(textNode);
  } else {
    wrapper.appendChild(textNode);
    wrapper.appendChild(anchor);
  }
  const y = anchor.getBoundingClientRect().top;
  parentEl.insertBefore(textNode, wrapper);
  parentEl.removeChild(wrapper);
  return y;
}
function captureVerticalTextNode(textNode, _parentEl, s, ctx) {
  const raw = textNode.textContent ?? "";
  if (!raw.trim()) return;
  if (s.visibility === "hidden" || s.visibility === "collapse") return;
  const fontRef = resolveFontRef(s.fontFamily, s.fontWeight, s.fontStyle, ctx.fontMap, ctx.registeredFonts);
  if (!fontRef) {
    const fam = (s.fontFamily.split(",")[0] ?? "").replace(/["']/g, "").trim();
    console.warn(`[daepdf] Font "${fam}" is not registered \u2014 vertical text skipped. Register via loadFontsFromManifest() or loadAndRegisterFont().`);
    return;
  }
  const sizePx = parseFloat(s.fontSize) || 16;
  const sizePt = sizePx / PX_PER_PT;
  const colorAlphaVal = parseColorAlpha(s.color);
  const color = colorAlphaVal ? [colorAlphaVal[0], colorAlphaVal[1], colorAlphaVal[2]] : [0, 0, 0];
  const opacity = stackOpacity(ctx);
  const blend = stackBlend(ctx);
  const chars = [...raw];
  const range = document.createRange();
  const hits = [];
  let charIdx = 0;
  for (const ch of chars) {
    range.setStart(textNode, charIdx);
    range.setEnd(textNode, charIdx + ch.length);
    const r = range.getBoundingClientRect();
    charIdx += ch.length;
    if (r.width < 0.01 && r.height < 0.01) continue;
    hits.push({ ch, rect: r });
  }
  range.detach?.();
  if (!hits.length) return;
  const columns = [];
  for (const hit of hits) {
    const left = hit.rect.left;
    const existing = columns.find((c) => Math.abs(c.left - left) < 3);
    if (existing) {
      existing.chars.push(hit);
      existing.minTop = Math.min(existing.minTop, hit.rect.top);
    } else {
      columns.push({ chars: [hit], left, minTop: hit.rect.top });
    }
  }
  columns.sort((a, b) => s.writingMode === "vertical-lr" ? a.left - b.left : b.left - a.left);
  for (const col of columns) {
    const text = col.chars.map((c) => c.ch).join("");
    if (!text.trim()) continue;
    const colLeft = Math.min(...col.chars.map((c) => c.rect.left));
    const colRight = Math.max(...col.chars.map((c) => c.rect.right));
    const colX = (colLeft - ctx.containerRect.left) / PX_PER_PT;
    const colTopPx = col.minTop - ctx.containerRect.top;
    const { page, y: ly } = paginate(colTopPx / PX_PER_PT, ctx.pageH);
    ctx.commands.push({
      type: "text",
      page,
      text,
      vertical: true,
      x: colX,
      y: ly,
      font: fontRef.name,
      style: fontRef.style,
      weight: fontRef.weight,
      size: sizePt,
      color,
      align: "left",
      maxWidth: (colRight - colLeft) / PX_PER_PT,
      opacity,
      blend
    });
  }
}
function captureTextNode(textNode, parentEl, s, ctx) {
  const raw = textNode.textContent ?? "";
  if (!raw.trim()) return;
  if (s.visibility === "hidden" || s.visibility === "collapse") return;
  const fontRef = resolveFontRef(s.fontFamily, s.fontWeight, s.fontStyle, ctx.fontMap, ctx.registeredFonts);
  if (!fontRef) {
    const fam = (s.fontFamily.split(",")[0] ?? "").replace(/["']/g, "").trim();
    console.warn(`[daepdf] Font "${fam}" is not registered \u2014 text skipped. Register via loadFontsFromManifest() or loadAndRegisterFont().`);
    return;
  }
  const sizePx = parseFloat(s.fontSize) || 16;
  const sizePt = sizePx / PX_PER_PT;
  const colorSrc = String(s.webkitTextFillColor || s.color);
  const colorAlphaVal = parseColorAlpha(colorSrc);
  const { color: colorRgb, alpha: colorAlpha } = splitColorAlpha(colorAlphaVal);
  let color = colorRgb ?? [0, 0, 0];
  let drawText = true;
  if (colorAlphaVal === null && isTransparentColor(colorSrc)) {
    let sub = null;
    const clipsText = String(s.webkitBackgroundClip || s.backgroundClip || "").includes("text");
    if (clipsText) {
      if (s.backgroundImage && s.backgroundImage !== "none") {
        for (const layer of splitByTopLevelComma(s.backgroundImage)) {
          const g = parseCSSGradient(layer.trim());
          const gs0 = g?.stops[0];
          if (gs0) {
            sub = [gs0.color[0], gs0.color[1], gs0.color[2]];
            break;
          }
        }
      }
      if (!sub) {
        const bg = parseColorAlpha(s.backgroundColor);
        if (bg) sub = [bg[0], bg[1], bg[2]];
      }
    }
    if (sub) color = sub;
    else if (!clipsText) drawText = false;
  }
  const lsPt = s.letterSpacing === "normal" ? void 0 : pxToPt(s.letterSpacing) || void 0;
  const wsPt = s.wordSpacing === "normal" ? void 0 : pxToPt(s.wordSpacing) || void 0;
  const txform = s.textTransform;
  const opacity = stackOpacity(ctx);
  const blend = stackBlend(ctx);
  const textOpacity = combineOpacity(opacity, colorAlpha);
  const tsWidthPt = pxToPt(String(s.webkitTextStrokeWidth || "0px"));
  const tsCA = tsWidthPt > 0 ? parseColorAlpha(String(s.webkitTextStrokeColor || "")) : null;
  const textStroke = tsCA ? { color: [tsCA[0], tsCA[1], tsCA[2]], width: tsWidthPt } : null;
  let strokeOnly = false;
  if (textStroke && !drawText) {
    drawText = true;
    strokeOnly = true;
  }
  const decos = [];
  {
    const seen = /* @__PURE__ */ new Set();
    let decoEl = parentEl;
    let decoStyle = s;
    while (decoEl) {
      const dl = decoStyle.textDecorationLine;
      if (dl && dl !== "none") {
        for (const part of dl.split(" ")) {
          if (seen.has(part)) continue;
          seen.add(part);
          const dcRaw = decoStyle.textDecorationColor;
          const ca = parseColorAlpha(dcRaw) ?? (isTransparentColor(dcRaw) ? null : parseColorAlpha(decoStyle.color));
          if (!ca) continue;
          const thM = (decoStyle.textDecorationThickness || "").match(/^(-?[\d.]+)px$/);
          const uoM = (decoStyle.textUnderlineOffset || "").match(/^(-?[\d.]+)px$/);
          decos.push({
            part,
            color: [ca[0], ca[1], ca[2]],
            alpha: ca[3] / 255,
            lineStyle: normBorderStyle(decoStyle.textDecorationStyle),
            thicknessPt: thM?.[1] ? Math.max(0.1, +thM[1] / PX_PER_PT) : void 0,
            underlineOffsetPt: uoM?.[1] ? +uoM[1] / PX_PER_PT : void 0
          });
        }
      }
      const d = decoStyle.display;
      if (decoStyle.position === "absolute" || decoStyle.position === "fixed" || decoStyle.cssFloat !== "none" || d === "inline-block" || d === "inline-table" || d === "inline-flex" || d === "inline-grid") break;
      decoEl = decoEl.parentElement;
      if (!decoEl || decoEl === document.body) break;
      decoStyle = getComputedStyle(decoEl);
    }
  }
  if (!drawText && !decos.length) return;
  const blockish = s.display === "block" || s.display === "list-item" || s.display === "flow-root" || s.display === "table-cell";
  const firstContent = blockish && isFirstContentOfBlock(textNode);
  const flStyle = firstContent && drawText ? pseudoTextOverride(parentEl, "::first-letter", s) : null;
  const fllStyle = firstContent && drawText ? pseudoTextOverride(parentEl, "::first-line", s) : null;
  let flStart = 0, flEnd = 0;
  if (flStyle) {
    const flM = raw.match(/^(\s*)([\p{P}\p{S}]*[\p{L}\p{N}][̀-ͯ]*)/u);
    if (flM) {
      flStart = (flM[1] ?? "").length;
      flEnd = flStart + (flM[2] ?? "").length;
    }
  }
  const range = document.createRange();
  const continuesWord = textNode.previousSibling?.nodeName === "WBR";
  const wordHits = [];
  const re = /\S+/g;
  re.lastIndex = flEnd;
  let m;
  while ((m = re.exec(raw)) !== null) {
    try {
      range.setStart(textNode, m.index);
      range.setEnd(textNode, m.index + m[0].length);
    } catch {
      continue;
    }
    const midWordChunk = txform === "capitalize" && m.index === 0 && continuesWord;
    const frags = Array.from(range.getClientRects()).filter((fr) => fr.width > 0.1 && fr.height > 0.1);
    if (frags.length <= 1) {
      const r = frags[0] ?? range.getBoundingClientRect();
      if (r.width < 0.1 && r.height < 0.1) continue;
      wordHits.push({
        text: midWordChunk ? m[0] : applyTextTransform(m[0], txform),
        rect: r,
        start: m.index,
        len: m[0].length
      });
      continue;
    }
    let segStart = m.index;
    let prevTop = null;
    const closeSegment = (endIdx) => {
      if (endIdx <= segStart) return;
      range.setStart(textNode, segStart);
      range.setEnd(textNode, endIdx);
      const sr = range.getBoundingClientRect();
      if (sr.width < 0.1 && sr.height < 0.1) return;
      const slice = raw.slice(segStart, endIdx);
      const capAtStart = segStart === m.index && !midWordChunk;
      const segText = txform !== "capitalize" || capAtStart ? applyTextTransform(slice, txform) : slice;
      wordHits.push({ text: segText, rect: sr, start: segStart, len: endIdx - segStart });
    };
    for (let ci = 0; ci < m[0].length; ci++) {
      range.setStart(textNode, m.index + ci);
      range.setEnd(textNode, m.index + ci + 1);
      const cr = range.getBoundingClientRect();
      if (cr.width < 0.01 && cr.height < 0.01) continue;
      if (prevTop !== null && Math.abs(cr.top - prevTop) > 3) {
        closeSegment(m.index + ci);
        segStart = m.index + ci;
      }
      prevTop = cr.top;
    }
    closeSegment(m.index + m[0].length);
  }
  range.detach?.();
  if (s.hyphens === "auto") {
    for (let i = 0; i < wordHits.length - 1; i++) {
      const cur = wordHits[i], next = wordHits[i + 1];
      if (next.start === cur.start + cur.len && Math.abs(next.rect.top - cur.rect.top) > 3) {
        cur.text += "-";
      }
    }
  }
  if (!wordHits.length && !flEnd) return;
  const lines = [];
  for (const hit of wordHits) {
    const top = hit.rect.top;
    const existing = lines.find((l) => Math.abs(l.top - top) < 3);
    if (existing) {
      existing.words.push(hit);
      existing.minX = Math.min(existing.minX, hit.rect.left);
    } else {
      lines.push({ words: [hit], minX: hit.rect.left, top });
    }
  }
  const firstBaselineY = measureBaselineY(parentEl, textNode, true) - ctx.containerRect.top;
  if (flEnd > 0) {
    const flRange = document.createRange();
    flRange.setStart(textNode, flStart);
    flRange.setEnd(textNode, flEnd);
    const flRect = flRange.getBoundingClientRect();
    if (flRect.width > 0.1 && flRect.height > 0.1) {
      const flFont = resolveFontRef(flStyle.fontFamily, flStyle.fontWeight, flStyle.fontStyle, ctx.fontMap, ctx.registeredFonts) ?? fontRef;
      const flSizePx = parseFloat(flStyle.fontSize) || sizePx;
      const flCA = parseColorAlpha(String(flStyle.webkitTextFillColor || flStyle.color));
      const floated = flStyle.cssFloat !== "none";
      const baselinePx = floated ? (flRect.top + flRect.bottom) / 2 - ctx.containerRect.top + flSizePx * 0.35 : firstBaselineY;
      const { page, y: ly } = paginate(baselinePx / PX_PER_PT, ctx.pageH);
      ctx.commands.push({
        type: "text",
        page,
        text: applyTextTransform(raw.slice(flStart, flEnd), flStyle.textTransform),
        x: (flRect.left - ctx.containerRect.left) / PX_PER_PT,
        y: ly,
        font: flFont.name,
        style: flFont.style,
        weight: flFont.weight,
        size: flSizePx / PX_PER_PT,
        color: flCA ? [flCA[0], flCA[1], flCA[2]] : color,
        align: "left",
        maxWidth: flRect.width / PX_PER_PT + flSizePx / PX_PER_PT,
        opacity: combineOpacity(opacity, flCA ? flCA[3] / 255 : colorAlpha),
        blend
      });
    }
  }
  if (!lines.length) return;
  const wsMode = s.whiteSpace;
  const perWord = s.textAlign === "justify" || wsMode === "pre" || wsMode === "pre-wrap" || wsMode === "break-spaces" || wsPt !== void 0 || hasBidiMix(raw);
  const tShadows = parseCSSBoxShadow(s.textShadow);
  let ellipsisLimitPx = Infinity;
  if (drawText && s.textOverflow === "ellipsis" && wsMode === "nowrap" && s.direction !== "rtl") {
    const ox = s.overflowX;
    if (ox === "hidden" || ox === "clip" || ox === "auto" || ox === "scroll") {
      const pe = parentEl;
      if (pe.scrollWidth > pe.clientWidth + 1) {
        const pr = pe.getBoundingClientRect();
        ellipsisLimitPx = pr.left + pe.clientLeft + pe.clientWidth - (parseFloat(s.paddingRight) || 0);
      }
    }
  }
  const firstLineTop = Math.min(...lines.map((l) => l.top));
  const ascentOffset = firstBaselineY - (firstLineTop - ctx.containerRect.top);
  const baseStyle = { fontRef, sizePt, color, textOpacity, lsPt };
  let fllResolved = null;
  let ascentOffsetRest = ascentOffset;
  if (fllStyle && lines.length) {
    const fllFont = resolveFontRef(fllStyle.fontFamily, fllStyle.fontWeight, fllStyle.fontStyle, ctx.fontMap, ctx.registeredFonts) ?? fontRef;
    const fllSizePx = parseFloat(fllStyle.fontSize) || sizePx;
    const fllCA = parseColorAlpha(String(fllStyle.webkitTextFillColor || fllStyle.color));
    fllResolved = {
      fontRef: fllFont,
      sizePt: fllSizePx / PX_PER_PT,
      color: fllCA ? [fllCA[0], fllCA[1], fllCA[2]] : color,
      textOpacity: combineOpacity(opacity, fllCA ? fllCA[3] / 255 : colorAlpha),
      lsPt: fllStyle.letterSpacing === "normal" ? void 0 : pxToPt(fllStyle.letterSpacing) || void 0
    };
    if (lines.length > 1) {
      const lastBaselineY = measureBaselineY(parentEl, textNode, false) - ctx.containerRect.top;
      const lastLineTop = Math.max(...lines.map((l) => l.top));
      ascentOffsetRest = lastBaselineY - (lastLineTop - ctx.containerRect.top);
    }
  }
  for (const [li, line] of lines.entries()) {
    const st = li === 0 && fllResolved ? fllResolved : baseStyle;
    const famSrc = li === 0 && fllResolved ? fllStyle : s;
    const lineAscent = li === 0 ? ascentOffset : fllResolved ? ascentOffsetRest : ascentOffset;
    const lineText = line.words.map((w) => w.text).join(" ");
    if (!lineText.trim()) continue;
    const xPx = line.minX - ctx.containerRect.left;
    const yPx = line.top - ctx.containerRect.top + lineAscent;
    const xPt = xPx / PX_PER_PT;
    const yPt = yPx / PX_PER_PT;
    const rightEdge = Math.max(...line.words.map((w) => w.rect.right));
    const wPt = (rightEdge - ctx.containerRect.left) / PX_PER_PT - xPt;
    const { page, y: ly } = paginate(yPt, ctx.pageH);
    let lineOut = lineText;
    let truncated = false;
    if (ellipsisLimitPx !== Infinity) {
      const ellW = measure_string_width("\u2026", fontRef.name, fontRef.style, fontRef.weight, 0, sizePt) * PX_PER_PT;
      const limit = ellipsisLimitPx - ellW;
      const kept = [];
      for (const wd of line.words) {
        if (wd.rect.right <= limit) {
          kept.push(wd.text);
          continue;
        }
        truncated = true;
        if (wd.rect.left < limit) {
          let sub = "";
          for (let ci = 1; ci <= wd.len; ci++) {
            const r2 = document.createRange();
            r2.setStart(textNode, wd.start);
            r2.setEnd(textNode, wd.start + ci);
            if (r2.getBoundingClientRect().right > limit) break;
            sub = raw.slice(wd.start, wd.start + ci);
          }
          if (sub) kept.push(applyTextTransform(sub, txform));
        }
        break;
      }
      if (truncated) {
        const anyVisible = kept.length > 0 || (line.words[0]?.rect.left ?? 0) < limit;
        lineOut = anyVisible ? kept.join(" ") + "\u2026" : "";
      }
      if (!lineOut) continue;
    }
    const emitRun = (txt, tx, maxW, font, ws) => {
      for (let si = tShadows.length - 1; si >= 0; si--) {
        const sh = tShadows[si];
        ctx.commands.push({
          type: "text",
          page,
          text: txt,
          x: tx + sh.x,
          y: ly + sh.y,
          font: font.name,
          style: font.style,
          weight: font.weight,
          size: st.sizePt,
          color: [sh.color[0], sh.color[1], sh.color[2]],
          align: "left",
          maxWidth: maxW,
          direction: s.direction === "rtl" ? "rtl" : "ltr",
          letterSpacing: st.lsPt,
          wordSpacing: ws,
          // blur is approximated by knocking the shadow's alpha down
          opacity: combineOpacity(opacity, (sh.color[3] ?? 255) / 255 * (sh.blur ? 0.55 : 1)),
          blend
        });
      }
      ctx.commands.push({
        type: "text",
        page,
        text: txt,
        x: tx,
        y: ly,
        font: font.name,
        style: font.style,
        weight: font.weight,
        size: st.sizePt,
        color: st.color,
        align: "left",
        maxWidth: maxW,
        direction: s.direction === "rtl" ? "rtl" : "ltr",
        letterSpacing: st.lsPt,
        wordSpacing: ws,
        opacity: st.textOpacity,
        stroke: textStroke?.color,
        strokeWidth: textStroke?.width,
        strokeOnly: textStroke ? strokeOnly : void 0,
        blend
      });
    };
    const emitTextCmd = (txt, tx, maxW, ws) => {
      if (s.direction === "rtl") {
        emitRun(txt, tx, maxW, st.fontRef, ws);
        return;
      }
      const runs = splitByFontCoverage(txt, st.fontRef, famSrc.fontFamily, famSrc.fontWeight, famSrc.fontStyle, ctx.fontMap, ctx.registeredFonts);
      if (runs.length === 1) {
        emitRun(txt, tx, maxW, st.fontRef, ws);
        return;
      }
      let runX = tx;
      for (const run of runs) {
        const runWidthPt = measure_string_width(run.text, run.font.name, run.font.style, run.font.weight, 0, st.sizePt);
        emitRun(run.text, runX, runWidthPt, run.font, ws);
        runX += runWidthPt;
      }
    };
    if (drawText && perWord && !truncated) {
      for (const wd of line.words) {
        emitTextCmd(wd.text, (wd.rect.left - ctx.containerRect.left) / PX_PER_PT, wd.rect.width / PX_PER_PT);
      }
    } else if (drawText) {
      emitTextCmd(lineOut, xPt, wPt || st.sizePt * lineOut.length * 0.6, wsPt);
    }
    for (const deco of decos) {
      let dy;
      if (deco.part === "underline") dy = ly + (deco.underlineOffsetPt ?? st.sizePt * 0.15);
      else if (deco.part === "overline") dy = ly - st.sizePt * 0.8;
      else if (deco.part === "line-through") dy = ly - st.sizePt * 0.3;
      else continue;
      ctx.commands.push({
        type: "line",
        page,
        x1: xPt,
        y1: dy,
        x2: xPt + wPt,
        y2: dy,
        width: deco.thicknessPt ?? Math.max(0.4, st.sizePt / 14),
        color: deco.color,
        lineStyle: deco.lineStyle,
        opacity: combineOpacity(opacity, deco.alpha),
        blend
      });
    }
  }
}
function markerLabel(type, index) {
  switch (type) {
    case "disc":
      return "\u2022";
    case "circle":
      return "\u25E6";
    case "square":
      return "\u25AA";
    case "decimal":
      return `${index}.`;
    case "decimal-leading-zero":
      return `${index < 10 && index >= 0 ? "0" : ""}${index}.`;
    case "lower-alpha":
    case "lower-latin":
      return `${alphaLabel(index)}.`;
    case "upper-alpha":
    case "upper-latin":
      return `${alphaLabel(index).toUpperCase()}.`;
    case "lower-roman":
      return `${romanNumeral(index).toLowerCase()}.`;
    case "upper-roman":
      return `${romanNumeral(index)}.`;
    default:
      return "\u2022";
  }
}
function listIndex(el) {
  const li = el;
  if (li.value > 0) return li.value;
  let gap = 0;
  let sib = el.previousElementSibling;
  while (sib) {
    if (getComputedStyle(sib).display === "list-item") {
      gap++;
      const sibLi = sib;
      if (sibLi.value > 0) return sibLi.value + gap;
    }
    sib = sib.previousElementSibling;
  }
  const parent = el.parentElement;
  const start = parent instanceof HTMLOListElement ? parent.start : 1;
  return start + gap;
}
function emitListMarker(el, s, ctx) {
  if (s.display !== "list-item") return;
  const type = s.listStyleType;
  if (!type || type === "none") return;
  const ms = getComputedStyle(el, "::marker");
  if (ms.content === "none") return;
  let text = null;
  const strM = (ms.content ?? "").match(/^"((?:[^"\\]|\\.)*)"$/);
  if (strM?.[1] !== void 0) text = strM[1].replace(/\\(.)/g, "$1");
  if (text === null) text = markerLabel(type, listIndex(el));
  if (!text) return;
  const fontRef = resolveFontRef(s.fontFamily, s.fontWeight, s.fontStyle, ctx.fontMap, ctx.registeredFonts);
  if (!fontRef) return;
  const probe = document.createElement("span");
  probe.style.cssText = "display:inline;font-size:0;line-height:0;vertical-align:baseline;visibility:hidden;pointer-events:none;";
  try {
    el.insertBefore(probe, el.firstChild);
    const pr = probe.getBoundingClientRect();
    el.removeChild(probe);
    const sizePx = parseFloat(s.fontSize) || 16;
    const sizePt = sizePx / PX_PER_PT;
    const markerW = measure_string_width(text, fontRef.name, fontRef.style, fontRef.weight, 0, sizePt);
    const gapPt = sizePt * 0.4;
    const xPt = (pr.left - ctx.containerRect.left) / PX_PER_PT - gapPt - markerW;
    const yPt = (pr.top - ctx.containerRect.top) / PX_PER_PT;
    const { page, y: ly } = paginate(yPt, ctx.pageH);
    const { color: clr, alpha } = splitColorAlpha(parseColorAlpha(ms.color || s.color));
    ctx.commands.push({
      type: "text",
      page,
      text,
      x: xPt,
      y: ly,
      font: fontRef.name,
      style: fontRef.style,
      weight: fontRef.weight,
      size: sizePt,
      color: clr ?? [0, 0, 0],
      align: "left",
      maxWidth: markerW + sizePt,
      opacity: combineOpacity(stackOpacity(ctx), alpha)
    });
  } catch {
    try {
      el.removeChild(probe);
    } catch {
    }
  }
}
function isSafeHref(href) {
  if (href.startsWith("#")) return true;
  const lower = href.toLowerCase().trimStart();
  return lower.startsWith("http://") || lower.startsWith("https://") || lower.startsWith("mailto:");
}
function emitLinks(el, ctx) {
  const href = el.getAttribute("href");
  if (!href || !isSafeHref(href)) return;
  for (const domRect of Array.from(el.getClientRects())) {
    if (domRect.width < 1 || domRect.height < 1) continue;
    const { x, y, w, h } = domRectToPt(domRect, ctx.containerRect);
    for (const { page, y: ly } of paginateSpan(y, h, ctx.pageH)) {
      const sliceTop = Math.max(0, ly);
      const sliceH = Math.min(ctx.pageH, ly + h) - sliceTop;
      if (sliceH < 0.5) continue;
      ctx.commands.push({ type: "link", page, href, x, y: sliceTop, w, h: sliceH });
    }
  }
}
var TEXT_LIKE_INPUT_TYPES = /* @__PURE__ */ new Set(["text", "email", "tel", "url", "number", "password", "search", ""]);
function emitFormField(el, s, ctx) {
  const tag = el.tagName.toUpperCase();
  const rect = el.getBoundingClientRect();
  if (rect.width < 1 || rect.height < 1) return;
  const { x, y, w, h } = domRectToPt(rect, ctx.containerRect);
  const { page, y: ly } = paginate(y, ctx.pageH);
  const color = parseColorAlpha(s.color);
  const rgb = color ? [color[0], color[1], color[2]] : [0, 0, 0];
  const name = el.name || `field${ctx.fieldCounter.n++}`;
  if (tag === "INPUT") {
    const inputType = (el.type || "text").toLowerCase();
    if (inputType === "checkbox" || inputType === "radio") {
      ctx.commands.push({
        type: "field",
        page,
        x,
        y: ly,
        w,
        h,
        name,
        font: "",
        style: "",
        weight: 400,
        size: 0,
        color: rgb,
        fieldType: "Btn",
        checked: el.checked
      });
      return;
    }
  }
  const fontRef = resolveFontRef(s.fontFamily, s.fontWeight, s.fontStyle, ctx.fontMap, ctx.registeredFonts);
  const sizePt = fontRef ? (parseFloat(s.fontSize) || 16) / PX_PER_PT : 0;
  const base = {
    type: "field",
    page,
    x,
    y: ly,
    w,
    h,
    name,
    font: fontRef?.name ?? "",
    style: fontRef?.style ?? "",
    weight: fontRef?.weight ?? 400,
    size: sizePt,
    color: rgb
  };
  if (tag === "SELECT") {
    const select = el;
    const options = Array.from(select.options).map((o) => o.value || o.text);
    const sel = select.options[select.selectedIndex];
    ctx.commands.push({ ...base, fieldType: "Ch", value: sel?.value || sel?.text || "", options });
    return;
  }
  if (tag === "TEXTAREA") {
    ctx.commands.push({ ...base, fieldType: "Tx", value: el.value });
    return;
  }
  if (tag === "INPUT") {
    const input = el;
    const inputType = (input.type || "text").toLowerCase();
    if (TEXT_LIKE_INPUT_TYPES.has(inputType)) {
      ctx.commands.push({ ...base, fieldType: "Tx", value: input.value });
    }
  }
}
function captureAnchor(el, ctx) {
  if (!el.id) return;
  if (ctx.anchors.has(el.id)) return;
  const r = el.getBoundingClientRect();
  const yPt = (r.top - ctx.containerRect.top) / PX_PER_PT;
  const { page, y } = paginate(yPt, ctx.pageH);
  ctx.anchors.set(el.id, { page, y });
}
function pseudoBoxSpec(el, ps) {
  const wPx = parseFloat(ps.width);
  const hPx = parseFloat(ps.height);
  if (!(wPx > 0) || !(hPx > 0)) return null;
  const w = wPx / PX_PER_PT;
  const h = hPx / PX_PER_PT;
  const bgCA = parseColorAlpha(ps.backgroundColor);
  let gradient;
  if (ps.backgroundImage && ps.backgroundImage !== "none") {
    for (const layer of splitByTopLevelComma(ps.backgroundImage)) {
      gradient = parseCSSGradient(layer.trim()) ?? void 0;
      if (gradient) break;
    }
  }
  let border = null;
  const bw = pxToPt(ps.borderTopWidth || "0px");
  if (bw > 0 && ps.borderTopStyle !== "none" && ps.borderRightWidth === ps.borderTopWidth && ps.borderBottomWidth === ps.borderTopWidth && ps.borderLeftWidth === ps.borderTopWidth) {
    const bCA = parseColorAlpha(ps.borderTopColor);
    if (bCA) border = { w: bw, color: [bCA[0], bCA[1], bCA[2]], alpha: bCA[3] / 255 };
  }
  if (!bgCA && !gradient && !border) return null;
  let dx = 0, dy = 0;
  if (ps.transform && ps.transform !== "none") {
    const m = ps.transform.match(/^matrix\(1,\s*0,\s*0,\s*1,\s*(-?[\d.]+),\s*(-?[\d.]+)\)$/);
    if (!m) return null;
    dx = +(m[1] ?? 0) / PX_PER_PT;
    dy = +(m[2] ?? 0) / PX_PER_PT;
  }
  if (ps.position === "relative") {
    const rl = parseFloat(ps.left), rr = parseFloat(ps.right);
    const rt = parseFloat(ps.top), rb = parseFloat(ps.bottom);
    dx += (isFinite(rl) ? rl : isFinite(rr) ? -rr : 0) / PX_PER_PT;
    dy += (isFinite(rt) ? rt : isFinite(rb) ? -rb : 0) / PX_PER_PT;
  }
  const mlAuto = ps.marginLeft === "auto", mrAuto = ps.marginRight === "auto";
  const spec = {
    anchor: "flow",
    w,
    h,
    dx,
    dy,
    mL: mlAuto ? null : pxToPt(ps.marginLeft || "0px"),
    mR: mrAuto ? null : pxToPt(ps.marginRight || "0px"),
    mT: pxToPt(ps.marginTop || "0px"),
    mB: pxToPt(ps.marginBottom || "0px"),
    fill: bgCA ? [bgCA[0], bgCA[1], bgCA[2]] : null,
    fillAlpha: bgCA ? bgCA[3] / 255 : 1,
    gradient,
    border,
    radius: clampRadiusToBox(parseBorderRadius(ps, void 0, { w, h }), w, h)
  };
  const elS = getComputedStyle(el);
  if (ps.position === "absolute" || ps.position === "fixed") {
    if (elS.position === "static") return null;
    const hasH = isFinite(parseFloat(ps.left)) || isFinite(parseFloat(ps.right));
    const hasV = isFinite(parseFloat(ps.top)) || isFinite(parseFloat(ps.bottom));
    if (!hasH || !hasV) return null;
    spec.anchor = "abs";
    return spec;
  }
  if (ps.position !== "static" && ps.position !== "relative") return null;
  const elD = elS.display;
  if (elD !== "block" && elD !== "inline-block" && elD !== "list-item" && elD !== "flow-root" && elD !== "table-cell") return null;
  const d = ps.display;
  if (d === "block" || d === "flex" || d === "grid" || d === "flow-root") return spec;
  if (d === "inline-block" && (ps.verticalAlign === "baseline" || ps.verticalAlign === "middle")) {
    spec.anchor = "probe";
    return spec;
  }
  return null;
}
function emitPseudoBox(el, which, ps, spec, probeRect, ctx) {
  const elR = domRectToPt(el.getBoundingClientRect(), ctx.containerRect);
  const elS = getComputedStyle(el);
  const bL = pxToPt(elS.borderLeftWidth || "0px"), bR = pxToPt(elS.borderRightWidth || "0px");
  const bT = pxToPt(elS.borderTopWidth || "0px"), bB = pxToPt(elS.borderBottomWidth || "0px");
  let x, y;
  if (spec.anchor === "abs") {
    const pL = elR.x + bL, pT = elR.y + bT;
    const pR = elR.x + elR.w - bR, pB = elR.y + elR.h - bB;
    const oL = parseFloat(ps.left), oR = parseFloat(ps.right);
    const oT = parseFloat(ps.top), oB = parseFloat(ps.bottom);
    x = isFinite(oL) ? pL + oL / PX_PER_PT + (spec.mL ?? 0) : pR - oR / PX_PER_PT - spec.w - (spec.mR ?? 0);
    y = isFinite(oT) ? pT + oT / PX_PER_PT + spec.mT : pB - oB / PX_PER_PT - spec.h - spec.mB;
  } else if (spec.anchor === "flow") {
    const cL = elR.x + bL + pxToPt(elS.paddingLeft || "0px");
    const cR = elR.x + elR.w - bR - pxToPt(elS.paddingRight || "0px");
    const cT = elR.y + bT + pxToPt(elS.paddingTop || "0px");
    const cB = elR.y + elR.h - bB - pxToPt(elS.paddingBottom || "0px");
    if (spec.mL === null && spec.mR === null) x = cL + (cR - cL - spec.w) / 2;
    else if (spec.mL === null) x = cR - (spec.mR ?? 0) - spec.w;
    else x = cL + spec.mL;
    y = which === "::before" ? cT + spec.mT : cB - spec.mB - spec.h;
  } else {
    if (!probeRect) return;
    const probeLeft = (probeRect.left - ctx.containerRect.left) / PX_PER_PT;
    const baseline = (probeRect.top - ctx.containerRect.top) / PX_PER_PT;
    x = which === "::before" ? probeLeft - (spec.mR ?? 0) - spec.w : probeLeft + (spec.mL ?? 0);
    if (ps.verticalAlign === "middle") {
      const xh = (parseFloat(ps.fontSize) || 16) / PX_PER_PT * 0.5;
      y = baseline - xh / 2 - spec.h / 2;
    } else {
      y = baseline - spec.mB - spec.h;
    }
  }
  x += spec.dx;
  y += spec.dy;
  let gradient = spec.gradient;
  if (gradient) gradient = resolveGradientBox(gradient, spec.w, spec.h);
  const elOp = parseFloat(ps.opacity);
  const base = !isNaN(elOp) && elOp < 1 ? combineOpacity(stackOpacity(ctx), elOp) : stackOpacity(ctx);
  for (const { page, y: ly } of paginateSpan(y, spec.h, ctx.pageH)) {
    if (spec.fill || gradient) {
      ctx.commands.push({
        type: "rect",
        page,
        x,
        y: ly,
        w: spec.w,
        h: spec.h,
        fill: gradient ? null : spec.fill,
        gradient,
        radius: spec.radius,
        opacity: gradient ? base : combineOpacity(base, spec.fillAlpha)
      });
    }
    if (spec.border) {
      ctx.commands.push({
        type: "rect",
        page,
        x,
        y: ly,
        w: spec.w,
        h: spec.h,
        fill: null,
        stroke: spec.border.color,
        strokeWidth: spec.border.w,
        radius: spec.radius,
        opacity: combineOpacity(base, spec.border.alpha)
      });
    }
  }
}
async function capturePseudo(el, which, ctx) {
  const ps = getComputedStyle(el, which);
  if (ps.display === "none" || !ps.content || ps.content === "none" || ps.content === "normal") return;
  if (ps.visibility === "hidden" || ps.visibility === "collapse") return;
  const pseudoCounters = applyCounters(ctx.counters, ps);
  try {
    await capturePseudoContent(el, which, ps, ctx);
  } finally {
    popCounters(ctx.counters, pseudoCounters);
  }
}
async function capturePseudoContent(el, which, ps, ctx) {
  const resolved = resolveContentList(ps.content, ctx.counters);
  if (resolved === null) return;
  const psColorSrc = String(ps.webkitTextFillColor || ps.color);
  const text = applyTextTransform(resolved, ps.textTransform);
  const fontRef = text && !isTransparentColor(psColorSrc) ? resolveFontRef(ps.fontFamily, ps.fontWeight, ps.fontStyle, ctx.fontMap, ctx.registeredFonts) : null;
  const box = pseudoBoxSpec(el, ps);
  if (!fontRef && !box) return;
  let probeRect = null;
  if (fontRef || box?.anchor === "probe") {
    const probe = document.createElement("span");
    probe.style.cssText = "display:inline;font-size:0;line-height:0;vertical-align:baseline;visibility:hidden;pointer-events:none;";
    try {
      if (which === "::before") el.insertBefore(probe, el.firstChild);
      else el.appendChild(probe);
      probeRect = probe.getBoundingClientRect();
    } catch {
    }
    try {
      el.removeChild(probe);
    } catch {
    }
  }
  if (box) emitPseudoBox(el, which, ps, box, probeRect, ctx);
  if (!fontRef || !probeRect) return;
  const sizePx = parseFloat(ps.fontSize) || 16;
  const sizePt = sizePx / PX_PER_PT;
  const xPt = (probeRect.left - ctx.containerRect.left) / PX_PER_PT;
  const yPt = (probeRect.top - ctx.containerRect.top) / PX_PER_PT;
  const { page, y: ly } = paginate(yPt, ctx.pageH);
  const { color: colorRgb, alpha: colorAlpha } = splitColorAlpha(parseColorAlpha(psColorSrc));
  const color = colorRgb ?? [0, 0, 0];
  const opacity = stackOpacity(ctx);
  const lsPt = ps.letterSpacing === "normal" ? void 0 : pxToPt(ps.letterSpacing) || void 0;
  ctx.commands.push({
    type: "text",
    page,
    text,
    x: xPt,
    y: ly,
    font: fontRef.name,
    style: fontRef.style,
    weight: fontRef.weight,
    size: sizePt,
    color,
    align: "left",
    maxWidth: ctx.pageW,
    letterSpacing: lsPt,
    opacity: combineOpacity(opacity, colorAlpha)
  });
}

// src/html/mask.ts
function hasMask(s) {
  const v = s.maskImage;
  return !!v && v !== "none";
}
function addStops(grad, stops) {
  for (const st of stops) {
    const [r, g, b, a] = st.color;
    grad.addColorStop(Math.min(1, Math.max(0, st.position)), `rgba(${r},${g},${b},${a / 255})`);
  }
}
function loadImage(url) {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => resolve(null);
    img.src = url;
  });
}
async function paintMaskSource(spec, wPt, hPt, cw, ch) {
  const canvas = document.createElement("canvas");
  canvas.width = cw;
  canvas.height = ch;
  const c = canvas.getContext("2d");
  const lin = parseCSSGradient(spec);
  if (lin) {
    const g = resolveGradientBox(lin, wPt, hPt);
    let grad;
    if (g.type === "linear") {
      const rad = g.angle * Math.PI / 180;
      const dx = Math.sin(rad), dy = -Math.cos(rad);
      const hw = cw / 2, hh = ch / 2;
      const projs = [-hw * dx - hh * dy, hw * dx - hh * dy, -hw * dx + hh * dy, hw * dx + hh * dy];
      const tMin = Math.min(...projs), tMax = Math.max(...projs);
      const cx = cw / 2, cy = ch / 2;
      grad = c.createLinearGradient(cx + tMin * dx, cy + tMin * dy, cx + tMax * dx, cy + tMax * dy);
    } else {
      const gcx = cw * (g.cx ?? 0.5), gcy = ch * (g.cy ?? 0.5);
      const r = Math.hypot(Math.max(gcx, cw - gcx), Math.max(gcy, ch - gcy));
      grad = c.createRadialGradient(gcx, gcy, 0, gcx, gcy, r);
    }
    addStops(grad, g.stops);
    c.fillStyle = grad;
    c.fillRect(0, 0, cw, ch);
    return canvas;
  }
  const conic = parseCSSConicGradient(spec);
  if (conic && typeof c.createConicGradient === "function") {
    const grad = c.createConicGradient((conic.fromDeg - 90) * Math.PI / 180, conic.cx * cw, conic.cy * ch);
    addStops(grad, tileStops(conic.stops, conic.repeating));
    c.fillStyle = grad;
    c.fillRect(0, 0, cw, ch);
    return canvas;
  }
  const urlM = spec.match(/^url\((['"]?)(.*?)\1\)$/);
  if (urlM) {
    const img = await loadImage(urlM[2]);
    if (!img) return null;
    c.drawImage(img, 0, 0, cw, ch);
    return canvas;
  }
  return null;
}
async function emitMaskedElement(el, s, ctx) {
  const domRect = el.getBoundingClientRect();
  if (domRect.width < 1 || domRect.height < 1) return;
  const { x, y, w, h } = domRectToPt(domRect, ctx.containerRect);
  const dpr = 3;
  const cw = Math.max(1, Math.round(domRect.width * dpr));
  const ch = Math.max(1, Math.round(domRect.height * dpr));
  const maskSpec = s.maskImage;
  const maskCanvas = await paintMaskSource(maskSpec, w, h, cw, ch);
  if (!maskCanvas) return;
  const content = document.createElement("canvas");
  content.width = cw;
  content.height = ch;
  paintNode(el, content.getContext("2d"), domRect, dpr);
  const finalCanvas = document.createElement("canvas");
  finalCanvas.width = cw;
  finalCanvas.height = ch;
  const fc = finalCanvas.getContext("2d");
  fc.drawImage(content, 0, 0);
  fc.globalCompositeOperation = "destination-in";
  fc.drawImage(maskCanvas, 0, 0);
  const src = canvasToPngBytes(finalCanvas);
  if (!src) return;
  const opacity = stackOpacity(ctx);
  for (const { page, y: ly } of paginateSpan(y, h, ctx.pageH)) {
    ctx.commands.push({ type: "image", page, src, format: "png", x, y: ly, w, h, opacity });
  }
}

// src/html/walk.ts
var SKIP_TAGS = /* @__PURE__ */ new Set(["SCRIPT", "STYLE", "NOSCRIPT", "META", "LINK", "HEAD", "TITLE", "TEMPLATE"]);
function captureAnyTextNode(node, parent, parentStyle, ctx) {
  if (parentStyle.writingMode === "vertical-rl" || parentStyle.writingMode === "vertical-lr") {
    captureVerticalTextNode(node, parent, parentStyle, ctx);
  } else {
    captureTextNode(node, parent, parentStyle, ctx);
  }
}
function tagTextCommands(ctx, cmds) {
  if (!ctx.struct) return;
  for (const cmd of cmds) {
    if (cmd.type !== "text") continue;
    const tagged = tagStructContent(ctx, cmd.page);
    if (tagged) {
      cmd.mcid = tagged.mcid;
      cmd.structTag = tagged.tag;
    }
  }
}
function tagImageCommands(ctx, cmds) {
  if (!ctx.struct) return;
  for (const cmd of cmds) {
    if (cmd.type !== "image" && cmd.type !== "raw-image") continue;
    const tagged = tagStructContent(ctx, cmd.page);
    if (tagged) {
      const c = cmd;
      c.mcid = tagged.mcid;
      c.structTag = tagged.tag;
    }
  }
}
function paddingBoxClip(x, y, w, h, radius, s) {
  const top = pxToPt(s.borderTopWidth || "0px");
  const right = pxToPt(s.borderRightWidth || "0px");
  const bottom = pxToPt(s.borderBottomWidth || "0px");
  const left = pxToPt(s.borderLeftWidth || "0px");
  if (!top && !right && !bottom && !left) return { x, y, w, h, radius };
  return {
    x: x + left,
    y: y + top,
    w: Math.max(0, w - left - right),
    h: Math.max(0, h - top - bottom),
    radius: insetBorderRadius(radius, top, right, bottom, left)
  };
}
async function walkChildren(parent, parentStyle, ctx) {
  const children = Array.from(parent.childNodes);
  let needsZSort = false;
  for (const child of children) {
    if (child.nodeType !== Node.ELEMENT_NODE) continue;
    if (getComputedStyle(child).position !== "static") {
      needsZSort = true;
      break;
    }
  }
  const childCounters = [];
  if (!needsZSort) {
    for (const child of children) {
      if (child.nodeType === Node.TEXT_NODE) {
        const startIdx = ctx.commands.length;
        captureAnyTextNode(child, parent, parentStyle, ctx);
        tagTextCommands(ctx, ctx.commands.slice(startIdx));
      } else if (child.nodeType === Node.ELEMENT_NODE) {
        childCounters.push(...await walkElement(child, ctx));
      }
    }
    popCounters(ctx.counters, childCounters);
    return;
  }
  const layers = [];
  for (const child of children) {
    const subCtx = { ...ctx, commands: [], opacityStack: [...ctx.opacityStack], blendStack: [...ctx.blendStack] };
    if (child.nodeType === Node.TEXT_NODE) {
      captureAnyTextNode(child, parent, parentStyle, subCtx);
      tagTextCommands(ctx, subCtx.commands);
      layers.push({ z: 0, group: 1, commands: subCtx.commands });
    } else if (child.nodeType === Node.ELEMENT_NODE) {
      const childEl = child;
      const cs = getComputedStyle(childEl);
      const positioned = cs.position !== "static";
      const zRaw = parseInt(cs.zIndex, 10);
      const z = positioned && !isNaN(zRaw) ? zRaw : 0;
      const group = !positioned ? 1 : z < 0 ? 0 : z > 0 ? 3 : 2;
      childCounters.push(...await walkElement(childEl, subCtx));
      layers.push({ z, group, commands: subCtx.commands });
    }
  }
  popCounters(ctx.counters, childCounters);
  const ordered = [
    ...layers.filter((l) => l.group === 0).sort((a, b) => a.z - b.z),
    ...layers.filter((l) => l.group === 1),
    ...layers.filter((l) => l.group === 2),
    ...layers.filter((l) => l.group === 3).sort((a, b) => a.z - b.z)
  ];
  for (const layer of ordered) {
    for (const cmd of layer.commands) ctx.commands.push(cmd);
  }
}
async function walkElement(el, ctx) {
  const tag = el.tagName.toUpperCase();
  if (SKIP_TAGS.has(tag)) return [];
  const s = getComputedStyle(el);
  if (s.display === "none") return [];
  const structEntry = enterStruct(el, tag, ctx);
  try {
    if (s.position === "fixed" && ctx.fixedElements) {
      return await captureFixedElement(el, tag, s, ctx);
    }
    if (s.transform && s.transform !== "none") {
      return await captureTransformedElement(el, tag, s, ctx);
    }
    return await walkElementBody(el, tag, s, ctx);
  } finally {
    exitStruct(ctx, structEntry);
  }
}
async function captureFixedElement(el, tag, s, ctx) {
  const subCtx = { ...ctx, commands: [], opacityStack: [...ctx.opacityStack], blendStack: [...ctx.blendStack] };
  const counters = s.transform && s.transform !== "none" ? await captureTransformedElement(el, tag, s, subCtx) : await walkElementBody(el, tag, s, subCtx);
  ctx.fixedElements.push(subCtx.commands);
  return counters;
}
async function captureTransformedElement(el, tag, s, ctx) {
  const rawMatrix = parseCSSMatrix(s.transform);
  if (!rawMatrix) {
    console.warn("[daepdf] 3D transforms (matrix3d/perspective) are not supported \u2014 element rendered untransformed.");
    return walkElementBody(el, tag, s, ctx);
  }
  const cssMatrix = [
    rawMatrix[0],
    rawMatrix[1],
    rawMatrix[2],
    rawMatrix[3],
    rawMatrix[4] / PX_PER_PT,
    rawMatrix[5] / PX_PER_PT
  ];
  const htmlEl = el;
  const savedInline = htmlEl.style.transform;
  htmlEl.style.transform = "none";
  const boxRect = el.getBoundingClientRect();
  const { x: boxX, y: boxY } = domRectToPt(boxRect, ctx.containerRect);
  const [oxStr, oyStr] = s.transformOrigin.split(/\s+/);
  const originX = boxX + (parseFloat(oxStr ?? "") || 0) / PX_PER_PT;
  const originY = boxY + (parseFloat(oyStr ?? "") || 0) / PX_PER_PT;
  const subCtx = { ...ctx, commands: [], opacityStack: [...ctx.opacityStack], blendStack: [...ctx.blendStack] };
  const counters = await walkElementBody(el, tag, s, subCtx);
  htmlEl.style.transform = savedInline;
  const matrix = buildPdfTransformMatrix(cssMatrix, originX, originY, ctx.pageH);
  const pages = [...new Set(subCtx.commands.map((c) => c.page))].sort((a, b) => a - b);
  for (const page of pages) ctx.commands.push({ type: "transform-push", page, matrix });
  for (const cmd of subCtx.commands) ctx.commands.push(cmd);
  for (const page of pages) ctx.commands.push({ type: "transform-pop", page });
  return counters;
}
async function walkElementBody(el, tag, s, ctx) {
  const hiddenSelf = s.visibility === "hidden" || s.visibility === "collapse";
  const ownCounters = applyCounters(ctx.counters, s);
  captureAnchor(el, ctx);
  const elOpacity = parseFloat(s.opacity);
  const hasOwnOpacity = !isNaN(elOpacity) && elOpacity < 1;
  if (hasOwnOpacity) ctx.opacityStack.push(elOpacity);
  const ownBlend = cssBlendToPdf(s.mixBlendMode);
  if (ownBlend) ctx.blendStack.push(ownBlend);
  const popStacks = () => {
    if (hasOwnOpacity) ctx.opacityStack.pop();
    if (ownBlend) ctx.blendStack.pop();
  };
  if (hasFilter(s)) {
    if (!hiddenSelf) emitFilteredElement(el, s, ctx);
    popStacks();
    return ownCounters;
  }
  if (hasMask(s)) {
    if (!hiddenSelf) await emitMaskedElement(el, s, ctx);
    popStacks();
    return ownCounters;
  }
  let clipPathSpans = [];
  const clipPathVal = s.clipPath;
  if (clipPathVal && clipPathVal !== "none") {
    const box = domRectToPt(el.getBoundingClientRect(), ctx.containerRect);
    const shape = parseClipPath(clipPathVal, box);
    if (shape?.kind === "rect") {
      const spans = paginateSpan(shape.y, Math.max(shape.h, 1e-3), ctx.pageH);
      for (const { page, y: ly } of spans) {
        ctx.commands.push({ type: "clip-push", page, x: shape.x, y: ly, w: shape.w, h: shape.h, radius: shape.radius });
      }
      clipPathSpans = spans;
    } else if (shape?.kind === "path") {
      const ys = shape.ops.flatMap((seg) => seg.args.filter((_, i) => i % 2 === 1));
      const minY = Math.min(...ys), maxY = Math.max(...ys);
      const spans = paginateSpan(minY, Math.max(maxY - minY, 1e-3), ctx.pageH);
      for (const { page, y: ly } of spans) {
        const dy = ly - minY;
        const ops = shape.ops.map((seg) => ({ op: seg.op, args: seg.args.map((v, i) => i % 2 === 1 ? v + dy : v) }));
        ctx.commands.push({ type: "clip-push", page, path: ops, evenOdd: shape.evenOdd });
      }
      clipPathSpans = spans;
    }
  }
  const popClipPath = () => {
    for (const { page } of clipPathSpans) ctx.commands.push({ type: "clip-pop", page });
  };
  if (tag === "SVG") {
    if (!hiddenSelf) {
      const startIdx = ctx.commands.length;
      await emitInlineSVG(el, ctx);
      tagImageCommands(ctx, ctx.commands.slice(startIdx));
    }
    popClipPath();
    popStacks();
    return ownCounters;
  }
  if (!hiddenSelf) {
    emitBox(el, s, ctx);
    emitListMarker(el, s, ctx);
    if (hasBorderImage(s)) await emitBorderImage(el, s, ctx);
  }
  const clips = (v) => v === "hidden" || v === "clip" || v === "auto" || v === "scroll";
  const needsClip = clips(s.overflowX) || clips(s.overflowY);
  let clipSpans = [];
  let clipRegion = null;
  if (needsClip) {
    const r = el.getBoundingClientRect();
    const { x, y, w, h } = domRectToPt(r, ctx.containerRect);
    clipRegion = paddingBoxClip(x, y, w, h, parseBorderRadius(s, el), s);
    clipSpans = paginateSpan(clipRegion.y, Math.max(clipRegion.h, 1e-3), ctx.pageH);
    for (const { page, y: ly } of clipSpans) {
      ctx.commands.push({
        type: "clip-push",
        page,
        x: clipRegion.x,
        y: ly,
        w: clipRegion.w,
        h: clipRegion.h,
        radius: clipRegion.radius
      });
    }
  }
  const popClips = () => {
    for (const { page } of clipSpans) {
      ctx.commands.push({ type: "clip-pop", page });
    }
    popClipPath();
  };
  if (!hiddenSelf && s.backgroundImage && s.backgroundImage !== "none") {
    const layers = splitByTopLevelComma(s.backgroundImage);
    for (let i = layers.length - 1; i >= 0; i--) {
      const url = extractBgUrl((layers[i] ?? "").trim());
      if (url) await emitBgImage(el, url, ctx, i, layers.length);
    }
  }
  if (tag === "IMG") {
    if (!hiddenSelf) {
      const startIdx = ctx.commands.length;
      await emitImage(el, ctx);
      tagImageCommands(ctx, ctx.commands.slice(startIdx));
    }
    popClips();
    popStacks();
    return ownCounters;
  }
  if (tag === "CANVAS") {
    if (!hiddenSelf) emitCanvas(el, ctx);
    popClips();
    popStacks();
    return ownCounters;
  }
  if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") {
    if (!hiddenSelf) emitFormField(el, s, ctx);
    popClips();
    popStacks();
    return ownCounters;
  }
  if (tag === "A" && !hiddenSelf) emitLinks(el, ctx);
  await capturePseudo(el, "::before", ctx);
  await walkChildren(el, s, ctx);
  await capturePseudo(el, "::after", ctx);
  popClips();
  popStacks();
  return ownCounters;
}

// src/html/prep.ts
async function waitForLayout() {
  if (typeof document !== "undefined" && document.fonts?.ready) {
    await document.fonts.ready;
  }
  await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
}
function injectWordBreaks(root, chunkSize = 25) {
  const d = root.ownerDocument ?? document;
  const walker = d.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const targets = [];
  let node;
  while (node = walker.nextNode()) targets.push(node);
  for (const text of targets) {
    const raw = text.textContent ?? "";
    if (!/\S{26,}/.test(raw)) continue;
    const parent = text.parentNode;
    if (!parent) continue;
    if (parent.nodeType === Node.ELEMENT_NODE) {
      const ws = getComputedStyle(parent).whiteSpace;
      if (ws === "nowrap" || ws === "pre") continue;
    }
    const frag = d.createDocumentFragment();
    let last = 0;
    const re = /\S{26,}/g;
    let m;
    while ((m = re.exec(raw)) !== null) {
      if (m.index > last) frag.appendChild(d.createTextNode(raw.slice(last, m.index)));
      const word = m[0];
      for (let i = 0; i < word.length; i += chunkSize) {
        frag.appendChild(d.createTextNode(word.slice(i, i + chunkSize)));
        if (i + chunkSize < word.length) frag.appendChild(d.createElement("wbr"));
      }
      last = m.index + word.length;
    }
    if (last < raw.length) frag.appendChild(d.createTextNode(raw.slice(last)));
    parent.replaceChild(frag, text);
  }
}
var scopeCounter = 0;
function nextScopeId() {
  scopeCounter += 1;
  return `s${scopeCounter}${Math.random().toString(36).slice(2, 8)}`;
}
function scopeTemplateCSS(css, scopeId) {
  const faces = [];
  const rest = css.replace(/@font-face\s*\{[^}]*\}/g, (m) => {
    faces.push(m);
    return "";
  });
  const body = rest.trim().replace(/:root\b/g, ":scope").replace(/(^|[},\s])(html|body)(?=[\s,{.:#[>+~])/g, "$1:scope");
  const scoped = body ? `@scope ([data-tpdf-scope="${scopeId}"]) {
${body}
}` : "";
  return [faces.join("\n"), scoped].filter(Boolean).join("\n");
}
function parseSafeHTML(html, scopeId) {
  const doc = new DOMParser().parseFromString(html, "text/html");
  doc.querySelectorAll('link[rel="stylesheet"]').forEach((l) => {
    console.warn(`[daepdf] <link rel="stylesheet" href="${l.getAttribute("href")}"> is not supported and was removed \u2014 use an inline <style> block instead.`);
  });
  doc.querySelectorAll("script, link, object, embed, iframe, video, audio").forEach((s) => s.remove());
  doc.querySelectorAll("style").forEach((s) => {
    const css = s.textContent ?? "";
    for (const imp of css.match(/@import\b[^;]*/g) ?? []) {
      console.warn(`[daepdf] "${imp.trim()}" is not supported and was removed \u2014 inline the imported stylesheet's contents instead.`);
    }
    s.textContent = scopeTemplateCSS(css.replace(/@import\b[^;]*;?/g, ""), scopeId);
  });
  const XLINK_NS2 = "http://www.w3.org/1999/xlink";
  const isScriptScheme = (v) => !!v && /^\s*(javascript|data|vbscript):/i.test(v);
  doc.querySelectorAll("*").forEach((el) => {
    for (const { name } of Array.from(el.attributes)) {
      if (name.startsWith("on")) el.removeAttribute(name);
    }
    if (isScriptScheme(el.getAttribute("href"))) el.removeAttribute("href");
    if (isScriptScheme(el.getAttributeNS(XLINK_NS2, "href"))) el.removeAttributeNS(XLINK_NS2, "href");
    if (isScriptScheme(el.getAttribute("xlink:href"))) el.removeAttribute("xlink:href");
  });
  return doc;
}
function safeInjectParsed(doc, container, scopeId) {
  container.dataset["tpdfScope"] = scopeId;
  const frag = document.createDocumentFragment();
  for (const style of Array.from(doc.head.querySelectorAll("style"))) {
    frag.appendChild(document.importNode(style, true));
  }
  for (const node of Array.from(doc.body.childNodes)) {
    frag.appendChild(document.importNode(node, true));
  }
  container.textContent = "";
  container.appendChild(frag);
}
function createHiddenContainer(pageWPt, pageHPt) {
  const div = document.createElement("div");
  const height = pageHPt !== void 0 ? `${pageHPt * PX_PER_PT}px` : "auto";
  div.style.cssText = `position:fixed;top:-99999px;left:-99999px;width:${pageWPt * PX_PER_PT}px;height:${height};overflow:visible;pointer-events:none;z-index:-9999;transform:translateZ(0);`;
  document.body.appendChild(div);
  return div;
}
function extractFontFaceBlocks(css) {
  const blocks = [];
  const startRe = /@font-face\s*\{/g;
  let sm;
  while ((sm = startRe.exec(css)) !== null) {
    let pos = sm.index + sm[0].length;
    let depth = 1;
    let parenDepth = 0;
    let inStr = null;
    while (pos < css.length && depth > 0) {
      const ch = css[pos];
      if (inStr) {
        if (ch === "\\") {
          pos += 2;
          continue;
        }
        if (ch === inStr) inStr = null;
      } else if (parenDepth > 0) {
        if (ch === ")") parenDepth--;
        else if (ch === "(") parenDepth++;
        else if (ch === '"' || ch === "'") inStr = ch;
      } else {
        if (ch === '"' || ch === "'") inStr = ch;
        else if (ch === "(") parenDepth++;
        else if (ch === "{") depth++;
        else if (ch === "}") depth--;
      }
      pos++;
    }
    blocks.push(css.slice(sm.index, pos));
    startRe.lastIndex = pos;
  }
  return blocks;
}
function parseAtFontFace(html) {
  const results = [];
  for (const block of extractFontFaceBlocks(html)) {
    const nameM = block.match(/font-family\s*:\s*['"]?([^'";,]+)['"]?/);
    const urlM = block.match(/src\s*:[^;]*url\(['"]?([^'")\s]+)['"]?\)/);
    if (nameM && urlM) results.push({ name: (nameM[1] ?? "").trim(), url: (urlM[1] ?? "").trim() });
  }
  return results;
}
async function autoRegisterFonts(styleText) {
  const faces = parseAtFontFace(styleText);
  if (!faces.length) return;
  await Promise.all(faces.map(
    (f) => loadAndRegisterFont({ path: f.url, name: f.name }).catch((e) => console.warn(`[daepdf] Could not load font "${f.name}" from ${f.url}:`, e))
  ));
  invalidateFontMapCache();
}

// src/html/breaks.ts
var BREAK_ATTR = "data-tpdf-break";
var MAX_FIXES = 300;
function isOutOfFlow(cs) {
  return cs.position === "absolute" || cs.position === "fixed";
}
function wantsBreakBefore(cs) {
  const v = cs.breakBefore ?? "";
  return v === "page" || v === "left" || v === "right" || v === "always";
}
function wantsBreakAfter(cs) {
  const v = cs.breakAfter ?? "";
  return v === "page" || v === "left" || v === "right" || v === "always";
}
function avoidsBreakInside(cs) {
  const v = cs.breakInside ?? "";
  return v === "avoid" || v === "avoid-page";
}
var ATOMIC_TAGS = /* @__PURE__ */ new Set(["IMG", "CANVAS", "SVG", "TR"]);
function isAtomic(el, cs) {
  if (ATOMIC_TAGS.has(el.tagName.toUpperCase())) return true;
  if (avoidsBreakInside(cs)) return true;
  const d = cs.display;
  return d === "flex" || d === "grid" || d === "inline-flex" || d === "inline-grid";
}
function pushHeight(top, containerTop, pageHPx) {
  const rel = top - containerTop;
  const next = (Math.floor(rel / pageHPx) + 1) * pageHPx;
  return next - rel;
}
function makeSpacer(doc, forTag, heightPx) {
  if (forTag === "TR") {
    const tr = doc.createElement("tr");
    tr.setAttribute(BREAK_ATTR, "");
    const td = doc.createElement("td");
    td.colSpan = 100;
    td.style.cssText = `height:${heightPx}px;padding:0;border:0;background:transparent;`;
    tr.appendChild(td);
    return tr;
  }
  const div = doc.createElement("div");
  div.setAttribute(BREAK_ATTR, "");
  div.style.cssText = `display:block;height:${heightPx}px;margin:0;padding:0;border:0;`;
  return div;
}
function insertSpacer(node, targetRect, containerTop, pageHPx) {
  const parent = node.parentNode;
  if (!parent) return false;
  const doc = node.ownerDocument ?? document;
  const startTop = targetRect().top;
  const h = pushHeight(startTop, containerTop, pageHPx);
  if (h <= 0.5 || h >= pageHPx) return false;
  const forTag = node.nodeType === Node.ELEMENT_NODE ? node.tagName.toUpperCase() : "";
  const spacer = makeSpacer(doc, forTag, h);
  parent.insertBefore(spacer, node);
  const intendedRel = (Math.floor((startTop - containerTop) / pageHPx) + 1) * pageHPx;
  const actualRel = targetRect().top - containerTop;
  const residual = intendedRel - actualRel;
  if (Math.abs(residual) > 0.5) {
    const inner = forTag === "TR" ? spacer.firstElementChild : spacer;
    const newH = h + residual;
    if (newH <= 0.5 || newH >= pageHPx * 1.5) {
      parent.removeChild(spacer);
      return false;
    }
    inner.style.height = `${newH}px`;
  }
  return true;
}
function repeatThead(tr) {
  if (tr.closest("thead")) return;
  const table = tr.closest("table");
  if (!table) return;
  const thead = table.querySelector(":scope > thead");
  if (!thead || !thead.rows.length) return;
  const parent = tr.parentNode;
  if (!parent) return;
  const frag = (tr.ownerDocument ?? document).createDocumentFragment();
  for (const row of Array.from(thead.rows)) {
    const clone = row.cloneNode(true);
    clone.setAttribute(BREAK_ATTR, "");
    frag.appendChild(clone);
  }
  parent.insertBefore(frag, tr);
}
function crossesBoundary(rect, containerTop, pageHPx) {
  if (rect.height <= 0.5 || rect.height >= pageHPx) return false;
  const topRel = rect.top - containerTop;
  const botRel = rect.bottom - containerTop;
  return Math.floor((topRel + 0.5) / pageHPx) !== Math.floor((botRel - 0.5) / pageHPx);
}
function atPageTop(rect, containerTop, pageHPx) {
  const rel = (rect.top - containerTop) % pageHPx;
  return rel < 1;
}
function findViolation(root, containerTop, pageHPx, skip) {
  let best = null;
  const consider = (top, fix, node) => {
    if (skip.has(node)) return;
    if (best === null || top < best.top - 0.5) {
      best = { top, fix: () => {
        const ok = fix();
        if (!ok) skip.add(node);
        return ok;
      } };
    }
  };
  const walkEl = (el) => {
    const cs = getComputedStyle(el);
    if (el !== root) {
      if (cs.display === "none" || isOutOfFlow(cs)) return;
      if (el.hasAttribute(BREAK_ATTR)) return;
    }
    const rect = el.getBoundingClientRect();
    if (wantsBreakBefore(cs) && rect.height > 0 && !atPageTop(rect, containerTop, pageHPx)) {
      consider(rect.top, () => insertSpacer(el, () => el.getBoundingClientRect(), containerTop, pageHPx), el);
    }
    if (wantsBreakAfter(cs)) {
      let sib = el.nextElementSibling;
      while (sib && (sib.hasAttribute(BREAK_ATTR) || getComputedStyle(sib).display === "none")) sib = sib.nextElementSibling;
      if (sib) {
        const sr = sib.getBoundingClientRect();
        const target = sib;
        if (sr.height > 0 && !atPageTop(sr, containerTop, pageHPx)) {
          consider(sr.top, () => insertSpacer(target, () => target.getBoundingClientRect(), containerTop, pageHPx), target);
        }
      }
    }
    if (isAtomic(el, cs)) {
      if (crossesBoundary(rect, containerTop, pageHPx)) {
        const isRow = el.tagName.toUpperCase() === "TR";
        const fix = () => {
          const ok = insertSpacer(el, () => el.getBoundingClientRect(), containerTop, pageHPx);
          if (ok && isRow) repeatThead(el);
          return ok;
        };
        consider(rect.top, fix, el);
      }
      return;
    }
    for (const child of Array.from(el.childNodes)) {
      if (child.nodeType === Node.ELEMENT_NODE) {
        walkEl(child);
      } else if (child.nodeType === Node.TEXT_NODE && (child.textContent ?? "").trim()) {
        walkText(child);
      }
    }
  };
  const walkText = (textNode) => {
    const range = (textNode.ownerDocument ?? document).createRange();
    range.selectNodeContents(textNode);
    const rects = Array.from(range.getClientRects()).filter((r) => r.height > 0.5 && r.width > 0.1);
    for (const r of rects) {
      if (!crossesBoundary(r, containerTop, pageHPx)) continue;
      const lineTop = r.top;
      consider(lineTop, () => fixTextLineWithOrphansWidows(textNode, lineTop, containerTop, pageHPx), textNode);
      break;
    }
  };
  walkEl(root);
  return best;
}
function fixTextLine(textNode, lineTop, containerTop, pageHPx) {
  const doc = textNode.ownerDocument ?? document;
  const range = doc.createRange();
  const len = textNode.length;
  let splitAt = -1;
  for (let i = 0; i < len; i++) {
    range.setStart(textNode, i);
    range.setEnd(textNode, i + 1);
    const cr = range.getBoundingClientRect();
    if (cr.height <= 0.5 && cr.width <= 0.1) continue;
    if (cr.top >= lineTop - 1) {
      splitAt = i;
      break;
    }
  }
  if (splitAt < 0) return false;
  let target = textNode;
  if (splitAt > 0) target = textNode.splitText(splitAt);
  const parent = target.parentNode;
  if (!parent) return false;
  const block = doc.createElement("span");
  block.setAttribute(BREAK_ATTR, "");
  block.style.cssText = "display:block;height:1px;margin:0;padding:0;border:0;";
  parent.insertBefore(block, target);
  const rectOf = () => {
    const r2 = doc.createRange();
    r2.setStart(target, 0);
    r2.setEnd(target, Math.min(1, target.length));
    return r2.getBoundingClientRect();
  };
  const startTop = rectOf().top;
  const h = pushHeight(startTop, containerTop, pageHPx);
  if (h <= 0.5 || h >= pageHPx) {
    parent.removeChild(block);
    return false;
  }
  block.style.height = `${h}px`;
  const intendedRel = (Math.floor((startTop - containerTop) / pageHPx) + 1) * pageHPx;
  const residual = intendedRel - (rectOf().top - containerTop);
  if (Math.abs(residual) > 0.5) {
    const newH = h + residual;
    if (newH <= 0.5 || newH >= pageHPx * 1.5) {
      parent.removeChild(block);
      return false;
    }
    block.style.height = `${newH}px`;
  }
  return true;
}
function findLineBlock(node) {
  let el = node.parentElement;
  while (el) {
    const d = getComputedStyle(el).display;
    if (d === "block" || d === "list-item" || d === "table-cell" || d === "flow-root") return el;
    el = el.parentElement;
  }
  return null;
}
function fixLineAcrossBlock(block, targetTop, containerTop, pageHPx) {
  const doc = block.ownerDocument ?? document;
  const walker = doc.createTreeWalker(block, NodeFilter.SHOW_TEXT);
  const range = doc.createRange();
  let node;
  while (node = walker.nextNode()) {
    const text = node;
    for (let i = 0; i < text.length; i++) {
      range.setStart(text, i);
      range.setEnd(text, i + 1);
      const cr = range.getBoundingClientRect();
      if (cr.height <= 0.5 && cr.width <= 0.1) continue;
      if (cr.top >= targetTop - 1) return fixTextLine(text, targetTop, containerTop, pageHPx);
    }
  }
  return false;
}
function fixTextLineWithOrphansWidows(textNode, lineTop, containerTop, pageHPx) {
  const block = findLineBlock(textNode);
  if (!block) return fixTextLine(textNode, lineTop, containerTop, pageHPx);
  const cs = getComputedStyle(block);
  const orphans = parseInt(cs.orphans, 10) || 2;
  const widows = parseInt(cs.widows, 10) || 2;
  if (orphans <= 1 && widows <= 1) return fixTextLine(textNode, lineTop, containerTop, pageHPx);
  const doc = textNode.ownerDocument ?? document;
  const blockRange = doc.createRange();
  blockRange.selectNodeContents(block);
  const lineRects = Array.from(blockRange.getClientRects()).filter((r) => r.height > 0.5 && r.width > 0.1);
  if (!lineRects.length) return fixTextLine(textNode, lineTop, containerTop, pageHPx);
  const N = lineRects.length;
  const K = lineRects.findIndex((r) => Math.abs(r.top - lineTop) < 1);
  if (K < 0) return fixTextLine(textNode, lineTop, containerTop, pageHPx);
  if (K < orphans) {
    return insertSpacer(block, () => block.getBoundingClientRect(), containerTop, pageHPx);
  }
  const splitIdx = N - K < widows ? Math.max(orphans, N - widows) : K;
  if (splitIdx === K) return fixTextLine(textNode, lineTop, containerTop, pageHPx);
  return fixLineAcrossBlock(block, lineRects[splitIdx].top, containerTop, pageHPx);
}
function applyPageBreaks(root, pageHPx) {
  if (pageHPx <= 0) return;
  const mightBreak = /break-(?:before|after|inside)/.test(root.innerHTML);
  if (!mightBreak && root.scrollHeight <= pageHPx + 0.5) return;
  const skip = /* @__PURE__ */ new Set();
  for (let i = 0; i < MAX_FIXES; i++) {
    const containerTop = root.getBoundingClientRect().top;
    const violation = findViolation(root, containerTop, pageHPx, skip);
    if (!violation) return;
    violation.fix();
  }
  console.warn("[daepdf] Page-break pass hit the fix cap \u2014 layout may still contain cut content.");
}
function undoPageBreaks(root) {
  const spacers = root.querySelectorAll(`[${BREAK_ATTR}]`);
  const parents = /* @__PURE__ */ new Set();
  for (const sp of Array.from(spacers)) {
    if (sp.parentNode) parents.add(sp.parentNode);
    sp.remove();
  }
  for (const p of parents) p.normalize();
}

// src/html/chrome.ts
async function renderChromeInto(fn, page, totalPages, pageWidthPt) {
  const html = fn(page, totalPages);
  const scopeId = nextScopeId();
  const parsed = parseSafeHTML(html, scopeId);
  const styleText = Array.from(parsed.querySelectorAll("style")).map((s) => s.textContent ?? "").join("\n");
  await autoRegisterFonts(styleText);
  const container = createHiddenContainer(pageWidthPt);
  safeInjectParsed(parsed, container, scopeId);
  injectWordBreaks(container);
  return container;
}
async function measureChromeHeight(fn, pageWidthPt) {
  const container = await renderChromeInto(fn, 1, 1, pageWidthPt);
  try {
    return container.scrollHeight / PX_PER_PT;
  } finally {
    document.body.removeChild(container);
  }
}
async function captureChrome(fn, page, totalPages, pageWidthPt, bandHeightPt, fonts) {
  const container = await renderChromeInto(fn, page, totalPages, pageWidthPt);
  try {
    const ctx = {
      containerRect: container.getBoundingClientRect(),
      pageH: bandHeightPt,
      pageW: pageWidthPt,
      commands: [],
      anchors: /* @__PURE__ */ new Map(),
      fontMap: fonts,
      registeredFonts: buildRegisteredFontMap(),
      opacityStack: [],
      blendStack: [],
      counters: /* @__PURE__ */ new Map(),
      fieldCounter: { n: 0 }
    };
    const rootStyle = getComputedStyle(container);
    emitBox(container, rootStyle, ctx);
    await walkChildren(container, rootStyle, ctx);
    for (const cmd of ctx.commands) cmd.page = 1;
    return ctx.commands;
  } finally {
    document.body.removeChild(container);
  }
}

// src/html/index.ts
async function fromDOM(el, config, fonts = {}, taggedPdf = false) {
  const size = resolvePageSize(config.size, config.orientation);
  await waitForLayout();
  applyPageBreaks(el, size.height * PX_PER_PT);
  try {
    const structRoot = { tag: "Root", kids: [] };
    const ctx = {
      containerRect: el.getBoundingClientRect(),
      pageH: size.height,
      pageW: size.width,
      commands: [],
      anchors: /* @__PURE__ */ new Map(),
      fontMap: fonts,
      registeredFonts: buildRegisteredFontMap(),
      opacityStack: [],
      blendStack: [],
      counters: /* @__PURE__ */ new Map(),
      struct: taggedPdf ? { root: structRoot, stack: [structRoot], mcidCounters: /* @__PURE__ */ new Map(), artifactDepth: 0 } : void 0,
      fieldCounter: { n: 0 },
      fixedElements: []
    };
    const rootStyle = getComputedStyle(el);
    applyCounters(ctx.counters, rootStyle);
    emitBox(el, rootStyle, ctx);
    await walkChildren(el, rootStyle, ctx);
    const totalHPx = el.scrollHeight;
    const rawPages = totalHPx / (size.height * PX_PER_PT);
    const frac = rawPages - Math.floor(rawPages);
    const pageCount = Math.max(1, frac < 0.01 ? Math.floor(rawPages) : Math.ceil(rawPages));
    const commands = ctx.commands.filter((c) => c.page <= pageCount);
    for (const group of ctx.fixedElements ?? []) {
      if (!group.length) continue;
      const naturalPage = Math.min(...group.map((c) => c.page));
      if (naturalPage > pageCount) continue;
      for (let page = 1; page <= pageCount; page++) {
        for (const cmd of group) {
          if (page === naturalPage) {
            commands.push(cmd);
            continue;
          }
          const clone = { ...cmd, page };
          delete clone.mcid;
          delete clone.structTag;
          commands.push(clone);
        }
      }
    }
    if (taggedPdf) pruneStructTreePages(structRoot, pageCount);
    return { commands, pageCount, anchors: ctx.anchors, structRoot: taggedPdf ? structRoot : void 0 };
  } finally {
    undoPageBreaks(el);
  }
}
async function fromHTML(html, config, fonts = {}, chrome = {}, taggedPdf = false) {
  const scopeId = nextScopeId();
  const parsed = parseSafeHTML(html, scopeId);
  const styleText = Array.from(parsed.querySelectorAll("style")).map((s) => s.textContent ?? "").join("\n");
  await autoRegisterFonts(styleText);
  const trueSize = resolvePageSize(config.size, config.orientation);
  const headerH = chrome.header ? await measureChromeHeight(chrome.header, trueSize.width) : 0;
  const footerH = chrome.footer ? await measureChromeHeight(chrome.footer, trueSize.width) : 0;
  const contentConfig = headerH || footerH ? { size: { width: trueSize.width, height: trueSize.height - headerH - footerH } } : config;
  const contentHeight = resolvePageSize(contentConfig.size, contentConfig.orientation).height;
  const container = createHiddenContainer(trueSize.width, contentHeight);
  let capture;
  try {
    safeInjectParsed(parsed, container, scopeId);
    injectWordBreaks(container);
    const opszStyle = document.createElement("style");
    opszStyle.textContent = `[data-tpdf-scope="${scopeId}"] *{font-optical-sizing:none}`;
    container.appendChild(opszStyle);
    capture = await fromDOM(container, contentConfig, fonts, taggedPdf);
  } finally {
    document.body.removeChild(container);
  }
  if (!headerH && !footerH) return capture;
  return applyChrome(capture, chrome, trueSize, headerH, footerH, fonts);
}
async function applyChrome(capture, chrome, trueSize, headerH, footerH, fonts) {
  const pages = Array.from(new Set(capture.commands.map((c) => c.page))).sort((a, b) => a - b);
  const out = [];
  const contentH = trueSize.height - headerH - footerH;
  for (const page of pages) {
    if (headerH) out.push({ type: "transform-push", page, matrix: [1, 0, 0, 1, 0, -headerH] });
    out.push({ type: "clip-push", page, x: 0, y: 0, w: trueSize.width, h: contentH });
    for (const cmd of capture.commands) if (cmd.page === page) out.push(cmd);
    out.push({ type: "clip-pop", page });
    if (headerH) out.push({ type: "transform-pop", page });
  }
  for (let page = 1; page <= capture.pageCount; page++) {
    if (chrome.header && headerH > 0) {
      const cmds = await captureChrome(chrome.header, page, capture.pageCount, trueSize.width, headerH, fonts);
      out.push({ type: "clip-push", page, x: 0, y: 0, w: trueSize.width, h: headerH });
      for (const c of cmds) {
        c.page = page;
        out.push(c);
      }
      out.push({ type: "clip-pop", page });
    }
    if (chrome.footer && footerH > 0) {
      const cmds = await captureChrome(chrome.footer, page, capture.pageCount, trueSize.width, footerH, fonts);
      out.push({ type: "transform-push", page, matrix: [1, 0, 0, 1, 0, -(trueSize.height - footerH)] });
      out.push({ type: "clip-push", page, x: 0, y: 0, w: trueSize.width, h: footerH });
      for (const c of cmds) {
        c.page = page;
        out.push(c);
      }
      out.push({ type: "clip-pop", page });
      out.push({ type: "transform-pop", page });
    }
  }
  const anchors = /* @__PURE__ */ new Map();
  for (const [id, entry] of capture.anchors) {
    anchors.set(id, headerH ? { page: entry.page, y: entry.y + headerH } : entry);
  }
  return { commands: out, pageCount: capture.pageCount, anchors, structRoot: capture.structRoot };
}
var _injectedPreviewFonts = /* @__PURE__ */ new Set();
var _previewFontStyleEl = null;
function ensurePreviewFontStyleEl() {
  if (!_previewFontStyleEl || !_previewFontStyleEl.isConnected) {
    _previewFontStyleEl = document.createElement("style");
    _previewFontStyleEl.dataset["tpdfPreviewFonts"] = "";
    document.head.appendChild(_previewFontStyleEl);
  }
  return _previewFontStyleEl;
}
function previewHTML(html, container, config) {
  container.dataset["tpdfPreview"] = "";
  if (!container.querySelector("[data-tpdf-opsz]")) {
    const opszEl = document.createElement("style");
    opszEl.dataset["tpdfOpsz"] = "";
    opszEl.textContent = "[data-tpdf-preview] *,[data-tpdf-measure] *{font-optical-sizing:none}";
    container.appendChild(opszEl);
  }
  const size = resolvePageSize(config.size, config.orientation);
  const pageWPx = size.width * PX_PER_PT;
  const pageHPx = size.height * PX_PER_PT;
  const scopeId = nextScopeId();
  const parsed = parseSafeHTML(html, scopeId);
  for (const el of Array.from(parsed.querySelectorAll("style"))) {
    const css = el.textContent ?? "";
    const blocks = extractFontFaceBlocks(css);
    let stripped = css;
    for (const block of blocks) {
      if (!_injectedPreviewFonts.has(block)) {
        _injectedPreviewFonts.add(block);
        ensurePreviewFontStyleEl().appendChild(document.createTextNode(block + "\n"));
      }
      stripped = stripped.replace(block, "");
    }
    el.textContent = stripped;
  }
  const measure = document.createElement("div");
  measure.dataset["tpdfMeasure"] = "";
  measure.style.cssText = `position:fixed;top:-99999px;left:-99999px;width:${pageWPx}px;height:auto;visibility:hidden;transform:translateZ(0);`;
  safeInjectParsed(parsed, measure, scopeId);
  document.body.appendChild(measure);
  injectWordBreaks(measure);
  applyPageBreaks(measure, pageHPx);
  const totalHPx = measure.scrollHeight;
  const measured = Array.from(measure.childNodes).map((n) => n.cloneNode(true));
  document.body.removeChild(measure);
  const rawPages = totalHPx / pageHPx;
  const frac = rawPages - Math.floor(rawPages);
  const pageCount = Math.max(1, frac < 0.01 ? Math.floor(rawPages) : Math.ceil(rawPages));
  const frag = document.createDocumentFragment();
  for (let p = 0; p < pageCount; p++) {
    const page = document.createElement("div");
    page.style.cssText = `position:relative;width:${pageWPx}px;height:${pageHPx}px;overflow:hidden;flex-shrink:0;background:white;box-shadow:0 2px 8px rgba(0,0,0,0.15);transform:translateZ(0);`;
    if (p < pageCount - 1) page.style.marginBottom = "24px";
    const inner = document.createElement("div");
    inner.dataset["tpdfScope"] = scopeId;
    inner.style.cssText = `position:absolute;top:${-(p * pageHPx)}px;left:0;width:100%;margin:0;`;
    for (const node of measured) inner.appendChild(node.cloneNode(true));
    page.appendChild(inner);
    frag.appendChild(page);
  }
  for (const child of Array.from(container.children)) {
    if (child.tagName !== "STYLE") container.removeChild(child);
  }
  container.appendChild(frag);
}
async function renderHTMLtoPDF(html, config, options = {}, fonts = {}) {
  if (options.pdfA && options.security) {
    throw new Error("[daepdf] PDF/A does not allow encryption \u2014 pass either `pdfA` or `security`, not both.");
  }
  const taggedPdf = !!(options.taggedPdf || options.pdfA);
  const { commands, anchors, structRoot } = await fromHTML(
    html,
    config,
    fonts,
    { header: options.header, footer: options.footer },
    taggedPdf
  );
  await rasterizeSVGs(commands);
  const shim = {
    config,
    metadata: options.metadata,
    security: options.security,
    bookmarks: options.bookmarks,
    taggedPdf,
    pdfA: !!options.pdfA
  };
  return applyToPDF(commands, shim, anchors, structRoot);
}

// index.ts
var _ready = null;
function escapeHtml(s) {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}
function randomOwnerPassword() {
  return Array.from(crypto.getRandomValues(new Uint8Array(16))).map((b) => b.toString(16).padStart(2, "0")).join("");
}
function resolveSecurityOption(opt) {
  if (opt === void 0 || opt === null || typeof opt === "object") return opt;
  if (opt === "open") return null;
  const base = {
    userPassword: "",
    ownerPassword: randomOwnerPassword(),
    permissions: { print: true, copy: true, modify: false, annotate: false, fillForms: false }
  };
  if (opt === "fillable") return { ...base, permissions: { ...base.permissions, fillForms: true } };
  if (opt === "locked") return { ...base, permissions: { print: false, copy: false, modify: false, annotate: false, fillForms: false } };
  return base;
}
var pdf = {
  warmup() {
    if (!_ready) _ready = initEngine().then(() => void 0);
    return _ready;
  },
  async render(html, size = "A4", security, extras = {}) {
    return renderHTMLtoPDF(html, { size, orientation: extras.orientation }, {
      security: resolveSecurityOption(security),
      metadata: extras.metadata,
      bookmarks: extras.bookmarks,
      header: extras.header,
      footer: extras.footer,
      taggedPdf: extras.taggedPdf,
      pdfA: extras.pdfA
    });
  },
  async download(html, size = "A4", filename, security, extras = {}) {
    const bytes2 = await this.render(html, size, security, extras);
    triggerDownload(bytes2, filename);
  },
  name: safeName
};
var index_default = pdf;
export {
  index_default as default,
  escapeHtml,
  previewHTML,
  renderHTMLtoPDF
};
