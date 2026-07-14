// ParkaHub — aritmética PURA de devoluciones por modelo: tasa (métrica 7) + costo esperado/unidad
// (métrica 8, que alimenta el margen del MAESTRO). Extraída TAL CUAL de maestroEnsureReturns
// (publicaciones.ts), sin cambio de lógica → NO cambia runtime.
// Fuente de verdad: _context/formulas-ledger.md métricas 7 y 8.
//
// El MODELO de cada devolución se resuelve SIEMPRE desde la VENTA (seller_sku de la orden), nunca de la
// publicación viva (regla dura; cubierto por sku-resolver.test.ts — no se duplica acá).

export interface ReturnsModelStats {
  returns: number                 // total de devoluciones del modelo en la ventana
  rate: number | null             // tasa = devoluciones ÷ ventas (métrica 7); null si no hubo ventas
  fleteAvg: number                // flete de vuelta promedio real, SOLO de las costeadas
  devUnit: number                 // costo esperado de devolución/unidad = tasa × fleteAvg (métrica 8, BRUTO)
  cov: { cnt: number; all: number } // cobertura del backfill: costeadas (cnt) sobre el total (all)
}

// `retCosts` = el `ret_cost` de CADA devolución del modelo. Semántica del ledger (crítica):
//   NULL/undefined = sin chequear todavía → NO entra al promedio.
//   0              = claim cerrado sin flete → SÍ entra (suma 0, baja el promedio).
//   > 0            = flete real (receiver.cost).
// El promedio sale SOLO de las costeadas (ret_cost != null) y se aplica a TODAS las devoluciones: robusto
// al backfill parcial (arranca conservador, converge a exacto). `sales` = ventas del MISMO período (ventana
// ALINEADA con las devoluciones, ambas desde SALES_FROM): si num y den no se alinean, el lag venta→devolución
// —una devolución de hoy es de una venta de semanas atrás— da tasas >100%. La tasa NO se clampea: la
// honestidad viene de la alineación de ventanas, no de un tope artificial.
export function returnsModelStats(retCosts: (number | null | undefined)[], sales: number): ReturnsModelStats {
  const returns = retCosts.length
  const costed = retCosts.filter(c => c != null)                       // ret_cost != null (0 cuenta; null no)
  const fleteAvg = costed.length > 0 ? costed.reduce((a, c) => a + (+c! || 0), 0) / costed.length : 0
  const rate = sales > 0 ? returns / sales : null                      // null = sin ventas → no estimamos
  const devUnit = rate != null ? rate * fleteAvg : 0
  return { returns, rate, fleteAvg, devUnit, cov: { cnt: costed.length, all: returns } }
}
