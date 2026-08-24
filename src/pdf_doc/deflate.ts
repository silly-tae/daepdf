import { zlib } from '../daefl/index.js'

// level 6 measured smaller than the previous implementation at the same level
// on real PDF, font and image data, so the switch did not grow any output.
// Deterministic, which the output-determinism tests depend on.
export const deflate = (bytes: Uint8Array): Uint8Array => zlib(bytes, 6)
