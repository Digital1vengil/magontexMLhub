import { describe, it, expect } from 'vitest'
import { garmentClimate } from './garment'

const only = (r: {rain:boolean;warm:boolean;light:boolean}) => Object.entries(r).filter(([,v])=>v).map(([k])=>k)

describe('garmentClimate (carácter de prenda para la señal de clima)', () => {
  // Casos REALES del Maestro (pub_master jul-2026).
  it('ALCHEMY (Impermeable · Sin relleno · Trench) → LLUVIA', () => {
    expect(garmentClimate('Sin relleno', 'Trench', 'Impermeable')).toEqual({ rain: true, warm: false, light: false })
  })
  it('GEMINI (Impermeable · Con relleno leve · Piloto) → LLUVIA (la tipología manda sobre el relleno leve)', () => {
    expect(garmentClimate('Con relleno leve', 'Piloto', 'Impermeable')).toEqual({ rain: true, warm: false, light: false })
  })
  it('Puffer (Con relleno · Campera Puffer) → ABRIGO (frío)', () => {
    expect(garmentClimate('Con relleno', 'Campera Puffer', 'No impermeable')).toEqual({ rain: false, warm: true, light: false })
  })
  it('Con corderito → ABRIGO', () => {
    expect(garmentClimate('Con corderito', 'Campera', '')).toEqual({ rain: false, warm: true, light: false })
  })
  it('Sin relleno, no-lluvia → LIVIANA (temperatura)', () => {
    expect(garmentClimate('Sin relleno', 'Campera', 'No impermeable')).toEqual({ rain: false, warm: false, light: true })
  })
  it('Trench NO impermeable → NO es de lluvia (sin protección = no la dispara la lluvia) → liviana', () => {
    expect(garmentClimate('Sin relleno', 'Trench', 'No impermeable')).toEqual({ rain: false, warm: false, light: true })
  })
  it('vacío / no clasificado → neutro (ningún chip)', () => {
    expect(garmentClimate('', '', '')).toEqual({ rain: false, warm: false, light: false })
    expect(garmentClimate(null, null, null)).toEqual({ rain: false, warm: false, light: false })
  })
  it('INVARIANTE: como mucho UNO de rain/warm/light, nunca dos, para cualquier combinación real', () => {
    const abrigos = ['Con relleno', 'Con relleno leve', 'Con corderito', 'Sin relleno', ''] as const
    const tipos = ['Trench', 'Piloto', 'Campera Puffer', 'Campera Parka', 'Campera', ''] as const
    const impers = ['Impermeable', 'Repelente', 'No impermeable', ''] as const
    for (const a of abrigos) for (const t of tipos) for (const i of impers) {
      expect(only(garmentClimate(a, t, i)).length).toBeLessThanOrEqual(1)
    }
  })
})
