import { Worker } from 'node:worker_threads'

// romanNumeral/alphaLabel loop while subtracting, so a non-finite counter never
// terminates. Running it in a worker keeps a hang from taking the suite with it.
function callWithTimeout(fn, arg, ms = 2000) {
  const src = `
    import { parentPort, workerData } from 'node:worker_threads'
    import { load } from '${JSON.parse(JSON.stringify(new URL('./load.mjs', import.meta.url).pathname))}'
    const c = await load('src/html/counters.ts')
    parentPort.postMessage(String(c[workerData.fn](workerData.arg)))
  `
  return new Promise(resolve => {
    const w = new Worker(src, { eval: true, workerData: { fn, arg } })
    const t = setTimeout(() => { w.terminate(); resolve({ hung: true }) }, ms)
    w.on('message', v => { clearTimeout(t); w.terminate(); resolve({ value: v }) })
    w.on('error', e => { clearTimeout(t); resolve({ error: e.message }) })
  })
}

export default async function ({ test, eq, ok, load }) {
  const c = await load('src/html/counters.ts')

  test('roman numerals are correct for the normal range', () => {
    eq(c.romanNumeral(1), 'I'); eq(c.romanNumeral(4), 'IV'); eq(c.romanNumeral(9), 'IX')
    eq(c.romanNumeral(14), 'XIV'); eq(c.romanNumeral(40), 'XL'); eq(c.romanNumeral(1990), 'MCMXC')
    eq(c.romanNumeral(3999), 'MMMCMXCIX')
  })

  test('alpha labels wrap past z', () => {
    eq(c.alphaLabel(1), 'a'); eq(c.alphaLabel(26), 'z')
    eq(c.alphaLabel(27), 'aa'); eq(c.alphaLabel(52), 'az'); eq(c.alphaLabel(53), 'ba')
  })

  test('counterText dispatches the list styles', () => {
    eq(c.counterText(3, 'upper-roman'), 'III')
    eq(c.counterText(3, 'lower-roman'), 'iii')
    eq(c.counterText(3, 'upper-alpha'), 'C')
    eq(c.counterText(3, 'decimal-leading-zero'), '03')
    eq(c.counterText(12, 'decimal-leading-zero'), '12')
    eq(c.counterText(3), '3')
  })

  test('a counter value CSS can actually produce', () => {
    // parseCounterList accepts any all-digit token and parseInt's it
    ok(!Number.isFinite(parseInt('9'.repeat(400), 10)), 'a 400-digit counter parses to Infinity')
  })

  const roman = await callWithTimeout('romanNumeral', Infinity)
  test('romanNumeral terminates on a non-finite counter', () =>
    ok(!roman.hung, 'romanNumeral(Infinity) never returns — the render hangs'))

  const alpha = await callWithTimeout('alphaLabel', Infinity)
  test('alphaLabel terminates on a non-finite counter', () =>
    ok(!alpha.hung, 'alphaLabel(Infinity) never returns — the render hangs'))
}
