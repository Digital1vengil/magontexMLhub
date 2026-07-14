// ParkaHub — share math de la tendencia geográfica (métrica 12 del ledger, mitad front del /api/geo-trend).
// Extraída TAL CUAL de report.ts (charts 100%-stacked), sin cambio de lógica.
// El bucketing semanal (lunes) y el resolved=1 son SQL en el Worker → no-unit-testeable (excepción (b)).
// Acá vive lo testeable: el SHARE. num y den salen del MISMO subconjunto (unidades resueltas de ESA semana)
// → el share no se sesga aunque la semana esté parcialmente resuelta (solo más ruidoso con n chico).

// Participación (%) de una parte sobre el total de la semana = part / (total||1) × 100. El `||1` evita /0;
// en la práctica una parte solo es >0 cuando total>0 (invariante de los DATOS: la parte es un sumando del
// total), así que con total=0 el resultado es 0. Float; el redondeo se hace solo en el tooltip → suman 100.
export function share(part: number, total: number | null | undefined): number {
  return (part / (total || 1)) * 100
}

// Share de "Otras" en un stack top-N + Otras = (total − Σseleccionadas) / total. Nunca negativo porque las
// seleccionadas son un SUBCONJUNTO del total (Σseleccionadas ≤ total). selectedSum = suma de las top-N.
// total=0 (semana sin unidades resueltas) → 0, NO 100: corrige la rareza heredada del `||1` original que
// pintaba "Otras" al 100% en semanas vacías (decisión de Martin, jul-2026 — cambio honesto, display-only).
export function othersShare(total: number | null | undefined, selectedSum: number): number {
  const t = total || 0
  return t > 0 ? ((t - selectedSum) / t) * 100 : 0
}
