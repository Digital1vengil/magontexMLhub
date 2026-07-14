import { describe, it, expect } from 'vitest'
import { fractionInRange, pctWithin100, marginWithinNet, nonNegative, isSafeNumber, sharesSumTo } from './invariants'
import { conversionRate, daysOfStock } from './inventory-math'
import { mstMarginCalc } from './mst-math'
import { share, othersShare } from './geo-math'

// Predicados de las invariantes runtime del ledger (§final). null siempre pasa (ausencia de dato = válida).
describe('invariantes — predicados puros', () => {
  it('fractionInRange: conversión ∈ [0,1]', () => {
    expect(fractionInRange(0)).toBe(true)
    expect(fractionInRange(1)).toBe(true)
    expect(fractionInRange(0.5)).toBe(true)
    expect(fractionInRange(null)).toBe(true)
    expect(fractionInRange(1.5)).toBe(false)
    expect(fractionInRange(-0.1)).toBe(false)
  })
  it('pctWithin100: margenPct ≤ 100 (pérdida negativa permitida)', () => {
    expect(pctWithin100(50)).toBe(true)
    expect(pctWithin100(100)).toBe(true)
    expect(pctWithin100(-30)).toBe(true)
    expect(pctWithin100(100.1)).toBe(false)
  })
  it('marginWithinNet: no ganás más que el precio neto', () => {
    expect(marginWithinNet(10, 100)).toBe(true)
    expect(marginWithinNet(100, 100)).toBe(true)
    expect(marginWithinNet(150, 100)).toBe(false)
    expect(marginWithinNet(null, 100)).toBe(true)
  })
  it('nonNegative: cobertura / días de inventario ≥ 0', () => {
    expect(nonNegative(0)).toBe(true)
    expect(nonNegative(45)).toBe(true)
    expect(nonNegative(-1)).toBe(false)
    expect(nonNegative(null)).toBe(true)
  })
  it('isSafeNumber: sin NaN/Infinity en pantalla', () => {
    expect(isSafeNumber(5)).toBe(true)
    expect(isSafeNumber(null)).toBe(true)
    expect(isSafeNumber(NaN)).toBe(false)
    expect(isSafeNumber(Infinity)).toBe(false)
  })
  it('sharesSumTo: un desglose suma ~100% (tolerancia por floats)', () => {
    expect(sharesSumTo([30, 30, 40])).toBe(true)
    expect(sharesSumTo([33.33, 33.33, 33.34])).toBe(true)
    expect(sharesSumTo([30, 30, 50])).toBe(false)
  })
})

// Las fórmulas del ledger RESPETAN sus invariantes (atan invariants.ts a las métricas reales).
describe('las fórmulas del ledger respetan sus invariantes', () => {
  it('conversionRate cae en [0,1] o null', () => {
    for (const [s, v] of [[5, 100], [0, 100], [120, 100], [50, 50]] as [number, number][])
      expect(fractionInRange(conversionRate(s, v, true))).toBe(true)
  })
  it('mstMarginCalc: margen ≤ neto, margenPct ≤ 100, sin Infinity', () => {
    const r = mstMarginCalc({
      precioReal: 100000, landedUSD: 20, dolar: 1200, comisUnit: 21780, envBruto: 9680,
      adsCost: 36300, adsQty: 0, iibb: 0.05, impdc: 0.012, tasaDev: 0.05, fleteVueltaProm: 12100,
    })!
    expect(marginWithinNet(r.margen, r.neto)).toBe(true)
    expect(pctWithin100(r.margenPct)).toBe(true)
    expect(isSafeNumber(r.margen)).toBe(true)          // qty 0 no metió Infinity
  })
  it('daysOfStock nunca negativo', () => {
    expect(nonNegative(daysOfStock(45, 30, 30))).toBe(true)
    expect(nonNegative(daysOfStock(0, 30, 30))).toBe(true)   // null → pasa
  })
  it('un stack geo (top + Otras) suma ~100', () => {
    const total = 250
    expect(sharesSumTo([share(60, total), share(60, total), share(60, total), othersShare(total, 180)])).toBe(true)
  })
})
