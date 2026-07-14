// ParkaHub — invariantes runtime del ledger (§final) como predicados PUROS. Baratos, cazan bugs con dato
// real de prod. NO lanzan: devuelven bool, para usarse en tests (fijan qué NO puede pasar) y, si hace
// falta, en guards de dev. Fuente de verdad: _context/formulas-ledger.md "Invariantes runtime a mantener".
// `null` siempre pasa (la ausencia de dato es válida; el UI degrada mudo, no es una violación).

export const fractionInRange = (x: number | null | undefined): boolean => x == null || (x >= 0 && x <= 1)   // conversión ∈ [0,1]
export const pctWithin100 = (p: number | null | undefined): boolean => p == null || p <= 100                // margenPct ≤ 100
export const marginWithinNet = (margen: number | null | undefined, neto: number | null | undefined): boolean =>
  margen == null || neto == null || margen <= neto                                                          // no ganás más que el neto
export const nonNegative = (x: number | null | undefined): boolean => x == null || x >= 0                   // cobertura / días inv ≥ 0
export const isSafeNumber = (x: number | null | undefined): boolean => x == null || Number.isFinite(x)       // sin NaN/Infinity en pantalla
// Un desglose (shares/participaciones) suma ~100% (tolerancia por floats/redondeo).
export const sharesSumTo = (parts: number[], total = 100, tol = 0.5): boolean =>
  Math.abs(parts.reduce((a, b) => a + b, 0) - total) <= tol
