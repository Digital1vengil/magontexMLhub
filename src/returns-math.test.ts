import { describe, it, expect } from 'vitest'
import { returnsModelStats } from './returns-math'

// Esperados calculados A MANO desde el ledger (métricas 7 y 8) — NO de la salida del código.
// La resolución modelo↔SKU desde la VENTA está cubierta por sku-resolver.test.ts (no se duplica acá).

describe('returnsModelStats — tasa (métrica 7) + costo esperado de devolución/unidad (métrica 8)', () => {
  it('tasa = devoluciones ÷ ventas (ventana alineada)', () => {
    // 5 devoluciones sobre 100 ventas del MISMO período → 5%.
    const st = returnsModelStats([12100, 12100, 12100, 12100, 12100], 100)
    expect(st.returns).toBe(5)
    expect(st.rate).toBeCloseTo(0.05, 6)
    expect(st.fleteAvg).toBeCloseTo(12100, 6)
    expect(st.devUnit).toBeCloseTo(605, 6)          // 0.05 × 12100 (BRUTO; el ÷1.21 lo hace mstMargin)
  })

  it('sin ventas en la ventana → tasa null y devUnit 0 (no estimamos)', () => {
    const st = returnsModelStats([12100, 12100], 0)
    expect(st.rate).toBeNull()
    expect(st.devUnit).toBe(0)
  })

  // Métrica 8 — el promedio del flete sale SOLO de las costeadas (ret_cost != null), aplicado a TODAS.
  it('flete promedio SOLO de las costeadas, aplicado a todas las devoluciones', () => {
    // 4 devoluciones, 2 costeadas (10000 y 14000) → promedio 12000; se aplica a las 4.
    // tasa = 4/100 = 0.04; devUnit = 0.04 × 12000 = 480.
    const st = returnsModelStats([10000, 14000, null, null], 100)
    expect(st.returns).toBe(4)
    expect(st.fleteAvg).toBeCloseTo(12000, 6)       // (10000+14000)/2, NO ÷4
    expect(st.rate).toBeCloseTo(0.04, 6)
    expect(st.devUnit).toBeCloseTo(480, 6)          // 0.04 × 12000
    expect(st.cov).toEqual({ cnt: 2, all: 4 })      // 2 costeadas de 4 totales
  })

  it('ret_cost: NULL ≠ 0 ≠ >0 — el 0 (cerrado sin flete) SÍ entra al promedio y lo baja', () => {
    // 3 costeadas: 0, 6000, 6000 → promedio 4000 (el 0 cuenta). NULL no entra.
    const st = returnsModelStats([0, 6000, 6000, null], 200)
    expect(st.cov).toEqual({ cnt: 3, all: 4 })      // el 0 cuenta como costeada; el null no
    expect(st.fleteAvg).toBeCloseTo(4000, 6)        // (0+6000+6000)/3
    expect(st.devUnit).toBeCloseTo(0.02 * 4000, 6)  // tasa 4/200=0.02 × 4000 = 80
  })

  it('devoluciones pero NINGUNA costeada todavía → fleteAvg 0, devUnit 0 (arranca conservador)', () => {
    const st = returnsModelStats([null, null, null], 50)
    expect(st.fleteAvg).toBe(0)
    expect(st.rate).toBeCloseTo(0.06, 6)            // la tasa SÍ se conoce (3/50)
    expect(st.devUnit).toBe(0)                       // sin flete real todavía → 0, no un número inventado
  })

  it('DOCUMENTA por qué la ventana debe alinearse: sin alinear, la tasa puede pasar 100% (lag)', () => {
    // Si num (devoluciones de hoy, de ventas de semanas atrás) y den (ventas de la ventana) no se alinean,
    // devoluciones > ventas → tasa >1. La función NO clampea: la honestidad viene de alinear las ventanas.
    const st = returnsModelStats([1, 1, 1], 2)       // 3 devol. sobre 2 ventas (ventanas desalineadas)
    expect(st.rate).toBeGreaterThan(1)               // 1.5 — señal de que las ventanas NO están alineadas
  })
})
