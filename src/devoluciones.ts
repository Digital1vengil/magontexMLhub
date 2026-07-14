// @ts-nocheck
// ParkaHub — módulo DEVOLUCIONES (Análisis). Por modelo: ventas del período, devoluciones por talle
// (grande/chico), % de devoluciones-talle sobre ventas (tasa de "cambio de talle" para decidir tablas
// de talles), motivos con %, y desglose por TALLE (expandible) para ver qué talle de cada modelo se
// devuelve más y por qué motivo. Data: /api/returns (Worker → D1) + ventas de VML_WEEKS (ya cargadas).
// REGLA: el modelo sale del SKU de la VENTA (resolver SKU↔modelo, igual que rsmBuild2), nunca de la
// publicación (se reusan); el SKU de cada devolución ya viene resuelto por la orden desde el Worker.
import { S } from './state'
import { apiGet, apiPost } from './api'
import { toast } from './core-ui'
import { vmlBaseCode } from './util'
import { makeSkuModelResolver, nrm } from './sku-resolver'
import { getWarehouse } from './warehouse-cache'

const FROM = '2026-03-01'
const FROM_TS = Date.parse(FROM + 'T00:00:00-03:00')

// ── Motivos: clasificación por reason_id (estable). cls maneja la barra/talle:
//   grande/chico = dirección de calce (en barra + cuentan p/ tasa de talle).
//   talle_guia   = "no coincide con la guía de talles" (talle, sin dirección; en barra gris).
//   otro_producto= "le mandamos un producto distinto al pedido" (ERROR DE ARMADO, NO es talle, FUERA de barra).
//   arrepentido / otro = no talle.
// Etiquetas con el texto EXACTO de ML (campo detail del reason) para que no haya ambigüedad. Los dos
// "no lo quiere" son distintos en la taxonomía de ML: PDD9939/9984 = arrepentido (dice que llegó bien
// pero no lo quiere); PDD9978 = catch-all "otro motivo" de moda (ML NO lo sub-clasifica; la causa real
// solo está en el mensaje del comprador, por reclamo).
const REASONS = {
  PDD9976: { label: 'Es más grande de lo que pensaba',                cls: 'grande' },
  PDD9977: { label: 'Es más chico de lo que pensaba',                 cls: 'chico' },
  PDD9962: { label: 'Las medidas no coinciden con la guía de talles', cls: 'talle_guia' },
  PDD9963: { label: 'No es el color/talle/modelo que pidió (producto distinto)', cls: 'otro_producto' },
  // "arrepentido" + "no lo quiere otro motivo" = lo mismo (comprador que recibió y no lo quiere; el texto
  // del comprador en los 129 PDD9978 era genérico "no quiere el producto"). Fusionados a pedido de Martin.
  PDD9939: { label: 'Se arrepintió / no lo quiere', cls: 'arrepentido' },
  PDD9984: { label: 'Se arrepintió / no lo quiere', cls: 'arrepentido' },
  PDD9978: { label: 'Se arrepintió / no lo quiere', cls: 'arrepentido' },
}
function classify(r){
  const k = REASONS[r.reason_id]; if (k) return k
  const n = String(r.reason_name || '').toLowerCase()
  if (n.includes('bigger') || n.includes('larger')) return { label:'Es más grande de lo que pensaba', cls:'grande' }
  if (n.includes('smaller')) return { label:'Es más chico de lo que pensaba', cls:'chico' }
  if (n.includes('size_guide') || n.includes('not_match_size')) return { label:'No coincide con la guía de talles', cls:'talle_guia' }
  // "distinto a lo pedido/publicado" (color/talle/modelo, item diferente, falso) = error de armado, NO talle.
  if (n.includes('different') || n.includes('fake') || n.includes('not_as_described') || n.includes('wrong_item')) return { label:'Le llegó un producto distinto al pedido', cls:'otro_producto' }
  if (n.includes('repentant') || n.includes('regret') || n.includes('dont_want') || n.includes('not_want')) return { label:'Se arrepintió / no lo quiere', cls:'arrepentido' }
  if (n.includes('broken') || n.includes('defect') || n.includes('damaged') || n.includes('fail')) return { label:'Producto con fallas', cls:'otro' }
  return { label: n ? titleCase(n.replace(/_/g,' ')) : 'Otro motivo', cls:'otro' }
}
const CLS_COLOR = { grande:'#ef4444', chico:'#3b82f6', talle_guia:'#9ca3af', otro_producto:'#a855f7', arrepentido:'#64748b', otro:'#cbd5e1' }
const talleClasses = ['grande','chico','talle_guia']            // lo que cuenta como "por talle"
const sizeFitOf = a => (a.grande||0) + (a.chico||0)             // grande+chico = calce (lo que pidió Martin)
const talleOf   = a => (a.grande||0) + (a.chico||0) + (a.talle_guia||0)

// ── Talle: del SKU (último token) o, si no, del variant. Normaliza 2XL→XXL etc. ──
const SIZE_RE = /^(xxxs|xxs|xs|s|m|l|xl|xxl|xxxl|xxxxl|[2-6]xl|\d{2,3})$/i
const SIZE_NORM = { '2XL':'XXL','3XL':'XXXL','4XL':'XXXXL','2XS':'XXS','3XS':'XXXS' }
const SIZE_ORDER = ['XXXS','XXS','XS','S','M','L','XL','XXL','XXXL','XXXXL']
const sizeIdx = t => { const i = SIZE_ORDER.indexOf(t); if (i>=0) return i; const n = parseInt(t,10); return isNaN(n) ? 999 : 100+n }
function extractTalle(sku, variant){
  let t = ''
  if (sku){ const p = String(sku).split('-'); const last = (p[p.length-1]||'').trim(); if (SIZE_RE.test(last)) t = last }
  if (!t && variant){ for (const tok of String(variant).split(/[\/,;|]/)){ const tt = tok.trim(); if (SIZE_RE.test(tt)){ t = tt; break } } }
  if (!t) return '—'
  t = t.toUpperCase(); return SIZE_NORM[t] || t
}

function byId(id){ return document.getElementById(id) }
function esc(s){ return String(s==null?'':s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;') }
function titleCase(s){ return String(s||'').replace(/\b\w/g, c=>c.toUpperCase()) }
function pct(n,d){ return d ? Math.round(100*n/d) : 0 }

// ── Resolver SKU→modelo + modelo→género (mismo criterio/fuente que rsmBuild2 en report.ts) ─────────
// El género sale del atributo GENDER del catálogo (warehouse), que es el de la PUBLICACIÓN: nunca
// cambia aunque se reuse la publicación con otro modelo adentro (lo que Martin remarcó). Devuelve
// { resolveModel(base)->modelo, genderOf(modelo)->'Hombre'|'Mujer'|'' }.
async function buildResolver(){
  let cat = [], master = {}
  try{ const res = await Promise.all([getWarehouse(), apiGet('/api/sku-master')])
    try{ cat = res[0] && res[0].catalog ? JSON.parse(res[0].catalog) : [] }catch(e){}
    try{ master = res[1] && res[1].data ? (typeof res[1].data==='string'?JSON.parse(res[1].data):res[1].data) : {} }catch(e){}
  }catch(e){}
  // resolutor SKU→modelo COMPARTIDO (sku-resolver.ts) — mismo criterio que rsmBuild2, antes duplicado acá.
  const model2gender = {}
  ;(cat||[]).forEach(it=>{ const m=nrm(it.model); if(m && it.gender && !model2gender[m]) model2gender[m]=it.gender })
  return {
    resolveModel: makeSkuModelResolver(master, S.PC_PRODUCTS),
    genderOf: model => { const g=model2gender[nrm(model)]||''; return g==='Mujer'?'Mujer':(g==='Hombre'?'Hombre':'') },
  }
}

// ── Ventas por modelo y por modelo+talle (VML_WEEKS, ventana desde FROM) ─────────────────────────
function weekTs(w){
  if (w && typeof w._ts==='number' && w._ts) return w._ts
  const lab = String((w&&w.label)||'')
  let m = lab.match(/(\d{2})\/(\d{2})\/(\d{2})\s*$/)            // fin "DD/MM/YY"
  if (m) return Date.parse('20'+m[3]+'-'+m[2]+'-'+m[1]+'T00:00:00-03:00')
  m = lab.match(/^(\d{2})\/(\d{2})/)
  return m ? Date.parse('2026-'+m[2]+'-'+m[1]+'T00:00:00-03:00') : 0
}
function computeSales(resolveModel){
  const byModel = {}, byModelTalle = {}
  let total = 0, weeks = 0
  ;(S.VML_WEEKS||[]).forEach(w=>{
    const ts = weekTs(w)
    if (ts && ts < FROM_TS) return                              // fuera de la ventana
    weeks++
    Object.keys((w&&w.skus)||{}).forEach(sku=>{
      const qty = w.skus[sku]||0
      const base = vmlBaseCode(String(sku).toLowerCase().replace(/\s+/g,'-'))
      const key = resolveModel(base) || base || '(sin sku)'
      byModel[key] = (byModel[key]||0) + qty
      const tl = extractTalle(sku, '')
      byModelTalle[key+'||'+tl] = (byModelTalle[key+'||'+tl]||0) + qty
      total += qty
    })
  })
  return { byModel, byModelTalle, total, weeks }
}

// ── Estado del módulo (cache para repintar sin re-fetch) ─────────────────────────────────────────
let _rows = null, _resolver = null, _dataTs = 0, _sync = null
const _open = {}
const RET_TTL = 10 * 60 * 1000   // /api/returns cambia solo con el sync (cada varias horas) → 10min evita re-bajarlo en cada entrada a la sección

// ── Sync resumible (incremental; rebuild total = ?reset=1 manual) ────────────────────────────────
async function devSyncML(){
  const btn=byId('dev-sync-btn'), ld=byId('dev-loading'), lt=byId('dev-loadtxt')
  if(btn) btn.disabled=true
  if(ld) ld.style.display='flex'
  try{
    let done=false, guard=0, total=0
    while(!done && guard<140){
      guard++
      const res=await apiPost('/api/ml/returns-sync?from='+FROM,{})
      if(!res || !res.ok) throw new Error(res && res.error ? res.error : 'Sin respuesta del servidor (¿token de ML vencido? Reconectá en /oauth/login)')
      total=res.totalRows||total
      done=!!res.done
      if(lt) lt.textContent='Sincronizando devoluciones… '+total+(done?'':' (sigue, '+(res.cursorMonth||'')+')')
      if(!done && !res.cursorMonth) break
    }
    toast('✓ '+total+' devoluciones sincronizadas','success')
    await renderDevoluciones(true)   // sync trajo data nueva → saltar el cache
  }catch(err){ toast('Error al sincronizar: '+err.message,'error'); console.error('[Devoluciones sync]',err) }
  if(ld) ld.style.display='none'
  if(btn) btn.disabled=false
}

// ── Entrada: trae la data y construye el resolver, luego pinta ──────────────────────────────────
// force=true salta el cache (lo usa el sync, que acaba de traer data nueva); la nav normal a la sección
// reusa _rows si está fresco (<RET_TTL) → no re-baja el payload en cada entrada.
async function renderDevoluciones(force){
  if(!force && _rows && (Date.now()-_dataTs < RET_TTL)){ if(!_rows.length){ const e=byId('dev-empty'),c=byId('dev-content'); if(e)e.style.display=''; if(c)c.style.display='none'; return } _resolver = _resolver || await buildResolver(); devPaint(); return }
  let data=null
  try{ data=await apiGet('/api/returns') }catch(e){}
  _rows = (data && data.rows) || []
  _sync = data && data.sync; _dataTs = Date.now()
  const sy = _sync
  const meta = byId('dev-sync-meta')
  const nCambio = _rows.filter(r=>String(r.type)==='change').length, nDevol = _rows.length - nCambio
  if (meta) meta.textContent = sy ? (nDevol.toLocaleString('es-AR')+' devoluciones'+(nCambio?(' + '+nCambio+' cambios'):'')+' · '+(sy.done?'al día':'incompleto — volvé a sincronizar')+(sy.updated_at?(' · '+String(sy.updated_at).slice(0,10)):'')) : ''
  const empty=byId('dev-empty'), content=byId('dev-content')
  if (!_rows.length){ if(empty)empty.style.display=''; if(content)content.style.display='none'; return }
  if (empty)empty.style.display='none'; if(content)content.style.display=''
  _resolver = await buildResolver()
  devPaint()
}

// ── Pinta todo desde la cache (rápido; lo llaman sort/minsample/toggle) ─────────────────────────
function devPaint(){
  if (!_rows) return
  const resolveModel = (_resolver && _resolver.resolveModel) || (()=> '')
  const genderOf = (_resolver && _resolver.genderOf) || (()=> '')
  const sales = computeSales(resolveModel)
  const hasSales = sales.total > 0
  // Ventas por género (para el % de calce sobre ventas de cada género)
  const salesByGender = { Hombre:0, Mujer:0, Otro:0 }
  Object.keys(sales.byModel).forEach(k=>{ const g = genderOf(k) || 'Otro'; salesByGender[g] += sales.byModel[k] })

  // Agregar devoluciones por modelo / talle / motivo / género
  const agg = {}, motivos = {}
  const G = { total:0, grande:0, chico:0, talle_guia:0, otro_producto:0, arrepentido:0, otro:0 }
  const byGender = { Hombre:{grande:0,chico:0,talle:0}, Mujer:{grande:0,chico:0,talle:0}, Otro:{grande:0,chico:0,talle:0} }
  const byGenderTalle = { Hombre:{}, Mujer:{}, Otro:{} }  // g -> talle -> {grande,chico}
  let dMin='', dMax=''
  for (const r of _rows){
    const m = classify(r)
    motivos[m.label] = motivos[m.label] || { label:m.label, cls:m.cls, n:0 }
    motivos[m.label].n++
    G.total++; G[m.cls] = (G[m.cls]||0) + 1
    const dc = r.date_created||''; if(dc){ if(!dMin||dc<dMin)dMin=dc; if(!dMax||dc>dMax)dMax=dc }
    const base = r.sku ? vmlBaseCode(String(r.sku).toLowerCase().replace(/\s+/g,'-')) : ''
    const model = base ? resolveModel(base) : ''
    const key = model || base || '(sin sku)'
    const label = model ? titleCase(model) : (base ? base.toUpperCase() : '(sin SKU)')
    // género del catálogo (estable por publicación); para la tendencia de calce global
    const g = (model ? genderOf(model) : '') || 'Otro'
    if (m.cls==='grande'){ byGender[g].grande++; byGender[g].talle++ }
    else if (m.cls==='chico'){ byGender[g].chico++; byGender[g].talle++ }
    else if (m.cls==='talle_guia'){ byGender[g].talle++ }
    let A = agg[key]; if (!A){ A = agg[key] = { key, label, total:0, grande:0, chico:0, talle_guia:0, otro_producto:0, arrepentido:0, otro:0, talles:{} } }
    A.total++; A[m.cls] = (A[m.cls]||0) + 1
    const tl = extractTalle(r.sku, r.variant)
    let T = A.talles[tl]; if (!T){ T = A.talles[tl] = { talle:tl, total:0, grande:0, chico:0, talle_guia:0, otro_producto:0, arrepentido:0, otro:0 } }
    T.total++; T[m.cls] = (T[m.cls]||0) + 1
    if (m.cls==='grande' || m.cls==='chico'){ const GT=byGenderTalle[g]||(byGenderTalle[g]={}); const cc=GT[tl]||(GT[tl]={grande:0,chico:0}); cc[m.cls]++ }
  }

  // ── Resumen global ──
  const gSizeFit = sizeFitOf(G)
  const gRate = hasSales ? (100*gSizeFit/sales.total) : null     // tasa de talle s/ventas
  const devRate = hasSales ? (100*G.total/sales.total) : null    // devoluciones (todas) s/ventas
  const rango = (dMin?dMin.slice(0,10):'?')+' → '+(dMax?dMax.slice(0,10):'?')
  const card=(label,val,sub,color)=>'<div class="card" style="flex:1;min-width:170px"><div class="card-body" style="padding:12px 16px">'
    +'<div style="font-size:11px;color:var(--text-muted)">'+label+'</div>'
    +'<div style="font-size:26px;font-weight:800;color:'+(color||'var(--text)')+';line-height:1.15">'+val+'</div>'
    +'<div style="font-size:11px;color:var(--text-soft)">'+sub+'</div></div></div>'
  // Tendencia de calce por género (card propio)
  const genVerd = o => { const sf=o.grande+o.chico; if(sf<10) return {t:'Poca muestra',c:'var(--text-muted)'}
    return o.grande>=o.chico*1.3 ? {t:'Corren GRANDE',c:'#dc2626'} : o.chico>=o.grande*1.3 ? {t:'Corren CHICO',c:'#0ea5e9'} : {t:'Equilibrado',c:'#16a34a'} }
  // % sobre las ventas de ESE género (grande/ventas-género y chico/ventas-género)
  const gp = (n,sv) => sv ? (100*n/sv).toFixed(1)+'%' : '—'
  const genLine = (lab,o,sv) => { const v=genVerd(o); return '<div style="margin-top:8px">'
    +'<div style="display:flex;justify-content:space-between;align-items:baseline;gap:8px">'
    +'<span style="font-size:12px;color:var(--text);font-weight:600">'+lab+'</span>'
    +'<span style="font-size:13px;font-weight:800;color:'+v.c+'">'+v.t+'</span></div>'
    +'<div style="font-size:10px;color:var(--text-soft);margin-top:2px">'
    +'<span style="color:#dc2626">↑ grande '+o.grande+' · '+gp(o.grande,sv)+'</span>'
    +' &nbsp;·&nbsp; <span style="color:#0ea5e9">↓ chico '+o.chico+' · '+gp(o.chico,sv)+'</span>'
    +' <span style="color:var(--text-muted)">(s/ '+(sv?sv.toLocaleString('es-AR'):'0')+' ventas)</span></div></div>' }
  const tendCard = '<div class="card" style="flex:1.6;min-width:260px"><div class="card-body" style="padding:12px 16px">'
    +'<div style="font-size:11px;color:var(--text-muted)">Tendencia de calce (por género) · % s/ventas del género</div>'
    + genLine('👨 Hombre', byGender.Hombre, salesByGender.Hombre) + genLine('👩 Mujer', byGender.Mujer, salesByGender.Mujer)
    + (byGender.Otro.grande+byGender.Otro.chico ? '<div style="font-size:10px;color:var(--text-muted);margin-top:6px">'+(byGender.Otro.grande+byGender.Otro.chico)+' sin género en el catálogo</div>' : '')
    +'</div></div>'
  byId('dev-summary').innerHTML =
      card('Ventas netas (período)', hasSales ? sales.total.toLocaleString('es-AR') : '—', hasSales ? rango+' · sin canceladas' : 'cargá ventas en Ventas ML')
    + card('Devoluciones', G.total.toLocaleString('es-AR'), devRate==null ? rango : (devRate.toFixed(1)+'% sobre ventas'))
    + card('Cambio de talle s/ventas', gRate==null ? '—' : (gRate.toFixed(1)+'%'), 'grande+chico ('+gSizeFit+') ÷ ventas', '#b45309')
    + tendCard

  // ── Motivos (detalle con %) ──
  const motList = Object.values(motivos).sort((a,b)=>b.n-a.n)
  byId('dev-motivos').innerHTML = motList.map(mo=>{
    const p = pct(mo.n, G.total)
    return '<div style="margin-bottom:7px">'
      +'<div style="display:flex;justify-content:space-between;font-size:12px;margin-bottom:2px">'
      +'<span style="color:var(--text)">'+esc(mo.label)+'</span>'
      +'<span style="font-weight:700;color:var(--text-soft)">'+mo.n.toLocaleString('es-AR')+' · '+p+'%</span></div>'
      +'<div style="height:6px;background:var(--border);border-radius:3px"><div style="height:100%;width:'+p+'%;background:'+(CLS_COLOR[mo.cls]||'#cbd5e1')+';border-radius:3px"></div></div></div>'
  }).join('')
    + '<div style="font-size:10px;color:var(--text-muted);margin-top:8px;border-top:1px solid var(--border);padding-top:8px;line-height:1.5">'
    + '<strong>Se arrepintió / no lo quiere</strong>: el comprador recibió el producto y no lo quiere (junta los motivos «arrepentido» y «otro motivo» de ML — verificado: el texto de esos casos era genérico «no quiere el producto»). <strong>Producto distinto</strong> = nos avisó que mandamos otra cosa (error de armado), NO es talle. Solo devoluciones y cambios <strong>post-entrega</strong>: las cancelaciones de compra (arrepentido ANTES de recibir) no entran acá.'
    + '</div>'
  byId('dev-motivos-sub').textContent = G.total.toLocaleString('es-AR')+' devoluciones · texto exacto de ML'

  // ── Calce por talle y género: matriz talle × (👨grande, 👨chico, 👩grande, 👩chico) ──
  // Cada celda = % de ese talle DENTRO de ese caso (columna normalizada). Lee hacia abajo una columna
  // para ver qué talles componen, p.ej., las 342 "grande" de Hombre → qué talle achicar en la tabla.
  const calce = byId('dev-calce')
  if (calce){
    const cols = [
      { g:'Hombre', c:'grande', lab:'👨 Grande', col:'#dc2626' },
      { g:'Hombre', c:'chico',  lab:'👨 Chico',  col:'#0ea5e9' },
      { g:'Mujer',  c:'grande', lab:'👩 Grande', col:'#dc2626' },
      { g:'Mujer',  c:'chico',  lab:'👩 Chico',  col:'#0ea5e9' },
    ]
    const totOf = cc => byGender[cc.g][cc.c] || 0
    const tset = {}; ['Hombre','Mujer'].forEach(g=>Object.keys(byGenderTalle[g]).forEach(t=>{ tset[t]=1 }))
    const talles = Object.keys(tset).sort((a,b)=>sizeIdx(a)-sizeIdx(b))
    if (!talles.length){ calce.innerHTML = '<div style="font-size:12px;color:var(--text-soft);padding:8px">Sin datos de calce por género (¿catálogo sin GENDER? se completa con el refresco del cron).</div>' }
    else {
      const head = '<table style="width:100%;border-collapse:collapse;font-size:12px"><thead><tr style="color:var(--text-muted);font-size:11px;border-bottom:1px solid var(--border)">'
        + '<th style="text-align:left;padding:6px 10px">Talle</th>'
        + cols.map(cc=>'<th style="text-align:center;padding:6px 8px;min-width:120px"><span style="color:'+cc.col+';font-weight:700">'+cc.lab+'</span> <span style="font-weight:400;color:var(--text-soft)">('+totOf(cc)+')</span></th>').join('')
        + '</tr></thead><tbody>'
      const body = talles.map(t=>{
        return '<tr style="border-bottom:1px solid var(--border)"><td style="padding:6px 10px;font-weight:700">'+esc(t)+'</td>'
          + cols.map(cc=>{
              const tot = totOf(cc), n = (byGenderTalle[cc.g][t] && byGenderTalle[cc.g][t][cc.c]) || 0
              const p = tot ? Math.round(100*n/tot) : 0
              if (!n) return '<td style="text-align:center;padding:6px 8px;color:var(--border)">·</td>'
              return '<td style="padding:6px 8px"><div style="display:flex;align-items:center;gap:5px">'
                + '<div style="flex:1;height:13px;background:var(--border);border-radius:3px;min-width:24px"><div style="height:100%;width:'+p+'%;background:'+cc.col+';border-radius:3px;opacity:.85"></div></div>'
                + '<span style="font-size:11px;font-weight:700;white-space:nowrap">'+p+'%</span>'
                + '<span style="font-size:10px;color:var(--text-muted);white-space:nowrap">('+n+')</span></div></td>'
            }).join('') + '</tr>'
      }).join('')
      calce.innerHTML = head + body + '</tbody></table>'
    }
  }

  // ── Tabla por modelo ──
  const minSample = Math.max(1, parseInt(byId('dev-minsample')?.value||'5',10)||5)
  const sortBy = byId('dev-sort')?.value || 'rate'
  // Tasa s/ventas: solo rankea modelos con ventas Y con muestra suficiente de talle (≥minSample);
  // los de poca muestra (ruido tipo 14 ventas / 3 devol) caen al fondo en vez de copar el top.
  const rateOf = a => { const v = sales.byModel[a.key]||0; const sf = sizeFitOf(a); return (v>0 && sf>=minSample) ? sf/v : -1 }
  let list = Object.values(agg)
  list.sort((a,b)=>{
    if (sortBy==='ventas') return (sales.byModel[b.key]||0)-(sales.byModel[a.key]||0)
    if (sortBy==='total')  return b.total-a.total
    if (sortBy==='talle')  return sizeFitOf(b)-sizeFitOf(a)
    if (sortBy==='grande') return b.grande-a.grande
    if (sortBy==='chico')  return b.chico-a.chico
    return rateOf(b)-rateOf(a)   // rate (default): mayor % talle s/ventas
  })
  byId('dev-table-sub').textContent = list.length+' modelos · '+G.total+' devoluciones'+(hasSales?'':' · sin ventas cargadas (la tasa s/ventas queda en —)')

  const head = '<table style="width:100%;border-collapse:collapse;font-size:13px"><thead><tr style="text-align:left;border-bottom:1px solid var(--border);color:var(--text-muted);font-size:11px">'
    +'<th style="padding:8px 12px">Modelo</th>'
    +'<th style="padding:8px 8px;text-align:center">Ventas</th>'
    +'<th style="padding:8px 8px;text-align:center">Devol.</th>'
    +'<th style="padding:8px 8px;text-align:center">Talle (G+C)</th>'
    +'<th style="padding:8px 8px;text-align:center">% talle s/ventas</th>'
    +'<th style="padding:8px 8px;min-width:150px">Calce</th>'
    +'<th style="padding:8px 12px">Veredicto</th></tr></thead><tbody>'
  const rowsHtml = list.map(a=>{
    const ventas = sales.byModel[a.key]||0
    const sf = sizeFitOf(a), rate = ventas ? (100*sf/ventas) : null
    const dir = a.grande+a.chico
    const verd = dir<minSample ? {t:'Poca muestra ('+dir+')',bg:'var(--surface2)',fg:'var(--text-soft)'} :
      a.grande>=a.chico*1.3 ? {t:'Corre grande',bg:'#fee2e2',fg:'#991b1b'} :
      a.chico>=a.grande*1.3 ? {t:'Corre chico',bg:'#e0f2fe',fg:'#075985'} : {t:'Equilibrado',bg:'#dcfce7',fg:'#166534'}
    const sw = v => a.total ? (100*v/a.total) : 0   // barra de calce = sobre las devoluciones del modelo (solo talle)
    const tot = a.total||1
    const bar = '<div style="display:flex;height:8px;border-radius:4px;overflow:hidden;background:var(--border)">'
      +'<div style="width:'+(100*a.grande/tot)+'%;background:#ef4444" title="grande '+a.grande+'"></div>'
      +'<div style="width:'+(100*a.chico/tot)+'%;background:#3b82f6" title="chico '+a.chico+'"></div>'
      +'<div style="width:'+(100*a.talle_guia/tot)+'%;background:#9ca3af" title="guía de talles '+a.talle_guia+'"></div>'
      +'</div>'
    const isOpen = !!_open[a.key]
    const rateCell = rate==null ? '<span style="color:var(--text-muted)">—</span>'
      : '<span style="font-weight:800;color:'+(rate>=15?'#dc2626':rate>=8?'#b45309':'var(--text)')+'">'+rate.toFixed(1)+'%</span>'
    const keyAttr = esc(a.key).replace(/"/g,'&quot;')
    return '<tr onclick="devToggle(&quot;'+keyAttr+'&quot;)" style="border-bottom:1px solid var(--border);cursor:pointer'+(isOpen?';background:var(--surface2)':'')+'">'
      +'<td style="padding:9px 12px"><span style="color:var(--text-muted);font-size:10px">'+(isOpen?'▾':'▸')+'</span> <span style="font-weight:700">'+esc(a.label)+'</span></td>'
      +'<td style="padding:9px 8px;text-align:center">'+(ventas?ventas.toLocaleString('es-AR'):'<span style="color:var(--text-muted)">—</span>')+'</td>'
      +'<td style="padding:9px 8px;text-align:center;font-weight:600">'+a.total+'</td>'
      +'<td style="padding:9px 8px;text-align:center;font-weight:700;color:#b45309">'+sf+'</td>'
      +'<td style="padding:9px 8px;text-align:center">'+rateCell+'</td>'
      +'<td style="padding:9px 8px">'+bar+'<div style="font-size:10px;color:var(--text-soft);margin-top:3px">↑'+a.grande+' · ↓'+a.chico+(a.talle_guia?(' · guía '+a.talle_guia):'')+'</div></td>'
      +'<td style="padding:9px 12px"><span class="badge" style="background:'+verd.bg+';color:'+verd.fg+'">'+verd.t+'</span></td></tr>'
      + (isOpen ? detailRow(a, sales) : '')
  }).join('')
  byId('dev-table').innerHTML = head + rowsHtml + '</tbody></table>'
}

// ── Fila expandida: desglose por TALLE de un modelo ──────────────────────────────────────────────
function detailRow(a, sales){
  const talles = Object.values(a.talles).sort((x,y)=> y.total - x.total)
  const inner = '<table style="width:100%;border-collapse:collapse;font-size:12px;background:var(--surface)">'
    +'<thead><tr style="text-align:left;color:var(--text-muted);font-size:10px;border-bottom:1px solid var(--border)">'
    +'<th style="padding:6px 10px">Talle</th><th style="padding:6px 8px;text-align:center">Ventas</th>'
    +'<th style="padding:6px 8px;text-align:center">Devol.</th><th style="padding:6px 8px;text-align:center">Grande</th>'
    +'<th style="padding:6px 8px;text-align:center">Chico</th><th style="padding:6px 8px;text-align:center">% talle s/ventas</th>'
    +'<th style="padding:6px 10px">Motivo principal</th></tr></thead><tbody>'
    + talles.map(t=>{
        const ventas = sales.byModelTalle[a.key+'||'+t.talle]||0
        const sf = sizeFitOf(t), rate = ventas ? (100*sf/ventas) : null
        // motivo principal del talle (la clase con más casos)
        const order = [['grande','Le quedó grande'],['chico','Le quedó chico'],['talle_guia','Guía de talles'],['otro_producto','Producto distinto'],['arrepentido','Arrepentido'],['otro','Otro']]
        let top = order[0], topN = -1
        for (const [c,lab] of order){ if ((t[c]||0) > topN){ topN = t[c]||0; top = [c,lab] } }
        const topPct = pct(topN, t.total)
        return '<tr style="border-bottom:1px solid var(--border)">'
          +'<td style="padding:6px 10px;font-weight:700">'+esc(t.talle)+'</td>'
          +'<td style="padding:6px 8px;text-align:center">'+(ventas?ventas.toLocaleString('es-AR'):'—')+'</td>'
          +'<td style="padding:6px 8px;text-align:center;font-weight:600">'+t.total+'</td>'
          +'<td style="padding:6px 8px;text-align:center;color:#dc2626">'+(t.grande||'·')+'</td>'
          +'<td style="padding:6px 8px;text-align:center;color:#0ea5e9">'+(t.chico||'·')+'</td>'
          +'<td style="padding:6px 8px;text-align:center;font-weight:700;color:'+(rate!=null&&rate>=15?'#dc2626':'var(--text)')+'">'+(rate==null?'—':rate.toFixed(1)+'%')+'</td>'
          +'<td style="padding:6px 10px"><span style="font-size:11px">'+esc(top[1])+'</span> <span style="font-size:10px;color:var(--text-muted)">'+topPct+'%</span></td></tr>'
      }).join('')
    + '</tbody></table>'
  return '<tr><td colspan="7" style="padding:0 12px 12px 12px;background:var(--surface2)"><div style="border:1px solid var(--border);border-radius:8px;overflow:hidden">'
    + '<div style="font-size:11px;color:var(--text-muted);padding:8px 10px">Desglose por talle de <strong>'+esc(a.label)+'</strong> — qué talle se devuelve más y por qué (orden: más devoluciones primero)</div>'
    + inner + '</div></td></tr>'
}

function devToggle(key){ _open[key] = !_open[key]; devPaint() }

// --- window-expose (el HTML llama por onclick/onchange/oninput) ---
try{ window.devSyncML=devSyncML }catch(e){}
try{ window.renderDevoluciones=renderDevoluciones }catch(e){}
try{ window.devPaint=devPaint }catch(e){}
try{ window.devToggle=devToggle }catch(e){}

export { renderDevoluciones }
