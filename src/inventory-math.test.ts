import { describe, it, expect } from 'vitest'
import { stockMode, daysOfStock, conversionRate, shipAvg } from './inventory-math'

// Esperados calculados A MANO desde el ledger (métricas 4, 5, 6) — NO de la salida del código. Si un
// test rompe, cambió la matemática de una señal del Radar/Promos → revisar contra el ledger y reportar.

describe('stockMode — MODA del stock compartido entre publicaciones activas (métrica 4)', () => {
  it('una sola publicación → su stock', () => {
    expect(stockMode([7])).toBe(7)
  })
  it('MODA = el valor que más se repite (no la suma ni el promedio)', () => {
    expect(stockMode([5, 5, 3])).toBe(5)
    expect(stockMode([2, 9, 9, 9, 4])).toBe(9)
  })
  it('empate de frecuencia → gana el MAYOR (criterio del banner de Promos)', () => {
    expect(stockMode([3, 3, 5, 5])).toBe(5)
    expect(stockMode([2, 2, 8, 8])).toBe(8)
  })
  it('array vacío → 0', () => {
    expect(stockMode([])).toBe(0)
  })
})

describe('daysOfStock — cobertura / días de inventario = stock ÷ velocidad diaria (métricas 4 y 6)', () => {
  it('Radar (ventana 30d): stock ÷ (qty/30)', () => {
    expect(daysOfStock(45, 30, 30)).toBe(45)     // 45 ÷ (30/30=1) = 45 días
    expect(daysOfStock(100, 50, 30)).toBe(60)    // 100 ÷ (50/30=1.6667) = 60
  })
  it('Promos (ventana 14d): stock ÷ (sales2w/14)', () => {
    expect(daysOfStock(28, 14, 14)).toBe(28)     // 28 ÷ (14/14=1) = 28 días
    expect(daysOfStock(30, 15, 14)).toBe(28)     // 30 ÷ (15/14=1.0714) = 28
  })
  it('redondea al día entero', () => {
    expect(daysOfStock(10, 7, 30)).toBe(43)      // 10 ÷ (7/30=0.2333) = 42.857 → 43
  })
  it('stock ≤ 0 o null → null (sin stock no hay cobertura)', () => {
    expect(daysOfStock(0, 30, 30)).toBeNull()
    expect(daysOfStock(-5, 30, 30)).toBeNull()
    expect(daysOfStock(null, 30, 30)).toBeNull()
  })
  it('velocidad ≤ 0 o null → null (sin velocidad no hay cobertura, jamás /0 = Infinity)', () => {
    expect(daysOfStock(100, 0, 30)).toBeNull()
    expect(daysOfStock(100, null, 30)).toBeNull()
  })
})

describe('conversionRate — ventas ÷ visitas, gate de frescura + clamp [0,1] (métrica 5)', () => {
  it('caso normal: fracción 0..1', () => {
    expect(conversionRate(5, 100, true)).toBeCloseTo(0.05, 6)
    expect(conversionRate(3, 12, true)).toBeCloseTo(0.25, 6)
  })
  it('exactamente 1 (100%) es válido (r ≤ 1)', () => {
    expect(conversionRate(100, 100, true)).toBe(1)
  })
  it('ventas 0 → 0 (hay visitas, no vendió), NO null', () => {
    expect(conversionRate(0, 100, true)).toBe(0)
  })
  it('INVARIANTE >100% imposible → null (el bug 6-jul: ventas viejas ÷ visitas frescas = 104%)', () => {
    expect(conversionRate(120, 100, true)).toBeNull()
    expect(conversionRate(104, 100, true)).toBeNull()
  })
  it('ventas NO frescas → null (mudo, no un número inventado)', () => {
    expect(conversionRate(5, 100, false)).toBeNull()
  })
  it('visitas 0 o null → null (sin visitas no se juzga, jamás /0)', () => {
    expect(conversionRate(5, 0, true)).toBeNull()
    expect(conversionRate(5, null, true)).toBeNull()
    expect(conversionRate(5, undefined, true)).toBeNull()
  })
})

describe('shipAvg — flete de IDA promedio = Σcost ÷ Σpagos (métrica 9, mitad front)', () => {
  it('promedio ponderado sobre los envíos pagos', () => {
    expect(shipAvg(30000, 3)).toBeCloseTo(10000, 6)   // los gratis ya no entran (npaid solo pagos)
  })
  it('sin envíos pagos todavía → null (backfill en curso → cae a la muestra de mlcosts)', () => {
    expect(shipAvg(0, 0)).toBeNull()
  })
})
