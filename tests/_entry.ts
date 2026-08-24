// One bundle so PdfDoc and the engine share a single daepl module instance;
// loading them separately gives each its own uninitialised copy.
export { PdfDoc } from '../src/pdf_doc/index.js'
export { default as initEngine } from '../src/daepl/wasm/daepl.js'
export * from '../src/daepl/wasm/daepl.js'
