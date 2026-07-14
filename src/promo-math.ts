// ParkaHub — matemática de plata de promos y margen (funciones PURAS, sin estado/DOM → testeables en Node).
// Extraídas TAL CUAL de promos.ts, cero cambio de lógica (por eso NO hubo bump de SCAN_SV). Si cambiás
// una FÓRMULA de acá: bump SCAN_SV en promos.ts Y la constante espejo del cron en parkahub-api/src/index.ts
// (bump JUNTOS — regla dura del proyecto). Tests: promo-math.test.ts.

// Promo de un ítem tal como la devuelve /api/ml/promo-resolve (campos que usa esta matemática).
export interface MlPromo {
  status?: string
  type?: string
  name?: string
  promotionId?: string | number | null
  offerPrice?: number
  sellerPct?: number | null
  meliPct?: number | null
  boosted?: boolean
  boostedPrice?: number
  boostAmount?: number | null
  boostMeliPct?: number | null
  max?: number | null
}

// Mejor promo ACTIVA de un ítem, con la matemática de plata correcta cuando ML POTENCIA la oferta (boost).
// ML puede poner plata extra encima del descuento del vendedor: total_price_for_boosted_offer es el precio
// FINAL que ve el comprador (más bajo que el deal_price del vendedor) y boostAmount lo pone ML, no vos.
//   buyerPct  = descuento que VE el comprador (sobre el precio potenciado si lo hay) — para mostrar.
//   sellerPct = descuento que FINANCIÁS VOS (co-fondeada: lo que pone el vendedor; con boost: hasta el
//               deal_price pre-boost, ML pone el resto; si no, = buyer) — para margen y coherencia.
export function bestActivePromo(promos: MlPromo[] | null | undefined, list: number) {
  const act = (promos || []).filter(x => (x.status === 'started' || x.status === 'active') && x.offerPrice > 0)
  if (!act.length || !(list > 0)) return null
  const eff = (p: MlPromo) => (p.boosted && p.boostedPrice > 0) ? p.boostedPrice : p.offerPrice   // precio al comprador
  const best = act.reduce((a, b) => eff(b) < eff(a) ? b : a)                                       // el más barato gana
  const effPrice = eff(best)
  const buyerPct = Math.round((1 - effPrice / list) * 1000) / 10
  let sellerPct
  if (best.sellerPct != null) sellerPct = best.sellerPct                                           // co-fondeada: lo que ponés vos
  else if (best.boosted && best.offerPrice > 0) sellerPct = Math.round((1 - best.offerPrice / list) * 1000) / 10  // boost: hasta tu deal_price
  else sellerPct = buyerPct
  return { type: best.type || '', name: best.name || '', effPrice, offerPrice: best.offerPrice, buyerPct, sellerPct,
           boosted: !!best.boosted, boostAmount: best.boostAmount || null,
           cofunded: best.sellerPct != null, meliPct: best.meliPct != null ? best.meliPct : null }
}

// OPORTUNIDAD de campaña: una promo CANDIDATA (no activa todavía) donde ML PONE PLATA. El caso de oro de
// Parka: el precio de lista está inflado y siempre corre un descuento grande (~60-65%). Si aparece una
// campaña co-fondeada que pide, ponele, 66% PERO ML suma 4% extra, entrar cuesta apenas 1 punto más de lo
// que ya descontás y el comprador ve 70% → hay que entrar sí o sí. Medimos el COSTO MARGINAL:
//   reqSeller = % que tenés que financiar vos para entrar (co-fondeada: seller_percentage; banda: el
//               descuento MÍNIMO que te deja entrar = a partir de max_discounted_price).
//   meli      = % que aporta ML (co-fondeo / boost) — plata que NO ponés vos.
//   buyer     = descuento aprox que ve el comprador (reqSeller + meli).
//   extra     = puntos extra de costo TUYO vs tu descuento activo de hoy (≤0 = entrás gratis o mejor).
//   net       = meli − max(0, extra) = cuántos puntos de descuento te REGALA ML netos de tu costo extra.
// Solo es "oportunidad" si ML aporta (meli>0); las candidatas 100% tuyas (DEAL/PRICE_DISCOUNT) no entran acá.
export function campaignOpp(p: MlPromo, list: number, currentSellerPct: number | null, curEff: number) {
  if (!(list > 0)) return null
  // SOLO una CANDIDATA es oportunidad de ENTRAR. Estados de ML del ítem en la campaña:
  //   candidate = puede entrar | pending = aprobada y PROGRAMADA (YA participa, aunque no arrancó) |
  //   started/active = corriendo | finished = ya salió. Antes solo se filtraban started/active, así que
  //   las 'pending' (y 'finished') se colaban como oportunidades FALSAS en publicaciones que YA participaban
  //   (lo que se vio en 917281612 / 1413697651 — figuraban "para entrar" estando ya adentro de todo).
  const stt = String(p.status || '').toLowerCase()
  if (stt === 'started' || stt === 'active' || stt === 'pending' || stt === 'finished') return null
  if (p.type === 'SELLER_COUPON_CAMPAIGN' || /COUPON|CUPON/i.test(p.type || '')) return null  // cupones: ni los miramos
  const meli = p.meliPct != null ? p.meliPct : (p.boostMeliPct != null ? p.boostMeliPct : 0)
  if (!(meli > 0)) return null                                                 // sin aporte de ML no es regalo
  let reqSeller, approx = false
  if (p.sellerPct != null) {
    // % EXACTO desde el PRECIO de la oferta (los % que da la API vienen redondeados a 1 decimal): lo que
    // financiás vos = descuento total del precio objetivo menos el aporte de ML. 2 decimales, sin inventar.
    reqSeller = (p.offerPrice > 0) ? Math.round(((1 - p.offerPrice / list) * 100 - meli) * 100) / 100 : p.sellerPct
    // NO recalculamos la propuesta de ML (lección jul-2026, 3 capturas de Martin): no hay fórmula confiable
    // — Ofertazos propone legítimamente MÁS profundo que tu precio actual (evento futuro con precio propio),
    // Compartidas se alinea a tu precio y a veces queda SELLADA a uno viejo. Cualquier umbral que arregla un
    // caso rompe otro. Política: mostrar el dato de la API exacto + el precio objetivo (cotejable contra la
    // columna "Precio final" del panel de ML) + señal '~' si el objetivo es >3% más profundo que tu precio
    // actual (posible candidata vieja — verificar en ML). La decisión es del usuario; el join nunca se bloquea.
    if (p.offerPrice > 0 && curEff > 0 && p.offerPrice < curEff * 0.97) approx = true
  }
  else if (p.max != null) reqSeller = Math.round((1 - p.max / list) * 1000) / 10       // banda: descuento mínimo p/entrar
  else reqSeller = 0                                                                    // ML fija todo (ej. MELI_ALL)
  const buyer = Math.round((reqSeller + meli) * 100) / 100
  const extra = currentSellerPct != null ? Math.round((reqSeller - currentSellerPct) * 100) / 100 : reqSeller
  const net = Math.round((meli - Math.max(0, extra)) * 100) / 100
  return { type: p.type || '', name: p.name || '', promotionId: p.promotionId || null, reqSeller, meli, buyer, extra, net, approx, base: (currentSellerPct != null ? currentSellerPct : null), target: (p.offerPrice > 0 ? p.offerPrice : null) }
}

// % MÁXIMO que financia el VENDEDOR hoy, entre las promos ACTIVAS (co-fondeada: seller_percentage; con
// boost: hasta el deal_price pre-boost; propia: el descuento entero). NO cuenta el aporte de ML. null si no
// hay activas. Es la base del "te cuesta" de las oportunidades (pedido de Martin): entrar cuesta lo que pide
// la campaña MENOS lo más profundo que YA financiamos de nuestro bolsillo.
export function maxOwnSellerPct(promos: MlPromo[] | null | undefined, list: number): number | null {
  if (!(list > 0)) return null
  let mx = null
  for (const x of (promos || [])) {
    if (!(x.status === 'started' || x.status === 'active') || !(x.offerPrice > 0)) continue
    let sp
    if (x.sellerPct != null) sp = x.sellerPct                                              // co-fondeada: lo que pone el vendedor
    else if (x.boosted && x.offerPrice > 0) sp = Math.round((1 - x.offerPrice / list) * 1000) / 10  // boost: hasta tu deal_price (ML pone el resto)
    else sp = Math.round((1 - ((x.boosted && x.boostedPrice > 0) ? x.boostedPrice : x.offerPrice) / list) * 1000) / 10  // propia: el descuento entero
    if (sp != null && (mx == null || sp > mx)) mx = sp
  }
  return mx
}

// ── Margen real por modelo (fila de la tabla de Costos → Margen) ────────────────────────────────────
// Margen NETO de IVA (responsable inscripto): el precio se netea (/IVA) y la comisión, el envío y la
// publicidad TAMBIÉN —su IVA es crédito fiscal recuperable, igual que el débito del precio—. El costo
// landed ya es neto. Las columnas muestran los valores BRUTOS (como los ves en ML); el margen los netea.
// Publicidad por unidad = gasto de ads del modelo (30d) / unidades vendidas del modelo (30d) → reparte
// la inversión entre TODAS las ventas (no solo las atribuidas a ads). Sin ads en el período = $0 (el
// margen se muestra SIN ads, no null); sin costo landed / comisión / envío → margen null ("cargá costo").
export const IVA = 1.21

// Costos reales por modelo (de ensureMlCosts) — valores BRUTOS como los reporta ML.
export interface MlCostRow { precioReal?: number | null; comisUnit?: number | null; comisionPct?: number | null; envio?: number | null; envN?: number; qty?: number }
// Publicidad del modelo (de ensureAdsCosts, 30d).
export interface AdsModel { cost?: number; acos?: number | null; roas?: number | null; units?: number; pubs?: number }

export function margenRealRow(c: MlCostRow, landed: number | null | undefined, adsM: AdsModel | null | undefined) {
  const price = c.precioReal || 0; const neto = price / IVA
  const comis = c.comisUnit                                   // bruto: lo que descuenta ML (incluye cuotas + IVA)
  const env = c.envio                                         // bruto: costo de envío neto de reintegro, con IVA
  const adsUnit = (adsM && c.qty) ? adsM.cost / c.qty : 0     // bruto: inversión de ads repartida por unidad vendida
  const comisNet = comis != null ? comis / IVA : null, envNet = env != null ? env / IVA : null, adsNet = adsUnit / IVA
  const margen = (price && landed != null && comisNet != null && envNet != null) ? (neto - landed - comisNet - envNet - adsNet) : null
  return { qty: c.qty, price, comisionPct: c.comisionPct, comis, env, envN: c.envN, landed, adsM, adsUnit, acos: adsM ? adsM.acos : null, margen, margenPct: (margen != null && neto) ? margen / neto * 100 : null }
}
