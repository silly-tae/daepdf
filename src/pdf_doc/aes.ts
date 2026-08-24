// AES-128/256 (FIPS 197), encrypt-only — this codebase only ever ENCRYPTS
// (writing PDFs; a reader decrypts), including the PDF 2.0 R6 "hardened
// hash" (Algorithm 2.B), which needs an internal AES-128-CBC encrypt step.
// The S-box is derived from its GF(2^8) definition (multiplicative inverse
// + affine transform) rather than hand-transcribed, for the same reason
// the sha2.ts constants are derived: a single wrong byte in a 256-entry
// table would be effectively unfindable by inspection, only by a failing
// known-answer test — so it's generated from the algorithm's own
// definition and verified against FIPS-197 test vectors instead.

function gmul(a: number, b: number): number {
  let p = 0
  for (let i = 0; i < 8; i++) {
    if (b & 1) p ^= a
    const hi = a & 0x80
    a = (a << 1) & 0xff
    if (hi) a ^= 0x1b
    b >>= 1
  }
  return p
}

function gf256Inverse(a: number): number {
  if (a === 0) return 0
  for (let x = 1; x < 256; x++) if (gmul(a, x) === 1) return x
  return 0
}

function affineTransform(b: number): number {
  let out = 0
  for (let i = 0; i < 8; i++) {
    const bit = ((b >> i) & 1) ^ ((b >> ((i+4)%8)) & 1) ^ ((b >> ((i+5)%8)) & 1)
              ^ ((b >> ((i+6)%8)) & 1) ^ ((b >> ((i+7)%8)) & 1) ^ ((0x63 >> i) & 1)
    out |= bit << i
  }
  return out
}

const SBOX = new Uint8Array(256)
for (let i = 0; i < 256; i++) SBOX[i] = affineTransform(gf256Inverse(i))

// Rcon[i] = 2^(i-1) in GF(2^8), 1-indexed; AES-256's 14-round key schedule
// needs up to Rcon[7]
const RCON = new Uint8Array(15)
{
  let r = 1
  for (let i = 1; i <= 14; i++) { RCON[i] = r; r = gmul(r, 2) }
}

const sbox = (b: number): number => SBOX[b & 0xff]!

function subWord(w: number): number {
  return (sbox(w >>> 24) << 24) | (sbox(w >>> 16) << 16)
       | (sbox(w >>> 8) << 8) | sbox(w)
}

function rotWord(w: number): number {
  return ((w << 8) | (w >>> 24)) >>> 0
}

// Nk = key length in 32-bit words (4 for AES-128, 8 for AES-256); Nr =
// number of rounds (10 / 14). Returns Nb*(Nr+1) = 4*(Nr+1) round-key words.
function keyExpansion(key: Uint8Array, nk: number, nr: number): Uint32Array {
  const nb = 4
  const w = new Uint32Array(nb * (nr + 1))
  const view = new DataView(key.buffer, key.byteOffset, key.byteLength)
  for (let i = 0; i < nk; i++) w[i] = view.getUint32(i * 4, false)
  for (let i = nk; i < w.length; i++) {
    let temp = w[i - 1]!
    if (i % nk === 0) {
      temp = (subWord(rotWord(temp)) ^ (RCON[i / nk]! << 24)) >>> 0
    } else if (nk > 6 && i % nk === 4) {
      temp = subWord(temp)
    }
    w[i] = (w[i - nk]! ^ temp) >>> 0
  }
  return w
}

function addRoundKey(state: Uint8Array, w: Uint32Array, round: number): void {
  for (let c = 0; c < 4; c++) {
    const word = w[round * 4 + c]!
    const i = c * 4
    state[i]     = state[i]!     ^ ((word >>> 24) & 0xff)
    state[i + 1] = state[i + 1]! ^ ((word >>> 16) & 0xff)
    state[i + 2] = state[i + 2]! ^ ((word >>> 8) & 0xff)
    state[i + 3] = state[i + 3]! ^ (word & 0xff)
  }
}

function subBytes(state: Uint8Array): void {
  for (let i = 0; i < 16; i++) state[i] = sbox(state[i]!)
}

// state is column-major (state[c*4+r]); ShiftRows moves row r left by r
function shiftRows(state: Uint8Array): void {
  const s = state.slice()
  for (let r = 1; r < 4; r++) {
    for (let c = 0; c < 4; c++) {
      state[c * 4 + r] = s[((c + r) % 4) * 4 + r]!
    }
  }
}

function mixColumns(state: Uint8Array): void {
  for (let c = 0; c < 4; c++) {
    const i = c * 4
    const a0 = state[i]!, a1 = state[i+1]!, a2 = state[i+2]!, a3 = state[i+3]!
    state[i]   = gmul(a0,2) ^ gmul(a1,3) ^ a2 ^ a3
    state[i+1] = a0 ^ gmul(a1,2) ^ gmul(a2,3) ^ a3
    state[i+2] = a0 ^ a1 ^ gmul(a2,2) ^ gmul(a3,3)
    state[i+3] = gmul(a0,3) ^ a1 ^ a2 ^ gmul(a3,2)
  }
}

// keyExpansion is expensive (SBOX lookups + XORs across up to 60 words for
// AES-256) and depends only on the key — every call site in this file
// re-encrypts many blocks under the SAME key (aesCbcEncrypt's per-block
// loop, or repeated single-block calls with the same document key), so the
// schedule is cached by key identity rather than recomputed per block.
let cachedKey: Uint8Array | null = null
let cachedSchedule: Uint32Array | null = null
let cachedNr = 0

function scheduleFor(key: Uint8Array): { w: Uint32Array; nr: number } {
  if (cachedKey !== key) {
    const nk = key.length / 4
    cachedNr = nk + 6
    cachedSchedule = keyExpansion(key, nk, cachedNr)
    cachedKey = key
  }
  return { w: cachedSchedule!, nr: cachedNr }
}

// key must be 16 (AES-128) or 32 (AES-256) bytes; block is exactly 16 bytes,
// modified in place
function encryptBlock(block: Uint8Array, key: Uint8Array): void {
  const { w, nr } = scheduleFor(key)

  // FIPS-197's state[r][c] = in[r + 4c] maps to this file's state[c*4+r]
  // convention with the SAME index arithmetic (c*4+r === r+4c) — the input
  // bytes are already in this layout, so no reordering is needed here
  const state = block.slice()

  addRoundKey(state, w, 0)
  for (let round = 1; round < nr; round++) {
    subBytes(state); shiftRows(state); mixColumns(state); addRoundKey(state, w, round)
  }
  subBytes(state); shiftRows(state); addRoundKey(state, w, nr)

  block.set(state)
}

function xorInto(a: Uint8Array, b: Uint8Array): void {
  for (let i = 0; i < a.length; i++) a[i] = a[i]! ^ b[i]!
}

// PKCS#7 padding (PDF spec Algorithm 8) — always adds a full block of
// padding when data is already block-aligned, per spec (not an optimization
// to skip it in that case)
function pkcs7Pad(data: Uint8Array): Uint8Array {
  const padLen = 16 - (data.length % 16)
  const out = new Uint8Array(data.length + padLen)
  out.set(data)
  out.fill(padLen, data.length)
  return out
}

export function aesCbcEncrypt(key: Uint8Array, iv: Uint8Array, data: Uint8Array, pad: boolean): Uint8Array {
  const input = pad ? pkcs7Pad(data) : data
  const out = new Uint8Array(input.length)
  let prev = iv.slice()
  for (let off = 0; off < input.length; off += 16) {
    const block = input.slice(off, off + 16)
    xorInto(block, prev)
    encryptBlock(block, key)
    out.set(block, off)
    prev = block
  }
  return out
}

// ECB, single block, no padding — only used for the PDF R6 /Perms field
// (Algorithm 3.A), which is exactly one 16-byte block by spec
export function aesEcbEncryptBlock(key: Uint8Array, block: Uint8Array): Uint8Array {
  const out = block.slice()
  encryptBlock(out, key)
  return out
}
