import { sha256, sha384, sha512 } from './sha2.js'
import { aesCbcEncrypt, aesEcbEncryptBlock } from './aes.js'

const _te = new TextEncoder()

function concatBytes(...parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((n, p) => n + p.length, 0)
  const out = new Uint8Array(total)
  let off = 0
  for (const p of parts) { out.set(p, off); off += p.length }
  return out
}

// Password preprocessing is simplified to plain UTF-8 + a 127-byte cap,
// skipping full SASLprep (RFC 4013) normalization — the spec's own
// recommendation for the general case, but overkill for this project's
// actual inputs (typically an empty user password and an auto-generated
// hex owner password, both already ASCII).
function preparePassword(pw: string): Uint8Array {
  const b = _te.encode(pw)
  return b.length > 127 ? b.slice(0, 127) : b
}

function randomBytes(n: number): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(n))
}

// ISO 32000-2 Algorithm 2.B — the revision-6 "hardened hash". Genuinely
// needs SHA-256 AND SHA-384 AND SHA-512 (not just SHA-256): the loop
// re-hashes its own AES output with whichever of the three a running
// digest byte selects, at least 64 times, until a data-dependent stop
// condition. `extra` is the 48-byte U string for owner-password hashing,
// or empty for a user password (per spec, step (a)).
function hardenedHash(password: Uint8Array, salt: Uint8Array, extra: Uint8Array): Uint8Array {
  let k: Uint8Array = sha256(concatBytes(password, salt, extra))

  let round = 0
  for (;;) {
    const k1Unit = concatBytes(password, k, extra)
    const k1 = new Uint8Array(k1Unit.length * 64)
    for (let i = 0; i < 64; i++) k1.set(k1Unit, i * k1Unit.length)

    const aesKey = k.slice(0, 16)
    const iv     = k.slice(16, 32)
    const e = aesCbcEncrypt(aesKey, iv, k1, false)

    let sum = 0
    for (let i = 0; i < 16; i++) sum += e[i]!
    const mod3 = sum % 3
    k = mod3 === 0 ? sha256(e) : mod3 === 1 ? sha384(e) : sha512(e)

    round++
    if (round >= 64 && e[e.length - 1]! <= round - 32) break
  }
  return k.slice(0, 32)
}

export interface R6Security {
  fileKey:     Uint8Array // 32 bytes — the actual AES-256 content-encryption key
  o:           Uint8Array // 48 bytes
  u:           Uint8Array // 48 bytes
  oe:          Uint8Array // 32 bytes
  ue:          Uint8Array // 32 bytes
  perms:       Uint8Array // 16 bytes
  permissions: number
}

// ISO 32000-2 Algorithm 2.A (compute U/UE, O/OE and the file key) + the
// /Perms field (Algorithm 3.A / Table 23's own description). Unlike the R3
// handler this replaces, V5 encrypts every object with the SAME file key
// directly (no per-object MD5 derivation) — the file key only needs
// wrapping (UE/OE) so a correct password can recover it.
export function computeR6Security(userPw: string, ownerPw: string, permissions: number): R6Security {
  const userPassword  = preparePassword(userPw)
  const ownerPassword = preparePassword(ownerPw)
  const fileKey = randomBytes(32)

  const uValidationSalt = randomBytes(8)
  const uKeySalt        = randomBytes(8)
  const uHash = hardenedHash(userPassword, uValidationSalt, new Uint8Array(0))
  const u = concatBytes(uHash, uValidationSalt, uKeySalt)

  const uIntermediateKey = hardenedHash(userPassword, uKeySalt, new Uint8Array(0))
  const ue = aesCbcEncrypt(uIntermediateKey, new Uint8Array(16), fileKey, false)

  const oValidationSalt = randomBytes(8)
  const oKeySalt        = randomBytes(8)
  const oHash = hardenedHash(ownerPassword, oValidationSalt, u)
  const o = concatBytes(oHash, oValidationSalt, oKeySalt)

  const oIntermediateKey = hardenedHash(ownerPassword, oKeySalt, u)
  const oe = aesCbcEncrypt(oIntermediateKey, new Uint8Array(16), fileKey, false)

  // Algorithm 3.A: P (low-order 4 bytes, little-endian) + 0xFFFFFFFF +
  // 'T' (EncryptMetadata always true here, matching the previous R3
  // handler's behavior of encrypting the whole document) + "adb" (literal,
  // per spec) + 4 random bytes, AES-256-ECB-no-pad encrypted with the file key
  const permsBlock = new Uint8Array(16)
  new DataView(permsBlock.buffer).setUint32(0, permissions >>> 0, true)
  permsBlock[4] = 0xFF; permsBlock[5] = 0xFF; permsBlock[6] = 0xFF; permsBlock[7] = 0xFF
  permsBlock[8] = 0x54 // 'T'
  permsBlock[9] = 0x61; permsBlock[10] = 0x64; permsBlock[11] = 0x62 // "adb"
  permsBlock.set(randomBytes(4), 12)
  const perms = aesEcbEncryptBlock(fileKey, permsBlock)

  return { fileKey, o, u, oe, ue, perms, permissions }
}
