import { describe, it, expect } from 'vitest'
import { acosLight } from './ads-math'

// Umbrales del ledger (métrica 3): <12 verde · <18 ámbar · resto rojo. Bordes A MANO.
describe('acosLight — semáforo de ACOS', () => {
  it('sin dato → null (color atenuado, no verde por defecto)', () => {
    expect(acosLight(null)).toBeNull()
    expect(acosLight(undefined)).toBeNull()
  })
  it('< 12 → verde', () => {
    expect(acosLight(0)).toBe('green')
    expect(acosLight(11.9)).toBe('green')
  })
  it('[12, 18) → ámbar (12 ya NO es verde)', () => {
    expect(acosLight(12)).toBe('amber')
    expect(acosLight(17.9)).toBe('amber')
  })
  it('≥ 18 → rojo (18 ya NO es ámbar)', () => {
    expect(acosLight(18)).toBe('red')
    expect(acosLight(40)).toBe('red')
  })
})
