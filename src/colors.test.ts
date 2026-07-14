import { describe, it, expect } from 'vitest'
import { canonColor, colorOfSku } from './colors'

describe('canonColor — agrupación por familia', () => {
  it('agrupa todos los verdes en Verde', () => {
    for (const v of ['verde', 'Verde', 'green', 'Green', 'grn', 'GRN', 'verde musgo', 'verde militar', 'verde oscuro'])
      expect(canonColor(v)).toBe('Verde')
  })

  it('agrupa todos los azules en Azul (incluye marino, petróleo, navy)', () => {
    for (const v of ['azul', 'Azul', 'blue', 'navy', 'Navy', 'azul marino', 'Azul marino', 'azul petróleo', 'azul petroleo'])
      expect(canonColor(v)).toBe('Azul')
  })

  it('agrupa negros en Negro (typos blak/blk y mayúsculas incluidos)', () => {
    for (const v of ['negro', 'Negro', 'negra', 'black', 'Black', 'BLACK', 'blak', 'blk'])
      expect(canonColor(v)).toBe('Negro')
  })

  it('beig y beige caen en Beige', () => {
    expect(canonColor('beig')).toBe('Beige')
    expect(canonColor('Beige')).toBe('Beige')
  })

  it('grises en EN/ES → Gris', () => {
    for (const v of ['gris', 'grey', 'gray', 'Grey']) expect(canonColor(v)).toBe('Gris')
  })

  it('colapsa la mezcla inglés/español de ML al mismo canónico', () => {
    expect(canonColor('Black')).toBe(canonColor('Negro'))
    expect(canonColor('Green')).toBe(canonColor('Verde'))
    expect(canonColor('Navy')).toBe(canonColor('Azul marino'))
  })

  it('sin familia: título tal cual (colores propios)', () => {
    expect(canonColor('hielo')).toBe('Hielo')
    expect(canonColor('lila')).toBe('Lila')   // lila NO es violeta → queda como su propio color
  })

  it('offwhite es un tono de blanco → Blanco (agrupado a propósito)', () => {
    expect(canonColor('Offwhite')).toBe('Blanco')
  })

  it('vacío/nulo → cadena vacía', () => {
    expect(canonColor('')).toBe('')
    expect(canonColor('   ')).toBe('')
    expect(canonColor(undefined)).toBe('')
    expect(canonColor(null)).toBe('')
  })
})

describe('colorOfSku — venta primero, SKU como fallback', () => {
  it('usa el color de la venta cuando existe (src=sale)', () => {
    expect(colorOfSku('m-114-blk-l', 'm-114-blk', { Negro: 5 })).toEqual({ color: 'Negro', src: 'sale' })
  })

  it('elige el color dominante si la venta trae varios', () => {
    expect(colorOfSku('x', 'x-azul', { Verde: 2, Azul: 9 })).toEqual({ color: 'Azul', src: 'sale' })
  })

  it('cae al último segmento alfabético del SKU si no hay color de venta (src=sku)', () => {
    expect(colorOfSku('m-114-black-l', 'm-114-black', undefined)).toEqual({ color: 'Negro', src: 'sku' })
  })

  it('canonicaliza también el color derivado del SKU', () => {
    expect(colorOfSku('x', 'x-grn', undefined)).toEqual({ color: 'Verde', src: 'sku' })
  })

  it("sin venta ni segmento de color → vacío (src='')", () => {
    expect(colorOfSku('x', 'm-114', undefined)).toEqual({ color: '', src: '' })
  })

  it('un mapa de venta vacío no cuenta como venta → fallback al SKU', () => {
    expect(colorOfSku('x', 'x-rojo', {})).toEqual({ color: 'Rojo', src: 'sku' })
  })
})
