import { describe, it, expect } from 'vitest'
import { share, othersShare } from './geo-math'

// Share 100%-stacked de la tendencia geográfica (métrica 12). Esperados A MANO.
describe('share — participación % de una parte sobre el total de la semana', () => {
  it('parte sobre total', () => {
    expect(share(30, 100)).toBeCloseTo(30, 6)
    expect(share(50, 200)).toBeCloseTo(25, 6)
  })
  it('total 0/undefined → 0 (no divide por cero)', () => {
    expect(share(0, 0)).toBe(0)
    expect(share(0, undefined)).toBe(0)
  })
  it('num y den del MISMO subconjunto → las partes de un desglose completo suman 100 exacto', () => {
    const total = 100
    expect(share(30, total) + share(30, total) + share(40, total)).toBeCloseTo(100, 6)
  })
})

describe('othersShare — "Otras" = (total − Σtop) / total', () => {
  it('resto tras las top', () => {
    expect(othersShare(100, 70)).toBeCloseTo(30, 6)
  })
  it('NUNCA negativo: las seleccionadas son un subconjunto (Σtop ≤ total)', () => {
    expect(othersShare(100, 100)).toBe(0)              // top cubren todo → Otras 0
    expect(othersShare(100, 95)).toBeGreaterThanOrEqual(0)
  })
  it('top + Otras suman 100 (num/den del mismo subconjunto)', () => {
    const total = 250, topSum = 180
    // 3 top que suman 180 + Otras(70) → 100
    expect(share(60, total) + share(60, total) + share(60, total) + othersShare(total, topSum)).toBeCloseTo(100, 6)
  })
  it('semana sin unidades resueltas (total=0) → "Otras" 0 (fix honesto, no 100 como el original)', () => {
    // Corrige la rareza heredada del `||1`: una semana vacía ya NO pinta la barra entera de "Otras".
    expect(othersShare(0, 0)).toBe(0)
    expect(othersShare(undefined, 0)).toBe(0)
  })
})
