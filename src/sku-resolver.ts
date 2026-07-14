// ParkaHub — resolutor SKU→modelo (funciones PURAS, sin estado/DOM → testeables en Node).
// ÚNICO criterio compartido del cruce venta→modelo: lo usan rsmBuild2 (report.ts) y Devoluciones
// (devoluciones.ts). Antes vivía DUPLICADO en los dos archivos ("mismo criterio" sostenido a copy-paste);
// ahora la regla es estructural: un solo lugar, imposible divergir. REGLA del proyecto: el análisis por
// modelo parte del SKU de la VENTA, nunca de la publicación (se reusan). Tests: sku-resolver.test.ts.

export const nrm = (s: unknown): string => String(s || '').toLowerCase().trim()
export const dash = (s: unknown): string => nrm(s).replace(/\s+/g, '-').replace(/-+/g, '-')
// Saca el último segmento ALFABÉTICO (el color): "m-114-black" → "m-114". Un sufijo numérico (el propio
// código) queda intacto.
export const noColor = (b: string): string => b.replace(/-[a-z]+$/i, '')

// (maestro SKU↔modelo, PC_PRODUCTS de Costos) → resolveModel(base)→modelo ('' si no resuelve).
// Precedencia: maestro a nivel color → maestro a nivel modelo (sin color, first-wins) → alias seed
// (m-114=thor, histórico: el maestro no lo traía) → Costos (PC_PRODUCTS, sku→name) como último fallback.
// El input `base` es el código base del SKU vendido (vmlBaseCode), normalizado acá mismo con dash().
export function makeSkuModelResolver(
  master: Record<string, string> | null | undefined,
  pcProducts?: Array<{ sku?: string; name?: string } | null> | null,
): (base: unknown) => string {
  const sku2model: Record<string, string> = {}
  Object.keys(master || {}).forEach(k => { const kk = dash(k), v = nrm((master || {})[k]); sku2model[kk] = v; const nc = noColor(kk); if (nc && !sku2model[nc]) sku2model[nc] = v })
  sku2model['m-114'] = sku2model['m-114'] || 'thor'
  try { (pcProducts || []).forEach(p => { if (p && p.sku && p.name) { const kk = dash(p.sku); if (!sku2model[kk]) sku2model[kk] = nrm(p.name) } }) } catch (e) {}
  return base => { const b = dash(base); return sku2model[b] || sku2model[noColor(b)] || '' }
}
