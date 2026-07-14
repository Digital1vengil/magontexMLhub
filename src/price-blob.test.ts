import { describe, it, expect } from 'vitest'
import { acceptPriceBlob } from './price-blob'

// sv literal (no importamos SCAN_SV): el test verifica la FUNCIÓN, no la constante — sigue valiendo si
// SCAN_SV cambia. Casos de la retro 2026-07-13 (ml-price-blob-sv-row0-validation). Espejo del set de
// blobHasStaleRow en parkahub-api/src/warehouse.test.ts.
describe('acceptPriceBlob — sv-gate del blob de precios compartido', () => {
  it('blob del esquema vigente → aceptado', () => {
    expect(acceptPriceBlob([{ sv: 4, num: 'MLA1' }], 4)).toBe(true)
    expect(acceptPriceBlob([{ sv: 4 }, { sv: 4 }], 4)).toBe(true)
  })
  it('blob de esquema VIEJO (row[0].sv distinto) → rechazado', () => {
    expect(acceptPriceBlob([{ sv: 3, num: 'MLA1' }], 4)).toBe(false)
  })
  it('row[0] nulo → rechazado (no explota)', () => {
    expect(acceptPriceBlob([null, { sv: 4 }], 4)).toBe(false)
  })
  it('row[0] sin sv (pre-esquema) → rechazado', () => {
    expect(acceptPriceBlob([{ num: 'MLA1' }], 4)).toBe(false)
  })
  it('blob vacío → rechazado', () => {
    expect(acceptPriceBlob([], 4)).toBe(false)
  })
  it('CONTRATO: solo mira row[0] — un blob MIXTO con row[0] vigente lo ACEPTA', () => {
    // El helper NO detecta blobs heterogéneos por diseño (es O(1)). Esa protección vive del lado del
    // servidor: el POST /api/warehouse (blobHasStaleRow) + el rebuild del cron garantizan homogeneidad
    // de sv en D1 → el par helper+gate es indivisible. Si algún día esto da false, rompió esa invariante.
    expect(acceptPriceBlob([{ sv: 4 }, { sv: 3 }], 4)).toBe(true)
  })
  it('no-array (null / undefined / string) → rechazado (defensivo)', () => {
    expect(acceptPriceBlob(null, 4)).toBe(false)
    expect(acceptPriceBlob(undefined, 4)).toBe(false)
    expect(acceptPriceBlob('[]', 4)).toBe(false)
  })
})
