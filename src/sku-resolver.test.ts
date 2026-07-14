import { describe, it, expect } from 'vitest'
import { makeSkuModelResolver, nrm, dash, noColor } from './sku-resolver'

describe('helpers de normalización', () => {
  it('nrm: minúsculas + trim; null/undefined → vacío', () => {
    expect(nrm('  TANK ')).toBe('tank')
    expect(nrm(null)).toBe('')
    expect(nrm(undefined)).toBe('')
  })

  it('dash: espacios → guión, guiones repetidos colapsan', () => {
    expect(dash('  M 114  Black ')).toBe('m-114-black')
    expect(dash('a  b--c')).toBe('a-b-c')
  })

  it('noColor: saca el último segmento ALFABÉTICO (el color); sufijo numérico queda intacto', () => {
    expect(noColor('m-114-black')).toBe('m-114')
    expect(noColor('k-220-navy')).toBe('k-220')
    expect(noColor('m-114')).toBe('m-114')
  })
})

describe('makeSkuModelResolver — criterio único venta→modelo (rsmBuild2 + Devoluciones)', () => {
  it('resuelve por el maestro con normalización de espacios/mayúsculas en clave e input', () => {
    const resolve = makeSkuModelResolver({ 'M 152 Army': 'Tank' })
    expect(resolve('m-152-army')).toBe('tank')
    expect(resolve('M-152-ARMY')).toBe('tank')
  })

  it('fallback a nivel modelo (sin color): color no cargado en el maestro resuelve igual', () => {
    const resolve = makeSkuModelResolver({ 'K-220-NAVY': 'Lizard' })
    expect(resolve('k-220-red')).toBe('lizard')   // color desconocido → cae al código base
    expect(resolve('k-220')).toBe('lizard')
  })

  it('first-wins en el índice sin color; el match exacto por color le gana al fallback', () => {
    const resolve = makeSkuModelResolver({ 'X-1-RED': 'alfa', 'X-1-BLUE': 'beta' })
    expect(resolve('x-1')).toBe('alfa')        // primer color indexado gana el nivel modelo
    expect(resolve('x-1-blue')).toBe('beta')   // pero el color exacto sigue mandando
  })

  it('alias seed m-114=thor (histórico: el maestro no lo traía); el maestro lo pisa si aparece', () => {
    const sinMaestro = makeSkuModelResolver({})
    expect(sinMaestro('m-114')).toBe('thor')
    expect(sinMaestro('m-114-black')).toBe('thor')
    const conMaestro = makeSkuModelResolver({ 'M-114': 'otro' })
    expect(conMaestro('m-114')).toBe('otro')
  })

  it('PC_PRODUCTS (Costos) es el ÚLTIMO fallback; el maestro tiene precedencia', () => {
    const resolve = makeSkuModelResolver({}, [{ sku: 'Z 9', name: 'Nuevo Modelo' }])
    expect(resolve('z-9')).toBe('nuevo modelo')
    const conMaestro = makeSkuModelResolver({ 'Z-9': 'Master' }, [{ sku: 'Z-9', name: 'Costos' }])
    expect(conMaestro('z-9')).toBe('master')
  })

  it('sin match → cadena vacía (discontinuado / desalineado, el caller decide)', () => {
    const resolve = makeSkuModelResolver({ 'M-152': 'Tank' })
    expect(resolve('zzz-999')).toBe('')
    expect(resolve('')).toBe('')
    expect(resolve(null)).toBe('')
  })

  it('entradas rotas no explotan: maestro null, PC_PRODUCTS con filas inválidas', () => {
    const resolve = makeSkuModelResolver(null, [null, {}, { sku: 'A-1' }, { name: 'sin sku' }])
    expect(resolve('a-1')).toBe('')          // fila sin name no indexa
    expect(resolve('m-114')).toBe('thor')    // el alias sobrevive igual
  })
})
