// ParkaHub — aritmética PURA de stock/cobertura/conversión, compartida por el Radar (publicaciones.ts) y
// Promos (promos.ts). Extraída TAL CUAL de esos módulos, sin cambio de lógica → NO cambia runtime.
// Fuente de verdad: _context/formulas-ledger.md métricas 4 (cobertura), 5 (conversión) y 6 (días inv.).

// MODA del stock entre las publicaciones ACTIVAS de un modelo. El stock es COMPARTIDO entre publicaciones
// (mismo depósito) → NO se suma: se toma el valor que más se repite. Empate de frecuencia → gana el MAYOR
// (criterio del banner de Promos). Array vacío → 0. Los callers filtran los stocks positivos antes de llamar.
export function stockMode(arr: number[]): number {
  if (!arr.length) return 0
  const f: Record<number, number> = {}
  arr.forEach(v => f[v] = (f[v] || 0) + 1)
  let best = arr[0], bc = 0
  for (const k in f) { const v = +k; if (f[k] > bc || (f[k] === bc && v > best)) { best = v; bc = f[k] } }
  return best
}

// Días de stock (cobertura / días de inventario) = stock ÷ velocidad diaria, donde velocidad diaria =
// unidades del período ÷ días del período. Radar: (qty 30d, windowDays 30). Promos: (sales 14d, 14).
// null si stock ≤ 0 (o null) o si units ≤ 0 (sin velocidad no hay cobertura). Redondeo al día entero.
export function daysOfStock(stock: number | null | undefined, units: number | null | undefined, windowDays: number): number | null {
  return (stock! > 0 && units! > 0) ? Math.round(stock! / (units! / windowDays)) : null
}

// Conversión = ventas ÷ visitas, MISMA ventana y MISMOS ids (los callers suman num/den sobre el mismo
// subconjunto). Fracción 0..1. Reglas de honestidad del ledger (métrica 5):
//   · Gate de frescura: si las ventas NO están frescas → null (mudo, no un número inventado).
//   · Invariante >100% imposible (bug 6-jul: ventas viejas ÷ visitas frescas daba 104%) → null.
//   · visits ≤ 0 / null → null (sin visitas no se juzga).
export function conversionRate(sales: number, visits: number | null | undefined, salesFresh: boolean): number | null {
  if (!salesFresh || !(visits! > 0)) return null
  const r = sales / visits!
  return (r >= 0 && r <= 1) ? r : null
}

// Flete de IDA promedio por modelo (ship-agg full-set) = Σcost ÷ Σenvíos-pagos. Los envíos gratis (cost=0)
// ya se descartan en el SQL del Worker (WHERE cost>0) → npaid solo cuenta pagos. null si no hay pagos
// todavía (backfill en curso) → mstMargin cae a la muestra de mlcosts. Métrica 9 (mitad front).
export function shipAvg(spaid: number, npaid: number): number | null {
  return npaid > 0 ? spaid / npaid : null
}
