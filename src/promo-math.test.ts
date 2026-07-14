import { describe, it, expect } from 'vitest'
import { bestActivePromo, campaignOpp, maxOwnSellerPct, margenRealRow, IVA } from './promo-math'

// Los números están calculados A MANO en cada caso (nada de repetir la fórmula del código en el test:
// eso pasaría siempre). Si un test rompe, cambió la matemática de plata → revisar y bumpear SCAN_SV
// en promos.ts + parkahub-api si el cambio es intencional.

describe('bestActivePromo — mejor promo activa', () => {
  it('sin promos o sin lista válida → null', () => {
    expect(bestActivePromo([], 100000)).toBeNull()
    expect(bestActivePromo(null, 100000)).toBeNull()
    expect(bestActivePromo([{ status: 'active', offerPrice: 40000 }], 0)).toBeNull()
  })

  it('ignora candidatas/pendientes/terminadas y ofertas sin precio', () => {
    expect(bestActivePromo([
      { status: 'candidate', offerPrice: 30000 },
      { status: 'pending', offerPrice: 30000 },
      { status: 'finished', offerPrice: 30000 },
      { status: 'active', offerPrice: 0 },
    ], 100000)).toBeNull()
  })

  it('promo propia: buyer = seller = descuento entero (1 decimal)', () => {
    const r = bestActivePromo([{ status: 'active', offerPrice: 40000, type: 'DEAL' }], 100000)
    expect(r.buyerPct).toBe(60)
    expect(r.sellerPct).toBe(60)
    expect(r.effPrice).toBe(40000)
    expect(r.cofunded).toBe(false)
  })

  it('gana la más barata para el comprador', () => {
    const r = bestActivePromo([
      { status: 'active', offerPrice: 40000 },
      { status: 'started', offerPrice: 35000 },
    ], 100000)
    expect(r.effPrice).toBe(35000)
  })

  it('boost: el comprador ve el precio potenciado, el vendedor financia hasta su deal_price', () => {
    const r = bestActivePromo([{ status: 'started', offerPrice: 40000, boosted: true, boostedPrice: 37000, boostAmount: 3000 }], 100000)
    expect(r.effPrice).toBe(37000)   // precio final que ve el comprador (ML puso 3000)
    expect(r.buyerPct).toBe(63)      // sobre el potenciado
    expect(r.sellerPct).toBe(60)     // solo hasta el deal_price del vendedor
    expect(r.boosted).toBe(true)
  })

  it('co-fondeada: sellerPct es lo que pone el vendedor, no el descuento total', () => {
    const r = bestActivePromo([{ status: 'active', offerPrice: 34000, sellerPct: 62, meliPct: 4, type: 'MARKETPLACE_CAMPAIGN' }], 100000)
    expect(r.buyerPct).toBe(66)
    expect(r.sellerPct).toBe(62)
    expect(r.cofunded).toBe(true)
    expect(r.meliPct).toBe(4)
  })

  it('co-fondeada Y potenciada a la vez: sellerPct (lo que ponés vos) le gana a la fórmula del boost', () => {
    const r = bestActivePromo([{ status: 'active', offerPrice: 40000, sellerPct: 58, boosted: true, boostedPrice: 37000 }], 100000)
    expect(r.effPrice).toBe(37000)   // el comprador ve el potenciado
    expect(r.buyerPct).toBe(63)
    expect(r.sellerPct).toBe(58)     // pero vos financiás lo que dice seller_percentage, no el 60 del boost
  })
})

describe('campaignOpp — oportunidades honestas (dato exacto desde pesos)', () => {
  // El caso de oro de Parka: candidata co-fondeada, ML pone plata.
  const list = 100000

  it('candidata co-fondeada: reqSeller EXACTO desde el precio en pesos (no el % redondeado de la API)', () => {
    // precio objetivo 34000 → descuento total 66%; ML pone 4 → el vendedor financia 62.
    // sellerPct de la API dice 61.9 (redondeado) a propósito: debe ganar el cálculo desde pesos.
    const r = campaignOpp({ status: 'candidate', type: 'MARKETPLACE_CAMPAIGN', sellerPct: 61.9, meliPct: 4, offerPrice: 34000 }, list, 65, 35000)
    expect(r.reqSeller).toBe(62)
    expect(r.buyer).toBe(66)
    expect(r.extra).toBe(-3)      // ya financiás 65 → entrás "gratis" (3 puntos mejor)
    expect(r.net).toBe(4)         // ML te regala sus 4 puntos enteros (extra negativo no suma)
    expect(r.target).toBe(34000)
    expect(r.approx).toBe(false)  // 34000 >= 35000*0.97=33950 → no es candidata vieja
  })

  it('reqSeller con decimales reales (2 exactos, sin inventar)', () => {
    // 41900/119900: descuento total 65.0542% − meli 4.5 = 60.5542 → 60.55
    const r = campaignOpp({ status: 'candidate', sellerPct: 60.6, meliPct: 4.5, offerPrice: 41900 }, 119900, null, 41900)
    expect(r.reqSeller).toBe(60.55)
    expect(r.extra).toBe(60.55)   // sin descuento activo, el costo es todo tuyo
    expect(r.base).toBeNull()
  })

  it('señal ~ cuando el precio objetivo es >3% más profundo que el precio vivo (posible sellada vieja)', () => {
    const r = campaignOpp({ status: 'candidate', sellerPct: 62, meliPct: 4, offerPrice: 34000 }, list, 61, 45000)
    expect(r.approx).toBe(true)   // 34000 < 45000*0.97=43650
    expect(r.extra).toBe(1)       // 62 − 61
    expect(r.net).toBe(3)         // 4 − 1
  })

  it('sin precio objetivo cae al % redondeado de la API', () => {
    const r = campaignOpp({ status: 'candidate', sellerPct: 62.5, meliPct: 4, offerPrice: 0 }, list, null, list)
    expect(r.reqSeller).toBe(62.5)
    expect(r.target).toBeNull()
  })

  it('campaña de banda: reqSeller = descuento mínimo para entrar (desde max_discounted_price)', () => {
    const r = campaignOpp({ status: 'candidate', type: 'DEAL', max: 40000, meliPct: 3 }, list, null, list)
    expect(r.reqSeller).toBe(60)
    expect(r.buyer).toBe(63)
  })

  it('sin sellerPct ni banda: ML fija todo → reqSeller 0', () => {
    const r = campaignOpp({ status: 'candidate', meliPct: 10 }, list, null, list)
    expect(r.reqSeller).toBe(0)
    expect(r.buyer).toBe(10)
  })

  it('estados que YA participan o terminaron NO son oportunidad (fix de las falsas)', () => {
    for (const status of ['started', 'active', 'pending', 'finished', 'STARTED', 'Pending'])
      expect(campaignOpp({ status, sellerPct: 62, meliPct: 4, offerPrice: 34000 }, list, 61, 35000)).toBeNull()
  })

  it('CUPONES: jamás son oportunidad (regla dura)', () => {
    expect(campaignOpp({ status: 'candidate', type: 'SELLER_COUPON_CAMPAIGN', sellerPct: 60, meliPct: 5, offerPrice: 34000 }, list, null, list)).toBeNull()
    expect(campaignOpp({ status: 'candidate', type: 'ALGO_CUPON_RARO', sellerPct: 60, meliPct: 5, offerPrice: 34000 }, list, null, list)).toBeNull()
    expect(campaignOpp({ status: 'candidate', type: 'NEW_COUPON_X', sellerPct: 60, meliPct: 5, offerPrice: 34000 }, list, null, list)).toBeNull()
  })

  it('sin aporte de ML no es regalo → null (las 100% tuyas no entran acá)', () => {
    expect(campaignOpp({ status: 'candidate', type: 'DEAL', sellerPct: 60, offerPrice: 34000 }, list, null, list)).toBeNull()
    expect(campaignOpp({ status: 'candidate', sellerPct: 60, meliPct: 0, offerPrice: 34000 }, list, null, list)).toBeNull()
  })

  it('meli cae a boostMeliPct si meliPct falta', () => {
    const r = campaignOpp({ status: 'candidate', sellerPct: 60, meliPct: null, boostMeliPct: 5, offerPrice: 35000 }, list, null, list)
    expect(r.meli).toBe(5)
  })

  it('lista inválida → null', () => {
    expect(campaignOpp({ status: 'candidate', sellerPct: 60, meliPct: 5, offerPrice: 34000 }, 0, null, 0)).toBeNull()
  })

  it('curEff desconocido (0) NO dispara la señal ~ (la guarda exige precio vivo válido)', () => {
    const r = campaignOpp({ status: 'candidate', sellerPct: 62, meliPct: 4, offerPrice: 34000 }, list, 61, 0)
    expect(r.approx).toBe(false)
    expect(r.reqSeller).toBe(62)
  })

  it('reqSeller NEGATIVO documentado: banda con max ≥ lista y co-fondeo donde ML pone más que el descuento total', () => {
    // banda: max 110000 sobre lista 100000 → "descuento mínimo" −10 (entrar SUBE el precio efectivo)
    const banda = campaignOpp({ status: 'candidate', max: 110000, meliPct: 3 }, list, null, list)
    expect(banda.reqSeller).toBe(-10)
    expect(banda.buyer).toBe(-7)
    expect(banda.net).toBe(3)        // extra negativo no descuenta el regalo de ML
    // co-fondeada: precio objetivo 90000 (10% total) con ML poniendo 15 → vos "ponés" −5
    const cofin = campaignOpp({ status: 'candidate', sellerPct: 8, meliPct: 15, offerPrice: 90000 }, list, null, list)
    expect(cofin.reqSeller).toBe(-5)
    expect(cofin.net).toBe(15)
  })
})

describe('maxOwnSellerPct — lo más profundo que YA financia el vendedor', () => {
  const list = 100000

  it('sin activas o sin lista → null', () => {
    expect(maxOwnSellerPct([], list)).toBeNull()
    expect(maxOwnSellerPct([{ status: 'candidate', offerPrice: 30000 }], list)).toBeNull()
    expect(maxOwnSellerPct([{ status: 'active', offerPrice: 30000 }], 0)).toBeNull()
  })

  it('toma el MÁXIMO entre co-fondeada (sellerPct) y propia (descuento entero)', () => {
    expect(maxOwnSellerPct([
      { status: 'active', offerPrice: 34000, sellerPct: 62 },   // co-fondeada: ponés 62
      { status: 'started', offerPrice: 35000 },                 // propia: ponés 65
    ], list)).toBe(65)
  })

  it('boost: cuenta hasta el deal_price del vendedor, no el precio potenciado de ML', () => {
    expect(maxOwnSellerPct([{ status: 'active', boosted: true, offerPrice: 40000, boostedPrice: 37000 }], list)).toBe(60)
  })

  it('co-fondeada Y potenciada: manda sellerPct (misma precedencia que bestActivePromo)', () => {
    expect(maxOwnSellerPct([{ status: 'active', boosted: true, offerPrice: 40000, boostedPrice: 37000, sellerPct: 58 }], list)).toBe(58)
  })
})

describe('margenRealRow — margen neto de IVA (RI)', () => {
  // Caso redondo: precio 121000 → neto 100000; landed 40000 (ya neto); comisión 12100 → 10000;
  // envío 6050 → 5000; ads 60500 en 10 uds → 6050/u → 5000. Margen = 100000−40000−10000−5000−5000 = 40000.
  const c = { precioReal: 121000, comisUnit: 12100, comisionPct: 10, envio: 6050, envN: 3, qty: 10 }

  it('IVA es 1.21 (si cambia, cambia TODO el margen — a propósito acá)', () => {
    expect(IVA).toBe(1.21)
  })

  it('caso completo: netea precio, comisión, envío y publicidad; el landed NO (ya es neto)', () => {
    const r = margenRealRow(c, 40000, { cost: 60500, acos: 5, roas: 8 })
    expect(r.margen).toBeCloseTo(40000, 6)
    expect(r.margenPct).toBeCloseTo(40, 6)
    expect(r.adsUnit).toBeCloseTo(6050, 6)
    expect(r.acos).toBe(5)
  })

  it('sin costo landed → margen null ("cargá costo"), nunca un número confiado y equivocado', () => {
    const r = margenRealRow(c, undefined, null)
    expect(r.margen).toBeNull()
    expect(r.margenPct).toBeNull()
  })

  it('sin ads → margen SIN publicidad (0, no null): la falta de inversión no bloquea el margen', () => {
    const r = margenRealRow(c, 40000, undefined)
    expect(r.adsUnit).toBe(0)
    expect(r.acos).toBeNull()
    expect(r.margen).toBeCloseTo(45000, 6)
  })

  it('sin comisión o sin envío → margen null (datos incompletos ≠ margen 100%)', () => {
    expect(margenRealRow({ ...c, comisUnit: null }, 40000, null).margen).toBeNull()
    expect(margenRealRow({ ...c, envio: null }, 40000, null).margen).toBeNull()
  })

  it('sin precio de venta → margen null', () => {
    const r = margenRealRow({ ...c, precioReal: 0 }, 40000, null)
    expect(r.margen).toBeNull()
    expect(r.margenPct).toBeNull()
  })

  it('qty=0 con ads presentes → adsUnit 0, jamás Infinity (cost/0 reventaría el margen)', () => {
    const r = margenRealRow({ ...c, qty: 0 }, 40000, { cost: 60500, acos: 5 })
    expect(r.adsUnit).toBe(0)
    expect(r.margen).toBeCloseTo(45000, 6)   // margen sin ads, finito
  })
})
