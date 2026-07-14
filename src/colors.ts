// ParkaHub — canonicalización de colores (funciones PURAS, sin estado/DOM → testeables en Node).
// Extraídas de report.ts. El color que eligió el comprador (de la venta) es la fuente de verdad; el SKU
// es el fallback cuando un día todavía no se resincronizó. Todo termina pasando por canonColor.

// Agrupación por FAMILIA (decisión de Martin): los tonos van al color base. Si el texto (normalizado, sin
// acentos) contiene la palabra de la familia, se agrupa ahí → "verde musgo/militar/oscuro", "green", "grn"
// → Verde; "azul marino/petróleo", "navy" → Azul; "black/blak/blk" → Negro; "beig" → Beige. Cubre la
// mezcla EN/ES de ML y los typos vistos en datos reales. El orden solo importa en compuestos raros.
export const COLOR_FAMILIES: Array<[RegExp, string]> = [
  [/negro|negra|black|blak|blk/, 'Negro'],
  [/blanco|blanca|white|wht/, 'Blanco'],   // 'white' también captura "offwhite" → tono de blanco, agrupado a propósito
  [/verde|green|grn/, 'Verde'],
  [/azul|blue|navy|marino/, 'Azul'],
  [/gris|grey|gray/, 'Gris'],
  [/rojo|roja|red/, 'Rojo'],
  [/beige|beig|camel/, 'Beige'],
  [/marron|brown|cafe/, 'Marrón'],
  [/bordo|vino/, 'Bordó'],
  [/celeste/, 'Celeste'],
  [/rosa|pink|fucsia/, 'Rosa'],
  [/violeta|purple/, 'Violeta'],   // 'lila' queda como su propio color (no es violeta)
  [/amarillo|yellow|mostaza/, 'Amarillo'],
  [/naranja|orange/, 'Naranja'],
]

// Un nombre de color (de la venta o del SKU) → nombre canónico de familia. Sin familia: título tal cual
// (Hielo, Offwhite, …). '' si entra vacío.
export function canonColor(c: unknown): string {
  const s = String(c == null ? '' : c).trim()
  if (!s) return ''
  const k = s.toLowerCase()
    .replace(/[áàä]/g, 'a').replace(/[éèë]/g, 'e').replace(/[íìï]/g, 'i').replace(/[óòö]/g, 'o').replace(/[úùü]/g, 'u')
  for (const [re, name] of COLOR_FAMILIES) { if (re.test(k)) return name }
  return s.charAt(0).toUpperCase() + s.slice(1).toLowerCase()
}

// Mapa de colores de la venta para UN sku: {colorReal: uds}. Lo provee el caller (en el front,
// totalSkuColors[sku], que sale de vml_weeks.skuColors).
export type SaleColors = Record<string, number> | undefined

// sku + código base + colores de venta de ese sku → {color canónico, src}.
//   src = 'sale' (lo eligió el comprador, dato bueno) | 'sku' (fallback) | '' (no se pudo).
// Prioridad 1: color de la venta (el dominante si hay varios). Prioridad 2: último segmento alfabético
// del código base (p.ej. "m-114-black" → "black").
export function colorOfSku(sku: string, base: string, saleColors: SaleColors): { color: string; src: 'sale' | 'sku' | '' } {
  if (saleColors) {
    const best = Object.keys(saleColors).sort((a, b) => saleColors[b] - saleColors[a])[0]
    if (best) return { color: canonColor(best), src: 'sale' }
  }
  const m = String(base || '').match(/-([a-zA-Z]+)$/)
  return m ? { color: canonColor(m[1]), src: 'sku' } : { color: '', src: '' }
}
