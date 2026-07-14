import { describe, it, expect } from 'vitest'
import { mstMarginCalc, IVA } from './mst-math'
import { margenRealRow } from './promo-math'

// Los esperados salen del LEDGER (métrica 1), calculados A MANO — NUNCA de correr el código y copiar su
// salida (eso cementaría bugs). Si un test rompe, la matemática del margen del MAESTRO cambió: revisar
// contra _context/formulas-ledger.md métrica 1 y reportar a Martin (código diverge del ledger = posible
// bug de plata o ledger desactualizado). NO acomodar el test en silencio.

// Ejemplo dorado (spec H1.2): precioReal 100000 · landed 20 USD × dólar 1200 · comisUnit 21780 ·
// envBruto 9680 · ads cost 36300 en 10 uds · iibb 5% · impdc 1.2% · tasaDev 5% · fleteVuelta 12100.
const GOLDEN = {
  precioReal: 100000, landedUSD: 20, dolar: 1200, comisUnit: 21780, envBruto: 9680,
  adsCost: 36300, adsQty: 10, iibb: 0.05, impdc: 0.012, tasaDev: 0.05, fleteVueltaProm: 12100,
}

describe('mstMarginCalc — margen real del MAESTRO (métrica 1, LA COMPLETA)', () => {
  it('IVA es 1.21 (si cambia, cambia TODO el margen — fijado a propósito acá)', () => {
    expect(IVA).toBe(1.21)
  })

  it('ejemplo dorado: cada componente cuadra con el ledger, calculado a mano', () => {
    const r = mstMarginCalc(GOLDEN)!
    expect(r.neto).toBeCloseTo(82644.6281, 2)      // 100000 / 1.21
    expect(r.landedARS).toBeCloseTo(24000, 2)      // 20 × 1200, SIN ÷1.21 (costo FOB)
    expect(r.comisNet).toBeCloseTo(18000, 2)       // 21780 / 1.21
    expect(r.envNet).toBeCloseTo(8000, 2)          // 9680 / 1.21
    expect(r.adsNet).toBeCloseTo(3000, 2)          // (36300/10) / 1.21
    expect(r.iibbC).toBeCloseTo(4132.2314, 2)      // neto × 0.05 (sobre el NETO)
    expect(r.impdcC).toBeCloseTo(1200, 2)          // 100000 × 0.012 (sobre el BRUTO)
    expect(r.devNet).toBeCloseTo(500, 2)           // (0.05 × 12100) / 1.21
    expect(r.costoReal).toBeCloseTo(58832.2314, 2) // suma de los 7 costos
    expect(r.margen).toBeCloseTo(23812.3967, 2)    // neto − costoReal
    expect(r.margenPct).toBeCloseTo(28.81, 2)      // margen / neto × 100
  })

  // H1.3 — casos null del ledger: sin precio de venta o sin landed → null (nunca un número equivocado).
  it('sin precioReal → null', () => {
    expect(mstMarginCalc({ ...GOLDEN, precioReal: null })).toBeNull()
    expect(mstMarginCalc({ ...GOLDEN, precioReal: 0 })).toBeNull()
    expect(mstMarginCalc({ ...GOLDEN, precioReal: undefined })).toBeNull()
  })
  it('sin landed → null (landed 0 es válido, null no)', () => {
    expect(mstMarginCalc({ ...GOLDEN, landedUSD: null })).toBeNull()
    expect(mstMarginCalc({ ...GOLDEN, landedUSD: undefined })).toBeNull()
    expect(mstMarginCalc({ ...GOLDEN, landedUSD: 0 })!.landedARS).toBe(0)  // 0 pasa
  })

  // H1.4 — trato de IVA (lo que más plata cuesta si regresiona).
  it('el landed NO se netea: landedARS = landedUSD × dólar, sin ÷1.21', () => {
    const r = mstMarginCalc({ ...GOLDEN, landedUSD: 10, dolar: 1000 })!
    expect(r.landedARS).toBe(10000)                // 10 × 1000, exacto (no 10000/1.21)
  })
  it('iibb sobre el NETO, impdc sobre el BRUTO (bases distintas, no confundir)', () => {
    // precio 121000 → neto 100000. iibb 5% del neto = 5000; impdc 1.2% del bruto = 1452.
    const r = mstMarginCalc({ ...GOLDEN, precioReal: 121000 })!
    expect(r.neto).toBeCloseTo(100000, 6)
    expect(r.iibbC).toBeCloseTo(5000, 6)           // 100000 × 0.05 (NETO)
    expect(r.impdcC).toBeCloseTo(1452, 6)          // 121000 × 0.012 (BRUTO)
  })
  it('devNet y envNet SÍ se netean ÷1.21', () => {
    const r = mstMarginCalc({ ...GOLDEN, envBruto: 12100, fleteVueltaProm: 12100, tasaDev: 1 })!
    expect(r.envNet).toBeCloseTo(10000, 6)         // 12100 / 1.21
    expect(r.devNet).toBeCloseTo(10000, 6)         // (1 × 12100) / 1.21
  })
  it('sin ads → ads 0, no null; el margen se calcula igual', () => {
    const r = mstMarginCalc({ ...GOLDEN, adsCost: null })!
    expect(r.adsUnit).toBe(0)
    expect(r.adsNet).toBe(0)
    expect(r.margen).not.toBeNull()
  })
  it('sin devolución (tasaDev null/undefined) → devUnit 0', () => {
    expect(mstMarginCalc({ ...GOLDEN, tasaDev: null })!.devUnit).toBe(0)
    expect(mstMarginCalc({ ...GOLDEN, tasaDev: undefined })!.devUnit).toBe(0)
  })

  // H1.5 — invariantes del ledger (§final): margen ≤ neto; margenPct ≤ 100; sin NaN/Infinity con denom 0.
  it('invariante: margen ≤ neto (no podés ganar más que el precio neto)', () => {
    const r = mstMarginCalc(GOLDEN)!
    expect(r.margen).toBeLessThanOrEqual(r.neto)
  })
  it('invariante: margenPct ≤ 100', () => {
    const r = mstMarginCalc(GOLDEN)!
    expect(r.margenPct!).toBeLessThanOrEqual(100)
  })
  it('invariante: qty 0 con ads presentes → adsUnit 0, jamás Infinity', () => {
    const r = mstMarginCalc({ ...GOLDEN, adsCost: 36300, adsQty: 0 })!
    expect(r.adsUnit).toBe(0)
    expect(Number.isFinite(r.margen)).toBe(true)
    expect(Number.isFinite(r.costoReal)).toBe(true)
  })

  // H1.6 — FORK intencional (ledger §1 vs §2): mismos insumos base, mstMargin lleva IIBB + imp.déb/créd +
  // devolución y margenRealRow (Promos) NO. Protege el pedido explícito de Martin (esos 3 viven SOLO en el
  // MAESTRO). landedUSD × dolar=1 → landedARS 40000 = el `landed` (ya-ARS) que toma margenRealRow.
  it('el margen del MAESTRO es MÁS BAJO que el de Promos por exactamente iibb + impdc + dev', () => {
    const cost = { precioReal: 121000, comisUnit: 12100, comisionPct: 10, envio: 6050, envN: 3, qty: 10 }
    const promos = margenRealRow(cost, 40000, { cost: 60500, acos: 5, roas: 8 })
    const maestro = mstMarginCalc({
      precioReal: 121000, landedUSD: 40000, dolar: 1, comisUnit: 12100, envBruto: 6050,
      adsCost: 60500, adsQty: 10, iibb: 0.05, impdc: 0.012, tasaDev: 0.05, fleteVueltaProm: 12100,
    })!
    expect(promos.margen).toBeCloseTo(40000, 6)    // Promos: 100000 − 40000 − 10000 − 5000 − 5000
    expect(maestro.margen).toBeCloseTo(33048, 6)   // Maestro: lo mismo − iibb 5000 − impdc 1452 − dev 500
    // la diferencia es EXACTAMENTE los 3 costos que solo lleva el MAESTRO
    expect(promos.margen! - maestro.margen).toBeCloseTo(maestro.iibbC + maestro.impdcC + maestro.devNet, 6)
  })
})
