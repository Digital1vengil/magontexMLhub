// ParkaHub — aritmética PURA del margen real del MAESTRO (métrica 1 del ledger, LA COMPLETA).
// Extraída TAL CUAL de publicaciones.ts (`mstMargin`), cero cambio de lógica → NO cambia runtime.
// Fuente de verdad de la fórmula: _context/formulas-ledger.md métrica 1 (y 8 para `devUnit`).
//
// Neto de IVA (Martin = Responsable Inscripto): el margen se calcula sobre el precio NETO (÷IVA) restando
// costos NETOS. Excepciones de trato de IVA que cuestan plata si regresionan:
//   - `landedARS` (costo FOB importado) NO se netea.
//   - `iibbC` va sobre el NETO; `impdcC` (imp. déb/créd) va sobre el BRUTO (es sobre el movimiento).
//   - comisión, envío, ads y devolución SÍ se netean ÷IVA (crédito fiscal).
// Fork intencional con la de Promos (`margenRealRow`, promo-math.ts, LA SIMPLE): ESTA lleva IIBB +
// imp.déb/créd + costo de devolución; la de Promos NO (pedido explícito de Martin).

export const IVA = 1.21

// Todos los insumos del ledger. Los BRUTOS son como los reporta ML (la fórmula los netea).
export interface MstMarginInputs {
  precioReal: number | null | undefined      // precio promedio real de venta 30d (mlcosts), BRUTO (con IVA)
  landedUSD: number | null | undefined        // costo FOB por unidad en USD (maestro)
  dolar: number                               // dólar oficial venta del día (para landed USD→ARS)
  comisUnit: number | null | undefined        // comisión real por unidad, BRUTA (sale_fee, incluye cuotas + IVA)
  envBruto: number | null | undefined         // flete de IDA por unidad, BRUTO (ship-agg full-set o muestra mlcosts); null = sin dato
  adsCost: number | null | undefined          // gasto de ads del modelo 30d (null = sin inversión → ads 0, no null)
  adsQty: number | null | undefined           // unidades 30d (mlcosts.qty) para prorratear ads
  iibb: number                                // alícuota IIBB (fracción, ~0.05)
  impdc: number                               // alícuota imp. déb/créd (fracción, ~0.012)
  tasaDev: number | null | undefined          // tasa de devolución (métrica 7); null/undefined = sin estimación → devUnit 0
  fleteVueltaProm: number | null | undefined  // flete de vuelta PROMEDIO real (receiver.cost), BRUTO
}

// Devuelve null si falta el precio de venta o el costo landed (mismo gate que el `mstMargin` original:
// nunca un margen "confiado y equivocado" con datos incompletos). Con `neto>0` garantizado si no es null.
export function mstMarginCalc(i: MstMarginInputs, iva: number = IVA) {
  if (i.precioReal == null || !i.precioReal || i.landedUSD == null) return null
  const precio = i.precioReal, neto = precio / iva
  const landedARS = i.landedUSD * i.dolar                        // FOB importado: NO se netea IVA
  const comisNet = (i.comisUnit || 0) / iva
  const envNet = (i.envBruto != null ? i.envBruto : 0) / iva     // sin dato de envío → 0 (noEnvio marca la falta)
  // guard fail-safe `adsCost!=null` (el original chequeaba el objeto `ad` truthy): idéntico para todo input
  // alcanzable —el Worker siempre emite cost numérico— y además evita un NaN teórico. qty 0/null → 0, jamás Infinity.
  const adsUnit = (i.adsCost != null && i.adsQty) ? i.adsCost / i.adsQty : 0
  const adsNet = adsUnit / iva
  const iibbC = neto * i.iibb                                    // IIBB sobre el NETO
  const impdcC = precio * i.impdc                                // imp. déb/créd sobre el BRUTO (el movimiento)
  // Costo esperado de devolución/unidad (métrica 8) = tasa × flete de vuelta promedio, neteado ÷IVA.
  // `!=` laxo: null Y undefined (modelo sin devoluciones / sin ventas en la ventana) → devUnit 0.
  const devUnit = (i.tasaDev != null) ? i.tasaDev * (i.fleteVueltaProm || 0) : 0
  const devNet = devUnit / iva
  const costoReal = landedARS + comisNet + envNet + adsNet + iibbC + impdcC + devNet
  const margen = neto - costoReal
  return {
    neto, costoReal, margen, margenPct: neto > 0 ? margen / neto * 100 : null,
    landedARS, comisNet, envNet, adsUnit, adsNet, iibbC, impdcC, devUnit, devNet,
    noEnvio: i.envBruto == null,
  }
}
