// @ts-nocheck
// ParkaHub — módulo PROMOS: gestión masiva de promociones de Mercado Libre.
// Panel de promos activas + cargar publicaciones (por título/modelo o SKU) → ver imagen/título/n°/precio/
// cuotas (Premium=con / Clásica=sin) + TODAS sus promos → salir de todas, o re-aplicar por cuotas
// (Premium % / Clásica %) con preview (dry-run) antes de escribir. Worker: /api/ml/promos, promo-resolve, promo-bulk.
import { S } from './state'
import { toast } from './core-ui'
import { apiGet, apiPost, apiPut, apiPostEx } from './api'
import { calcCostoARS } from './costs'
import { setLive, liveStateFor } from './live'
import { bestActivePromo, campaignOpp, maxOwnSellerPct, margenRealRow } from './promo-math'
import { acceptPriceBlob } from './price-blob'   // sv-gate del blob de precios (fuente única del criterio; ver price-blob.ts)
import { stockMode, daysOfStock, conversionRate } from './inventory-math'   // MODA/días inv./conversión (métricas 4-6)
import { getWarehouse, invalidateWarehouse } from './warehouse-cache'
import { makeSkuModelResolver } from './sku-resolver'   // MISMO resolver SKU→modelo que Devoluciones/rsmBuild
import { vmlBaseCode, titleSuggest } from './util'

function esc(s){ return String(s==null?'':s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }
function money(n){ return n==null ? '—' : '$'+Math.round(n).toLocaleString('es-AR'); }
// % con 1 decimal y COMA (rioplatense): 60.7 → "60,7", 60 → "60" (sin decimal de relleno).
function pct(n){ if(n==null) return '—'; const r=Math.round(n*10)/10; return String(r).replace('.',','); }
// 2 decimales EXACTOS (pedido de Martin: "evitá redondear" en lo que cuesta entrar — 0,04 y 0,1 son decisiones distintas)
function pct2(n){ if(n==null) return '—'; const r=Math.round(n*100)/100; return String(r).replace('.',','); }
function agoTxt(ts){ if(!ts) return ''; const m=Math.round((Date.now()-ts)/60000); return m<1?'recién':(m<60?('hace '+m+' min'):(m<1440?('hace '+Math.round(m/60)+' h'):('hace '+Math.round(m/1440)+' d'))); }
// Link a la EDICIÓN de la publicación en ML (el formulario de modificar del vendedor), NO la vista del
// comprador. Usado en TODO el apartado Incongruencias. `target` = el item_id real a editar (para familias,
// el primer item_id; familyId no es editable); `num` = lo que se muestra (#familia o #ítem).
function mlEditUrl(id){ const n=String(id).replace(/^MLA-?/,''); return 'https://www.mercadolibre.com.ar/publicaciones/MLA'+n+'/modificar'; }
function mlEditA(num, target){ return '<a href="'+mlEditUrl(target!=null?target:num)+'" target="_blank" rel="noopener" title="Abrir la edición de la publicación en Mercado Libre" style="color:#0ea5e9;text-decoration:none">#'+esc(num)+'</a>'; }
// Link a la página de PROMOCIONES de una publicación (donde se ven/gestionan sus campañas), NO la edición.
// Lo usa el apartado Precios: ahí todo gira en torno a promos/descuentos. `search` = el id SIN prefijo (solo
// dígitos): MLA851262957 → 851262957.
function mlPromosUrl(id){ const n=String(id).replace(/\D/g,''); return 'https://www.mercadolibre.com.ar/publicaciones/listado/promos?page=1&search='+n; }
// Link a la publicación + botoncito COPIAR (pedido de Martin: copiar el número para pegarlo en el buscador
// del panel de ML, que usa los dígitos sin "MLA"). Aparece en TODAS las secciones porque todas linkean por acá.
function mlPromosA(num, target){
  const digits=String(target!=null?target:num).replace(/\D/g,'');
  return '<a href="'+mlPromosUrl(target!=null?target:num)+'" target="_blank" rel="noopener" title="Abrir las promociones de esta publicación en Mercado Libre" style="color:#0ea5e9;text-decoration:none">#'+esc(num)+'</a>'
    + '<span onclick="pubIdCopy(\''+esc(digits)+'\',this)" title="Copiar el número ('+esc(digits)+') para pegarlo en el buscador de ML" style="cursor:pointer;margin-left:3px;color:var(--text-soft);font-size:11px;user-select:none">⧉</span>';
}
function pubIdCopy(digits, el){
  const done=()=>{ if(el){ const t=el.textContent; el.textContent='✓'; el.style.color='#16a34a'; setTimeout(()=>{ el.textContent=t; el.style.color=''; },1200); } };
  try{ navigator.clipboard.writeText(digits).then(done).catch(()=>{ fallback(); }); }
  catch(e){ fallback(); }
  function fallback(){ try{ const ta=document.createElement('textarea'); ta.value=digits; document.body.appendChild(ta); ta.select(); document.execCommand('copy'); document.body.removeChild(ta); done(); }catch(e){ toast('No pude copiar','error'); } }
}
try{ window.pubIdCopy=pubIdCopy; }catch(e){}

const TIPO_LABEL = {
  DEAL:'Campaña ML', DOD:'Oferta del día', LIGHTNING:'Relámpago', SMART:'Co-participación',
  MARKETPLACE_CAMPAIGN:'Co-fondeada', PRE_NEGOTIATED:'Pre-negociada', PRICE_DISCOUNT:'Descuento propio',
  SELLER_CAMPAIGN:'Campaña propia', VOLUME:'Por cantidad', SELLER_COUPON_CAMPAIGN:'Cupón',
  PRICE_MATCHING:'Precio competitivo', UNHEALTHY_STOCK:'Liquidación stock',
};


// bestActivePromo / campaignOpp / maxOwnSellerPct / margenRealRow viven en promo-math.ts (módulo PURO,
// testeado por promo-math.test.ts) — movidas TAL CUAL, la doc de dominio viajó con ellas.

// ── Panel: tus promociones activas ─────────────────────────────────────────────
let _promosCache = null;
let _promoCounts = null, _promoCountsTs = 0;   // {promotionId:{enrolled,candidate,started,pending}} → conteos por promo (los carga ensureCampaignAlerts)
async function renderPromosPanel(force){
  const el = document.getElementById('promo-list');
  if(!el) return;
  if(!_promosCache || force){
    el.innerHTML = '<div style="color:var(--text-soft);font-size:13px;padding:6px">Cargando…</div>';
    let r=null; try{ r = await apiGet('/api/ml/promos'); }catch(e){ console.error('[Promos] panel', e); }
    if(r && r.ok){ _promosCache = r.promos || []; }
    else{
      // El Worker ahora devuelve 502 si ML falla (no 200-vacío): error EXPLÍCITO, no "sin promos"
      // (que se confundía con "no tenés promos"). No cacheamos el fallo → el botón reintenta.
      el.innerHTML = '<div style="color:#dc2626;font-size:13px;padding:6px">No pude cargar las promociones (error de Mercado Libre). <button onclick="window.renderPromosPanel(true)" style="margin-left:6px;font-size:12px;cursor:pointer">Reintentar</button></div>';
      const cntE = document.getElementById('promo-list-count'); if(cntE) cntE.textContent = '—';
      return;
    }
  }
  const ps = (_promosCache || []).slice();
  const cnt = document.getElementById('promo-list-count'); if(cnt) cnt.textContent = ps.length+' activas';
  if(!ps.length){ el.innerHTML = '<div style="color:var(--text-soft);font-size:13px;padding:6px">Sin promociones activas.</div>'; return; }
  // ORDEN POR PRIORIDAD (pedido de Martin 3/7): primero las campañas donde hay algo para hacer —
  // con candidatas sin sumar (más candidatas = más arriba), NUEVAS antes que conocidas; después el resto.
  // Los conteos los carga ensureCampaignAlerts en 2do plano y re-renderiza → el orden se acomoda solo.
  ps.sort((a,b)=>{
    const ca=(_promoCounts&&_promoCounts[a.id]&&_promoCounts[a.id].candidate)||0;
    const cb=(_promoCounts&&_promoCounts[b.id]&&_promoCounts[b.id].candidate)||0;
    if((ca>0)!==(cb>0)) return ca>0?-1:1;
    const na=isNewPromo(String(a.id))?1:0, nb=isNewPromo(String(b.id))?1:0;
    if(na!==nb) return nb-na;
    return cb-ca;
  });
  // Status en español (ML devuelve started/pending/finished en inglés). pending = programada: ya está cargada
  // pero todavía no arrancó; ML la activa en su fecha de inicio (típico de campañas estacionales).
  const STATUS_ES = { started:'Activa', pending:'Programada', finished:'Finalizada' };
  const STATUS_TIP = { started:'Corriendo ahora.', pending:'Programada: ya está cargada pero todavía no arrancó — Mercado Libre la activa en su fecha de inicio.', finished:'Ya terminó.' };
  el.innerHTML = '<div style="display:flex;flex-direction:column;gap:5px">'+ps.map(p=>{
    const st = String(p.status||'').toLowerCase();
    const lbl = STATUS_ES[st] || p.status || '';
    const bg = st==='started'?'#dcfce7':(st==='pending'?'#fef9c3':'#f1f5f9');
    const fg = st==='started'?'#166534':(st==='pending'?'#854d0e':'#475569');
    const startTxt = (st==='pending' && p.start_date) ? (' · arranca '+String(p.start_date).slice(0,10)) : '';
    const finTxt = p.finish_date ? (' · hasta '+String(p.finish_date).slice(0,10)) : '';
    // conteos por promo (a cuántas podrías sumar con tu descuento): los carga ensureCampaignAlerts en segundo plano
    const c = _promoCounts && _promoCounts[p.id];
    const pausedOut = c ? Math.max(0,(c.candidateTotal||0)-(c.candidate||0)) : 0;   // candidatas pausadas que NO cuento
    const sumTip = 'Publicaciones ACTIVAS elegibles sin este descuento'+(pausedOut?(' — excluyo '+pausedOut+' pausadas/inactivas que ML igual lista como candidatas'):'');
    const countsTxt = c ? ('<div style="font-size:11px;color:var(--text-muted);margin-top:1px"><b>'+c.enrolled+'</b> anotadas'+((c.candidate||0)>0?(' · <b style="color:#dc2626" title="'+esc(sumTip)+'">'+c.candidate+'</b> sin sumar'):'')+'</div>') : '';
    // NUEVA = apareció hace <7 días (promo_seen del cron) y todavía no la abriste (ack en localStorage).
    const isNew = isNewPromo(String(p.id));
    const newBadge = isNew ? ' <span class="badge" style="background:#dc2626;color:#fff;font-weight:700">NUEVA</span>' : '';
    // "Ver ofertas": expande la campaña acá mismo con TODAS sus candidatas tildables + entrada masiva
    // (unifica el viejo tab Pendientes). Solo para activas/programadas con candidatas.
    const expandBtn = (c && (c.candidate||0)>0)
      ? '<button class="btn btn-sm" onclick="promoExpand(\''+esc(p.id)+'\',\''+esc(String(p.type||''))+'\')" style="background:#0ea5e9;color:#fff;border-color:#0ea5e9;font-weight:600;white-space:nowrap">Ver ofertas ('+c.candidate+')</button>' : '';
    return '<div style="background:var(--surface2);border-radius:6px;padding:7px 10px">'
      + '<div style="display:flex;justify-content:space-between;align-items:center;gap:10px">'
      + '<div style="min-width:0;flex:1"><div style="font-size:13px;font-weight:600;color:var(--text);overflow:hidden;text-overflow:ellipsis;white-space:nowrap">'+esc(p.name||TIPO_LABEL[p.type]||p.type)+newBadge+'</div>'
      + '<div style="font-size:11px;color:var(--text-muted)">'+esc(TIPO_LABEL[p.type]||p.type)+startTxt+finTxt+'</div>'+countsTxt+'</div>'
      + expandBtn
      + '<span class="badge" title="'+esc(STATUS_TIP[st]||'')+'" style="background:'+bg+';color:'+fg+'">'+esc(lbl)+'</span></div>'
      + '<div id="pexp-'+esc(p.id)+'"></div>'
      + '</div>';
  }).join('')+'</div>';
  if(!_promoSeen) ensurePromoSeen().then(()=>{ try{ renderPromosPanel(); }catch(e){} });
  updNuevasBadge();
}

// ── Cargar publicaciones ────────────────────────────────────────────────────────
let _items = [];     // publicaciones resueltas (con promos/precio/cuotas)
let _plan = {};      // resultado del dry-run por itemId
let _catalog = [];   // índice del catálogo: {id, title, model, skus, status}

const norm = s => String(s||'').toLowerCase().trim();

// Índice del catálogo: ML no filtra por atributo ni por prefijo de SKU, así que bajamos id+título+MODELO+SKUs
// de todas las publicaciones (active+paused) y matcheamos del lado del cliente. Cacheado 6h en localStorage.
// OJO (ver memoria parka-publication-reuse): reutilizan publicaciones (mismo item_id, otra campera adentro),
// así que el modelo/SKU de una publicación cambia. El índice cacheado se vuelve viejo → TTL corto (1h) +
// mostramos antigüedad + botón Reindexar. La verdad ACTUAL por card sale del resolve en vivo (título/imagen).
let _catalogTs = 0;
// Almacén COMPARTIDO en D1 (warehouse): catálogo + ventas precomputados. getWarehouse/invalidateWarehouse
// viven en warehouse-cache.ts — memo de 5 min COMPARTIDO por TODOS los módulos (antes cada uno lo bajaba
// aparte). Tras subir un scan fresco: invalidateWarehouse() para que todos re-bajen.
async function ensureCatalog(force){
  // Memoria: reuso corto (5 min) — el almacén ahora se parchea EN VIVO (webhook de ML + item-update),
  // así que conviene re-mirar su timestamp seguido (getWarehouse ya cachea 5 min: costo ~cero).
  if(!force && _catalog.length && (Date.now()-_catalogTs < 5*60*1000)) { showIdxAge(); return; }
  if(!force){
    let loc=null; try{ const c=JSON.parse(localStorage.getItem('parka_promo_catalog_v2')||'null'); if(c && c.items && c.items.length) loc=c; }catch(e){}
    // ALMACÉN COMPARTIDO primero si es MÁS NUEVO que el cache local: una edición de hace segundos
    // (webhook/item-update) se ve sin Reindexar. Si el local es más nuevo (<60min), gana el local.
    let wcat=null, wts=0;
    try{ const w=await getWarehouse(); const cat = w && w.catalog ? JSON.parse(w.catalog) : [];
      if(cat && cat.length){ wcat=cat; wts = w.tsCat ? Date.parse(w.tsCat)||0 : 0; } }catch(e){}
    if(wcat && (!loc || wts > loc.ts)){ _catalog=wcat; _catalogTs=wts||Date.now(); try{ localStorage.setItem('parka_promo_catalog_v2', JSON.stringify({ts:_catalogTs, items:wcat})); }catch(e){} showIdxAge(); return; }
    if(loc && (Date.now()-loc.ts < 60*60*1000)){ _catalog=loc.items; _catalogTs=loc.ts; showIdxAge(); return; }
    if(wcat){ _catalog=wcat; _catalogTs=wts||Date.now(); showIdxAge(); return; }
  }
  const lt=document.getElementById('promo-loadtxt');
  let all=[];
  for(const st of ['active','paused','under_review']){
    let offset=0, done=false, g=0;
    while(!done && g<40){ g++;
      const r = await apiGet('/api/ml/catalog?status='+st+'&offset='+offset);
      if(!r || !r.ok) throw new Error('índice: '+(r && r.error || 'sin respuesta'));
      all=all.concat(r.items||[]); offset=r.nextOffset; done=!!r.done;
      if(lt) lt.textContent='Indexando catálogo… '+all.length;
      if(!done && offset==null) break;
    }
  }
  _catalog=all; _catalogTs=Date.now();
  try{ localStorage.setItem('parka_promo_catalog_v2', JSON.stringify({ts:_catalogTs, items:all})); }catch(e){}
  invalidateWarehouse(); apiPost('/api/warehouse', { catalog: all }).then(ok=>{ if(ok==null) toast('No pude actualizar el almacén compartido (catálogo) — queda local','info'); });   // compartir con todos
  showIdxAge();
}
function showIdxAge(){
  const el=document.getElementById('promo-idx-age'); if(!el || !_catalogTs) return;
  const min=Math.round((Date.now()-_catalogTs)/60000);
  el.textContent='índice: '+_catalog.length+' pub · '+(min<1?'recién':('hace '+min+' min'))+(min>=45?' (conviene reindexar)':'');
}

// SKU → MODELO desde el EXCEL MAESTRO ("sku y modelos.xlsx": columnas SKU + Nombre Modelo). El SKU SIEMPRE
// está bien; el modelo en atributos de ML es ~97%. Se carga con el botón "Cargar SKU↔modelo" y queda en
// localStorage. Al buscar un SKU lo resolvemos al MODELO y traemos TODAS las publicaciones con ese modelo
// (atributo = verdad, aunque el título esté viejo). Match por prefijo con borde: "w-8" pega "w-8-blk".
let _skuMaster = null;
// Maestro COMPARTIDO en D1 (lo ven todos los usuarios). localStorage = cache de arranque, D1 = fuente de verdad.
async function ensureSkuMaster(force){
  if(_skuMaster && !force) return;
  if(!_skuMaster){ try{ _skuMaster = JSON.parse(localStorage.getItem('parka_sku_master')||'null'); }catch(e){} }
  try{
    const r = await apiGet('/api/sku-master');
    if(r && r.data){
      const m = typeof r.data==='string' ? JSON.parse(r.data) : r.data;
      if(m && Object.keys(m).length){ _skuMaster = m; try{ localStorage.setItem('parka_sku_master', JSON.stringify(m)); }catch(e){} }
    }
  }catch(e){}
  if(!_skuMaster) _skuMaster = {};
}

// Ventas por item_id de los últimos 14 días (para "días de inventario"). Endpoint resumible día-por-día;
// loopeamos hasta done y cacheamos 3h (las ventas cambian a diario, no por minuto).
let _sales2w = null, _sales2wComplete = false, _sales2wTs = 0;   // _sales2wTs = antigüedad real de las ventas (gate de frescura de la conversión)
async function ensureSales2w(force){
  // Solo reusar de memoria si el scan previo se COMPLETÓ. Si quedó parcial (un batch falló), reintentar
  // —antes un scan parcial se quedaba pegado toda la sesión, subcontando ventas/días de inventario—.
  if(_sales2w && _sales2wComplete && !force) return;
  if(!force){
    // Elegir el MÁS FRESCO entre el cache local y el almacén compartido (mismo criterio que ensureCatalog).
    // ANTES el local <3h ganaba SIEMPRE, aunque el cron hubiera dejado ventas más nuevas en el almacén →
    // servíamos ventas viejas y el TTL las congelaba. Ahora el almacén gana si su tsSales es posterior.
    let loc=null; try{ const c=JSON.parse(localStorage.getItem('parka_sales2w')||'null'); if(c && c.byItem && Object.keys(c.byItem).length) loc=c; }catch(e){}
    let wsales=null, wts=0;
    try{ const w=await getWarehouse(); const s = w && w.sales ? JSON.parse(w.sales) : null;
      if(s && Object.keys(s).length){ wsales=s; wts = w.tsSales ? Date.parse(w.tsSales)||0 : 0; } }catch(e){}
    // NO rejuvenecer el ts con Date.now(): preservamos la antigüedad real (tsSales) para que el TTL expire.
    // ts ESTRICTO (sin `|| Date.now()`): si el almacén no trae tsSales, wts=0 → _sales2wTs=0 → la
    // conversión se calla (mismo criterio que el Radar `_psalesTs`). Rejuvenecerlo a "ahora" fingía
    // frescura y reabría el bug de >100% (ventas viejas / visitas frescas). Preserva la antigüedad real.
    if(wsales && (!loc || wts > (loc.ts||0))){ _sales2w=wsales; _sales2wComplete=true; _sales2wTs=wts; try{ localStorage.setItem('parka_sales2w', JSON.stringify({ts:wts, byItem:wsales})); }catch(e){} return; }
    if(loc && (Date.now()-loc.ts < 3*60*60*1000)){ _sales2w=loc.byItem; _sales2wComplete=true; _sales2wTs=loc.ts||0; return; }
    if(wsales){ _sales2w=wsales; _sales2wComplete=true; _sales2wTs=wts; return; }
  }
  const lt=document.getElementById('promo-loadtxt');
  const merged = {}; let from=null, done=false, guard=0, failed=false;
  while(!done && guard<8){ guard++;
    if(lt) lt.textContent='Trayendo ventas de 14 días… '+Object.keys(merged).length;
    const r = await apiGet('/api/ml/sales-2w'+(from?('?from='+encodeURIComponent(from)):''));
    if(!r || !r.ok){ failed=true; break; }   // distinguir "falló" de "terminó" (antes ambos cortaban igual)
    for(const k in (r.byItem||{})) merged[k]=(merged[k]||0)+r.byItem[k];
    from = r.nextFrom; done = !!r.done || !from;
  }
  _sales2w = merged;   // para la sesión usamos lo que juntamos (parcial es mejor que nada)
  _sales2wComplete = done && !failed;   // si quedó parcial, la próxima llamada (sin force) reintenta
  _sales2wTs = Date.now();              // scan en vivo → ventas fresquísimas
  // Solo cacheamos en localStorage y subimos al almacén COMPARTIDO si el scan se COMPLETÓ. Si falló a
  // mitad, no persistimos parcial: Gonzalo vería ventas subcontadas como verdad y el TTL las congelaría.
  if(done && !failed){
    try{ localStorage.setItem('parka_sales2w', JSON.stringify({ts:Date.now(), byItem:merged})); }catch(e){}
    invalidateWarehouse(); apiPost('/api/warehouse', { sales: merged }).then(ok=>{ if(ok==null) toast('No pude actualizar el almacén compartido (ventas) — quedan locales','info'); });
  }
}


// Visitas (14d) por item_id, para conversión. ML solo deja 1 ítem por llamada; el endpoint loopea (cap 40).
// Cache COMPARTIDO entre secciones vía localStorage `parka_visits_v1` (6h — las visitas 14d se mueven
// lento): la MISMA clave que usa Publicaciones/Radar → traerlas una vez sirve a toda la app. En memoria
// solo se agrega lo que falta; a disco van solo los valores reales (un null = "no pude ahora", se reintenta).
let _visits = {};
let _visitsSeeded = false;
function visitsSeed(){
  if(_visitsSeeded) return; _visitsSeeded = true;
  try{ const c=JSON.parse(localStorage.getItem('parka_visits_v1')||'null'); if(c&&c.byItem&&(Date.now()-(c.ts||0)<6*60*60*1000)) _visits={...c.byItem, ..._visits}; }catch(e){}
}
function visitsPersist(){
  // MERGE con lo ya guardado (otro módulo pudo haber agregado entradas que esta copia en memoria no tiene
  // — pisarlo las borraría) + conservar el ts MÁS VIEJO aún válido (re-estamparlo alargaba la vida del TTL).
  try{
    let prev={}, prevTs=Date.now();
    try{ const c=JSON.parse(localStorage.getItem('parka_visits_v1')||'null'); if(c&&c.byItem&&(Date.now()-(c.ts||0)<6*60*60*1000)){ prev=c.byItem; prevTs=c.ts||prevTs; } }catch(e){}
    const clean={...prev}; for(const k in _visits){ if(_visits[k]!=null) clean[k]=_visits[k]; }
    localStorage.setItem('parka_visits_v1', JSON.stringify({ts:Math.min(prevTs, Date.now()), byItem:clean}));
  }catch(e){}
}
// Antes de pegarle a ML: sembrar del ALMACÉN compartido (blob `visits` que precomputa el cron, TTL 26h
// — se refresca a diario). Una sola vez por sesión; solo valores reales (null = no pudo, se pide en vivo).
let _visitsWhTried = false;
async function visitsSeedWarehouse(){
  if(_visitsWhTried) return; _visitsWhTried = true;
  try{ const r=await apiGet('/api/warehouse?part=visits'); const v=r&&r.visits?JSON.parse(r.visits):null; const ts=r&&r.tsVisits?Date.parse(r.tsVisits):0;
    if(v && (Date.now()-ts) < 26*60*60*1000){ for(const k in v){ if(v[k]!=null && !(k in _visits)) _visits[k]=v[k]; } visitsPersist(); } }catch(e){}
}
async function ensureVisits(ids){
  visitsSeed();
  if([...new Set(ids)].some(id => !(id in _visits))) await visitsSeedWarehouse();
  const want = [...new Set(ids)].filter(id => !(id in _visits));
  if(!want.length) return;
  const lt=document.getElementById('promo-loadtxt');
  for(let i=0;i<want.length;i+=40){
    const batch = want.slice(i,i+40);
    if(lt) lt.textContent='Trayendo visitas… '+i+'/'+want.length;
    const r = await apiGet('/api/ml/visits?ids='+encodeURIComponent(batch.join(',')));
    if(r && r.ok && r.visits){ Object.assign(_visits, r.visits); }
    else { batch.forEach(id=>{ if(!(id in _visits)) _visits[id]=null; }); }
  }
  visitsPersist();
}
function skuToModels(t){
  const master = _skuMaster || {};
  // Normalizamos IGUAL que las claves del maestro: separadores→guión, colapsar, y SIN guión final
  // (los SKU del Excel vienen como "PUFCOMBI-BLK-" con guión al final → sin esto, el match exacto fallaba).
  const tt = String(t).replace(/\s+/g,'-').replace(/-+/g,'-').replace(/-+$/,'');
  if(!tt) return [];
  const out = new Set();
  for(const sku in master){
    // exacto (pufcombi-blk) · término model-level → claves color-level (pufcombi → pufcombi-blk) ·
    // término más largo que la clave (pufcombi-blk-m con talle → clave pufcombi-blk)
    if(sku===tt || sku.startsWith(tt+'-') || tt.startsWith(sku+'-')) out.add(master[sku]);
  }
  return [...out];
}
// Normaliza y guarda el mapa {sku: modelo} (lower, espacios→guión, sin guión final) + lo SUBE A D1 (compartido).
function promoSetSkuMaster(raw){
  const m = {};
  for(const k in raw){ const sku=norm(k).replace(/\s+/g,'-').replace(/-+/g,'-').replace(/-+$/,''); const mod=norm(raw[k]); if(sku && mod) m[sku]=mod; }
  _skuMaster = m;
  try{ localStorage.setItem('parka_sku_master', JSON.stringify(m)); }catch(e){}
  try{ apiPut('/api/sku-master', { data: JSON.stringify(m) }); }catch(e){}  // compartir con todos via D1 (fire-and-forget)
  return { skus: Object.keys(m).length, modelos: new Set(Object.values(m)).size };
}
// Carga el maestro desde el Excel (ART · SKU · Nombre Modelo) con la lib XLSX (CDN, ya cargada).
function promoLoadSkuMaster(file){
  if(!file) return;
  const fr = new FileReader();
  fr.onload = (ev) => {
    try{
      const wb = XLSX.read(new Uint8Array(ev.target.result), {type:'array'});
      const ws = wb.Sheets[wb.SheetNames[0]];
      const rows = XLSX.utils.sheet_to_json(ws, {defval:''});
      if(!rows.length){ toast('El Excel está vacío','error'); return; }
      const cols = Object.keys(rows[0]);
      const kSku = cols.find(c=>/sku/i.test(c));
      const kMod = cols.find(c=>/modelo|model/i.test(c));
      if(!kSku || !kMod){ toast('No encontré columnas SKU y Modelo en el Excel','error'); return; }
      const raw = {}; rows.forEach(r=>{ if(r[kSku] && r[kMod]) raw[r[kSku]] = r[kMod]; });
      const res = promoSetSkuMaster(raw);
      toast('✓ Maestro cargado: '+res.skus+' SKU · '+res.modelos+' modelos','success');
    }catch(e){ toast('Error leyendo Excel: '+e.message,'error'); console.error('[Promos] skuMaster', e); }
  };
  fr.readAsArrayBuffer(file);
}

// Alias SKU-base → término de búsqueda. El SKU NO está en los datos del ítem (ML lo guarda solo en su
// índice de búsqueda exacta), así que para resolver un código de SKU (M-112, M-114…) lo mapeamos al
// modelo/palabra de título. Fuentes: seed + localStorage (manual) + Costos (PC_PRODUCTS: sku-base + nombre).
function aliases(){
  const m = { 'm-114': 'thor' };
  try{ Object.assign(m, JSON.parse(localStorage.getItem('parka_sku_aliases')||'{}')); }catch(e){}
  try{ (S.PC_PRODUCTS||[]).forEach(p=>{ if(p && p.sku && p.name){ const k=norm(p.sku); if(!m[k]) m[k]=norm(p.name); } }); }catch(e){}
  return m;
}
function promoSetAlias(sku, term){
  let m={}; try{ m=JSON.parse(localStorage.getItem('parka_sku_aliases')||'{}'); }catch(e){}
  m[norm(sku)]=norm(term);
  try{ localStorage.setItem('parka_sku_aliases', JSON.stringify(m)); }catch(e){}
}
function matchCatalog(term){
  let t = norm(term);
  // 1) ¿es un SKU del maestro? -> expandir al/los MODELO(s) y traer TODAS las publicaciones con ese modelo
  //    (atributo = verdad real, aunque el título esté viejo). Una mal-titulada "Harmony Holy" con modelo
  //    Holy NO entra acá (filtramos por ATRIBUTO, no por título).
  const models = skuToModels(t);
  const uniqById = arr => [...new Map(arr.map(x=>[x.id,x])).values()];  // el catálogo puede traer ítems repetidos
  if(models.length){
    const set = new Set(models);
    return uniqById(_catalog.filter(it => set.has(norm(it.model))));
  }
  // 2) si no es SKU del maestro: alias manual (fallback) + match. El ATRIBUTO MODEL MANDA (regla dura del
  //    proyecto: el modelo se decide por el atributo, no por el título — item_id reusado / palabras sueltas).
  //    Matcheamos por modelo (substring) o prefijo de SKU; el TÍTULO solo cuenta si la pub NO tiene modelo
  //    cargado (posible mal-titulada). Así buscar "VESUBIO" NO trae una pub modelo "Origin" cuyo título
  //    menciona "vesubio" como COLOR (bug jul-2026), ni "BAKER" trae una "Interval" con esa palabra suelta.
  const al = aliases(); if(al[t]) t = norm(al[t]);
  return uniqById(_catalog.filter(it => {
    const m = norm(it.model);
    if(m && m.includes(t)) return true;                              // modelo (atributo) matchea
    if((it.skus||[]).some(s=>norm(s).startsWith(t))) return true;    // prefijo de SKU
    if(!m && norm(it.title).includes(t)) return true;               // sin modelo cargado → uso el título de señal
    return false;
  }));
}

async function promoReindex(){ try{ localStorage.removeItem('parka_promo_catalog_v2'); _catalog=[]; toast('Reindexando…','info'); await ensureCatalog(true); toast('✓ Reindexado ('+_catalog.length+' pub)','success'); }catch(e){ toast('Error: '+e.message,'error'); } }

async function promoLoad(){
  const term = (document.getElementById('promo-term')?.value||'').trim();
  if(!term){ toast('Escribí un título, modelo o SKU','error'); return; }
  const btn=document.getElementById('promo-load-btn'); if(btn) btn.disabled=true;
  const ld=document.getElementById('promo-loading'); if(ld) ld.style.display='flex';
  _items=[]; _plan={}; rep('');
  try{
    await ensureCatalog(false);
    await ensureSkuMaster();   // mapa SKU→modelo del Excel maestro (D1 compartido) → resolver SKU → modelo
    await ensureSales2w();     // ventas por item_id (14d) → días de inventario en la card
    let ids = matchCatalog(term).map(i=>i.id);  // título OR modelo OR SKU(de órdenes) OR alias
    if(ids.length){
      for(let i=0;i<ids.length;i+=20){
        const batch = ids.slice(i,i+20);
        const r = await apiGet('/api/ml/promo-resolve?ids='+encodeURIComponent(batch.join(',')));
        if(r && r.ok) _items = _items.concat(r.items||[]);
        const lt=document.getElementById('promo-loadtxt'); if(lt) lt.textContent='Cargando promos… '+_items.length+'/'+ids.length;
      }
    } else {
      // Por si es un SKU COMPLETO que no salió en ventas recientes: búsqueda exacta de ML.
      const r = await apiGet('/api/ml/promo-resolve?sku='+encodeURIComponent(term)+'&offset=0');
      if(r && r.ok) _items = r.items||[];
    }
    await ensureVisits(_items.map(i=>i.itemId));   // visitas 14d por publicación → conversión en la card
    _items.sort((a,b)=> (a.status==='active'?0:1)-(b.status==='active'?0:1));
    const cnt=document.getElementById('promo-load-count');
    const act = _items.filter(i=>i.status==='active').length;
    if(cnt) cnt.textContent = _items.length+' publicaciones ('+act+' activas)';
    document.getElementById('promo-actions').style.display = _items.length ? 'block':'none';
    document.getElementById('promo-cuotas-exec').disabled = true;
    renderCards();
    if(!_items.length) toast('No encontré nada para "'+term+'" — probá por nombre, modelo o SKU','info');
  }catch(e){ toast('Error: '+e.message,'error'); console.error('[Promos] load', e); }
  finally{ if(btn) btn.disabled=false; if(ld) ld.style.display='none'; }
}

function cuotasBadge(it){
  return it.cuotas==='con'
    ? '<span class="badge" style="background:#ede9fe;color:#5b21b6">Premium · con cuotas</span>'
    : '<span class="badge" style="background:#e0f2fe;color:#075985">Clásica · sin cuotas</span>';
}
function statusBadge(s){
  if(s==='active') return '<span class="badge" style="background:#dcfce7;color:#166534">activa</span>';
  if(s==='paused') return '<span class="badge" style="background:#fef9c3;color:#854d0e">pausada</span>';
  return '<span class="badge" style="background:var(--surface2);color:var(--text-soft)">'+esc(s||'?')+'</span>';
}

// Agrupamos por la FAMILIA de ML (family_id): el modelo nuevo de catálogo donde 1 PUBLICACIÓN tiene
// variantes (talles/colores) que por debajo son item_ids MLA distintos. family_id = el número de
// publicación que ves en el panel de ML. Una card por familia; al aplicar le pega a todas las variantes
// ACTIVAS. Los ítems sin family_id son publicaciones sueltas (1 card c/u).
function groupItems(items){
  const map = {};
  for(const it of items){ const key = it.familyId ? ('fam:'+it.familyId) : ('id:'+it.itemId); (map[key]=map[key]||[]).push(it); }
  return Object.keys(map).map(key=>{
    const g = map[key];
    const active = g.filter(i=>i.status==='active');
    const rep = active[0] || g[0];
    const isFamily = !!rep.familyId;
    const sales = _sales2w || {};
    const stock = active.reduce((a,i)=>a+(i.stock||0),0);        // stock vendible (variantes activas)
    const sales2w = g.reduce((a,i)=>a+(sales[i.itemId]||0),0);   // demanda del producto (todas las variantes) — para diasInv
    const diasInv = daysOfStock(stock, sales2w, 14);             // días de inventario = stock ÷ (ventas14d/14) — métrica 6
    // CONVERSIÓN = ventas14d ÷ visitas14d, con el MISMO criterio que el Radar (radarModelSignals): num y den
    // sobre los MISMOS ids (solo variantes con visita CONOCIDA, para no inflar el ratio), gate de frescura
    // (si las ventas del almacén están viejas >48h, mudo mejor que un número inventado) y clamp [0,1] (>100%
    // = imposible → dato inconsistente, no se muestra). Antes: num sobre TODAS las variantes vs den solo las
    // visitadas, sin gate ni clamp → daba >100% (mismo bug que el Radar ya tenía arreglado).
    const visIds = g.filter(i=> _visits[i.itemId]!=null);
    const anyVisits = visIds.length>0;
    const visits = visIds.reduce((a,i)=> a + (_visits[i.itemId]||0), 0);   // visitas 14d (solo ids con visita conocida)
    const salesFresh = !!(_sales2wTs && (Date.now()-_sales2wTs < 48*60*60*1000));
    const convSales = visIds.reduce((a,i)=>a+(sales[i.itemId]||0),0);   // ventas del MISMO conjunto que visits
    const conv = conversionRate(convSales, visits, salesFresh);         // gate de frescura + clamp [0,1] — métrica 5
    return { key, rep, items: g, itemIds: g.map(i=>i.itemId), activeIds: active.map(i=>i.itemId),
      hasActive: active.length>0, nActive: active.length, isFamily,
      pubTitle: isFamily ? (rep.familyName||rep.title) : rep.title,
      pubNumber: isFamily ? rep.familyId : rep.itemId,
      pubUrl: rep.permalink || ('https://articulo.mercadolibre.com.ar/MLA-'+String(rep.itemId).replace(/^MLA/,'')),
      stock, sales2w, diasInv, visits, anyVisits, conv };
  });
}

function renderCards(){
  const wrap = document.getElementById('promo-cards'); if(!wrap) return;
  const groups = groupItems(_items);
  const cnt=document.getElementById('promo-load-count');
  if(cnt) cnt.textContent = groups.length+' publicaciones ('+groups.filter(g=>g.hasActive).length+' activas)';
  // Resumen del ARTÍCULO (modelo): con varias publicaciones activas el stock es COMPARTIDO → días reales =
  // stock (la MODA: el valor que más se repite entre las publicaciones) ÷ ventas totales de todas juntas.
  const activeG = groups.filter(g=>g.hasActive);
  let bannerHtml = '';
  if(activeG.length>1){
    const cm={}; _catalog.forEach(c=>{ cm[c.id]=c.model||''; });
    const mc={}; activeG.forEach(g=>g.items.forEach(i=>{ const m=cm[i.itemId]; if(m) mc[m]=(mc[m]||0)+1; }));
    const model = Object.keys(mc).sort((a,b)=>mc[b]-mc[a])[0] || 'artículo';
    const modeStock = stockMode(activeG.map(g=>g.stock).filter(s=>s>0));   // MODA del stock compartido — métrica 4
    const totSales = activeG.reduce((a,g)=>a+g.sales2w,0);
    const totVis = activeG.reduce((a,g)=>a+(g.visits||0),0);
    const dias = daysOfStock(modeStock, totSales, 14);                     // días de stock del artículo — métrica 6
    const dc = dias==null ? 'var(--text-soft)' : (dias>=60?'#d97706':(dias<21?'#16a34a':'var(--text)'));
    bannerHtml = '<div style="padding:10px 12px;border:1px solid #0ea5e9;border-radius:8px;background:var(--surface2);margin-bottom:10px;font-size:12px">'
      + '<b style="text-transform:capitalize">Artículo: '+esc(model)+'</b> · '+activeG.length+' publicaciones activas (stock compartido)<br>'
      + 'Stock ~<b>'+modeStock+'</b> (el que más se repite) · <b>'+totSales+'</b> vendidas 14d (todas juntas) · '
      + '<span style="color:'+dc+';font-weight:600">'+(dias!=null?('~'+dias+' días de inventario REAL'):'—')+'</span>'
      + (totVis?(' · '+totVis+' visitas'):'')
      + '</div>';
  }
  // preservar la selección actual (por grupo) al re-renderizar
  const prev = {}; let hadCards = false;
  wrap.querySelectorAll('.promo-chk').forEach(c=>{ prev[c.getAttribute('data-id')] = c.checked; hadCards = true; });
  wrap.innerHTML = bannerHtml + groups.map(g=>{
    const it = g.rep;
    const isActive = g.hasActive;
    const checked = isActive && (hadCards && prev[g.key] !== undefined ? prev[g.key] : true);
    const plan = _plan[it.itemId];
    const promoChips = it.promos.length ? it.promos.map(p=>{
      const lab = (TIPO_LABEL[p.type]||p.type)+(p.name?(': '+p.name):'');
      const on = p.status==='started'||p.status==='active';
      return '<span class="badge" title="'+esc(lab)+' ('+esc(p.status)+')" style="background:'+(on?'#dcfce7':'var(--surface2)')+';color:'+(on?'#166534':'var(--text-soft)')+';margin:2px 3px 0 0">'+esc(TIPO_LABEL[p.type]||p.type)+'</span>';
    }).join('') : '<span style="font-size:11px;color:var(--text-muted)">sin promos</span>';
    // Número de PUBLICACIÓN (familia si la hay = el que ves en ML), clickeable. Sin info de talles.
    const numLink = '<a href="'+esc(g.pubUrl)+'" target="_blank" rel="noopener" title="Abrir la publicación en Mercado Libre" style="color:#0ea5e9;text-decoration:none">#'+esc(g.pubNumber)+'</a>';
    // Línea de decisión: stock + ventas 14d. Los DÍAS por publicación solo cuando es publicación ÚNICA;
    // si el artículo tiene varias publicaciones el stock es COMPARTIDO → los días reales van en el banner
    // (por publicación engañarían, como marcó Martin).
    let stockLine = '<b>Stock '+g.stock+'</b> · '+g.sales2w+' vend. 14d';
    if(activeG.length<=1){
      let diasTxt, diasColor='var(--text-soft)', diasHint='';
      if(g.stock<=0){ diasTxt='sin stock'; diasColor='#dc2626'; }
      else if(g.sales2w<=0){ diasTxt='sin ventas (14d)'; diasColor='var(--text-muted)'; }
      else { diasTxt='~'+g.diasInv+' días de stock'; if(g.diasInv>=60){ diasColor='#d97706'; diasHint=' · mucho stock, candidata a descuento'; } else if(g.diasInv<21){ diasColor='#16a34a'; diasHint=' · rota rápido'; } }
      stockLine += ' · <span style="color:'+diasColor+';font-weight:600">'+diasTxt+'</span>'+diasHint;
    }
    // Visitas + conversión (idea #3): poco tráfico = problema de visibilidad (no de precio).
    let visTxt='', visColor='var(--text-soft)';
    if(g.anyVisits){
      if(g.visits < 50){ visTxt = g.visits+' visitas 14d · <span style="color:#d97706;font-weight:600">casi sin tráfico</span> (visibilidad, no precio)'; }
      else { visTxt = g.visits+' visitas 14d · convierte '+(g.conv!=null?('<b>'+(g.conv*100).toFixed(1)+'%</b>'):'—'); }
    }
    // Precio ACTUAL (con el descuento activo) + descuento que ve el comprador. Si ML potencia la oferta
    // (boost) mostramos el precio potenciado y avisamos cuánto pone ML. Si es co-fondeada, avisamos que
    // tocar el precio a mano la tira abajo (guardrail: ML está poniendo plata).
    let priceLine = money(it.price)+' full';
    const bp = bestActivePromo(it.promos, it.price);
    if(bp){
      priceLine = '<s style="color:var(--text-soft)">'+money(it.price)+'</s> → <b style="color:var(--text)">'+money(bp.effPrice)+'</b>'
        + ' <span class="badge" title="Descuento que ve el comprador" style="background:#dcfce7;color:#166534">−'+bp.buyerPct+'%</span>'
        + (bp.boosted?(' <span class="badge" title="ML potencia esta oferta: pone '+money(bp.boostAmount)+' de su bolsillo. Vos financiás '+bp.sellerPct+'%." style="background:#fef3c7;color:#92400e">⚡ ML potencia</span>'):'')
        + (bp.cofunded?(' <span class="badge" title="Co-fondeada: ML aporta '+(bp.meliPct!=null?bp.meliPct+'%':'parte')+', vos '+bp.sellerPct+'%. Si cambiás el precio a mano en ML, la perdés." style="background:#e0e7ff;color:#3730a3">co-fondeada · vos '+bp.sellerPct+'%</span>'):'');
    }
    let planHtml = '';
    if(plan){
      const joined = (plan.joined||[]).length, skipped=(plan.skipped||[]).length, left=(plan.left||[]).length;
      planHtml = '<div style="margin-top:6px;padding:6px 8px;background:var(--surface2);border-radius:6px;font-size:11px">'
        + '<strong style="color:var(--text)">Plan ('+plan.target+'% → '+money(plan.dealPrice)+'):</strong> '
        + (left?('sale de '+left+' · '):'')
        + '<span style="color:#16a34a">entra a '+joined+'</span>'
        + (joined?(' ('+(plan.joined.map(j=>TIPO_LABEL[j.type]||j.type).join(', '))+')'):'')
        + (skipped?(' · <span style="color:#d97706">saltea '+skipped+'</span>: '+plan.skipped.map(s=>(TIPO_LABEL[s.type]||s.type)).join(', ')):'')
        + (g.isFamily && g.nActive>1?(' · <span style="color:var(--text-soft)">aplica a las '+g.nActive+' variantes activas</span>'):'')
        + '</div>';
    }
    return '<div style="display:flex;gap:10px;padding:10px;border:1px solid var(--border);border-radius:8px;align-items:flex-start;opacity:'+(isActive?1:0.6)+'">'
      + '<input type="checkbox" class="promo-chk" data-id="'+esc(g.key)+'" data-ids="'+esc(g.activeIds.join(','))+'" '+(checked?'checked':'')+(isActive?'':' disabled')+' style="margin-top:3px;width:16px;height:16px;flex-shrink:0">'
      + (it.thumbnail?('<img src="'+esc(it.thumbnail)+'" style="width:46px;height:46px;object-fit:cover;border-radius:6px;flex-shrink:0" onerror="this.style.display=\'none\'">'):'')
      + '<div style="flex:1;min-width:0">'
      +   '<div style="font-size:13px;font-weight:600;color:var(--text);overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="'+esc(g.pubTitle)+'">'+esc(g.pubTitle||'(sin título)')+'</div>'
      +   '<div style="font-size:11px;color:var(--text-muted);margin:2px 0">'+numLink+' · '+priceLine+' · '+cuotasBadge(it)+' '+statusBadge(g.hasActive?'active':it.status)+(g.isFamily?(' · '+g.nActive+' variantes'):'')+'</div>'
      +   '<div style="font-size:11px;color:var(--text-muted);margin:2px 0">'+stockLine+'</div>'
      +   (visTxt?('<div style="font-size:11px;color:var(--text-soft);margin:2px 0">'+visTxt+'</div>'):'')
      +   '<div style="display:flex;flex-wrap:wrap">'+promoChips+'</div>'
      +   planHtml
      + '</div></div>';
  }).join('');
}

// Expande los grupos seleccionados a sus item_ids ACTIVOS (los talles a los que se aplica de verdad).
function selectedIds(){
  const out = [];
  document.querySelectorAll('.promo-chk:checked').forEach(c=>{ (c.getAttribute('data-ids')||'').split(',').filter(Boolean).forEach(id=>out.push(id)); });
  return [...new Set(out)];
}
function datesPayload(){
  const s=document.getElementById('promo-start')?.value, f=document.getElementById('promo-finish')?.value;
  return (s&&f) ? { startDate:s+'T00:00:00', finishDate:f+'T23:59:59' } : {};
}

// ── Bulk: loop resumible sobre promo-bulk ──
async function runBulk(payloadBase, itemIds){
  let offset=0, done=false, guard=0, results=[];
  while(!done && guard<80){ guard++;
    const r = await apiPostEx('/api/ml/promo-bulk', { ...payloadBase, itemIds, offset });
    if(!r.ok){
      const transient = r.status>=500 || r.status===0;   // 5xx/timeout/red: reintentable
      const msg = (r.body && r.body.error) || (transient ? 'error de red/servidor de Mercado Libre' : ('http '+r.status));
      // Un blip transitorio NO debe abortar todo el bulk (es resumible): reintentamos el MISMO tramo
      // (sin avanzar offset) un par de veces. Un 4xx (ej. validación) corta de una con el motivo real.
      if(transient && guard<78){ const rep=document.getElementById('promo-report'); if(rep) rep.textContent='Reintentando (error transitorio)…'; await new Promise(res=>setTimeout(res,1500)); continue; }
      throw new Error(msg);
    }
    results = results.concat(r.body.results||[]); offset=r.body.nextOffset; done=!!r.body.done;
    const rep=document.getElementById('promo-report'); if(rep) rep.textContent='Procesando… '+results.length+'/'+itemIds.length;
  }
  return results;
}

async function promoCuotasPreview(){
  const ids = selectedIds();
  if(!ids.length){ toast('No hay publicaciones seleccionadas','error'); return; }
  const con = parseFloat(document.getElementById('promo-con')?.value||'0');
  const sin = parseFloat(document.getElementById('promo-sin')?.value||'0');
  if(!(con>0&&con<=80)||!(sin>0&&sin<=80)){ toast('Los % deben estar entre 1 y 80','error'); return; }
  const btn=document.getElementById('promo-cuotas-prev'); if(btn) btn.disabled=true;
  try{
    const results = await runBulk({ leaveAll:true, reenter:{con,sin}, dryRun:true, ...datesPayload() }, ids);
    _plan = {}; results.forEach(r=>{ _plan[r.itemId]=r; });
    renderCards();
    const totJoin = results.reduce((a,r)=>a+(r.joined||[]).length,0);
    const zero = results.filter(r=>(r.joined||[]).length===0).length;
    document.getElementById('promo-report').innerHTML =
      '<span style="color:var(--text-soft)">Preview: '+results.length+' publicaciones · '+totJoin+' adhesiones a promos'+(zero?(' · <span style="color:#d97706">'+zero+' no entran a ninguna</span>'):'')+'. Revisá los planes en cada card y dale Ejecutar.</span>';
    document.getElementById('promo-cuotas-exec').disabled = false;
  }catch(e){ toast('Error en preview: '+e.message,'error'); console.error('[Promos] preview',e); }
  finally{ if(btn) btn.disabled=false; }
}

let _armExec = null, _armLeave = null;
function rep(html){ const r=document.getElementById('promo-report'); if(r) r.innerHTML = html; }

// Clasifica el resultado del bulk POR PUBLICACIÓN (no por adhesión): qué entró, qué quedó sin promo.
//  - ok: entró ≥1 promo. - failed: ML rechazó el POST (transitorio → se reintenta). - band: el % no cae
//    en la banda (no es transitorio, hay que cambiar el %). - none: no tenía promos aplicables (cupón/flash).
function classifyBulk(results){
  const ok=[], failed=[], band=[], none=[], stripped=[], blocked=[], guarded=[], inelegible=[];
  for(const r of (results||[])){
    // guarded = el guard de modelo la excluyó ANTES de tocarla: el MODEL vivo ya no coincide con lo que
    // la pantalla suponía (se cambió el artículo adentro de la pub, o no se pudo verificar) → NO se tocó.
    if(r.guard || (r.skipped||[]).some(s=>s.stage==='guard')){ guarded.push(r); continue; }
    // inelegible = ML la bloqueó de promos (mala experiencia de compra): 0 candidatas → NO se tocó, para no
    // dejarla sin descuento SIN retorno. Se separa de "blocked" (que es solo % fuera de banda, pub elegible).
    if(r.inelegible || (r.skipped||[]).some(s=>/INELEGIBLE/i.test(s.why||''))){ inelegible.push(r.itemId); continue; }
    // blocked = la pre-validación del backend NO la tocó (el % no entra en su banda) → sigue con su descuento.
    if(r.preflightBlocked || (r.skipped||[]).some(s=>s.stage==='preflight')){ blocked.push(r.itemId); continue; }
    const okJ=(r.joined||[]).filter(j=>j.ok).length;
    const failJ=(r.joined||[]).filter(j=>j.ok===false).length;
    const leftOk=(r.left||[]).filter(l=>l.ok!==false).length;
    const bandSkip=(r.skipped||[]).some(s=>/supera el tope|descuento mínimo|menor al/i.test(s.why||''));
    if(okJ>0) ok.push(r.itemId);
    else if(failJ>0) failed.push(r.itemId);
    else if(bandSkip) band.push(r.itemId);
    else none.push(r.itemId);
    // PELIGRO: se salió de promos (left OK) pero NO se reaplicó NADA (joined sin ok) → la pub quedó SIN
    // descuento. Señal robusta (no depende del texto del motivo, que a veces no matchea el regex).
    if(leftOk>0 && okJ===0) stripped.push(r.itemId);
  }
  return {ok,failed,band,none,stripped,blocked,guarded,inelegible};
}
let _lastBulk = { failedIds:[], con:0, sin:0 };
function renderBulkReport(cls){
  const cm={}; try{ _catalog.forEach(c=>{ cm[c.id]=c.model; }); }catch(e){}
  const link = id => (cm[id]?('<b style="text-transform:capitalize">'+esc(cm[id])+'</b> '):'')+'<a href="https://articulo.mercadolibre.com.ar/MLA-'+String(id).replace(/^MLA/,'')+'" target="_blank" rel="noopener" style="color:#0ea5e9;text-decoration:none">#'+esc(id)+'</a>';
  let h='<div style="font-size:12px;display:flex;flex-direction:column;gap:5px">';
  h+='<div style="color:#16a34a;font-weight:600">✓ '+cls.ok.length+' publicaciones con promo aplicada</div>';
  // ⛔ STRIPPED = lo más grave: salió de sus promos y NO reentró en ninguna → quedó SIN descuento (plata).
  // Antes classifyBulk lo calculaba pero renderBulkReport NO lo mostraba → el mal resultado pasaba invisible.
  if((cls.stripped||[]).length){
    h+='<div style="color:#dc2626;font-weight:800">⛔ '+cls.stripped.length+' quedaron SIN NINGÚN descuento (salieron de sus promos y el % no reentró en ninguna) — corregilas a mano o probá otro %: '+cls.stripped.map(link).join(' · ')+'</div>';
  }
  if(cls.failed.length){
    h+='<div style="color:#dc2626;font-weight:700">⚠️ '+cls.failed.length+' quedaron SIN promo (ML rebotó al escribir): '+cls.failed.map(link).join(' · ')+'</div>';
    h+='<div><button onclick="promoRetryFailed()" class="btn btn-sm" style="background:#dc2626;color:#fff;border-color:#dc2626;font-weight:600">Reintentar las '+cls.failed.length+' que fallaron</button></div>';
  }
  if((cls.inelegible||[]).length){ h+='<div style="color:#d97706">🚫 '+cls.inelegible.length+' INELEGIBLE(s) para promos (mala experiencia de compra) — NO se tocaron (al salir no podrían reponer el descuento); corregí desde el panel de ML o el precio de lista: '+cls.inelegible.map(link).join(' · ')+'</div>'; }
  if((cls.blocked||[]).length){ h+='<div style="color:#d97706">'+cls.blocked.length+' no se tocaron (el % no entra en su banda) — conservan su descuento actual: '+cls.blocked.map(link).join(' · ')+'</div>'; }
  if((cls.guarded||[]).length){ h+='<div style="color:#d97706">🛡️ '+cls.guarded.length+' excluida(s): el modelo VIVO no coincide con lo que mostraba la pantalla (¿se cambió el artículo adentro de la pub?) — reindexá: '+cls.guarded.map(r=>link(r.itemId)).join(' · ')+'</div>'; }
  if(cls.band.length){ h+='<div style="color:#d97706">'+cls.band.length+' no entraron porque el % no cae en la banda de ML: '+cls.band.map(link).join(' · ')+'. Probá otro %.</div>'; }
  if(cls.none.length){ h+='<div style="color:var(--text-soft)">'+cls.none.length+' sin promos aplicables (solo cupón / oferta flash, que no se tocan).</div>'; }
  h+='</div>';
  return h;
}
async function promoRetryFailed(){
  if(!_lastBulk.failedIds.length){ toast('No hay fallidas para reintentar','info'); return; }
  rep('<span style="color:var(--text-soft)">Reintentando '+_lastBulk.failedIds.length+' que habían rebotado…</span>');
  try{
    const map={};
    const rr = await runBulk({ leaveAll:true, reenter:{con:_lastBulk.con,sin:_lastBulk.sin}, ...datesPayload() }, _lastBulk.failedIds);
    rr.forEach(r=>{ _plan[r.itemId]=r; map[r.itemId]=r; });
    const cls = classifyBulk(Object.values(map));
    _lastBulk.failedIds = cls.failed;
    renderCards();
    rep(renderBulkReport(cls));
    toast(cls.failed.length?('⚠️ '+cls.failed.length+' siguen sin entrar'):'✓ Entraron todas','info');
  }catch(e){ rep('<span style="color:#dc2626">Error al reintentar: '+esc(e.message)+'</span>'); toast('Error: '+e.message,'error'); }
}

async function promoCuotasExecute(){
  const ids = selectedIds();
  const btn = document.getElementById('promo-cuotas-exec');
  if(!ids.length){ rep('<span style="color:#dc2626">Elegí al menos una publicación (tildá las que querés).</span>'); toast('Nada seleccionado','error'); return; }
  const con = parseFloat(document.getElementById('promo-con')?.value||'0');
  const sin = parseFloat(document.getElementById('promo-sin')?.value||'0');
  if(!(con>0&&con<=80)||!(sin>0&&sin<=80)){ rep('<span style="color:#dc2626">Los % deben estar entre 1 y 80.</span>'); return; }
  // Confirmación EN PANTALLA (doble clic) — sin confirm() del navegador, que a veces queda suprimido y devuelve cancelar sin avisar.
  if(!_armExec){
    if(btn){ btn.textContent='⚠️ Confirmar — escribe en ML'; btn.style.background='#dc2626'; btn.style.borderColor='#dc2626'; }
    rep('<span style="color:#dc2626;font-weight:600">⚠️ Vas a SALIR de todas + REAPLICAR (Premium '+con+'% / Clásica '+sin+'%) en '+ids.length+' publicaciones REALES de ML. Apretá "Confirmar" de nuevo para escribir.</span>');
    _armExec = setTimeout(()=>{ _armExec=null; if(btn){ btn.textContent='Ejecutar'; btn.style.background='#16a34a'; btn.style.borderColor='#16a34a'; } }, 12000);
    return;
  }
  clearTimeout(_armExec); _armExec=null;
  if(btn){ btn.disabled=true; btn.textContent='Aplicando…'; btn.style.background='#16a34a'; btn.style.borderColor='#16a34a'; }
  rep('<span style="color:var(--text-soft)">Aplicando… no cierres la pestaña.</span>');
  try{
    const dates = datesPayload();
    const map = {};
    const results = await runBulk({ leaveAll:true, reenter:{con,sin}, ...dates }, ids);
    results.forEach(r=>{ map[r.itemId]=r; });
    let cls = classifyBulk(Object.values(map));
    // AUTO-REINTENTO de las que ML rebotó (transitorio por consistencia eventual tras salir de promos):
    // hasta 2 vueltas más, solo sobre las fallidas. Las que no entran por banda (% no cae) NO se reintentan.
    for(let attempt=0; attempt<2 && cls.failed.length; attempt++){
      rep('<span style="color:var(--text-soft)">Reintentando '+cls.failed.length+' que rebotaron… (no cierres la pestaña)</span>');
      await new Promise(r=>setTimeout(r,1500));
      const rr = await runBulk({ leaveAll:true, reenter:{con,sin}, ...dates }, cls.failed);
      rr.forEach(r=>{ map[r.itemId]=r; });
      cls = classifyBulk(Object.values(map));
    }
    _plan = {}; Object.values(map).forEach(r=>{ _plan[r.itemId]=r; });
    renderCards();
    _lastBulk = { failedIds: cls.failed, con, sin };
    rep(renderBulkReport(cls));
    toast(cls.stripped.length?('⛔ '+cls.stripped.length+' quedaron SIN descuento'):(cls.failed.length?('⚠️ '+cls.failed.length+' quedaron sin promo'):('✓ '+cls.ok.length+' con promo aplicada')), cls.stripped.length?'error':(cls.failed.length?'info':'success'));
  }catch(e){ rep('<span style="color:#dc2626">Error al ejecutar: '+esc(e.message)+'</span>'); toast('Error: '+e.message,'error'); console.error('[Promos] execute',e); }
  finally{ if(btn){ btn.disabled=false; btn.textContent='Ejecutar'; } }
}

async function promoLeaveAll(){
  const ids = selectedIds();
  const btn = document.getElementById('promo-leave-btn');
  if(!ids.length){ rep('<span style="color:#dc2626">Elegí al menos una publicación.</span>'); toast('Nada seleccionado','error'); return; }
  if(!_armLeave){
    if(btn){ btn.textContent='⚠️ Confirmar salida'; }
    rep('<span style="color:#dc2626;font-weight:600">⚠️ Vas a SALIR de todas las promos activas en '+ids.length+' publicaciones. Apretá "Confirmar salida" de nuevo.</span>');
    _armLeave = setTimeout(()=>{ _armLeave=null; if(btn) btn.textContent='Salir de TODAS las promos'; }, 12000);
    return;
  }
  clearTimeout(_armLeave); _armLeave=null;
  if(btn){ btn.disabled=true; btn.textContent='Saliendo…'; }
  rep('<span style="color:var(--text-soft)">Saliendo de las promos…</span>');
  try{
    const results = await runBulk({ leaveAll:true }, ids);
    const left = results.reduce((a,r)=>a+(r.left||[]).filter(x=>x.ok!==false).length,0);
    const failed = results.reduce((a,r)=>a+(r.left||[]).filter(x=>x.ok===false).length,0);
    rep('<span style="color:'+(failed?'#dc2626':(left?'#16a34a':'var(--text-soft)'))+'">'+(left
      ? ('✓ Salió de '+left+' promos en '+ids.length+' publicaciones'+(failed?(' · '+failed+' fallaron'):''))
      : 'No había participaciones ACTIVAS para salir (las promos que figuran son candidatas/invitaciones, no participación).')+'</span>');
    toast(left?('✓ Salió de '+left+' promociones'):'Sin participaciones activas', left?'success':'info');
  }catch(e){ rep('<span style="color:#dc2626">Error: '+esc(e.message)+'</span>'); toast('Error: '+e.message,'error'); console.error('[Promos] leaveAll',e); }
  finally{ if(btn){ btn.disabled=false; btn.textContent='Salir de TODAS las promos'; } }
}

// ── Incongruencias de stock ──────────────────────────────────────────────────
// Mismo ARTÍCULO (atributo MODEL) publicado varias veces: como NO comparten inventario (user_product_id
// null, cada listing declara su propio stock), lo normal es que casi todas declaren ~el mismo número.
// Si una se desvía fuerte de la MODA del artículo (consenso: ≥2 publicaciones que coinciden) — ej. 3 de
// Thor con 1800 y una con 300 — la marcamos para revisar (puede ser error de carga O que esa vendió mucho;
// en ambos casos Martin quiere verlo). Orden por VISITAS desc: la incongruencia en la publicación más vista
// es la más grave (si figura con poco stock, perdés ventas justo en la que más mira la gente).
const INCONG_THRESH = 0.50;   // ±50%: solo saltos grandes (1800 vs 300), no la deriva normal por ventas
async function promoStockIncong(force){
  const btn=document.getElementById('promo-incong-btn');
  const ld=document.getElementById('promo-incong-loading');
  const txt=document.getElementById('promo-incong-txt');
  const res=document.getElementById('promo-incong-results');
  const cnt=document.getElementById('promo-incong-count');
  if(btn) btn.disabled=true; if(ld) ld.style.display='flex'; if(res) res.innerHTML='';
  try{
    if(txt) txt.textContent='Indexando catálogo…';
    await ensureCatalog(!!force);
    // El índice viejo (anterior a este feature) no trae available_quantity → reindexamos una vez.
    if(!_catalog.some(it=> it.stock!=null)){ if(txt) txt.textContent='Actualizando índice con stock (~25s)…'; await ensureCatalog(true); }
    await ensureSkuMaster();
    // artículo = MODEL (atributo). Si falta, lo resolvemos por SKU contra el maestro (si es inequívoco).
    const modelOf = it => { const m=norm(it.model); if(m) return m; const ms=(it.skus||[]).flatMap(s=>skuToModels(s)); return ms.length===1 ? norm(ms[0]) : ''; };
    // publicación = familyId (variantes de 1 listing) o item suelto. Stock de la publicación = suma de variantes ACTIVAS.
    const arts = {};
    for(const it of _catalog){
      if(it.status!=='active' || it.stock==null) continue;
      const model = modelOf(it); if(!model) continue;
      const pubKey = it.familyId ? ('fam:'+it.familyId) : ('id:'+it.id);
      const a = arts[model] || (arts[model]={pubs:{}});
      const p = a.pubs[pubKey] || (a.pubs[pubKey]={stock:0, ids:[], num: it.familyId||it.id, fam: !!it.familyId, title: it.title||''});
      p.stock += (it.stock||0); p.ids.push(it.id);
    }
    const modeOf = arr => { if(!arr.length) return 0; const f={}; arr.forEach(v=>f[v]=(f[v]||0)+1); let best=arr[0],bc=0; for(const k in f){ const v=+k; if(f[k]>bc||(f[k]===bc&&v>best)){ best=v; bc=f[k]; } } return best; };
    let flagged = [];
    for(const model in arts){
      const pubs = Object.values(arts[model].pubs);
      if(pubs.length<2) continue;
      const positive = pubs.map(p=>p.stock).filter(s=>s>0);
      const expected = modeOf(positive);
      const expCount = positive.filter(s=>s===expected).length;   // consenso: la moda tiene que repetirse en ≥2
      if(expected<=0 || expCount<2) continue;
      for(const p of pubs){
        if(p.stock===expected) continue;
        const dev = (p.stock-expected)/expected;
        if(Math.abs(dev)<INCONG_THRESH) continue;
        flagged.push({ model, num:p.num, fam:p.fam, stock:p.stock, expected, expCount, nPubs:pubs.length, devPct:Math.round(dev*100), low:p.stock<expected, ids:p.ids, title:p.title });
      }
    }
    if(!flagged.length){
      if(cnt) cnt.textContent='0 incongruencias'+(_catalogTs?(' · datos '+agoTxt(_catalogTs)):'');
      if(res) res.innerHTML='<div style="font-size:13px;color:#16a34a;padding:8px">✓ Sin incongruencias: en cada artículo con varias publicaciones, todas declaran un stock coherente (no hay ninguna que se desvíe +'+Math.round(INCONG_THRESH*100)+'% de las demás).</div>';
      return;
    }
    // visitas (14d) por publicación → orden por visibilidad desc. Cap defensivo por si hay muchísimas.
    let capped=false;
    if(flagged.length>120){ flagged.sort((a,b)=>Math.abs(b.devPct)-Math.abs(a.devPct)); flagged=flagged.slice(0,120); capped=true; }
    if(txt) txt.textContent='Trayendo visitas…';
    await ensureVisits(flagged.flatMap(f=>f.ids));
    flagged.forEach(f=>{ f.visits=f.ids.reduce((a,id)=>a+(_visits[id]||0),0); f.anyVisits=f.ids.some(id=>_visits[id]!=null); });
    flagged.sort((a,b)=> (b.visits||0)-(a.visits||0));
    const nArts = new Set(flagged.map(f=>f.model)).size;
    if(cnt) cnt.textContent = flagged.length+' incongruencia'+(flagged.length>1?'s':'')+' · '+nArts+' artículo'+(nArts>1?'s':'')+(_catalogTs?(' · datos '+agoTxt(_catalogTs)):'');
    if(res) res.innerHTML = (capped?'<div style="font-size:11px;color:#d97706;padding:4px 8px">Mostrando las 120 desviaciones más grandes.</div>':'') + flagged.map(f=>{
      const numLink = mlEditA(f.num, (f.ids&&f.ids[0])||f.num);
      const sev = f.low ? '#dc2626' : '#d97706';
      const arrow = f.low ? '▼' : '▲';
      const word = f.low ? 'por debajo' : 'por encima';
      const visTxt = f.anyVisits ? (f.visits.toLocaleString('es-AR')+' visitas 14d') : 'sin datos de visitas';
      return '<div style="display:flex;gap:10px;padding:10px;border:1px solid var(--border);border-left:3px solid '+sev+';border-radius:8px;align-items:flex-start">'
        + '<div style="font-size:18px;line-height:1.1;color:'+sev+'">'+arrow+'</div>'
        + '<div style="flex:1;min-width:0">'
        +   '<div style="font-size:13px;font-weight:600;color:var(--text);text-transform:capitalize">'+esc(f.model)+'</div>'
        +   '<div style="font-size:11px;color:var(--text-muted);margin:2px 0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">'+numLink+(f.title?(' · '+esc(f.title)):'')+'</div>'
        +   '<div style="font-size:12px;margin:2px 0">Declara <b style="color:'+sev+'">'+f.stock.toLocaleString('es-AR')+'</b> vs ~<b>'+f.expected.toLocaleString('es-AR')+'</b> del artículo ('+f.expCount+' de '+f.nPubs+' publicaciones coinciden) · <span style="color:'+sev+';font-weight:600">'+(f.devPct>0?'+':'')+f.devPct+'% '+word+'</span></div>'
        +   '<div style="font-size:11px;color:var(--text-soft)">'+visTxt+(f.low&&f.anyVisits&&f.visits>=50?' · si es error, perdés ventas en una publicación muy vista':'')+'</div>'
        + '</div></div>';
    }).join('');
  }catch(e){ if(res) res.innerHTML='<div style="color:#dc2626;font-size:13px;padding:8px">Error: '+esc(e.message)+'</div>'; console.error('[Promos] incong', e); }
  finally{ if(btn) btn.disabled=false; if(ld) ld.style.display='none'; }
}

// ── Incongruencias de GUÍA DE TALLES ─────────────────────────────────────────
// Cada publicación referencia una "guía de talles" de ML (atributo SIZE_GRID_ID → tabla con un nombre,
// ej. "M114 THOR 2024 prenda"). Si una publicación de Thor tiene la tabla de OTRO modelo (ej. "M112
// VESUBIO"), el comprador ve medidas equivocadas → devoluciones. Detección con doble red:
//   1) si el nombre de la tabla menciona OTRO modelo conocido (y no el del artículo) → ERROR claro (alto);
//   2) consenso: la tabla que usa la mayoría de las publicaciones del artículo es la "correcta"; las que
//      usan otra (o ninguna) se marcan. Cubre el caso "Provisorio" (tablas nombradas solo por código, sin
//      modelo): si la comparte la mayoría no se marca. Orden por visitas desc (la más vista = más grave).
// Nombres de tabla cacheados largo (el id de tabla es inmutable; si una pub cambia de tabla, cambia el gridId).
const despace = s => norm(s).replace(/[\s\-_.\/]/g,'');
// Levenshtein acotado: distingue "otro modelo" de una variante MAL ESCRITA del mismo (typo ≤2 chars).
function lev(a,b){ a=String(a); b=String(b); const m=a.length,n=b.length; if(Math.abs(m-n)>2) return 99; const dp=Array.from({length:m+1},(_,i)=>i); for(let j=1;j<=n;j++){ let prev=dp[0]; dp[0]=j; for(let i=1;i<=m;i++){ const tmp=dp[i]; dp[i]=Math.min(dp[i]+1, dp[i-1]+1, prev+(a[i-1]===b[j-1]?0:1)); prev=tmp; } } return dp[m]; }
let _chartNames = null;
async function ensureChartNames(ids){
  if(!_chartNames){ try{ const c=JSON.parse(localStorage.getItem('parka_chart_names')||'null'); _chartNames = (c && c.byId) ? c.byId : {}; }catch(e){ _chartNames={}; } }
  const want = [...new Set(ids)].filter(id => id && !(id in _chartNames));
  if(!want.length) return;
  const lt=document.getElementById('promo-talles-txt');
  for(let i=0;i<want.length;i+=50){
    const batch = want.slice(i,i+50);
    if(lt) lt.textContent='Trayendo nombres de tablas… '+i+'/'+want.length;
    const r = await apiGet('/api/ml/charts?ids='+encodeURIComponent(batch.join(',')));
    if(r && r.ok && r.charts){ Object.assign(_chartNames, r.charts); }
    else { batch.forEach(id=>{ if(!(id in _chartNames)) _chartNames[id]=null; }); }
  }
  // Persistir SOLO los nombres reales (no los null de fallos). El load NO tiene TTL (el gridId es inmutable),
  // así que un null cacheado se volvía "sin guía" PERMANENTE y nunca se reintentaba. En sesión el null evita
  // re-pedir; en localStorage solo van los resueltos → el próximo arranque reintenta los que fallaron.
  try{ const clean={}; for(const k in _chartNames){ if(_chartNames[k]!=null) clean[k]=_chartNames[k]; } localStorage.setItem('parka_chart_names', JSON.stringify({ts:Date.now(), byId:clean})); }catch(e){}
}

async function promoTallesIncong(force){
  const btn=document.getElementById('promo-talles-btn');
  const ld=document.getElementById('promo-talles-loading');
  const txt=document.getElementById('promo-talles-txt');
  const res=document.getElementById('promo-talles-results');
  const cnt=document.getElementById('promo-talles-count');
  if(btn) btn.disabled=true; if(ld) ld.style.display='flex'; if(res) res.innerHTML='';
  try{
    if(txt) txt.textContent='Indexando catálogo…';
    await ensureCatalog(!!force);
    if(!_catalog.some(it=> 'gridId' in it)){ if(txt) txt.textContent='Actualizando índice con guías (~25s)…'; await ensureCatalog(true); }
    // tokens de modelos conocidos (despaced, len>=4) para detectar "tabla de otro modelo"
    const modelTokens = {};
    _catalog.forEach(it=>{ const m=norm(it.model); if(m){ const t=despace(m); if(t.length>=4) modelTokens[t]=m; } });
    // agrupar por artículo (modelo) → publicaciones (family/item) → tablas usadas + ids para visitas
    const arts = {};
    for(const it of _catalog){
      if(it.status!=='active') continue;
      const m=norm(it.model); if(!m) continue;
      const a = arts[m] || (arts[m]={pubs:{}});
      const pk = it.familyId ? ('fam:'+it.familyId) : ('id:'+it.id);
      const p = a.pubs[pk] || (a.pubs[pk]={ grids:new Set(), ids:[], num: it.familyId||it.id, fam: !!it.familyId, title: it.title||'' });
      if(it.gridId) p.grids.add(it.gridId);
      p.ids.push(it.id);
    }
    // resolver nombres de todas las tablas usadas
    const allGrids = [];
    for(const m in arts) for(const pk in arts[m].pubs) arts[m].pubs[pk].grids.forEach(g=>allGrids.push(g));
    if(txt) txt.textContent='Trayendo nombres de tablas…';
    await ensureChartNames(allGrids);
    const nameOf = id => (_chartNames && _chartNames[id]) || '';
    // clasificar. CLAVE de tabla = NOMBRE normalizado (no el chart_id): ML tiene tablas duplicadas con
    // idéntico nombre y distinto id; tratarlas por nombre evita falsos "versiones distintas".
    const rawByKey = {};                            // nombreDespaced -> nombre crudo (para mostrar)
    const keyOf = gid => { const nm=nameOf(gid); const k=despace(nm); if(k && !(k in rawByKey)) rawByKey[k]=nm; return k; };
    const flags = [];      // por publicación: {sev,type,model,num,fam,ids,chart,detail,visits}
    const multi = [];      // por artículo: usa >1 tabla distinta (y SIN error de modelo, para no duplicar)
    for(const m in arts){
      const pubs = Object.values(arts[m].pubs);
      const mt = despace(m);
      const cntName={}; pubs.forEach(p=>{ const ks=new Set([...p.grids].map(keyOf).filter(Boolean)); p._keys=ks; ks.forEach(k=>cntName[k]=(cntName[k]||0)+1); });
      const distinctNames = Object.keys(cntName);
      const anyChart = distinctNames.length>0;
      let articleWrong = false;
      for(const p of pubs){
        const keys=[...p._keys];
        if(!keys.length){ if(anyChart) flags.push({sev:2,type:'missing',model:m,num:p.num,fam:p.fam,ids:p.ids,chart:'',detail:'sin guía de talles (el resto del artículo sí tiene)'}); continue; }
        for(const k of keys){
          if(mt && k.includes(mt)) continue;                        // el nombre menciona este modelo → OK
          let other=null;
          for(const tok in modelTokens){ if(tok!==mt && tok.length>=4 && k.includes(tok)){ other=modelTokens[tok]; break; } }
          if(other){ articleWrong=true; flags.push({sev:3,type:'wrong_model',model:m,num:p.num,fam:p.fam,ids:p.ids,chart:rawByKey[k]||'',detail:'tiene cargada la tabla de “'+other+'”, no la de “'+m+'”'}); }
          // code-only/provisorio sin modelo en el nombre: no se marca por publicación; si el artículo usa
          // más de una tabla queda reflejado abajo en "versiones distintas".
        }
      }
      if(distinctNames.length>1 && !articleWrong){
        multi.push({ model:m, ids: pubs.flatMap(p=>p.ids), tables: distinctNames.map(k=>({name:rawByKey[k]||k, pubs:cntName[k]})).sort((a,b)=>b.pubs-a.pubs) });
      }
    }
    // visitas para ordenar (flags + artículos multi)
    if(txt) txt.textContent='Trayendo visitas…';
    await ensureVisits([...flags.flatMap(f=>f.ids), ...multi.flatMap(x=>x.ids)]);
    const visOf = ids => ids.reduce((a,id)=>a+(_visits[id]||0),0);
    flags.forEach(f=>{ f.visits=visOf(f.ids); });
    multi.forEach(x=>{ x.visits=visOf(x.ids); });
    flags.sort((a,b)=> (b.sev-a.sev) || ((b.visits||0)-(a.visits||0)));
    multi.sort((a,b)=> (b.visits||0)-(a.visits||0));
    const nWrong = flags.filter(f=>f.type==='wrong_model').length;
    if(cnt) cnt.textContent = nWrong+' modelo equivocado · '+flags.filter(f=>f.type==='missing').length+' sin tabla · '+multi.length+' con versiones distintas'+(_catalogTs?(' · datos '+agoTxt(_catalogTs)):'');
    const sevColor = s => s>=3?'#dc2626':(s>=2?'#d97706':'#64748b');
    const linkOf = f => mlEditA(f.num, (f.ids&&f.ids[0])||f.num);
    let html='';
    if(!flags.length && !multi.length){
      html='<div style="font-size:13px;color:#16a34a;padding:8px">✓ Sin incongruencias de guía de talles: cada artículo usa una tabla coherente con su modelo.</div>';
    } else {
      if(flags.length){
        html += '<div style="font-size:12px;font-weight:600;color:var(--text);margin:2px 0 6px">Tablas a revisar ('+flags.length+')</div>';
        html += flags.map(f=>{
          const sc=sevColor(f.sev);
          return '<div style="display:flex;gap:10px;padding:9px 10px;border:1px solid var(--border);border-left:3px solid '+sc+';border-radius:8px;align-items:flex-start">'
            + '<div style="font-size:16px;line-height:1.1;color:'+sc+'">'+(f.sev>=3?'⚠':(f.sev>=2?'▲':'•'))+'</div>'
            + '<div style="flex:1;min-width:0">'
            +   '<div style="font-size:13px;font-weight:600;color:var(--text);text-transform:capitalize">'+esc(f.model)+' · '+linkOf(f)+'</div>'
            +   '<div style="font-size:12px;margin:2px 0;color:'+sc+';font-weight:600">'+esc(f.detail)+'</div>'
            +   (f.chart?('<div style="font-size:11px;color:var(--text-muted)">tabla actual: “'+esc(f.chart)+'”</div>'):'')
            +   '<div style="font-size:11px;color:var(--text-soft)">'+((f.visits!=null)?(f.visits.toLocaleString('es-AR')+' visitas 14d'):'')+'</div>'
            + '</div></div>';
        }).join('');
      }
      if(multi.length){
        html += '<div style="font-size:12px;font-weight:600;color:var(--text);margin:14px 0 6px">Artículos con más de una versión de tabla ('+multi.length+') <span style="font-weight:400;color:var(--text-soft)">— mismas medidas deberían usar la misma tabla</span></div>';
        html += multi.map(x=>{
          return '<div style="padding:8px 10px;border:1px solid var(--border);border-left:3px solid #64748b;border-radius:8px">'
            + '<div style="font-size:13px;font-weight:600;color:var(--text);text-transform:capitalize">'+esc(x.model)+(x.visits?(' · <span style="font-weight:400;color:var(--text-soft)">'+x.visits.toLocaleString('es-AR')+' visitas 14d</span>'):'')+'</div>'
            + '<div style="font-size:11px;color:var(--text-muted);margin-top:3px">'+x.tables.map(t=>'“'+esc(t.name)+'” <span style="color:var(--text-soft)">('+t.pubs+' pub)</span>').join(' · ')+'</div>'
            + '</div>';
        }).join('');
      }
    }
    if(res) res.innerHTML = html;
  }catch(e){ if(res) res.innerHTML='<div style="color:#dc2626;font-size:13px;padding:8px">Error: '+esc(e.message)+'</div>'; console.error('[Promos] talles', e); }
  finally{ if(btn) btn.disabled=false; if(ld) ld.style.display='none'; }
}

// ── Incongruencias de DESCRIPCIÓN ────────────────────────────────────────────
// Reutilizan publicaciones (mismo item_id, otra campera adentro; ver [[parka-publication-reuse]]) y a veces
// se olvidan de cambiar la descripción → queda la de otro artículo. Las descripciones arrancan con el modelo
// ("Campera Puffer Thor…"), así que comparo el ARRANQUE (primeros ~80 chars) contra el modelo del artículo:
// si arranca con OTRO modelo conocido → error claro. Si el modelo no aparece ni al principio ni en el texto
// → "sin el modelo en la descripción" (a revisar, más blando). ML sirve la descripción en endpoint aparte
// (1 por ítem) → traemos 1 por publicación (rep) y cacheamos 6h en localStorage.
let _desc = null, _descTs = 0;
async function ensureDescriptions(ids){
  if(!_desc){ try{ const c=JSON.parse(localStorage.getItem('parka_desc')||'null'); if(c && c.byId && (Date.now()-c.ts < 6*60*60*1000)){ _desc=c.byId; _descTs=c.ts; } }catch(e){} }
  // ALMACÉN COMPARTIDO: si está vacío en memoria/local, sembrar de D1 (lo que cargó otro usuario).
  if(!_desc || !Object.keys(_desc).length){ try{ const w=await apiGet('/api/warehouse?part=descriptions'); const d = w && w.descriptions ? JSON.parse(w.descriptions) : null; if(d && Object.keys(d).length){ _desc=d; _descTs = w.tsDesc?Date.parse(w.tsDesc):Date.now(); } }catch(e){} }
  if(!_desc){ _desc={}; _descTs=Date.now(); }
  const want = [...new Set(ids)].filter(id => id && !(id in _desc));
  if(!want.length) return;
  const lt=document.getElementById('promo-desc-txt');
  let failed=false;
  for(let i=0;i<want.length;i+=40){
    const batch = want.slice(i,i+40);
    if(lt) lt.textContent='Trayendo descripciones… '+i+'/'+want.length;
    const r = await apiGet('/api/ml/descriptions?ids='+encodeURIComponent(batch.join(',')));
    if(r && r.ok && r.descriptions){ Object.assign(_desc, r.descriptions); }
    else { failed=true; batch.forEach(id=>{ if(!(id in _desc)) _desc[id]=null; }); }
  }
  try{ localStorage.setItem('parka_desc', JSON.stringify({ts:_descTs, byId:_desc})); }catch(e){}
  // Solo subir al almacén COMPARTIDO si no hubo fallos: un batch caído marca nulls ("no pude traer") que
  // NO deben propagarse a otros usuarios como "sin descripción". Si el POST falla, avisar (no pisar mudo).
  if(!failed){ apiPost('/api/warehouse', { descriptions: _desc }).then(ok=>{ if(ok==null) toast('No pude actualizar el almacén (descripciones) — quedan locales','info'); }); }
}

async function promoDescIncong(force){
  const btn=document.getElementById('promo-desc-btn');
  const ld=document.getElementById('promo-desc-loading');
  const txt=document.getElementById('promo-desc-txt');
  const res=document.getElementById('promo-desc-results');
  const cnt=document.getElementById('promo-desc-count');
  if(btn) btn.disabled=true; if(ld) ld.style.display='flex'; if(res) res.innerHTML='';
  try{
    if(txt) txt.textContent='Indexando catálogo…';
    await ensureCatalog(!!force);
    const modelTokens = {};
    _catalog.forEach(it=>{ const m=norm(it.model); if(m){ const t=despace(m); if(t.length>=4) modelTokens[t]=m; } });
    // publicaciones = family/item, rep = primer ítem; ids = todas las variantes (para visitas)
    const pubs = {};
    for(const it of _catalog){
      if(it.status!=='active') continue;
      const m=norm(it.model); if(!m) continue;
      const pk = it.familyId ? ('fam:'+it.familyId) : ('id:'+it.id);
      const p = pubs[pk] || (pubs[pk]={ rep: it.id, model:m, num: it.familyId||it.id, fam: !!it.familyId, title: it.title||'', ids:[] });
      p.ids.push(it.id);
    }
    const repIds = Object.values(pubs).map(p=>p.rep);
    if(force){ _desc=null; _descTs=0; try{localStorage.removeItem('parka_desc')}catch(e){} }   // recalcular: re-sembrar del almacén compartido + gaps en vivo
    if(txt) txt.textContent='Trayendo descripciones…';
    await ensureDescriptions(repIds);
    // precomputar + agrupar por artículo (para el chequeo "oveja negra" en sin-modelo)
    const arts = {};
    for(const pk in pubs){
      const p=pubs[pk]; const d=_desc[p.rep]||''; const mt=despace(p.model);
      p._d=d; p._mt=mt; p._pre = d?despace(d.slice(0,80)):'';
      p._has = !!(d && mt && (p._pre.includes(mt) || despace(d).includes(mt)));   // nombra el modelo (arranque o cuerpo)
      (arts[p.model]=arts[p.model]||[]).push(p);
    }
    const wrong=[], noModel=[];
    for(const m in arts){
      const list=arts[m]; const mt=despace(m);
      const someHas = list.some(p=>p._has);            // alguna publicación del artículo SÍ nombra el modelo
      for(const p of list){
        if(!p._d) continue;                            // sin texto / sin acceso → no opino
        if(p._has) continue;                           // nombra el modelo → OK
        // ¿el arranque menciona OTRO modelo? (una variante mal escrita del mismo modelo NO cuenta)
        let other=null, typoSelf=false;
        for(const tok in modelTokens){ if(tok===mt || tok.length<4 || !p._pre.includes(tok)) continue; if(lev(tok,mt)<=2){ typoSelf=true; break; } if(!other) other=modelTokens[tok]; }
        if(typoSelf) continue;
        if(other){ wrong.push({model:m, num:p.num, fam:p.fam, ids:p.ids, other, snip:p._d.slice(0,110)}); continue; }
        if(someHas) noModel.push({model:m, num:p.num, fam:p.fam, ids:p.ids, snip:p._d.slice(0,110)});  // oveja negra
      }
    }
    if(txt) txt.textContent='Trayendo visitas…';
    await ensureVisits([...wrong.flatMap(f=>f.ids), ...noModel.flatMap(f=>f.ids)]);
    const visOf = ids => ids.reduce((a,id)=>a+(_visits[id]||0),0);
    [...wrong, ...noModel].forEach(f=>{ f.visits=visOf(f.ids); });
    wrong.sort((a,b)=>(b.visits||0)-(a.visits||0));
    noModel.sort((a,b)=>(b.visits||0)-(a.visits||0));
    if(cnt) cnt.textContent = wrong.length+' descripción de otro modelo · '+noModel.length+' sin el modelo'+(_descTs?(' · datos '+agoTxt(_descTs)):'');
    const linkOf = f => mlEditA(f.num, (f.ids&&f.ids[0])||f.num);
    const visTxt = f => (f.visits!=null && f.visits>0) ? (f.visits.toLocaleString('es-AR')+' visitas 14d') : '';
    let html='';
    if(!wrong.length && !noModel.length){
      html='<div style="font-size:13px;color:#16a34a;padding:8px">✓ Sin incongruencias de descripción: cada publicación arranca con su modelo.</div>';
    } else {
      if(wrong.length){
        html += '<div style="font-size:12px;font-weight:600;color:var(--text);margin:2px 0 6px">Descripción de otro modelo ('+wrong.length+')</div>';
        html += wrong.map(f=>(
          '<div style="display:flex;gap:10px;padding:9px 10px;border:1px solid var(--border);border-left:3px solid #dc2626;border-radius:8px;align-items:flex-start">'
          + '<div style="font-size:16px;line-height:1.1;color:#dc2626">⚠</div>'
          + '<div style="flex:1;min-width:0">'
          +   '<div style="font-size:13px;font-weight:600;color:var(--text);text-transform:capitalize">'+esc(f.model)+' · '+linkOf(f)+'</div>'
          +   '<div style="font-size:12px;margin:2px 0;color:#dc2626;font-weight:600">la descripción arranca hablando de “'+esc(f.other)+'”, no de “'+esc(f.model)+'”</div>'
          +   '<div style="font-size:11px;color:var(--text-muted)">“'+esc(f.snip)+'…”</div>'
          +   '<div style="font-size:11px;color:var(--text-soft)">'+visTxt(f)+'</div>'
          + '</div></div>'
        )).join('');
      }
      if(noModel.length){
        html += '<div style="font-size:12px;font-weight:600;color:var(--text);margin:14px 0 6px">Sin el modelo en la descripción ('+noModel.length+') <span style="font-weight:400;color:var(--text-soft)">— no la nombra al principio; puede ser genérica o estar mal</span></div>';
        html += noModel.map(f=>(
          '<div style="padding:8px 10px;border:1px solid var(--border);border-left:3px solid #64748b;border-radius:8px">'
          + '<div style="font-size:13px;font-weight:600;color:var(--text);text-transform:capitalize">'+esc(f.model)+' · '+linkOf(f)+(f.visits?(' · <span style="font-weight:400;color:var(--text-soft)">'+visTxt(f)+'</span>'):'')+'</div>'
          + '<div style="font-size:11px;color:var(--text-muted);margin-top:3px">“'+esc(f.snip)+'…”</div>'
          + '</div>'
        )).join('');
      }
    }
    if(res) res.innerHTML = html;
  }catch(e){ if(res) res.innerHTML='<div style="color:#dc2626;font-size:13px;padding:8px">Error: '+esc(e.message)+'</div>'; console.error('[Promos] desc', e); }
  finally{ if(btn) btn.disabled=false; if(ld) ld.style.display='none'; }
}

// ── Incongruencias de SKU ────────────────────────────────────────────────────
// El Excel maestro ("sku y modelos.xlsx") es la FUENTE DE VERDAD de los SKU: cada base (modelo+color) es
// real; solo falta pegarle el TALLE al final (M-114-BLK- → M-114-BLK-S). Comparamos el seller_sku de CADA
// variación de cada publicación ACTIVA contra ese maestro, con match EXACTO de la base (sin diccionario de
// colores: si la base no está tal cual en el Excel, está mal escrita y el sistema no le descuenta stock):
//   1) TALLE MAL: la base SÍ está en el Excel pero el talle del final del SKU ≠ talle REAL de la variación
//      en ML (atributo SIZE/SIZE_GRID_ROW). Ej: SKU dice -S y la variación es talle M → error de carga.
//   2) FUERA DEL EXCEL: la base (SKU sin talle) no matchea ninguna del Excel → typo o color mal escrito.
//      Sugerimos la base más parecida (Levenshtein) para que se vea qué tendría que decir.
//   3) SIN TALLE: el SKU no termina en un talle reconocible, o la variación no tiene SKU cargado.
const SKU_SIZE_RE = /^(xxxs|xxs|xs|s|m|l|xl|xxl|xxxl|xxxxl|[2-6]xl|\d{2,3})$/i;
const SKU_SIZE_NORM = { '2XL':'XXL','3XL':'XXXL','4XL':'XXXXL','5XL':'XXXXXL','6XL':'XXXXXXL','2XS':'XXS','3XS':'XXXS' };
const normSku = s => norm(s).replace(/\s+/g,'-').replace(/-+/g,'-').replace(/-+$/,'');   // igual que las claves del maestro
function normSize(s){ const t=String(s||'').toUpperCase().trim(); return SKU_SIZE_NORM[t]||t; }
// base + talle del SKU normalizado: el talle es el último segmento si parece un talle (S/M/L/XL/38…).
function splitSku(nsku){
  const parts = nsku.split('-'), last = parts[parts.length-1]||'';
  if(parts.length>1 && SKU_SIZE_RE.test(last)) return { base: parts.slice(0,-1).join('-'), talle: normSize(last) };
  return { base: nsku, talle: null };
}
// base del Excel más parecida (para sugerir el correcto en un typo). lev() ya corta si la diferencia es >2.
function nearestBase(base, keys){ let best=null, bd=4; for(const k of keys){ const d=lev(base,k); if(d<bd){ bd=d; best=k; if(d<=1) break; } } return best; }

async function promoSkuIncong(force){
  const btn=document.getElementById('promo-sku-btn');
  const ld=document.getElementById('promo-sku-loading');
  const txt=document.getElementById('promo-sku-txt');
  const res=document.getElementById('promo-sku-results');
  const cnt=document.getElementById('promo-sku-count');
  if(btn) btn.disabled=true; if(ld) ld.style.display='flex'; if(res) res.innerHTML='';
  try{
    if(txt) txt.textContent='Indexando catálogo…';
    await ensureCatalog(!!force);
    // El índice viejo (anterior a este feature) no trae las variaciones (sku/talle/color) → reindexar una vez.
    if(!_catalog.some(it=> Array.isArray(it.vars))){ if(txt) txt.textContent='Actualizando índice con variaciones (~25s)…'; await ensureCatalog(true); }
    if(txt) txt.textContent='Cargando maestro de SKU…';
    await ensureSkuMaster();
    const master = _skuMaster || {};
    const baseKeys = Object.keys(master);                      // bases válidas (modelo+color) del Excel
    const baseSet = new Set(baseKeys);
    const knownModels = new Set(Object.values(master).map(norm));   // modelos que existen en el Excel
    if(!baseSet.size){ if(res) res.innerHTML='<div style="color:#dc2626;font-size:13px;padding:8px">No tengo cargado el maestro de SKU. Cargá el Excel en <b>Promos → “Cargar SKU↔modelo”</b> y reintentá.</div>'; return; }

    const seen = new Set();   // dedupe por publicación+sku (una familia puede repetir variantes entre item_ids)
    const talleBad=[], unkKnown=[], unkOther=[], noTalle=[];
    for(const it of _catalog){
      if(it.status!=='active' || !Array.isArray(it.vars)) continue;
      const model = norm(it.model), num = it.familyId || it.id;
      for(const v of it.vars){
        const raw = String(v.sku||'').trim();
        const dk = num+'|'+raw.toLowerCase(); if(seen.has(dk)) continue; seen.add(dk);
        const rec = { model, num, id:it.id, title:it.title||'', sku:raw, size:v.size||'', color:v.color||'' };
        if(!raw){ rec.sku='(variación sin SKU)'; noTalle.push(rec); continue; }
        const { base, talle } = splitSku(normSku(raw));
        if(baseSet.has(base)){
          const real = normSize(v.size);
          // SKU sin talle: solo es error si la variación SÍ tiene talle real (producto con talles al que le
          // falta el talle en el SKU). Un accesorio sin talles (mochila/bolso) con SKU sin talle está bien.
          if(!talle){ if(real) noTalle.push(rec); }
          else if(real && talle!==real){ rec.talle=talle; rec.real=v.size; talleBad.push(rec); }   // -S pero la variación es M
          // si no hay talle real en ML no puedo verificar → no lo marco
        } else {
          rec.base=base; rec.near=nearestBase(base, baseKeys); rec.nearModel = rec.near?master[rec.near]:'';
          // modelo conocido (o el más parecido es del mismo modelo) → typo/color del SKU; si ni el modelo
          // existe en el Excel, probablemente sea un producto no cargado todavía.
          if(knownModels.has(model) || (rec.nearModel && norm(rec.nearModel)===model)) unkKnown.push(rec);
          else unkOther.push(rec);
        }
      }
    }

    const total = talleBad.length+unkKnown.length+unkOther.length+noTalle.length;
    if(cnt) cnt.textContent = talleBad.length+' talle mal · '+(unkKnown.length+unkOther.length)+' fuera del Excel · '+noTalle.length+' sin talle'+(_catalogTs?(' · datos '+agoTxt(_catalogTs)):'');
    if(!total){ if(res) res.innerHTML='<div style="font-size:13px;color:#16a34a;padding:8px">✓ Sin incongruencias de SKU: todas las variaciones activas tienen un SKU del Excel con el talle correcto.</div>'; return; }

    // agrupa registros por publicación (abrir cada una una sola vez) y arma una card por publicación
    const code = s => '<code style="font-family:ui-monospace,Menlo,Consolas,monospace;background:var(--surface2);padding:1px 5px;border-radius:4px;font-size:11px">'+esc(s)+'</code>';
    const pubLink = g => mlEditA(g.num, g.id||g.num);
    const groupByPub = arr => { const m={}; for(const r of arr){ const k=String(r.num); (m[k]=m[k]||{num:r.num,id:r.id,model:r.model,title:r.title,rows:[]}).rows.push(r); } return Object.values(m); };
    const section = (title, sub, arr, color, rowFn) => {
      if(!arr.length) return '';
      const groups = groupByPub(arr); const CAP=120; const show=groups.slice(0,CAP);
      let h='<div style="font-size:12px;font-weight:600;color:var(--text);margin:14px 0 6px">'+title+' ('+arr.length+') <span style="font-weight:400;color:var(--text-soft)">'+sub+'</span></div>';
      h += show.map(g=>(
        '<div style="padding:9px 10px;border:1px solid var(--border);border-left:3px solid '+color+';border-radius:8px;margin-bottom:6px">'
        + '<div style="font-size:13px;font-weight:600;color:var(--text);text-transform:capitalize">'+esc(g.model||'(sin modelo)')+' · '+pubLink(g)+(g.title?(' <span style="font-weight:400;color:var(--text-soft)">· '+esc(g.title)+'</span>'):'')+'</div>'
        + '<div style="margin-top:4px;display:flex;flex-direction:column;gap:3px">'+g.rows.map(rowFn).join('')+'</div>'
        + '</div>'
      )).join('');
      if(groups.length>CAP) h+='<div style="font-size:11px;color:#d97706;padding:4px 8px">… y '+(groups.length-CAP)+' publicaciones más (mostrando las primeras '+CAP+').</div>';
      return h;
    };
    const ctx = r => (r.color||r.size) ? (' <span style="color:var(--text-soft)">(variación: '+esc([r.color,r.size].filter(Boolean).join(' / '))+')</span>') : '';
    let html='';
    html += section('Talle mal asignado', '— el SKU dice un talle pero la variación es otro (error de carga, alta confianza)', talleBad, '#dc2626',
      r => '<div style="font-size:12px;color:var(--text-muted)">'+code(r.sku)+' — el SKU dice talle <b style="color:#dc2626">'+esc(r.talle)+'</b> pero la variación es talle <b style="color:#dc2626">'+esc(r.real)+'</b></div>');
    html += section('SKU fuera del Excel', '— la base no coincide con ningún SKU del maestro (typo o color mal escrito → no descuenta stock)', unkKnown, '#d97706',
      r => '<div style="font-size:12px;color:var(--text-muted)">'+code(r.sku)+' — no coincide con el Excel'+(r.near?(' · ¿debería ser '+code(r.near+'-…')+'?'+(r.nearModel?(' <span style="color:var(--text-soft)">('+esc(r.nearModel)+')</span>'):'')):'')+ctx(r)+'</div>');
    html += section('SKU de un producto que no está en el Excel', '— ni el modelo figura en el maestro; puede ser un producto nuevo sin cargar', unkOther, '#64748b',
      r => '<div style="font-size:12px;color:var(--text-muted)">'+code(r.sku)+ctx(r)+'</div>');
    html += section('Sin talle reconocible', '— el SKU no termina en un talle (S/M/L/XL/…) o la variación no tiene SKU', noTalle, '#64748b',
      r => '<div style="font-size:12px;color:var(--text-muted)">'+code(r.sku)+ctx(r)+'</div>');
    if(res) res.innerHTML = html;
  }catch(e){ if(res) res.innerHTML='<div style="color:#dc2626;font-size:13px;padding:8px">Error: '+esc(e.message)+'</div>'; console.error('[Promos] sku', e); }
  finally{ if(btn) btn.disabled=false; if(ld) ld.style.display='none'; }
}

// ── Incongruencias de PRECIOS / DESCUENTOS ───────────────────────────────────
// Errores que pegan en el margen: (1) un descuento más profundo de lo que corresponde (precio mal),
// (2) un descuento de Clásica aplicado a una Premium (que ya paga comisión más alta → doble golpe).
// Métrica clave = el % que FINANCIA EL VENDEDOR: en co-fondeadas (SMART) el comprador ve un descuento
// mayor que el que paga el vendedor (ML aporta el resto) → usamos sellerPct, no el descuento del comprador.
// Caro (1 consulta de promo por publicación) → cacheamos el resultado 1h en localStorage.
let _priceScan = null, _priceScanTs = 0, _priceScanComplete = false;
// VERSIÓN DEL ESQUEMA del scan de precios (filas + opps). Las filas viajan por el almacén compartido (D1) y
// por localStorage; si un deploy cambia CÓMO se calculan (no solo qué campos hay), un blob viejo con los
// campos "correctos" seguiría pasando un chequeo por-campo → versionamos EXPLÍCITO. Cambiaste rowFromItem,
// campaignOpp o los opps del cron → bump acá Y en parkahub-api (fase price, misma constante). Un blob con
// sv distinto se descarta y se re-escanea en vivo (self-heal). Lección del bug jul-2026: el fix de candidatas
// SMART desactualizadas no se veía porque el almacén tenía filas con candCamps (pasaban el sniff) pero opps
// calculados por el código anterior.
export const SCAN_SV = 4;   // versión de esquema del blob de precios (fuente única; la reusa publicaciones.ts para su sv-gate)
let _opps = [];       // oportunidades de campaña (el botón Entrar las resuelve por índice global)
let _oppsFree = [];   // subconjunto SIN costo extra (para "Entrar a TODAS")
let _pxActiveTab = ''; // tab activo del apartado Precios (free|cost|incoh|cayo|otros) — persiste entre re-renders
let _pxEntering = false, _pxLastBgTs = 0;  // refresco-en-vivo en curso / último background (debounce)
let _discSnap = null;  // snapshot diario del estado de descuento (watchdog "cayó de promo"): {prev,curr,prevTs,currTs}
let _promoSeen = null; // mapa {campaign_id:{type,name,firstSeen,lastSeen}} de campañas ya ofrecidas → marcar las NUEVAS para entrar
let _campaignAlerts = null, _campaignAlertsTs = 0;   // campañas DEAL programadas/activas con candidatos sin sumar (card de "entrar")
let _campBusy = false;   // guarda: evita corridas simultáneas de ensureCampaignAlerts (causaban el "va y viene")
const _dealPrev = {};   // preview computado por promotionId (grupos A/co-fondeadas/sin-desc/fuera-de-banda)
const _dealPaused = {}; // flag de pausa por promotionId durante la entrada masiva
// Claves "itemId|promotionId" que YA entraste → se ocultan de oportunidades. ML tiene consistencia eventual:
// tras enrolar sigue devolviéndolas 'candidate' un rato, y si recargás la página reaparecerían. Por eso se
// PERSISTE en localStorage con TTL (sobrevive al refresh). Cuando el dato finalmente muestra que participás,
// el filtro de "ya participás" (joinedIds por ítem) las oculta igual; el TTL evita ocultarlas para siempre si
// algún día salís de la campaña. Solo se marcan las que ML confirmó (ok / ya activa).
const _JOINED_TTL = 5*24*60*60*1000;
let _joined = (function(){ try{ const o=JSON.parse(localStorage.getItem('parka_joined_promos')||'{}'); const now=Date.now(), m={}; for(const k in o){ if(now-o[k] < _JOINED_TTL) m[k]=o[k]; } return m; }catch(e){ return {}; } })();
function markJoined(key){ if(!key) return; _joined[key]=Date.now(); try{ localStorage.setItem('parka_joined_promos', JSON.stringify(_joined)); }catch(e){} }
function isJoined(key){ return _joined[key]!=null; }

// item resuelto (de /api/ml/promo-resolve) → fila del scan de precios. ÚNICO lugar de verdad: lo usan el
// scan completo (ensurePriceScan) y la reconciliación por-ítem (reconcilePrices) para que NO diverjan.
// maxOwnSellerPct (la base del "te cuesta") está en promo-math.ts.
function rowFromItem(it, ids, num, model, fam){
  // tier DIRECTO del listing_type_id (gold_pro=Premium, gold_special=Clásica); si falta/otro → 'Otro'
  // (NO asumir Clásica: si ML no devuelve el tipo, mejor no opinar que mal-clasificar todo).
  const lt = it.listingType||'';
  const tier = lt==='gold_pro' ? 'Premium' : (lt==='gold_special' ? 'Clasica' : 'Otro');
  const list = it.price||0;
  // buyer = lo que ve el comprador (potenciado si ML potencia); sellerCost = lo que financia el vendedor
  // (NO incluye el boost de ML) → coherencia/extremos no se disparan por un descuento que no pagás vos.
  const bp = bestActivePromo(it.promos, list);
  let buyer=null, sellerCost=null, bestType='', boosted=false, cofunded=false, meli=null;
  if(bp){ buyer=bp.buyerPct; sellerCost=bp.sellerPct; bestType=bp.type; boosted=bp.boosted; cofunded=bp.cofunded; meli=bp.meliPct; }
  // "te cuesta" de cada candidata = medido contra el MÁXIMO que ya financiamos hoy (no la mejor promo).
  const base = maxOwnSellerPct(it.promos, list);
  // promotion_ids en los que el ítem YA participa (activa / programada / pendiente). ML a veces devuelve la
  // MISMA campaña dos veces —como participada Y como candidata (re-invitación)—; una candidata a un id en el
  // que ya estás NO es oportunidad (verás "Dejar de participar" en ML, no "Participar"). La ocultamos.
  const joinedIds = new Set((it.promos||[]).filter(x=>{ const s=String(x.status||'').toLowerCase(); return s==='started'||s==='active'||s==='pending'; }).map(x=>x.promotionId).filter(Boolean));
  // Precio VIVO que ve el comprador (potenciado si ML potencia; sin promo activa = lista) — para la señal
  // de candidata posiblemente vieja en campaignOpp.
  const curEff = bp ? bp.effPrice : list;
  const opps = (it.promos||[]).map(x=> (x.promotionId && joinedIds.has(x.promotionId)) ? null : campaignOpp(x, list, base!=null?base:sellerCost, curEff)).filter(Boolean);
  // MEMBRESÍA POR CAMPAÑA (conteos EXACTOS + entrada masiva) — la fuente confiable, NO el endpoint de
  // campaña que subcuenta. inCamps = campañas donde YA participa; candCamps = de cuáles es CANDIDATA (TODOS
  // los tipos no-cupón, no solo las co-fondeadas de opps → incluye DEAL/DOD/LIGHTNING self-funded). Debe
  // espejar EXACTO el cron (index.ts fase price). ensureCampaignAlerts/dealOpenPreview agregan esto.
  const inCamps = [...joinedIds].map(v=>String(v));
  const candCamps = (it.promos||[]).filter(x=>{ const s=String(x.status||'').toLowerCase(); if(s==='started'||s==='active'||s==='pending'||s==='finished') return false; if(x.promotionId && joinedIds.has(x.promotionId)) return false; if(/COUPON|CUPON/i.test(x.type||'')) return false; return true; }).map(x=>x.promotionId).filter(Boolean).map(v=>String(v));
  return { sv:SCAN_SV, model, num, fam, ids, tier, list, buyer, sellerCost, bestType, boosted, cofunded, meli, opps, hasDisc: buyer!=null, inCamps, candCamps };
}
// ── vs MAESTRO ───────────────────────────────────────────────────────────────────────────────────────
// Cruza el scan de precios en vivo contra el MAESTRO cargado en la app (pub_master: modelo → full,
// descPrem/Clas, marca). Refleja las publicaciones cuyo PRECIO de lista o DESCUENTO se aleja del maestro
// (pedido de Martin 4/7). El descuento comparado es el que financia PARKA (sellerCost, sin el aporte de ML).
let _maestro = null;
async function ensureMaestro(){
  if(_maestro) return _maestro;
  try{ const r=await apiGet('/api/pub-master'); const d=r&&r.data?JSON.parse(r.data):null; _maestro=(d&&d.models)?d.models:{}; }catch(e){ _maestro={}; }
  return _maestro;
}
function maestroCrossHtml(){
  const M=_maestro||{};
  if(!Object.keys(M).length) return { html:'<div style="font-size:13px;color:var(--text-soft);padding:10px">Sin maestro cargado en la app — subí el Excel maestro (ART · SKU · Modelo · Precio Full · Desc Premium/Clásica · Marca) en la sección <b>Publicaciones</b>.</div>', count:0 };
  const rows=_priceScan||[];
  const link = r => mlPromosA(r.num, (r.ids&&r.ids[0])||r.num);
  const tb = t => t==='Premium'?'<span class="badge" style="background:#ede9fe;color:#5b21b6">Premium</span>':(t==='Clasica'?'<span class="badge" style="background:#e0f2fe;color:#075985">Clásica</span>':'<span class="badge" style="background:var(--surface2);color:var(--text-soft)">'+esc(t||'?')+'</span>');
  const proBad=[], descHi=[], descLo=[];
  for(const r of rows){
    const key=norm(r.model); const mm=M[key]; if(!mm) continue;   // modelo sin entrada en el maestro → no se cruza
    const full=mm.price; const dMae = r.tier==='Premium'?mm.descPrem : (r.tier==='Clasica'?mm.descClas : null);
    if(full>0 && r.list>0 && Math.round(r.list)!==Math.round(full)) proBad.push({r, full});
    if(dMae!=null && r.hasDisc && r.sellerCost!=null){
      const diff=Math.round((r.sellerCost-dMae)*10)/10;
      if(diff>2) descHi.push({r, dMae, diff});          // Parka da MÁS que el maestro → come margen (ej. Ground/Nimbus)
      else if(diff<-2) descLo.push({r, dMae, diff});    // Parka da MENOS → mal enrolada / cayó
    }
  }
  const count=proBad.length+descHi.length+descLo.length;
  if(!count) return { html:'<div style="font-size:13px;color:#16a34a;padding:10px">✓ Todo alineado con el maestro: precios de lista y descuentos (premium/clásica) coinciden en las publicaciones con modelo en el maestro.</div>', count:0 };
  const line=(x,extra)=>'<div style="font-size:12px;color:var(--text-muted);padding:5px 8px;border:1px solid var(--border);border-radius:6px;margin-bottom:3px;display:flex;gap:8px;align-items:center;flex-wrap:wrap"><span style="text-transform:capitalize;font-weight:700;color:var(--text)">'+esc(x.r.model||'?')+'</span> · '+link(x.r)+' '+tb(x.r.tier)+' · '+extra+'</div>';
  let h='';
  if(proBad.length){
    h+='<div style="font-size:13px;font-weight:700;margin:4px 0 6px;color:#b91c1c">Precio de lista distinto del maestro ('+proBad.length+')</div>';
    h+=proBad.sort((a,b)=>Math.abs(b.r.list-b.full)-Math.abs(a.r.list-a.full)).map(x=>line(x,'ML <b>'+money(x.r.list)+'</b> vs maestro <b>'+money(x.full)+'</b>')).join('');
  }
  if(descHi.length){
    h+='<div style="font-size:13px;font-weight:700;margin:14px 0 6px;color:#b45309">Dan MÁS descuento que el maestro — te come margen ('+descHi.length+')</div>';
    h+=descHi.sort((a,b)=>b.diff-a.diff).map(x=>line(x,'das <b>'+pct(x.r.sellerCost)+'%</b> vs maestro <b>'+pct(x.dMae)+'%</b> <span style="color:#b45309">(+'+pct(x.diff)+' ptos)</span>'+(x.r.cofunded?' <span class="badge" style="background:#e0e7ff;color:#3730a3" title="Co-fondeada: el % mostrado es lo que financiás VOS (ML aporta aparte)">co-fondeada</span>':''))).join('');
  }
  if(descLo.length){
    h+='<div style="font-size:13px;font-weight:700;margin:14px 0 6px;color:#0369a1">Dan MENOS descuento que el maestro ('+descLo.length+')</div>';
    h+=descLo.sort((a,b)=>a.diff-b.diff).map(x=>line(x,'das <b>'+pct(x.r.sellerCost)+'%</b> vs maestro <b>'+pct(x.dMae)+'%</b> <span style="color:#0369a1">('+pct(x.diff)+' ptos)</span>')).join('');
  }
  return { html:h, count };
}
async function ensurePriceScan(force){
  // Solo reusar de memoria si el scan previo se COMPLETÓ (igual que ventas: un batch caído no se queda pegado).
  if(_priceScan && _priceScanComplete && !force) return;
  if(!force){
    // Cache LOCAL (arranque instantáneo) vs ALMACÉN COMPARTIDO en D1 (que el backend mantiene fresco: cron +
    // refreshPriceRows tras CADA escritura de precio/promo). Elegimos el MÁS NUEVO por timestamp: si corregiste
    // y el backend refrescó el blob, le gana al cache local aunque el local tenga <1h → el dato viejo (ej. THOR
    // corregida pero el refresco del front se cortó) deja de mostrarse. Es 1 GET (barato), NO re-consultar ML
    // por ítem. sv: descartamos blobs/caches de otra versión de esquema (traerían cálculos viejos).
    let local=null; try{ const c=JSON.parse(localStorage.getItem('parka_price_scan_v5')||'null'); if(c&&acceptPriceBlob(c.rows,SCAN_SV)) local={rows:c.rows, ts:c.ts||0}; }catch(e){}
    let blob=null; try{ const w=await apiGet('/api/warehouse?part=prices'); const p=w&&w.prices?JSON.parse(w.prices):null; if(acceptPriceBlob(p,SCAN_SV)) blob={rows:p, ts:w.tsPrices?Date.parse(w.tsPrices):0}; }catch(e){}
    const pick = (local&&blob) ? (blob.ts>local.ts?blob:local) : (blob||local);   // el MÁS FRESCO
    if(pick && (Date.now()-pick.ts < 12*60*60*1000)){
      // Único punto donde data externa (D1/localStorage) entra a _priceScan → saneamos acá: acceptPriceBlob
      // valida SOLO row[0] (contrato O(1)), así que una fila null interior pasaría y rompería a los consumidores
      // que hacen row.ids (reconcilePrices, etc.). filter(Boolean) los protege a todos de un saque.
      const rows=pick.rows.filter(Boolean);
      if(rows.length!==pick.rows.length) console.warn('ensurePriceScan: blob con '+(pick.rows.length-rows.length)+' fila(s) null salteada(s) — dato compartido posiblemente incompleto');   // rastro (regla 13): no filtrar en silencio
      _priceScan=rows; _priceScanTs=pick.ts; _priceScanComplete=true;
      try{ localStorage.setItem('parka_price_scan_v5', JSON.stringify({ts:pick.ts, rows})); }catch(e){}
      return;
    }
  }
  await ensureCatalog(false);
  // UNA FILA POR MLA ACTIVA (no por rep de familia): auditoría jul-2026 → 40 candidaturas co-fondeadas en
  // hermanos de familia que el rep no tenía = oportunidades invisibles. Cada pub se resuelve per-ítem.
  // DEBE espejar pricePubs del cron (parkahub-api fase price).
  const pubs = {};
  for(const it of _catalog){
    if(it.status!=='active') continue;
    pubs['id:'+it.id] = { rep: it.id, model: it.model||'', num: it.id, fam: false, ids:[it.id] };
  }
  const reps = Object.values(pubs);
  const byId = {};
  let failed=false;
  const lt=document.getElementById('promo-precio-txt');
  for(let i=0;i<reps.length;i+=25){
    const batch = reps.slice(i,i+25).map(p=>p.rep);
    if(lt) lt.textContent='Consultando descuentos… '+i+'/'+reps.length;
    const r = await apiGet('/api/ml/promo-resolve?ids='+encodeURIComponent(batch.join(',')));
    if(r && r.ok) (r.items||[]).forEach(it=>byId[it.itemId]=it);
    else failed=true;   // un batch caído NO debe hacerse pasar por "sin descuento" en el almacén compartido
  }
  const rows = [];
  for(const p of reps){
    const it = byId[p.rep]; if(!it) continue;
    rows.push(rowFromItem(it, p.ids, p.num, p.model, p.fam));
  }
  _priceScan = rows; _priceScanTs = Date.now(); _priceScanComplete = !failed;   // si falló, la próxima llamada reintenta
  // Solo persistir/compartir si el scan se completó (sin batches fallidos). Si falló, queda en memoria
  // para esta sesión pero NO contamina el cache local ni el almacén compartido (precios incompletos).
  if(!failed){
    try{ localStorage.setItem('parka_price_scan_v5', JSON.stringify({ts:_priceScanTs, rows})); }catch(e){}
    invalidateWarehouse(); apiPost('/api/warehouse', { prices: rows }).then(res=>{ if(res==null) toast('No pude actualizar el almacén (precios) — quedan locales','info'); else if(res.pricesDropped) toast('El almacén rechazó los precios (versión de esquema desincronizada front/backend) — quedan locales','info'); });   // compartir el scan con todos
  }
}

// Snapshot diario del estado de descuento (watchdog "cayó de promo"). 1 GET barato a D1; lo escribe el cron
// al completar la fase price. Si falla o aún no hay foto, el watchdog simplemente no marca nada (no rompe).
async function ensureDiscSnap(){
  try{ const r=await apiGet('/api/disc-snap'); if(r && r.ok){ _discSnap={ prev:JSON.parse(r.prev||'{}'), curr:JSON.parse(r.curr||'{}'), prevTs:r.prevTs||null, currTs:r.currTs||null }; } }catch(e){}
}
// Campañas ya ofrecidas (para marcar las NUEVAS para entrar). 1 GET barato a D1; lo puebla el cron. Si falla,
// no se marca nada como "nueva" (la card igual muestra el total de oportunidades).
async function ensurePromoSeen(){
  try{ const r=await apiGet('/api/promo-seen'); if(r && r.ok && r.seen){ _promoSeen=r.seen; } }catch(e){}
}

// RECONCILIACIÓN POST-ESCRITURA (sin re-scan global): tras tocar N ítems, re-resuelve SOLO esos en vivo y
// parchea su fila en _priceScan + sube el scan (completo) al almacén. Barato (N/20 fetches) vs los ~414 del
// scan entero. Solo corre si ya había un scan completo (guard) para no subir un estado a-medias a Gonzalo.
async function reconcilePrices(ids){
  const uniq = [...new Set((ids||[]).filter(Boolean))];
  if(!uniq.length || !_priceScan || !_priceScanComplete) return;
  setLive('precio', { state:'busy' });
  const touched = new Set(uniq);
  const resolveAll = async ()=>{
    const fresh = {};
    for(let i=0;i<uniq.length;i+=20){            // ML multiget topa en 20 ids
      const slice = uniq.slice(i,i+20);
      const r = await apiGet('/api/ml/promo-resolve?ids='+encodeURIComponent(slice.join(',')));
      if(r && r.ok) (r.items||[]).forEach(it=>fresh[it.itemId]=it);
    }
    return fresh;
  };
  const patch = (fresh)=>{ _priceScan = _priceScan.map(row=>{
    if(!(row.ids||[]).some(id=>touched.has(id))) return row;          // fila no tocada → intacta
    const rep = (row.ids||[]).find(id=>fresh[id]);                    // primer id de la fila que se re-resolvió
    return rep ? rowFromItem(fresh[rep], row.ids, row.num, row.model, row.fam) : row;
  }); };
  // ML tiene CONSISTENCIA EVENTUAL tras salir/entrar de promos: el descuento reaplicado tarda en reflejarse.
  // Polleamos con backoff (antes era UN solo intento a 1,5s que capturaba el estado "en transición" = sin
  // descuento y lo dejaba pegado, aunque en ML el descuento estuviera aplicado). Cortamos apenas TODAS las
  // filas tocadas que se re-resolvieron muestran descuento (hasDisc) — que es lo que aplica este flujo. Si nunca
  // reflejan (posible pub que quedó sin descuento de verdad), terminamos igual: el estado REAL de ML manda.
  const delays = [1500, 2500, 3500, 5000];   // ~12,5s máx; corta antes si ya reflejó
  for(let attempt=0; attempt<delays.length; attempt++){
    await new Promise(r=>setTimeout(r, delays[attempt]));
    const fresh = await resolveAll();
    patch(fresh);
    try{ await promoPriceIncong(false); }catch(e){}                   // re-render progresivo (converge en pantalla)
    const done = _priceScan.filter(row=>(row.ids||[]).some(id=>touched.has(id) && fresh[id]));
    if(done.length && done.every(row=>row.hasDisc)) break;            // ML ya reflejó el descuento → listo
  }
  _priceScanTs = Date.now();   // sigue complete=true: solo cambiaron N filas de un scan que ya estaba entero
  try{ localStorage.setItem('parka_price_scan_v5', JSON.stringify({ts:_priceScanTs, rows:_priceScan})); }catch(e){}
  invalidateWarehouse(); apiPost('/api/warehouse', { prices: _priceScan });        // subir SOLO el estado final (real) al almacén
  setLive('precio', { state:'ok', ts:_priceScanTs });
}

// ENTRAR a la sección: pinta instantáneo del cache/almacén y, si el dato está viejo, dispara un refresco en
// vivo en SEGUNDO PLANO (sin bloquear, sin botón). Guardas anti-abuso: no hay dos scans pisándose (_pxEntering)
// y no re-escanea si el último background fue hace <5 min (_pxLastBgTs) — entrar/salir/entrar no re-escanea.
async function promoPriceEnter(){
  ensureCampaignAlerts(false);   // card de campañas DEAL con artículos para sumar (independiente del scan; no bloquea)
  try{ await promoPriceIncong(false); }catch(e){}   // instantáneo desde cache/almacén (como hoy)
  setLive('precio', { state: liveStateFor(_priceScanTs, 30*60000, _priceScanComplete), ts:_priceScanTs });
  const stale = !_priceScanTs || (Date.now()-_priceScanTs > 30*60000) || !_priceScanComplete;   // >30min = viejo (igual que el color del puntito)
  if(stale && !_pxEntering && (Date.now()-_pxLastBgTs > 5*60000)){
    _pxEntering=true; _pxLastBgTs=Date.now(); setLive('precio', { state:'busy' });
    try{
      await ensurePriceScan(true);
      if(document.getElementById('sec-promos')?.classList.contains('active')) await promoPriceIncong(false);
      setLive('precio', { state:'ok', ts:_priceScanTs });
    }catch(e){ setLive('precio', { online:false }); }
    finally{ _pxEntering=false; }
  }
}

// Clic en el puntito = forzar recálculo EN VIVO (reemplaza al viejo botón "Recalcular"). Es SOLO LECTURA de
// ML (no escribe) → clic simple, sin diálogos del navegador.
async function promoPriceForce(){
  if(_pxEntering) return;
  _pxEntering=true; _pxLastBgTs=Date.now(); setLive('precio', { state:'busy' });
  try{ await promoPriceIncong(true); setLive('precio', { state: liveStateFor(_priceScanTs, 30*60000, _priceScanComplete), ts:_priceScanTs }); }
  catch(e){ setLive('precio', { online:false }); }
  finally{ _pxEntering=false; }
}

// Coherencia de precio DENTRO del artículo (lo que pidió Martin): las publicaciones del mismo modelo deben
// tener (1) el MISMO precio de lista; (2) mismo descuento entre las Premium, mismo entre las Clásica; y
// (3) Clásica > Premium (Premium paga comisión más alta → descuenta menos). Además, REGLA DURA: todo
// producto lleva descuento inicial → una publicación activa SIN descuento es incongruencia por sí sola,
// aunque sea la única pub del modelo o estén TODAS sin descuento (entra a "incoherentes" con sus MLA).
// Ordenado por ventas 14d (las que más venden primero = más urgente). El "descuento extremo" (≥80%) queda
// como aviso aparte.
async function promoPriceIncong(force){
  const btn=document.getElementById('promo-precio-btn');
  const ld=document.getElementById('promo-precio-loading');
  const txt=document.getElementById('promo-precio-txt');
  const res=document.getElementById('promo-precio-results');
  const cnt=document.getElementById('promo-precio-count');
  const TOL = 0;   // tolerancia 0 (pedido de Martin): cualquier diferencia de descuento entre pubs del mismo artículo = incoherencia
  const setBody=(id,h)=>{ const el=document.getElementById(id); if(el) el.innerHTML=h; };   // llenar un panel de tab
  const setN=(id,n)=>{ const el=document.getElementById(id); if(el) el.textContent=n; };     // contador de un tab
  if(btn) btn.disabled=true; if(ld) ld.style.display='flex'; if(res) res.innerHTML='';
  try{
    if(txt) txt.textContent=force?'Recalculando precios en vivo (~2 min)…':'Consultando precios y descuentos…';
    await ensurePriceScan(!!force);
    if(txt) txt.textContent='Trayendo ventas 14d…';
    await ensureSales2w();
    await ensureDiscSnap();   // foto diaria del descuento (para detectar las que cayeron de promo)
    await ensureMaestro();    // maestro en la app (pub_master) para el cruce «vs Maestro»
    const sales=_sales2w||{};
    const salesOf = ids => ids.reduce((a,id)=>a+(sales[id]||0),0);
    // consenso de descuento: moda a 1 decimal (NO redondear a entero — 60,7 es un valor real, no 60).
    const modeOf = arr => { if(!arr.length) return 0; const r=v=>Math.round(v*10)/10; const f={}; arr.forEach(v=>{const k=r(v); f[k]=(f[k]||0)+1;}); let best=r(arr[0]),bc=0; for(const k in f){ if(f[k]>bc){best=+k;bc=f[k];} } return best; };
    // agrupar publicaciones por ARTÍCULO (modelo)
    const arts={};
    for(const r of _priceScan){ const m=norm(r.model); if(!m) continue; r.sales2w=salesOf(r.ids); (arts[m]=arts[m]||[]).push(r); }
    const flagged=[]; const extreme=[];
    for(const m in arts){
      // Agrupadas por TIPO (Premium juntas, después Clásica, después Otro) y dentro de cada tipo por ventas.
      // Así en la tarjeta de incoherentes se comparan las de un mismo tipo de un vistazo (pedido de Martin).
      const _tr=t=> t==='Premium'?0:(t==='Clasica'?1:2);
      const pubs=arts[m].slice().sort((x,y)=> _tr(x.tier)-_tr(y.tier) || (y.sales2w-x.sales2w));
      const artSales=pubs.reduce((a,p)=>a+p.sales2w,0);
      pubs.forEach(p=>{ if(p.hasDisc && p.sellerCost>=80) extreme.push(p); });
      const issues=[];
      // OBJETIVO = el MAESTRO (pub_master), NO el consenso entre publicaciones (pedido de Martin 4/7). Las
      // incongruencias son CONTRA el maestro: precio de lista + descuento por tier (Premium/Clásica). El
      // corrector pre-tilda las que difieren del maestro y pre-carga el % del MAESTRO. Si el modelo no está
      // en el maestro, solo aplica la regla dura de "sin descuento" (no inventa un objetivo).
      const mm=_maestro[m]||null;
      const tierD={ Premium: (mm && mm.descPrem!=null ? mm.descPrem : null), Clasica: (mm && mm.descClas!=null ? mm.descClas : null) };
      const fullM = (mm && mm.price>0) ? Math.round(mm.price) : null;
      // descuento (lo que financia PARKA) vs el % del maestro, por tier
      for(const t of ['Premium','Clasica']){
        const dM=tierD[t]; if(dM==null) continue;
        const off=pubs.filter(p=>p.tier===t && p.hasDisc && p.sellerCost!=null && Math.abs(p.sellerCost-dM)>TOL);
        if(off.length) issues.push((t==='Premium'?'Premium':'Clásica')+': '+off.length+' con descuento ≠ maestro ('+pct(dM)+'%) → dan '+[...new Set(off.map(p=>pct(p.sellerCost)+'%'))].join(' / '));
      }
      // REGLA DURA (Martin): todo producto lleva descuento inicial → una pub activa SIN descuento es
      // incongruencia por sí sola (aunque el modelo no esté en el maestro).
      const noDisc=pubs.filter(p=>!p.hasDisc);
      if(noDisc.length) issues.push(noDisc.length+(pubs.length>1?(' de '+pubs.length):'')+' sin descuento — el maestro define descuento inicial');
      // PRECIO de lista vs maestro (se marca; el corrector solo toca descuento — el precio se ajusta aparte)
      if(fullM){
        const badP=pubs.filter(p=>p.list>0 && Math.round(p.list)!==fullM);
        if(badP.length) issues.push(badP.length+' con precio de lista ≠ maestro ('+money(fullM)+')');
      }
      // PRE-TILDAR vs MAESTRO: SIN descuento; PROPIA con descuento ≠ maestro; CO-FONDEADA que da MÁS que el
      // maestro (te come margen — al aplicar el corrector la saca y queda en la propia al %). Co-fondeada que
      // da ≤ maestro NO se tilda (ML aporta y no te pasás → está bien). Modelo sin maestro: solo sin-descuento.
      pubs.forEach(p=>{
        const dM=tierD[p.tier];
        if(!p.hasDisc){ p._fix=true; return; }
        if(dM==null){ p._fix=false; return; }
        const d=(p.sellerCost||0)-dM;
        p._fix = p.cofunded ? (d>TOL) : (Math.abs(d)>TOL);
      });
      if(issues.length) flagged.push({model:m, pubs, artSales, issues, cons:tierD});
    }
    flagged.sort((a,b)=>b.artSales-a.artSales);
    let sinDesc = _priceScan.filter(r=>!r.hasDisc).sort((a,b)=>(b.sales2w||0)-(a.sales2w||0));   // activas sin descuento, por ventas
    // WATCHDOG "cayó de promo": publicaciones que TENÍAN descuento en una foto reciente (snapshot diario
    // disc_snap) y AHORA, en el scan en vivo, NO lo tienen → cayeron de la promo solas = a precio full =
    // pierden ventas. Es el aviso que da la cuenta de ML, automático. Guardas:
    //  • Solo si en vivo NO tiene descuento (r.hasDisc=false): si ya se recuperó, no aparece (mata el falso
    //    positivo por la consistencia eventual de ML tras reaplicar).
    //  • Anti-REÚSO de MLA (regla dura: item_id no estable): exige que el MODEL de la foto coincida con el
    //    modelo vivo. Si cambió, la publicación se recicló con otra campera → NO es "cayó".
    //  • Sin modelo resuelto (MODEL vacío) → no podemos descartar reúso → fuera del watchdog.
    _priceScan.forEach(r=>{ r._cayo=0; });
    let cayo=[];
    if(_discSnap){
      const prevM=_discSnap.prev||{}, currM=_discSnap.curr||{};
      const pTs=_discSnap.prevTs?Date.parse(_discSnap.prevTs):0, cTs=_discSnap.currTs?Date.parse(_discSnap.currTs):0;
      // Gate de frescura: el scan en vivo puede venir del cache local (hasta 1h viejo) mientras la foto del
      // cron es siempre fresca. Solo confío en el hasDisc EN VIVO como "estado de ahora" si el scan NO es más
      // viejo que la última foto; si lo es, uso la foto (curr) que es más nueva. (Evita marcar "cayó" una pub
      // que el cron ya volvió a poner en promo hoy pero el scan cacheado todavía la ve sin descuento.)
      const liveFresh = !!_priceScanTs && !!cTs && _priceScanTs >= cTs;
      for(const r of _priceScan){
        const lm=norm(r.model); if(!lm) continue;      // sin modelo resuelto → no podemos descartar reúso
        const key=String(r.num); const c=currM[key], p=prevM[key];
        const nowHasDisc = liveFresh ? r.hasDisc : (c ? c.d===1 : r.hasDisc);   // estado de "ahora" = la señal más fresca
        if(nowHasDisc) continue;                       // ahora tiene descuento / se recuperó → no cayó
        let when=0;
        // A) el scan en vivo (fresco) ya no tiene descuento, pero la foto de hoy SÍ tenía (mismo modelo) → cayó recién.
        if(liveFresh && c && c.d===1 && norm(c.m)===lm) when=cTs;
        // B) la foto ANTERIOR tenía descuento (mismo modelo) y la última ya no → cayó entre fotos. Descarto reúso:
        //    si la última foto muestra un modelo resuelto DISTINTO, la MLA se recicló → no lo atribuyo a este modelo.
        else if(p && p.d===1 && norm(p.m)===lm && (!c || (c.d===0 && (!c.m || norm(c.m)===lm)))) when=cTs||pTs;
        if(when){ r._cayo=when; r.sales2w=salesOf(r.ids); cayo.push(r); }
      }
      // ORDEN por PRIORIDAD (pedido de Martin): la ÚLTIMA en caer primero (lo más reciente = actuá YA), y
      // como desempate las que MÁS venden (más plata perdida a precio full). _cayo = timestamp de la caída.
      cayo.sort((a,b)=>(b._cayo||0)-(a._cayo||0) || (b.sales2w||0)-(a.sales2w||0));
    }
    // OPORTUNIDADES de campaña (ML pone plata): UNA FILA POR PUBLICACIÓN (num) × campaña — pedido de Martin:
    // NO fusionar publicaciones distintas aunque compartan modelo/tier/valores (cada una con su MLA y su
    // Entrar; el backend valida cada id en vivo igual). Solo las familias multi-MLA reales del catálogo
    // (r.ids>1, comparten stock físico) siguen agrupadas en su fila. Rankear por net, luego ventas.
    const oppSeen={}; const oppU=[];
    for(const r of _priceScan){ const s=salesOf(r.ids); for(const o of (r.opps||[])){
      // ocultar las que ya entraste en esta sesión (ML todavía puede reportarlas 'candidate' por lag)
      if((r.ids||[]).some(id=>isJoined(id+'|'+(o.promotionId||'')))) continue;
      const k=String(r.num)+'|'+o.type+'|'+(o.promotionId||''); if(!oppSeen[k]){ oppSeen[k]={...o, model:r.model, num:r.num, ids:[...(r.ids||[])], tier:r.tier, sales2w:s, pubs:1}; oppU.push(oppSeen[k]); } } }
    oppU.sort((a,b)=>(b.net-a.net)||((b.sales2w||0)-(a.sales2w||0)));
    const oppFreeN = oppU.filter(o=>o.extra<=0).length;
    if(cnt) cnt.textContent = (oppU.length?('⚡ '+oppU.length+' oportunidad'+(oppU.length===1?'':'es')+(oppFreeN?(' ('+oppFreeN+' sin costo)'):'')+' · '):'')+flagged.length+' artículo'+(flagged.length===1?'':'s')+' incoherente'+(flagged.length===1?'':'s')+' · '+sinDesc.length+' sin descuento'+(cayo.length?(' · ⚠ '+cayo.length+' cayeron de promo'):'')+(extreme.length?(' · '+extreme.length+' extremos'):'')+(_priceScanTs?(' · datos '+agoTxt(_priceScanTs)):'');   // frescura visible (y también en el tooltip del puntito)
    // link SIEMPRE clickeable: muestra #num (familia o ítem) pero linkea al primer item_id real (abre la publicación)
    const linkOf = p => mlPromosA(p.num, (p.ids&&p.ids[0])||p.num);
    const tierBadge = t => t==='Premium' ? '<span class="badge" style="background:#ede9fe;color:#5b21b6">Premium</span>' : (t==='Clasica' ? '<span class="badge" style="background:#e0f2fe;color:#075985">Clásica</span>' : '<span class="badge" style="background:var(--surface2);color:var(--text-soft)">'+esc(t||'?')+'</span>');
    const discTxt = p => !p.hasDisc ? ('<span style="color:#d97706">sin descuento</span>'+(p._cayo?(' <span class="badge" title="Tenía descuento y lo perdió: cayó de la promoción sola. Reentrala para no vender a precio full." style="background:#fee2e2;color:#b91c1c;font-weight:700">⚠ cayó '+agoTxt(p._cayo)+'</span>'):'')) : ('desc <b>'+pct(p.sellerCost)+'%</b>'+((p.buyer!=null&&Math.abs(p.buyer-p.sellerCost)>=1)?(' <span style="color:var(--text-soft)">(comprador '+pct(p.buyer)+'%'+(p.boosted?' ⚡ML':'')+')</span>'):'')+(p.cofunded?(' <span class="badge" title="Co-fondeada: ML aporta'+(p.meli!=null?(' '+pct(p.meli)+'%'):'')+'. Bajar el descuento te SACA de la promo y perdés ese aporte de ML." style="background:#e0e7ff;color:#3730a3">⚡ ML aporta'+(p.meli!=null?(' '+pct(p.meli)+'%'):'')+'</span>'):''));
    // ⚡ OPORTUNIDADES: campañas candidatas donde ML pone plata. Dos grupos:
    //   • SIN COSTO (extra ≤ 0): no descontás más de lo que ya hacés → entrar MASIVO de un clic.
    //   • CON COSTO (extra > 0): te piden invertir más % → se listan para que DECIDAS (y el sistema aprende).
    oppU.forEach((o,i)=>{ o._i=i; });
    _opps = oppU;
    const oppFree = oppU.filter(o=>o.extra<=0);
    const oppCost = oppU.filter(o=>o.extra>0);
    _oppsFree = oppFree;
    // Fila por CAMPAÑA×TIER = una publicación (o grupo de pubs del mismo modelo+tier). Cada fila muestra SU
    // propia publicación (link + tier), porque un modelo puede tener varias pubs (una Premium, otra Clásica).
    const campaignLine = (o)=>{
      const extraTxt = o.extra<=0 ? '<span style="color:#16a34a;font-weight:600" title="No agregás nada de tu bolsillo por encima de lo que YA financiás hoy">sin costo extra</span>' : ('<span title="Puntos que agregás de TU bolsillo por encima del máximo que ya financiás hoy (no cuenta el aporte de ML)">te cuesta <b style="color:#dc2626">+'+pct2(o.extra)+'</b> pto'+(o.extra===1?'':'s')+'</span>');
      const npubs = (o.ids && o.ids.length) || o.pubs || 1;
      // "das X% hoy" = tu mayor % propio en esta pub (la base contra la que se mide "te cuesta").
      const baseTxt = o.base!=null ? ('<span style="color:var(--text-soft)" title="Tu mayor descuento propio activo en esta publicación (sin contar aportes de ML) — la base contra la que se mide el costo de entrar">das '+pct2(o.base)+'%</span> · ') : '';
      // Precio objetivo de la oferta: cotejable 1:1 contra la columna "Precio final" del panel de ML.
      const tgtTxt = o.target ? (' <span style="color:var(--text-soft)" title="Precio final que fija esta oferta — compará con la columna Precio final del panel de Promociones de ML. Si ML muestra OTRO precio, la candidata está desactualizada (el dato exacto es el de ML).">(a '+money(Math.round(o.target))+')</span>') : '';
      return '<div class="opp-row" data-opp="'+o._i+'" style="border-top:1px dashed var(--border);padding:5px 0">'
        + '<div style="display:flex;gap:6px;align-items:center;flex-wrap:wrap;font-size:12px;color:var(--text-muted)">'
        +   (o.extra<=0?'<span title="No te cuesta puntos extra">🟢</span> ':'')
        +   tierBadge(o.tier)
        +   ' '+linkOf(o)+(npubs>1?(' <span style="color:var(--text-soft)">('+npubs+' pubs '+(o.tier||'')+')</span>'):'')
        +   ' <span class="badge" style="background:#e0e7ff;color:#3730a3">'+esc(TIPO_LABEL[o.type]||o.type)+'</span>'
        +   (o.name?(' <span class="badge" title="Nombre de la campaña en Mercado Libre — buscala así en el panel de Promociones" style="background:#f1f5f9;color:#334155;font-weight:600">'+esc(o.name)+'</span>'):'')
        +   ' · '+baseTxt+'pide <b'+(o.approx?' title="Oferta posiblemente desactualizada: el precio objetivo es bastante más profundo que tu precio actual. OJO: ML tiene varias versiones de la misma oferta conviviendo — su propio panel puede mostrar números DISTINTOS al refrescar (verificado jul-2026). El número definitivo recién se confirma al entrar (la app te muestra qué aplicó ML) o en el panel de ML del momento."':'')+'>'+(o.approx?'~':'')+pct2(o.reqSeller)+'%</b>'+tgtTxt+' · ML <b style="color:#16a34a">+'+pct2(o.meli)+'%</b> → comprador <b>'+(o.approx?'~':'')+pct2(o.buyer)+'%</b>'
        +   ' · '+extraTxt
        +   '<button class="opp-join-btn btn btn-sm" onclick="promoJoinOpp('+o._i+')" style="margin-left:auto;background:#0ea5e9;color:#fff;border-color:#0ea5e9;font-weight:600">Entrar'+(o.pubs>1?(' ('+o.ids.length+')'):'')+'</button>'
        + '</div>'
        + '<div class="opp-join-st" style="font-size:11px;margin-top:3px"></div>'
        + '</div>';
    };
    // AGRUPA las oportunidades por publicación (modelo) → una publicación = un solo bloque con TODAS sus
    // campañas juntas (antes se repetía en filas sueltas). Grupos ordenados por prioridad (mejor "net" que
    // regala ML, luego ventas); campañas dentro del grupo, igual. Muestra TODO (sin corte).
    const oppGroupsHtml = (opps)=>{
      const gmap={}, order=[];
      for(const o of opps){ const key=norm(o.model)||('#'+o._i); let g=gmap[key]; if(!g){ g=gmap[key]={model:o.model,num:o.num,ids:new Set(),items:[],bestNet:-Infinity,sales:0}; order.push(g); } g.items.push(o); (o.ids||[]).forEach(id=>g.ids.add(id)); if((o.net||0)>g.bestNet) g.bestNet=o.net||0; if((o.sales2w||0)>g.sales) g.sales=o.sales2w||0; }
      order.forEach(g=>g.items.sort((a,b)=>(b.net-a.net)||((b.sales2w||0)-(a.sales2w||0))));
      order.sort((a,b)=>(b.bestNet-a.bestNet)||(b.sales-a.sales));
      return order.map(g=>(
        '<div style="border:1px solid var(--border);border-radius:8px;margin-bottom:6px;padding:8px 10px">'
        + '<div style="font-size:12px"><span style="text-transform:capitalize;font-weight:700;color:var(--text)">'+esc(g.model||'?')+'</span> <span style="color:var(--text-soft)">· modelo · '+g.ids.size+' publicaci'+(g.ids.size===1?'ón':'ones')+' con oportunidad · '+(g.sales||0)+' vend. 14d</span></div>'
        + g.items.map(campaignLine).join('')
        + '</div>'
      )).join('');
    };
    // Nota compartida de las oportunidades (mismo texto en los dos tabs de campaña).
    const oppNote = '<div style="font-size:10px;color:var(--text-soft);margin:8px 0 2px">El % es lo que financiás VOS; ML suma su parte encima. "Entrar" enrola en ML (doble-clic). Cada entrada queda registrada para ir aprendiendo qué conviene.</div>';
    // ── TAB 1: Sin costo ──────────────────────────────────────────────
    let freeHtml='';
    if(oppFree.length){
      freeHtml += '<div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap;margin:2px 0 6px">'
        + '<span style="font-size:12px;font-weight:600;color:var(--text)">🟢 Sin costo para vos ('+oppFree.length+') — ML pone plata, vos no descontás más</span>'
        + '<button id="opp-join-all" onclick="promoJoinAllFree()" class="btn btn-sm" style="background:#16a34a;color:#fff;border-color:#16a34a;font-weight:600">⚡ Entrar a TODAS sin costo ('+oppFree.length+')</button>'
        + '<span id="opp-join-all-st" style="font-size:11px;color:var(--text-soft)"></span>'
        + '</div>';
      freeHtml += oppGroupsHtml(oppFree);   // TODAS, agrupadas por publicación, por prioridad
      freeHtml += oppNote;
    } else freeHtml = '<div style="font-size:13px;color:var(--text-soft);padding:8px">No hay oportunidades sin costo extra ahora mismo.</div>';
    // ── TAB 2: Cuestan descuento extra ───────────────────────────────
    let costHtml='';
    if(oppCost.length){
      costHtml += '<div style="font-size:12px;font-weight:600;color:var(--text);margin:2px 0 6px">Cuestan descuento extra ('+oppCost.length+') <span style="font-weight:400;color:var(--text-soft)">— ML pone plata pero tenés que invertir más %. Decidí cuáles (ordenadas por lo que regala ML neto de tu costo).</span></div>';
      costHtml += oppGroupsHtml(oppCost);   // TODAS, agrupadas por publicación, por prioridad
      costHtml += oppNote;
    } else costHtml = '<div style="font-size:13px;color:var(--text-soft);padding:8px">No hay oportunidades que cuesten descuento extra ahora mismo.</div>';
    // ── TAB 3: Artículos incoherentes ────────────────────────────────
    let incohHtml='';
    if(flagged.length){
      incohHtml += flagged.map((a,idx)=>(
        '<div class="pxfix-card" data-art="'+idx+'" data-model="'+esc(a.model)+'" data-sugg-con="'+(a.cons&&a.cons.Premium!=null?a.cons.Premium:'')+'" data-sugg-sin="'+(a.cons&&a.cons.Clasica!=null?a.cons.Clasica:'')+'" data-sugg-pubs="'+esc(a.pubs.filter(p=>p._fix).flatMap(p=>p.ids||[]).join(','))+'" style="padding:10px;border:1px solid var(--border);border-left:3px solid #dc2626;border-radius:8px;margin-bottom:6px">'
        + '<div style="font-size:13px;font-weight:600;color:var(--text);text-transform:capitalize">'+esc(a.model)+' <span style="font-weight:400;color:var(--text-soft)">· '+a.pubs.length+' publicaciones · '+a.artSales+' vendidas 14d</span></div>'
        + '<div style="margin:5px 0">'+a.issues.map(i=>'<div style="font-size:12px;color:#dc2626;font-weight:600">• '+esc(i)+'</div>').join('')+'</div>'
        + '<div style="display:flex;flex-direction:column;gap:3px;margin-top:4px">'+a.pubs.map(p=>(
            '<label style="font-size:11px;color:var(--text-muted);display:flex;gap:8px;align-items:center;flex-wrap:wrap;cursor:pointer;padding:2px 4px;border-radius:4px;background:'+(p._fix?'#fff7ed':'transparent')+'"><input type="checkbox" class="pxfix-chk" data-ids="'+esc((p.ids||[]).join(','))+'" data-tier="'+esc(p.tier||'')+'"'+(p._fix?' checked':'')+'> '+linkOf(p)+' '+tierBadge(p.tier)+' · '+money(p.list)+' · '+discTxt(p)+' · '+p.sales2w+' vend.'+(p._fix?' <span style="color:#d97706;font-size:10px">← a corregir</span>':'')+'</label>'
          )).join('')+'</div>'
        + '<div style="margin-top:8px;padding-top:8px;border-top:1px dashed var(--border);display:flex;gap:10px;align-items:center;flex-wrap:wrap">'
          + '<span style="font-size:11px;color:var(--text-soft);font-weight:600">Corregir descuento:</span>'
          + '<label style="font-size:11px;color:var(--text-muted)">Premium <input class="pxfix-con" type="number" min="1" max="80" style="width:52px;font-size:11px" placeholder="%" value="'+(a.cons&&a.cons.Premium!=null?a.cons.Premium:'')+'"></label>'
          + '<label style="font-size:11px;color:var(--text-muted)">Clásica <input class="pxfix-sin" type="number" min="1" max="80" style="width:52px;font-size:11px" placeholder="%" value="'+(a.cons&&a.cons.Clasica!=null?a.cons.Clasica:'')+'"></label>'
          + '<button class="pxfix-btn btn btn-sm" onclick="promoFixDisc('+idx+')" style="background:#16a34a;color:#fff;border-color:#16a34a;font-weight:600">Aplicar a tildadas</button>'
          + '</div>'
        + '<div class="pxfix-status" style="font-size:11px;margin-top:6px"></div>'
        + '<div style="font-size:10px;color:var(--text-soft);margin-top:3px">El precio de lista no se cambia por acá (ML no lo permite por API con ventas) — ajustalo a mano en la publicación.</div>'
        + '</div>'
      )).join('');
    } else {
      incohHtml += '<div style="font-size:13px;color:#16a34a;padding:8px">✓ Coherencia OK: en cada artículo las publicaciones tienen el mismo precio de lista, descuentos consistentes por tipo y todas con descuento.</div>';
    }
    // ── TAB 4: Otros (descuento extremo + sin descuento sin modelo resuelto) ──
    let otrosHtml='';
    if(extreme.length){
      extreme.sort((a,b)=>(b.sellerCost||0)-(a.sellerCost||0));
      otrosHtml += '<div style="font-size:12px;font-weight:600;color:var(--text);margin:2px 0 6px">Descuento extremo ≥80% ('+extreme.length+') <span style="font-weight:400;color:var(--text-soft)">— ¿precio mal cargado?</span></div>';
      otrosHtml += extreme.map(p=>(
        '<div style="font-size:12px;color:var(--text-muted);padding:6px 8px;border:1px solid var(--border);border-left:3px solid #d97706;border-radius:6px;margin-bottom:4px"><span style="text-transform:capitalize;font-weight:600;color:var(--text)">'+esc(p.model||'?')+'</span> · '+linkOf(p)+' '+tierBadge(p.tier)+' · '+money(p.list)+' · desc <b>'+Math.round(p.sellerCost)+'%</b></div>'
      )).join('');
    }
    // Las sin-descuento CON modelo resuelto ya están en el tab "Incoherentes" (cada modelo con todas sus
    // MLA, pre-tildadas). Acá quedan solo las que NO pudimos atribuir a un modelo (atributo MODEL vacío) →
    // no se pueden agrupar; hay que revisar la publicación.
    const sinDescOrphan = sinDesc.filter(r=>!norm(r.model));
    if(sinDescOrphan.length){
      const CAP=80, show=sinDescOrphan.slice(0,CAP), conV=sinDescOrphan.filter(r=>(r.sales2w||0)>0).length;
      otrosHtml += '<div style="font-size:12px;font-weight:600;color:var(--text);margin:14px 0 6px">Sin descuento y sin modelo resuelto ('+sinDescOrphan.length+') <span style="font-weight:400;color:var(--text-soft)">— sin atributo MODEL para agruparlas por artículo; revisá la publicación · ordenadas por ventas 14d · '+conV+' venden sin descuento</span></div>';
      otrosHtml += show.map(p=>(
        '<div style="font-size:12px;color:var(--text-muted);padding:6px 8px;border:1px solid var(--border);border-left:3px solid '+((p.sales2w||0)>0?'#d97706':'#64748b')+';border-radius:6px;margin-bottom:3px;display:flex;gap:8px;align-items:center;flex-wrap:wrap"><span style="text-transform:capitalize;font-weight:600;color:var(--text)">'+esc(p.model||'?')+'</span> · '+linkOf(p)+' '+tierBadge(p.tier)+' · '+money(p.list)+' · <b>'+(p.sales2w||0)+'</b> vend. 14d</div>'
      )).join('');
      if(sinDescOrphan.length>CAP) otrosHtml += '<div style="font-size:11px;color:var(--text-soft);padding:4px 8px">… y '+(sinDescOrphan.length-CAP)+' más (sin ventas o muy pocas)</div>';
    }
    if(!otrosHtml) otrosHtml = '<div style="font-size:13px;color:var(--text-soft);padding:8px">Nada para revisar acá.</div>';
    // ── TAB 5: Cayó de promo (watchdog) + SIN NINGÚN DESCUENTO ───────
    // Dos secciones (pedido de Martin): (1) caídas RECIENTES detectadas por el watchdog (compara fotos —
    // solo ve lo que cayó desde que existe la foto); (2) TODAS las activas que HOY no tienen ningún
    // descuento (caídas viejas, hermanas destapadas por el scan per-MLA, o nunca tuvieron), con % sugerido
    // (el mayor % propio del mismo modelo en otras pubs) y APLICAR in-page (PRICE_DISCOUNT vía promo-apply,
    // doble-clic + decision_log + reconcile). Antes estaban listadas sin acción y las viejas no se veían.
    let cayoHtml='';
    if(cayo.length){
      const conV=cayo.filter(r=>(r.sales2w||0)>0).length;
      cayoHtml += '<div style="font-size:12px;font-weight:600;color:var(--text);margin:2px 0 6px">⚠ Cayeron de promoción ('+cayo.length+') <span style="font-weight:400;color:var(--text-soft)">— tenían descuento y ahora están a precio full → pierden ventas. Reentralas (el link abre sus promociones en ML). Ordenadas por ventas 14d · '+conV+' venden a precio full.</span></div>';
      cayoHtml += cayo.map(p=>(
        '<div style="font-size:12px;color:var(--text-muted);padding:6px 8px;border:1px solid var(--border);border-left:3px solid #dc2626;border-radius:6px;margin-bottom:4px;display:flex;gap:8px;align-items:center;flex-wrap:wrap">'
        + '<span style="text-transform:capitalize;font-weight:700;color:var(--text)">'+esc(p.model||'?')+'</span> · '+linkOf(p)+' '+tierBadge(p.tier)+' · '+money(p.list)
        + ' · <span class="badge" style="background:#fee2e2;color:#b91c1c;font-weight:700">cayó '+agoTxt(p._cayo)+'</span>'
        + ' · <b>'+(p.sales2w||0)+'</b> vend. 14d'
        + '</div>'
      )).join('');
      cayoHtml += '<div style="font-size:10px;color:var(--text-soft);margin-top:6px">Compara la foto diaria del descuento (ayer vs hoy) y el estado en vivo, descartando reúso de publicación (mismo modelo en ambas fotos). La comparación día-a-día se completa tras la segunda foto diaria. Si ya la reentraste y ML la reflejó, desaparece sola.</div>';
    } else cayoHtml = '<div style="font-size:13px;color:#16a34a;padding:8px">✓ Ninguna publicación se cayó de una promoción recientemente. <span style="color:var(--text-soft)">(Compara la foto de descuento de ayer vs hoy; la comparación día-a-día se completa tras la segunda medición diaria.)</span></div>';
    // SIN NINGÚN DESCUENTO AHORA — todas las activas a precio full, accionables. % sugerido = el mayor %
    // propio que el mismo modelo ya da en otras publicaciones (hermanas); editable antes de aplicar.
    _sinDescL = sinDesc.slice();
    _sinDescL.forEach(r=>{ if(r.sales2w==null) r.sales2w=salesOf(r.ids); });
    _sinDescL.sort((a,b)=>(b.sales2w||0)-(a.sales2w||0));
    if(_sinDescL.length){
      const modelDisc={};
      for(const r of _priceScan){ if(r.hasDisc && r.sellerCost!=null){ const m=norm(r.model); if(m) modelDisc[m]=Math.max(modelDisc[m]||0, r.sellerCost); } }
      const dIso=(ms)=>{ const d=new Date(ms); return d.getFullYear()+'-'+String(d.getMonth()+1).padStart(2,'0')+'-'+String(d.getDate()).padStart(2,'0'); };
      const conV=_sinDescL.filter(r=>(r.sales2w||0)>0).length;
      // MULTI-ENTRADA (rediseño 3/7, pedido de Martin): el % de la fila es LA LLAVE — entra a TODAS las
      // promociones que ese número cubra (propia julio + co-fondeadas que pidan ≤ % + DEALs cuya banda lo
      // acepte). El "Todas juntas por tier" se ELIMINÓ (no tenía sentido: son publicaciones distintas).
      // Crear una campaña propia con nombre NO existe por API (se crea en el panel de ML y esta sección la
      // toma sola); la vigencia de abajo es SOLO para el fallback Descuento por porcentaje.
      cayoHtml += '<div style="font-size:12px;font-weight:600;color:var(--text);margin:14px 0 6px">Sin ningún descuento ahora ('+_sinDescL.length+') <span style="font-weight:400;color:var(--text-soft)">— venden a precio FULL. Ordenadas por ventas 14d · '+conV+' venden así. Poné el % y Aplicar: con ese número entra a <b>todas las promociones que cubra</b> — tu campaña propia activa (julio, con la vigencia de la campaña), las co-fondeadas que pidan ≤ tu % (ML aporta encima) y los DEAL cuya banda lo acepte. Relámpago/DOD quedan para entrada manual. Si no puede entrar a ninguna campaña, crea un Descuento por porcentaje con esta vigencia:</span> <input type="date" id="sd-start" value="'+dIso(Date.now())+'" style="font-size:11px"> <span style="color:var(--text-soft)">→</span> <input type="date" id="sd-finish" value="'+dIso(Date.now()+30*86400000)+'" style="font-size:11px"></div>';
      cayoHtml += '<div style="font-size:12px;color:var(--text);margin:0 0 8px;display:flex;gap:8px;align-items:center;flex-wrap:wrap;padding:7px 9px;border:1px dashed var(--border);border-radius:6px"><button id="sd-all" onclick="sdApplyAll()" class="btn btn-sm" style="background:#16a34a;color:#fff;border-color:#16a34a;font-weight:600">⚡ Aplicar a todas las filas con % cargado</button> <span style="font-size:11px;color:var(--text-soft)">Cada fila entra a todo lo que su % cubra; las sin % quedan como están.</span><span id="sd-all-st" style="font-size:11px;width:100%"></span></div>';
      cayoHtml += _sinDescL.map((p,i)=>{
        const m=norm(p.model); const mm=_maestro[m]; const dM=mm?(p.tier==='Clasica'?mm.descClas:mm.descPrem):null; const sugV=(dM&&dM>=5&&dM<=80)?Math.round(dM):'';   // % del MAESTRO por tier (no el de las hermanas)
        return '<div style="font-size:12px;color:var(--text-muted);padding:6px 8px;border:1px solid var(--border);border-left:3px solid '+((p.sales2w||0)>0?'#d97706':'#94a3b8')+';border-radius:6px;margin-bottom:4px;display:flex;gap:8px;align-items:center;flex-wrap:wrap">'
          + '<span style="text-transform:capitalize;font-weight:700;color:var(--text)">'+esc(p.model||'?')+'</span>'+(m?'':' <span class="badge" style="background:#fef9c3;color:#854d0e">sin modelo</span>')+' · '+linkOf(p)+' '+tierBadge(p.tier)+' · '+money(p.list)
          + ' · <b>'+(p.sales2w||0)+'</b> vend. 14d'
          + ' · desc <input class="sd-pct" data-i="'+i+'" type="number" min="5" max="80" value="'+sugV+'" placeholder="%" style="width:48px;font-size:12px" oninput="sdCalc('+i+')">%'
          + (sugV?(' <span style="color:var(--text-soft)" title="Sugerido: el mayor % propio que este modelo ya da en otras publicaciones">(como sus hermanas)</span>'):'')
          + ' <span style="color:var(--text-soft)">→</span> <b id="sdfin-'+i+'">'+(sugV?money(Math.round(p.list*(1-sugV/100))):'—')+'</b>'
          + ' <button id="sdbtn-'+i+'" class="btn btn-sm" onclick="sdApply('+i+')" style="margin-left:auto;background:#0ea5e9;color:#fff;border-color:#0ea5e9;font-weight:600"'+(sugV?'':' disabled')+'>Aplicar</button>'
          + '<div id="sdst-'+i+'" style="font-size:11px;width:100%"></div>'
        + '</div>';
      }).join('');
    }
    // La barra de 6 tabs es ESTÁTICA en el HTML de #sec-promos (tab 1 "Promociones activas" la pinta
    // renderPromosPanel). Acá solo llenamos los 5 paneles de precios + actualizamos sus contadores.
    setBody('pxbody-free', freeHtml); setBody('pxbody-cost', costHtml); setBody('pxbody-incoh', incohHtml); setBody('pxbody-cayo', cayoHtml); setBody('pxbody-otros', otrosHtml);
    setN('pxn-free', oppFree.length); setN('pxn-cost', oppCost.length); setN('pxn-incoh', flagged.length); setN('pxn-cayo', cayo.length+_sinDescL.length); setN('pxn-otros', extreme.length+sinDescOrphan.length);
    setLive('precio', { state: liveStateFor(_priceScanTs, 30*60000, _priceScanComplete), ts:_priceScanTs });   // reflejar frescura tras cada pintado
  }catch(e){ setBody('pxbody-free', '<div style="color:#dc2626;font-size:13px;padding:8px">Error: '+esc(e.message)+'</div>'); console.error('[Promos] precio', e); setLive('precio', { online:false }); }
  finally{ if(btn) btn.disabled=false; if(ld) ld.style.display='none'; }
}

// Cambiar de tab en el apartado Precios (cableado por onclick en los botones .pxtab). Solo togglea display
// de los paneles ya renderizados — NO re-consulta nada. Recuerda la elección en _pxActiveTab.
function pxTab(name){
  _pxActiveTab = name;
  const root = document.getElementById('sec-promos'); if(!root) return;
  root.querySelectorAll('.pxtab').forEach(b=>b.classList.toggle('active', b.dataset.pxtab===name));
  root.querySelectorAll('.pxtab-panel').forEach(p=>{ p.style.display = (p.dataset.pxpanel===name)?'block':'none'; });
  // los controles del scan de precios (puntito/contador/tolerancia) solo aplican a las tabs de precios
  const ctl=document.getElementById('promo-precio-controls'); if(ctl) ctl.style.display = (name==='promos'||name==='pend')?'none':'flex';   // los controles del scan de precios no aplican a "activas" ni "Pendientes"
}

// DIAGNÓSTICO de SOLO LECTURA de una oportunidad: pide al Worker qué devuelve ML en los GET relevantes
// (no escribe NADA) y lo vuelca a la consola + un veredicto in-line. Sirve para confirmar de dónde sale
// (o no) el offer_id de un candidato. Útil sobre todo en SMART/PRICE_MATCHING (botón 🔍).
async function promoProbe(i){
  const o=_opps[i]; if(!o) return;
  const row=document.querySelector('.opp-row[data-opp="'+i+'"]'); const st=row&&row.querySelector('.opp-join-st');
  const set=(c,t)=>{ if(st){ st.style.color=c; st.innerHTML=t; } };
  if(!o.promotionId){ set('#dc2626','Esta campaña no trae id — no puedo diagnosticarla.'); return; }
  set('var(--text-soft)','Diagnosticando (solo lectura)…');
  try{
    const id=(o.ids&&o.ids[0])||o.num;
    const r=await apiGet('/api/ml/promo-probe?itemId='+encodeURIComponent(id)+'&promotionId='+encodeURIComponent(o.promotionId)+'&promotionType='+encodeURIComponent(o.type));
    console.log('[Promos] probe', r);
    if(r&&r.ok) set('var(--text)', '🔍 '+esc(r.verdict||'(sin veredicto)')+' — detalle completo en consola (F12)');
    else set('#dc2626','No pude diagnosticar: '+esc((r&&r.error)||'sin respuesta'));
  }catch(e){ set('#dc2626','Error: '+esc(e.message)); }
}

// Diagnóstico por ITEM ID (llamable desde la consola: promoProbeItem('MLA123...')). Busca la oportunidad de
// ese ítem en _opps y consulta el probe de solo-lectura. Vuelca a consola: veredicto + qué campaña + crudo.
async function promoProbeItem(itemId){
  const o = _opps.find(op => (op.ids||[]).indexOf(itemId)>=0);
  if(!o){ console.log('[Promos] no hay oportunidad listada para', itemId, '(quizá ya no figura). _opps:', _opps.length); return; }
  try{
    const r = await apiGet('/api/ml/promo-probe?itemId='+encodeURIComponent(itemId)+'&promotionId='+encodeURIComponent(o.promotionId||'')+'&promotionType='+encodeURIComponent(o.type||''));
    console.log('[Promos] probeItem', itemId, '| campaña:', o.name, '('+o.type+')', '| veredicto:', r&&r.verdict, '| estado del ítem en la promo:', r&&r.minePromoStatus, r);
    return r;
  }catch(e){ console.log('[Promos] probeItem error', e); }
}

// Diagnóstico CRUDO por itemId (consola: promoProbeRaw('MLA123...')). No necesita que el ítem sea una
// oportunidad: consulta /api/ml/promo-probe solo con el itemId y vuelca la ELEGIBILIDAD (qué promos ofrece
// ML para el ítem). Útil para ver por qué una pub figura "sin descuento" (¿no elegible para promos?).
async function promoProbeRaw(itemId){
  try{
    const r = await apiGet('/api/ml/promo-probe?itemId='+encodeURIComponent(itemId));
    console.log('[Promos] probeRaw', itemId, '| elegible:', r&&r.eligible, '| promos:', r&&r.promoCount, r&&r.promoSummary, r);
    return r;
  }catch(e){ console.log('[Promos] probeRaw error', e); }
}

// Corrector de DESCUENTO inline desde el apartado Precios (el precio base NO se edita por API con ventas).
// Lee % Premium / % Clásica del artículo idx + las publicaciones tildadas, y reusa la maquinaria de promo-bulk
// (salir de todas + reaplicar por cuotas) SOLO en las pubs del tier cuyo % se completó. Doble-clic confirm.
async function promoFixDisc(idx){
  const root=document.querySelector('.pxfix-card[data-art="'+idx+'"]'); if(!root) return;
  const status=root.querySelector('.pxfix-status');
  const setStatus=(c,t)=>{ if(status){ status.style.color=c; status.textContent=t; } };
  const con=parseFloat(root.querySelector('.pxfix-con')?.value||'')||0;
  const sin=parseFloat(root.querySelector('.pxfix-sin')?.value||'')||0;
  if(!con && !sin){ setStatus('#dc2626','Completá al menos un % (Premium o Clásica).'); return; }
  if((con && !(con>0&&con<=80)) || (sin && !(sin>0&&sin<=80))){ setStatus('#dc2626','Los % deben estar entre 1 y 80.'); return; }
  // ids de las pubs tildadas cuyo tier tiene % cargado (no tocar el tier que no completaste → no lo lleva a 0)
  const ids=[...root.querySelectorAll('.pxfix-chk:checked')]
    .filter(c=>{ const t=c.dataset.tier; return (t==='Premium'&&con) || (t==='Clasica'&&sin); })
    .flatMap(c=>(c.dataset.ids||'').split(',').filter(Boolean));
  if(!ids.length){ setStatus('#dc2626','No hay publicaciones tildadas del tipo con % cargado.'); return; }
  const btn=root.querySelector('.pxfix-btn');
  if(!btn._arm){
    btn._arm=setTimeout(()=>{ btn._arm=null; btn.textContent='Aplicar a tildadas'; btn.style.background='#16a34a'; btn.style.borderColor='#16a34a'; }, 12000);
    btn.textContent='⚠️ Confirmar — escribe en ML'; btn.style.background='#dc2626'; btn.style.borderColor='#dc2626';
    setStatus('#dc2626','⚠️ Vas a SALIR de las promos y reaplicar '+(con?('Premium '+con+'%'):'')+(con&&sin?' / ':'')+(sin?('Clásica '+sin+'%'):'')+' en '+ids.length+' publicación(es) REALES. Apretá Confirmar de nuevo.');
    return;
  }
  clearTimeout(btn._arm); btn._arm=null; btn.disabled=true; btn.textContent='Aplicando…'; btn.style.background='#16a34a'; btn.style.borderColor='#16a34a';
  setStatus('var(--text-soft)','Aplicando… no cierres la pestaña.');
  try{
    const reenter={}; if(con) reenter.con=con; if(sin) reenter.sin=sin;
    const dates=datesPayload();
    // GUARD DE MODELO: el corrector opera "todas las pubs del modelo X" → le decimos al Worker qué modelo
    // suponemos por pub; si el MODEL vivo ya no coincide (se cambió el artículo), el Worker la excluye.
    const expect={}; const expModel=root.dataset.model||''; if(expModel) ids.forEach(id=>{ expect[id]=expModel; });
    let results=await runBulk({ leaveAll:true, reenter, expect, ...dates }, ids);
    const map={}; results.forEach(r=>{ map[r.itemId]=r; });
    let cls=classifyBulk(Object.values(map));
    for(let att=0; att<2 && cls.failed.length; att++){
      setStatus('var(--text-soft)','Reintentando '+cls.failed.length+' que rebotaron…');
      await new Promise(r=>setTimeout(r,1500));
      const rr=await runBulk({ leaveAll:true, reenter, expect, ...dates }, cls.failed);
      rr.forEach(r=>{ map[r.itemId]=r; });
      cls=classifyBulk(Object.values(map));
    }
    const parts=[];
    if(cls.guarded.length) parts.push('🛡️ '+cls.guarded.length+' excluida(s) por el guard: '+cls.guarded.map(g=>'#'+g.itemId+' es «'+(g.liveModel||'?')+'», no «'+(g.expectModel||expModel)+'»').join(' · ')+' — reindexá');
    const danger = cls.failed.length || cls.stripped.length || cls.guarded.length;
    if(cls.ok.length) parts.push('✓ '+cls.ok.length+' con descuento aplicado');
    if(cls.inelegible.length) parts.push('🚫 '+cls.inelegible.length+' INELEGIBLE(s) para promos (mala experiencia de compra) — NO se tocaron (al salir no podrían reponer el descuento); corregí desde el panel de ML o el precio de lista');
    if(cls.stripped.length) parts.push('⛔ '+cls.stripped.length+' quedaron SIN descuento (el % no entra en la banda de ML) — corregilas a mano o probá otro %');
    if(cls.blocked.length) parts.push('⚠️ '+cls.blocked.length+' no se pudieron igualar (el % no entra en su banda) — NO se tocaron (siguen con su descuento); probá otro %');
    if(cls.failed.length) parts.push('⚠️ '+cls.failed.length+' fallaron');
    if(cls.band.length && !cls.stripped.length) parts.push(cls.band.length+' fuera de banda (probá otro %)');
    setStatus(danger?'#dc2626':(cls.blocked.length?'#d97706':'#16a34a'), parts.join(' · ')+' — actualizando…');
    toast(cls.stripped.length?('⛔ '+cls.stripped.length+' quedaron SIN descuento'):(cls.failed.length?('⚠️ '+cls.failed.length+' fallaron'):(cls.guarded.length?('🛡️ '+cls.guarded.length+' excluida(s): el modelo vivo no coincide — reindexá'):(cls.blocked.length?('⚠️ '+cls.blocked.length+' no se pudieron igualar'):'✓ Descuento aplicado'))), danger?'error':(cls.blocked.length?'info':'success'));
    // LOG DE DECISIÓN (primer ladrillo del loop): qué sugerí (pre-tildado + % de consenso) vs qué aplicaste.
    try{
      const suggCon=parseFloat(root.dataset.suggCon||'')||null, suggSin=parseFloat(root.dataset.suggSin||'')||null;
      const suggPubs=(root.dataset.suggPubs||'').split(',').filter(Boolean);
      const accepted = (con||null)===suggCon && (sin||null)===suggSin;   // ¿usó los % sugeridos tal cual?
      apiPost('/api/decisions', { area:'price-disc', subject: root.dataset.model||'', suggested:{con:suggCon, sin:suggSin, pubs:suggPubs}, applied:{con:con||null, sin:sin||null, pubs:ids}, outcome:{ok:cls.ok.length, failed:cls.failed.length, band:cls.band.length}, accepted });
    }catch(e){}
    await reconcilePrices(ids);   // re-resuelve SOLO las pubs tocadas y re-renderiza (sin re-scan global)
  }catch(e){ setStatus('#dc2626','Error: '+esc(e.message)); toast('Error: '+e.message,'error'); console.error('[Promos] fixDisc',e); }
  finally{ btn.disabled=false; btn.textContent='Aplicar a tildadas'; }
}

// ENTRAR a una campaña candidata (oportunidad donde ML pone plata). Enrola TODAS las publicaciones del
// modelo+campaña vía /api/ml/promo-join (el backend re-lee cada ítem en vivo y enrola la candidata que
// matchea). Doble-clic de confirmación (escribe en ML). Loguea la decisión y deja el scan para recalcular.
async function promoJoinOpp(i){
  const o=_opps[i]; if(!o) return;
  const row=document.querySelector('.opp-row[data-opp="'+i+'"]'); if(!row) return;
  const btn=row.querySelector('.opp-join-btn'), st=row.querySelector('.opp-join-st');
  const setSt=(c,t)=>{ if(st){ st.style.color=c; st.textContent=t; } };
  if(!btn) return;
  if(!o.promotionId){ setSt('#dc2626','Esta campaña no trae id — no puedo enrolarla automáticamente. Entrá desde ML.'); return; }
  if(!btn._arm){
    btn._arm=setTimeout(()=>{ btn._arm=null; btn.textContent='Entrar'+(o.pubs>1?(' ('+o.ids.length+')'):''); btn.style.background='#0ea5e9'; btn.style.borderColor='#0ea5e9'; }, 12000);
    btn.textContent='⚠️ Confirmar'; btn.style.background='#dc2626'; btn.style.borderColor='#dc2626';
    setSt('#dc2626','⚠️ Vas a ENTRAR '+o.ids.length+' publicación(es) a «'+(o.name||TIPO_LABEL[o.type]||o.type)+'» en ML. Apretá Confirmar de nuevo.');
    return;
  }
  clearTimeout(btn._arm); btn._arm=null; btn.disabled=true; btn.textContent='Entrando…'; btn.style.background='#0ea5e9'; btn.style.borderColor='#0ea5e9';
  setSt('var(--text-soft)','Entrando… no cierres la pestaña.');
  try{
    let offset=0, done=false, guard=0, results=[];
    // guard de modelo: estas cards agrupan "todas las pubs del modelo o.model" → el Worker re-verifica
    // el MODEL vivo y excluye las que ya no son de ese modelo (pub reutilizada con otro artículo).
    const expect={}; if(o.model) o.ids.forEach(id=>{ expect[id]=o.model; });
    while(!done && guard<80){ guard++;
      const r=await apiPostEx('/api/ml/promo-join', { itemIds:o.ids, promotionId:o.promotionId, promotionType:o.type, expect, offset });
      if(!r.ok){
        const transient = r.status>=500 || r.status===0;
        if(transient && guard<78){ setSt('var(--text-soft)','Reintentando (error transitorio)…'); await new Promise(res=>setTimeout(res,1500)); continue; }
        throw new Error((r.body && r.body.error) || ('http '+r.status));
      }
      results=results.concat(r.body.results||[]); offset=r.body.nextOffset; done=!!r.body.done;
      setSt('var(--text-soft)','Procesando… '+results.length+'/'+o.ids.length);
    }
    const ok=results.filter(x=>x.ok!==false && !x.skipped && !x.already).length;
    const already=results.filter(x=>x.already).length;
    const guarded=results.filter(x=>x.guard);
    const skip=results.filter(x=>x.skipped && !x.guard).length;
    const fail=results.filter(x=>x.ok===false && !x.skipped).length;
    // marcar como entradas las que ML confirmó (ok o ya activa) → se ocultan de oportunidades al instante
    results.forEach(x=>{ if(x && x.ok!==false && !x.skipped) markJoined(x.itemId+'|'+o.promotionId); });
    const parts=[];
    if(ok) parts.push('✓ '+ok+' entraron');
    if(already) parts.push(already+' ya estaban');
    if(guarded.length) parts.push('🛡️ '+guarded.length+' excluida(s): '+guarded.map(g=>'#'+g.itemId+' vive como «'+(g.liveModel||'?')+'»').join(' · ')+' — reindexá');
    if(skip) parts.push(skip+' quedaron afuera');
    if(fail) parts.push('⚠️ '+fail+' fallaron');
    // mostrar el ERROR real de ML (no solo el conteo) para no quedar a ciegas como pasó con Holy
    const firstErr=(results.find(x=>x.ok===false && !x.skipped)||{}).error;
    const firstSkip=(results.find(x=>x.skipped)||{}).error;
    const detail = firstErr ? (' — ML dijo: '+firstErr) : (skip ? (' — '+(firstSkip||'')) : '');
    // Color + toast según lo que PASÓ de verdad: éxito solo si algo entró. Un skip NO es éxito — el bug
    // clásico acá era festejar "✓ Entraste" con todo salteado (el guard de candidata vieja saltea a
    // propósito y el usuario veía el cartel verde mientras ML no tenía nada).
    const col = fail ? '#dc2626' : ((ok||already) ? '#16a34a' : '#b45309');
    // Qué aplicó ML DE VERDAD (verificación post-entrada del Worker): el % real puede diferir del que
    // mostraba la candidata (ofertas selladas a precio viejo) — informarlo cierra el loop de confianza.
    const ap=results.find(x=>x.appliedSeller!=null);
    const apTxt = ap ? (' — ML aplicó '+pct2(ap.appliedSeller)+'% a tu cargo'+(ap.appliedPrice?(' ('+money(Math.round(ap.appliedPrice))+')'):'')) : '';
    setSt(col, (parts.join(' · ')||'sin cambios')+detail+apTxt+((ok||already)&&!fail?' — actualizando…':''));
    if(fail||skip) console.warn('[Promos] join results', results);
    // Nombrar SIEMPRE la campaña en el toast: con varias cards del mismo modelo (Potencia en Sin costo,
    // Compartidas en Cuestan extra) un "Entraste" anónimo + la card que desaparece = no sabés CUÁL entró.
    const campNm = o.name||TIPO_LABEL[o.type]||'la campaña';
    if(fail) toast('⚠️ '+fail+' fallaron en «'+campNm+'»','info');
    else if(ok) toast('✓ Entraste a «'+campNm+'»'+(ap?(' — ML aplicó '+pct2(ap.appliedSeller)+'%'):''),'success');
    else if(already) toast('Ya estabas en «'+campNm+'»','info');
    else if(skip) toast('⚠️ No entró a «'+campNm+'»: '+(firstSkip||'quedó afuera'),'info');
    else toast('Sin cambios','info');
    // LOG DE DECISIÓN (loop de automatización): qué sugirió el sistema (la oportunidad) vs qué se aplicó.
    try{ apiPost('/api/decisions', { area:'promo-join', subject:o.model||'', suggested:{type:o.type, name:o.name, reqSeller:o.reqSeller, meli:o.meli, buyer:o.buyer, extra:o.extra, net:o.net}, applied:{ids:o.ids, promotionId:o.promotionId}, outcome:{ok, already, skip, fail}, accepted:true }); }catch(e){}
    await reconcilePrices(o.ids);   // re-resuelve SOLO las pubs de esta campaña y re-renderiza
  }catch(e){ setSt('#dc2626','Error: '+esc(e.message)); toast('Error: '+e.message,'error'); console.error('[Promos] joinOpp',e); }
  finally{ if(btn){ btn.disabled=false; btn.textContent='Entrar'+(o.pubs>1?(' ('+o.ids.length+')'):''); } }
}

// ENTRAR A TODAS las oportunidades SIN costo extra (extra ≤ 0): ML pone plata y no descontás más de lo que
// ya hacés → no-brainer en lote. Doble-clic de confirmación. Loguea CADA una en decision_log (batch:true)
// para que el sistema vaya aprendiendo. Sirve hasta que tengamos costos y se pueda auto-aceptar sin pedir.
async function promoJoinAllFree(){
  const btn=document.getElementById('opp-join-all'), st=document.getElementById('opp-join-all-st');
  const setSt=(c,t)=>{ if(st){ st.style.color=c; st.textContent=t; } };
  if(!btn) return;
  const list=_oppsFree.slice();
  if(!list.length){ setSt('var(--text-soft)','No hay oportunidades sin costo.'); return; }
  if(!btn._arm){
    const totPubs=list.reduce((a,o)=>a+o.ids.length,0);
    btn._arm=setTimeout(()=>{ btn._arm=null; btn.textContent='⚡ Entrar a TODAS sin costo ('+list.length+')'; btn.style.background='#16a34a'; btn.style.borderColor='#16a34a'; }, 12000);
    btn.textContent='⚠️ Confirmar — entra '+list.length+' en ML'; btn.style.background='#dc2626'; btn.style.borderColor='#dc2626';
    setSt('#dc2626','⚠️ Vas a ENTRAR '+list.length+' campañas ('+totPubs+' publicaciones) sin costo extra. Apretá Confirmar de nuevo.');
    return;
  }
  clearTimeout(btn._arm); btn._arm=null; btn.disabled=true; btn.textContent='Entrando…'; btn.style.background='#16a34a'; btn.style.borderColor='#16a34a';
  let okT=0, alreadyT=0, skipT=0, failT=0, lastErr='', lastSkip='';
  try{
    for(let n=0;n<list.length;n++){
      const o=list[n];
      setSt('var(--text-soft)','Entrando '+(n+1)+'/'+list.length+' — '+(o.model||''));
      let offset=0, done=false, guard=0, results=[];
      const expect={}; if(o.model) o.ids.forEach(id=>{ expect[id]=o.model; });   // guard de modelo (ver promoJoinOpp)
      while(!done && guard<80){ guard++;
        const r=await apiPostEx('/api/ml/promo-join', { itemIds:o.ids, promotionId:o.promotionId, promotionType:o.type, expect, offset });
        if(!r.ok){ const transient=r.status>=500||r.status===0; if(transient && guard<78){ await new Promise(res=>setTimeout(res,1500)); continue; } failT+=o.ids.length; lastErr=(r.body&&r.body.error)||('http '+r.status); break; }
        results=results.concat(r.body.results||[]); offset=r.body.nextOffset; done=!!r.body.done;
      }
      const ok=results.filter(x=>x.ok!==false && !x.skipped && !x.already).length;
      const already=results.filter(x=>x.already).length;
      const skip=results.filter(x=>x.skipped).length;
      const fail=results.filter(x=>x.ok===false && !x.skipped).length;
      okT+=ok; alreadyT+=already; skipT+=skip; failT+=fail;
      results.forEach(x=>{ if(x && x.ok!==false && !x.skipped) markJoined(x.itemId+'|'+o.promotionId); });   // ocultar las confirmadas
      const fe=(results.find(x=>x.ok===false && !x.skipped)||{}).error; if(fe) lastErr=fe;
      const fs=(results.find(x=>x.skipped)||{}).error; if(fs) lastSkip=fs;
      try{ apiPost('/api/decisions', { area:'promo-join', subject:o.model||'', suggested:{type:o.type, name:o.name, reqSeller:o.reqSeller, meli:o.meli, buyer:o.buyer, extra:o.extra, net:o.net, batch:true}, applied:{ids:o.ids, promotionId:o.promotionId}, outcome:{ok, already, skip, fail}, accepted:true }); }catch(e){}
    }
    const parts=[]; if(okT) parts.push('✓ '+okT+' entraron'); if(alreadyT) parts.push(alreadyT+' ya estaban'); if(skipT) parts.push(skipT+' quedaron afuera'); if(failT) parts.push('⚠️ '+failT+' fallaron');
    // Éxito solo si algo ENTRÓ: skips no se festejan (mismo bug que promoJoinOpp — cartel verde con 0 entradas).
    const colT = failT ? '#dc2626' : ((okT||alreadyT) ? '#16a34a' : '#b45309');
    setSt(colT, (parts.join(' · ')||'sin cambios')+(failT&&lastErr?(' — ML dijo: '+lastErr):(skipT&&lastSkip?(' — '+lastSkip):''))+((okT||alreadyT)&&!failT?' — actualizando…':''));
    if(failT||skipT) console.warn('[Promos] joinAll done', {okT,alreadyT,skipT,failT,lastErr,lastSkip});
    if(failT) toast('⚠️ '+failT+' fallaron','info');
    else if(okT) toast('✓ Entraste a '+okT+' campañas','success');
    else if(skipT) toast('⚠️ No entraron: '+(lastSkip||'quedaron afuera'),'info');
    else toast('Sin cambios','info');
    await reconcilePrices([...new Set(list.flatMap(o=>o.ids||[]))]);   // re-resuelve solo lo tocado, una vez
  }catch(e){ setSt('#dc2626','Error: '+esc(e.message)); toast('Error: '+e.message,'error'); console.error('[Promos] joinAll',e); }
  finally{ btn.disabled=false; btn.textContent='⚡ Entrar a TODAS sin costo ('+list.length+')'; }
}

// ── CARD "campaña con artículos para sumar" (DEAL, ej. VACACIONES INVIERNO) ──────────────────────
// Avisa arriba de la 1ra pestaña de Promos que hay una campaña DEAL (programada o activa) donde estás
// INVITADO con publicaciones candidatas SIN sumar, y deja entrarlas MASIVAMENTE con el descuento PROPIO
// actual de cada una (sellerCost, varía por tier) o editándolo. Es escritura a ML → preview + doble-clic +
// resumible + reconcile. Solo DEAL (campaña propia con deal_price); las co-fondeadas van por Sin costo/Cuestan.
function ddmm(s){ const p=String(s||'').slice(0,10).split('-'); return p.length===3?(p[2]+'/'+p[1]):String(s||''); }
async function ensureCampaignAlerts(force){
  // 1) Pintar INSTANTÁNEO desde cache local (evita el "va y viene": siempre mostramos lo último conocido).
  if(!_promoCounts){ try{ const c=JSON.parse(localStorage.getItem('parka_promo_counts_v1')||'null'); if(c && c.counts){ _promoCounts=c.counts; _campaignAlerts=c.alerts||[]; _promoCountsTs=c.ts||0; _campaignAlertsTs=c.ts||0; } }catch(e){} }
  renderCampaignAlerts(); try{ renderPromosPanel(); }catch(e){}
  // 2) Solo recalcular si está viejo (>5min) y no hay otra corrida en curso (guarda contra el parpadeo).
  const fresh = _promoCountsTs && (Date.now()-_promoCountsTs < 5*60*1000);
  if((fresh && !force) || _campBusy) return;
  _campBusy=true;
  const box=document.getElementById('promo-campaign-alert');
  if(box && !(_campaignAlerts && _campaignAlerts.length)) box.innerHTML='<div style="font-size:12px;color:var(--text-soft);padding:8px"><span class="spin" style="display:inline-block;vertical-align:middle;margin-right:6px"></span>Calculando pendientes…</div>';
  try{
    // Reusar la lista de promos que ya trae renderPromosPanel; si no está, pedirla.
    let ps=_promosCache;
    if(!ps){ const pr=await apiGet('/api/ml/promos'); ps=(pr&&pr.ok&&pr.promos)||[]; _promosCache=ps; }
    // FUENTE CONFIABLE = _priceScan (per-ítem, SOLO publicaciones ACTIVAS). El endpoint de campaña
    // (/promotions/{id}/items) subcuenta y devuelve un set incompleto → ya NO se usa para contar. Cada fila
    // del scan trae inCamps (campañas donde la publicación YA participa) y candCamps (de cuáles es CANDIDATA).
    // Agregamos por campaña: anotadas = filas con la campaña en inCamps; sin sumar = filas con la campaña en
    // candCamps. Es exacto y activo-only (ML en su UI muestra más porque cuenta pausadas, que no querés sumar).
    await ensurePriceScan(false);
    const scan=_priceScan||[];
    const active=ps.filter(p=>['pending','started'].includes(String(p.status||'').toLowerCase()));
    const counts={};
    for(const p of active){
      const pid=String(p.id); let enrolled=0, candidate=0;
      for(const row of scan){
        const rep=String((row.ids&&row.ids[0])||row.num||'');
        // isJoined = ya entrada localmente (marcada al confirmar, TTL). Cuenta como ANOTADA ya —no como "sin
        // sumar"— aunque inCamps todavía no lo refleje (ML tarda en propagar). Espeja el filtro del preview
        // (dealOpenPreview saltea isJoined) → card, panel y preview leen el MISMO set de candidatas.
        if((row.inCamps||[]).includes(pid) || isJoined(rep+'|'+pid)) enrolled++;
        else if((row.candCamps||[]).includes(pid)) candidate++;
      }
      counts[p.id]={ enrolled, candidateTotal:candidate, candidate, started:enrolled, pending:0 };
    }
    _promoCounts=counts; _promoCountsTs=Date.now();
    // Pendientes = tipos AUTO-FONDEADOS con candidatas ACTIVAS (los que este flujo sabe entrar con deal_price:
    // DEAL / Oferta del día / Relámpago). Las co-fondeadas (SMART) van por Sin costo / Cuestan extra.
    const SELF_DEAL=['DEAL','DOD','LIGHTNING'];
    _campaignAlerts=active.filter(p=>SELF_DEAL.includes(String(p.type||'')) && counts[p.id] && counts[p.id].candidate>0)
      .map(p=>({ id:p.id, type:String(p.type||''), name:p.name||'', status:String(p.status||'').toLowerCase(), start:p.start_date||p.finish_date, finish:p.finish_date, enrolled:counts[p.id].enrolled, candidate:counts[p.id].candidate }));
    _campaignAlertsTs=Date.now();
    try{ localStorage.setItem('parka_promo_counts_v1', JSON.stringify({ ts:_promoCountsTs, counts:_promoCounts, alerts:_campaignAlerts })); }catch(e){}
  }catch(e){ console.warn('[Promos] campaignAlerts', e); }
  finally{ _campBusy=false; }
  renderCampaignAlerts();
  try{ renderPromosPanel(); }catch(e){}   // refrescar la lista de activas con los conteos recién cargados
}
function renderCampaignAlerts(){
  const box=document.getElementById('promo-campaign-alert');
  const list=_campaignAlerts||[];
  const nEl=document.getElementById('pxn-pend'); if(nEl) nEl.textContent=list.length;
  if(!box) return;
  if(!list.length){ box.innerHTML='<div style="font-size:13px;color:var(--text-soft);padding:8px">No hay campañas con publicaciones pendientes de sumar. Cuando ML te invite a un DEAL (o queden publicaciones sin entrar), aparecen acá.</div>'; return; }
  box.innerHTML=list.map(c=>{
    const prog=c.status!=='started';
    const pill=prog?('<span class="badge" style="background:#fef9c3;color:#854d0e;font-weight:700">PROGRAMADA · arranca '+ddmm(c.start)+'</span>'):'<span class="badge" style="background:#dcfce7;color:#166534;font-weight:700">ACTIVA</span>';
    const typeLbl=esc(TIPO_LABEL[c.type]||c.type||'Campaña');
    const nameLbl=esc(c.name||TIPO_LABEL[c.type]||'Campaña');   // DOD/LIGHTNING no traen nombre → uso el label del tipo
    return '<div style="border:1px solid #f59e0b;border-left:4px solid #f59e0b;background:var(--surface);border-radius:8px;padding:11px 13px;margin-bottom:12px">'
      + '<div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap"><span class="badge" style="background:#e0e7ff;color:#3730a3">'+typeLbl+'</span><span style="font-size:14px;font-weight:700;color:var(--text)">'+nameLbl+'</span>'+pill+'</div>'
      + '<div style="font-size:13px;color:var(--text);margin:6px 0 2px"><b>'+c.enrolled+'</b> anotadas · <b style="color:#dc2626">'+c.candidate+'</b> sin sumar</div>'
      + '<div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-top:8px"><button onclick="dealOpenPreview(\''+esc(c.id)+'\',\''+esc(c.type)+'\')" class="btn btn-sm" style="background:#16a34a;color:#fff;border-color:#16a34a;font-weight:600">Entrar las '+c.candidate+' con su descuento actual</button>'
      + '<span style="font-size:11px;color:var(--text-soft)">Entra cada publicación al descuento propio que ya tiene; vos ponés el precio (ML no aporta). Podés editarlo antes.</span></div>'
      + '<div id="dealprev-'+esc(c.id)+'" style="margin-top:10px"></div>'
      + '</div>';
  }).join('');
}
// Abrir el preview: trae los candidatos, los cruza con el scan (sellerCost/tier vivos) y VERIFICA en seco
// (dryRun) contra ML para traer el mínimo/máximo real que pide el deal por publicación. NO escribe nada.
async function dealOpenPreview(pid, type){
  type = type || 'DEAL';
  const box=document.getElementById('dealprev-'+pid); if(!box) return;
  const load=(t)=>{ box.innerHTML='<div style="font-size:12px;color:var(--text-soft);padding:6px"><span class="spin" style="display:inline-block;vertical-align:middle;margin-right:6px"></span>'+t+'</div>'; };
  load('Analizando candidatos…');
  try{
    await ensurePriceScan(false); await ensureSales2w();
    const sales=_sales2w||{};
    // Candidatas desde _priceScan (fuente confiable, per-ítem, activas) — ya NO el endpoint de campaña que
    // subcuenta. Una fila = una publicación cuya membresía dice que es candidata de esta campaña (candCamps).
    // Entramos por publicación: el rep representa la fila; al confirmar se expande a TODOS sus item_ids (ids)
    // y el backend re-valida cada uno en vivo (banda + estado), así que expandir de más es inocuo.
    const rows0=(_priceScan||[]).filter(r=>(r.candCamps||[]).includes(String(pid)));
    const tent=[], co=[], noD=[], noData=[];
    for(const r of rows0){
      const repId=(r.ids&&r.ids[0])||r.num;
      if(isJoined(repId+'|'+pid)) continue;
      const rec={ id:repId, ids:(r.ids||[repId]), num:r.num, model:r.model, tier:r.tier, list:r.list, pct:r.sellerCost, sales:(r.ids||[]).reduce((a,x)=>a+(sales[x]||0),0) };
      if(r.cofunded||r.boosted) co.push(rec);
      else if(!r.hasDisc) noD.push(rec);
      else tent.push(rec);
    }
    // VERIFICAR en seco contra ML: trae por ítem el veredicto real + la banda (mín/máx que pide el deal).
    let rows=tent;
    if(tent.length){
      const payload=tent.map(x=>({ id:x.id, pct:Math.round(x.pct) }));
      let off=0, done=false, guard=0, dres=[];
      while(!done && guard<800){ guard++;
        load('Verificando contra Mercado Libre (no escribe nada)… '+dres.length+'/'+payload.length);
        const rr=await apiPostEx('/api/ml/promo-join-deal', { items:payload, promotionId:pid, promotionType:type, dryRun:true, offset:off });
        if(!rr.ok){ const transient=rr.status>=500||rr.status===0; if(transient&&guard<798){ await new Promise(res=>setTimeout(res,1200)); continue; } throw new Error((rr.body&&rr.body.error)||('http '+rr.status)); }
        dres=dres.concat(rr.body.results||[]); off=rr.body.nextOffset; done=!!rr.body.done;
      }
      const byRes={}; dres.forEach(x=>{ if(x&&x.itemId) byRes[x.itemId]=x; });
      rows=tent.map(x=>{ const v=byRes[x.id]||{}; return { ...x, floorPct:(v.floorPct!=null?v.floorPct:null), capPct:(v.capPct!=null?v.capPct:null), reqPct:(v.competitivePct!=null?v.competitivePct:null), reqSrc:(v.competitiveSrc||null), okBand:!!v.ok }; });
      // Coherencia con la expansión (pedido 3/7): costo de entrar por fila + orden barato→caro (sin dato al final).
      rows.forEach(x=>{ x.cost=(x.reqPct!=null)?Math.round((x.reqPct-(x.pct||0))*100)/100:null; });
      rows.sort((a,b)=>{ if(a.cost==null&&b.cost==null) return (b.sales||0)-(a.sales||0); if(a.cost==null) return 1; if(b.cost==null) return -1; if(a.cost!==b.cost) return a.cost-b.cost; return (b.sales||0)-(a.sales||0); });
    }
    _dealPrev[pid]={ rows, co, noD, noData, capped:false, type };   // sin paginación: la lista sale entera de _priceScan
    renderDealPreview(pid);
  }catch(e){ box.innerHTML='<div style="font-size:12px;color:#dc2626;padding:6px">Error: '+esc(e.message)+'</div>'; console.error('[Promos] dealPreview',e); }
}
// Preview: LISTA publicación por publicación (pedido de Martin — para verificar que cada una entra al
// descuento correcto). Cada fila trae su descuento propio actual (editable) + precio de lista → precio final
// estimado. La fuente de verdad al confirmar son estos inputs, no un % global por tier.
function renderDealPreview(pid){
  const box=document.getElementById('dealprev-'+pid); const P=_dealPrev[pid]; if(!box||!P) return;
  // linkOf/tierBadge son locales de promoPriceIncong → acá los redefinimos (mlPromosA sí es de módulo).
  const linkOf = p => mlPromosA(p.num, (p.ids&&p.ids[0])||p.num);
  const tierBadge = t => t==='Premium' ? '<span class="badge" style="background:#ede9fe;color:#5b21b6">Premium</span>' : (t==='Clasica' ? '<span class="badge" style="background:#e0f2fe;color:#075985">Clásica</span>' : '<span class="badge" style="background:var(--surface2);color:var(--text-soft)">'+esc(t||'?')+'</span>');
  const rows=(P.rows||[]).filter(x=>!isJoined(x.id+'|'+pid));
  const loOf=x=>Math.max(5, (x.floorPct!=null?x.floorPct:5));   // mínimo % técnico que acepta el deal (o 5)
  const hiOf=x=>Math.min(80, (x.capPct!=null?x.capPct:80));     // máximo % técnico que acepta el deal (o 80)
  const inBand=x=>{ const p=Math.round(x.pct); return p>=loOf(x) && p<=hiOf(x); };
  const okRow=x=>inBand(x) && (x.reqPct==null || Math.round(x.pct)>=x.reqPct);   // cumple lo que pide ML
  const N=rows.filter(okRow).length; const bad=rows.filter(x=>!inBand(x)).length;
  const belowReq=rows.filter(x=>inBand(x) && x.reqPct!=null && Math.round(x.pct)<x.reqPct).length;
  const total=rows.length+P.co.length+P.noD.length+P.noData.length;   // = las "sin sumar" de la card
  let h='<div style="border-top:1px dashed var(--border);padding-top:8px">';
  h+='<div style="font-size:13px;font-weight:700;color:var(--text)">Revisá y confirmá — <span id="dealcount-'+pid+'">'+N+'</span> listas para entrar</div>';
  // Reconciliar con el "N sin sumar" de la card: total = con descuento propio (abajo) + co-fondeadas + etc.
  const recon=[]; if(P.co.length) recon.push('<b>'+P.co.length+'</b> co-fondeadas (aparte: entrarlas acá te hace perder el aporte de ML → van por Sin costo/Cuestan extra)'); if(P.noD.length) recon.push('<b>'+P.noD.length+'</b> sin descuento propio'); if(P.noData.length) recon.push('<b>'+P.noData.length+'</b> sin datos en el scan');
  h+='<div style="font-size:11px;color:var(--text-muted);margin:2px 0 4px">De las <b>'+total+'</b> sin sumar: <b>'+rows.length+'</b> con tu descuento propio (abajo)'+(recon.length?(' · '+recon.join(' · ')):'')+'.</div>';
  h+='<div style="font-size:10px;color:var(--text-soft);margin:0 0 6px">Por fila: tu descuento (editable) vs el que <b>pide ML</b>. <span style="color:#b45309">Ámbar</span> = no llega al que pide ML (subilo para entrar). <span style="color:#dc2626">Rojo</span> = fuera del rango técnico. El precio final se calcula sobre el precio de lista vivo.</div>';
  if(!rows.length) h+='<div style="font-size:12px;color:var(--text-soft);padding:4px">No hay publicaciones activas con descuento propio para sumar acá.</div>';
  else{
    h+='<div style="max-height:360px;overflow:auto;border:1px solid var(--border);border-radius:6px">';
    // Notación unificada con Cuestan extra/expansión (coherencia en toda la app, pedido 3/7):
    //   das X% · pide ~Y% (a $target) · entra con [input]% · te cuesta +N ptos → $final
    h+=rows.map(x=>{
      const lo=loOf(x), hi=hiOf(x), p=Math.round(x.pct), band=p>=lo&&p<=hi;
      const req=x.reqPct, under=band && req!=null && p<req;
      const approx=(x.reqSrc && x.reqSrc!=='smart');   // sin SMART candidata → valor aproximado
      const est=Math.round((x.list||0)*(1-p/100));
      const bg = !band ? '#fef2f2' : (under ? '#fffbeb' : (x.cost!=null&&x.cost<=1 ? 'rgba(22,163,74,.05)' : 'transparent'));
      const reqTxt = req!=null ? ('<span style="color:'+(under?'#b45309':'#16a34a')+'" title="Descuento que pide ML para esta oferta'+(approx?' (aproximado: sin dato exacto de SMART para este ítem)':' (exacto, de la oferta compartida)')+'">pide '+(approx?'~':'')+pct2(req)+'%'+(x.list>0?(' <span style="color:var(--text-soft)">(a '+money(Math.round(x.list*(1-req/100)))+')</span>'):'')+'</span>') : '';
      const cuestaTxt = (x.cost!=null) ? (' · '+(x.cost<=0?'<span style="color:#16a34a;font-weight:600">sin costo extra</span>':('te cuesta <b style="color:'+(under?'#dc2626':'#b45309')+'">+'+pct2(x.cost)+' ptos</b>'))) : '';
      const bandTip='Rango técnico del deal: '+(x.floorPct!=null?('mín '+pct(x.floorPct)+'%'):'?')+(x.capPct!=null?(' – máx '+pct(x.capPct)+'%'):'');
      return '<div class="dealrow" style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;font-size:12px;padding:5px 8px;border-bottom:1px solid var(--border);background:'+bg+'">'
        + '<span style="text-transform:capitalize;font-weight:600;min-width:78px;color:var(--text)">'+esc(x.model||'?')+'</span>'
        + linkOf({num:x.num||x.id, ids:[x.id]})+((x.ids&&x.ids.length>1)?(' <span style="color:var(--text-soft)">('+x.ids.length+' pubs)</span>'):'')+' '+tierBadge(x.tier)
        + ' <span style="color:var(--text-soft)">das '+pct2(x.pct)+'%</span>'
        + (reqTxt?(' · '+reqTxt):'')
        + ' · <span style="color:var(--text-soft)" title="'+esc(bandTip)+'">entra con</span> <input class="dealrow-pct" data-id="'+esc(x.id)+'" data-ids="'+esc((x.ids&&x.ids.length?x.ids:[x.id]).join(','))+'" data-list="'+(x.list||0)+'" data-floor="'+(x.floorPct!=null?x.floorPct:'')+'" data-cap="'+(x.capPct!=null?x.capPct:'')+'" data-req="'+(req!=null?req:'')+'" type="number" min="5" max="80" value="'+p+'" style="width:50px;font-size:12px;border-color:'+(band?(under?'#f59e0b':''):'#dc2626')+'" oninput="dealRowCalc(\''+pid+'\')">%'
        + cuestaTxt
        + ' <span style="color:var(--text-soft)">→</span> <b class="dealrow-final" data-id="'+esc(x.id)+'">'+(band?money(est):'no entra')+'</b>'
        + (x.sales?(' <span style="color:var(--text-soft);margin-left:auto">'+x.sales+' vend.</span>'):'')
        + '</div>';
    }).join('');
    h+='</div>';
  }
  const aside=[];   // co-fondeadas/sin-descuento/sin-datos ya se reconcilian arriba; acá solo el estado de las filas
  if(bad) aside.push(bad+' en rojo (fuera del rango técnico, no entran)');
  if(belowReq) aside.push(belowReq+' en ámbar (tu descuento no llega al que pide ML — subilas si querés entrar)');
  if(aside.length) h+='<div style="font-size:11px;color:var(--text-soft);margin-top:6px">De las '+rows.length+' con descuento propio: '+aside.join(' · ')+'.</div>';
  if(P.capped) h+='<div style="font-size:11px;color:#d97706;margin-top:4px">⚠ La campaña tiene más candidatas de las que pude traer — entrá en tandas.</div>';
  h+='<div style="margin-top:8px"><button id="dealconfirm-'+pid+'" onclick="dealConfirm(\''+pid+'\')" class="btn btn-sm" style="background:#16a34a;color:#fff;border-color:#16a34a;font-weight:700"'+(N?'':' disabled')+'>Confirmar entrada de <span id="dealbtnN-'+pid+'">'+N+'</span></button>';
  h+='<span id="dealprogress-'+pid+'" style="font-size:11px;margin-left:8px"></span></div>';
  h+='</div>';
  box.innerHTML=h;
}
// Recalcular al editar un %: valida contra la banda del deal de CADA fila (mín/máx), actualiza el precio
// final y el conteo (N que se ve = N que se escribe). Rojo si el % no entra en el rango que pide el deal.
function dealRowCalc(pid){
  const box=document.getElementById('dealprev-'+pid); if(!box) return;
  let n=0;
  box.querySelectorAll('.dealrow-pct').forEach(inp=>{
    const id=inp.getAttribute('data-id'); const list=parseFloat(inp.getAttribute('data-list'))||0; const pct=parseFloat(inp.value);
    const fl=parseFloat(inp.getAttribute('data-floor')); const cp=parseFloat(inp.getAttribute('data-cap')); const rq=parseFloat(inp.getAttribute('data-req'));
    const lo=Math.max(5, isNaN(fl)?5:fl), hi=Math.min(80, isNaN(cp)?80:cp);
    const fin=box.querySelector('.dealrow-final[data-id="'+id+'"]');
    const band = pct>=lo && pct<=hi && list>0;
    const under = band && !isNaN(rq) && pct<rq;   // dentro de banda pero por debajo de lo que pide ML → no cuenta
    inp.style.borderColor = band?(under?'#f59e0b':''):'#dc2626';
    const rowEl=inp.closest('.dealrow'); if(rowEl) rowEl.style.background = !band?'#fef2f2':(under?'#fffbeb':'transparent');
    if(band){ if(fin){ fin.textContent=money(Math.round(list*(1-pct/100))); fin.style.color=under?'#b45309':''; } if(!under) n++; }
    else if(fin){ fin.textContent='no entra'; fin.style.color='#dc2626'; }
  });
  const cE=document.getElementById('dealcount-'+pid); if(cE) cE.textContent=n;
  const bE=document.getElementById('dealbtnN-'+pid); if(bE) bE.textContent=n;
}
function dealPause(pid){ _dealPaused[pid]=true; }
// ── EXPANSIÓN de campaña en "Promociones activas" (unifica el viejo tab Pendientes) ─────────────────
// Cada campaña se despliega con TODAS sus candidatas activas (no solo las con descuento propio — el viejo
// preview listaba solo esas y "126 sin sumar" mostraba 20). Filas TILDABLES: pre-tildadas en campañas
// normales (Rebates/SMART/julio/DEAL — lo normal es entrar), DESTILDADAS en las agresivas (Oferta del día /
// Relámpago — lo normal es elegir a mano). Entrada masiva de las tildadas, ruteada por tipo: auto-fondeadas
// → promo-join-deal (con % editable + banda), co-fondeadas → promo-join (ML fija los valores del offer).
const _pexp = {};
const tierBadgeM = t => t==='Premium' ? '<span class="badge" style="background:#ede9fe;color:#5b21b6">Premium</span>' : (t==='Clasica' ? '<span class="badge" style="background:#e0f2fe;color:#075985">Clásica</span>' : '<span class="badge" style="background:var(--surface2);color:var(--text-soft)">'+esc(t||'?')+'</span>');
const PEXP_SELF = ['DEAL','DOD','LIGHTNING','SELLER_CAMPAIGN'];   // auto-fondeadas: el % lo ponés vos
const PEXP_OFF  = ['DOD','LIGHTNING'];                            // agresivas: filas destildadas por default
function promoNewAck(){ try{ return JSON.parse(localStorage.getItem('parka_promo_new_ack')||'{}'); }catch(e){ return {}; } }
function isNewPromo(id){ const s=_promoSeen&&_promoSeen[id]; if(!s||!s.firstSeen) return false; const t=Date.parse(s.firstSeen); if(!(t>0) || (Date.now()-t > 7*86400000)) return false; return !promoNewAck()[id]; }
function updNuevasBadge(){ const el=document.getElementById('pxn-nuevas'); if(!el) return; const n=(_promosCache||[]).filter(p=>isNewPromo(String(p.id))).length; el.textContent=String(n); el.style.display=n?'':'none'; }
async function promoExpand(pid, type){
  const box=document.getElementById('pexp-'+pid); if(!box) return;
  if(box.dataset.open==='1'){ box.dataset.open=''; box.innerHTML=''; return; }   // 2do clic = cerrar
  box.dataset.open='1';
  try{ const a=promoNewAck(); if(!a[pid]){ a[pid]=Date.now(); localStorage.setItem('parka_promo_new_ack', JSON.stringify(a)); updNuevasBadge(); } }catch(e){}
  const load=(t)=>{ box.innerHTML='<div style="font-size:12px;color:var(--text-soft);padding:6px"><span class="spin" style="display:inline-block;vertical-align:middle;margin-right:6px"></span>'+esc(t)+'</div>'; };
  load('Cargando candidatas…');
  try{
    await ensurePriceScan(false); await ensureSales2w();
    const sales=_sales2w||{};
    const self=PEXP_SELF.includes(String(type||''));
    // % sugerido para auto-fondeadas: tu descuento propio actual; sin descuento → el mayor % del modelo.
    const modelDisc={};
    if(self){ for(const r of (_priceScan||[])){ if(r.hasDisc && r.sellerCost!=null){ const m=norm(r.model); if(m) modelDisc[m]=Math.max(modelDisc[m]||0, r.sellerCost); } } }
    const rows=[];
    for(const r of (_priceScan||[])){
      if(!(r.candCamps||[]).includes(String(pid))) continue;
      const repId=(r.ids&&r.ids[0])||r.num;
      if(isJoined(repId+'|'+pid)) continue;
      const opp=(r.opps||[]).find(o=>String(o.promotionId||'')===String(pid))||null;
      const sug = (r.hasDisc&&r.sellerCost!=null) ? Math.round(r.sellerCost) : (modelDisc[norm(r.model)]?Math.round(modelDisc[norm(r.model)]):null);
      rows.push({ id:repId, num:r.num, model:r.model, tier:r.tier, list:r.list, sales:(r.ids||[]).reduce((a,x)=>a+(sales[x]||0),0), sellerCost:r.sellerCost, hasDisc:r.hasDisc, opp, pct:sug });
    }
    // Auto-fondeadas: dryRun (no escribe) para traer banda real + "ML pide" por publicación. Resumible.
    // TODAS las filas van al dry-run (pedido 3/7: "¿por qué 310 de 370?"): las sin descuento de referencia
    // van con % centinela (5) — el dry-run igual devuelve banda + "ML pide", que es lo que queremos mostrar.
    if(self && rows.length){
      const payload=rows.map(x=>({id:x.id, pct:(x.pct!=null?x.pct:5)}));
      let off=0, done=payload.length===0, guard=0; const byRes={};
      while(!done && guard<400){ guard++;
        load('Verificando contra ML (no escribe)… '+off+'/'+payload.length);
        const rr=await apiPostEx('/api/ml/promo-join-deal',{ items:payload, promotionId:pid, promotionType:type, dryRun:true, offset:off });
        if(!rr.ok){ const tr=rr.status>=500||rr.status===0; if(tr&&guard<398){ await new Promise(res=>setTimeout(res,1200)); continue; } throw new Error((rr.body&&rr.body.error)||('http '+rr.status)); }
        (rr.body.results||[]).forEach(x=>{ if(x&&x.itemId) byRes[x.itemId]=x; });
        off=rr.body.nextOffset; done=!!rr.body.done;
      }
      rows.forEach(x=>{ const v=byRes[x.id]||{}; x.floorPct=(v.floorPct!=null?v.floorPct:null); x.capPct=(v.capPct!=null?v.capPct:null); x.reqPct=(v.competitivePct!=null?v.competitivePct:null); x.reqSrc=(v.competitiveSrc||null); });
    }
    // COSTO de entrar por fila (en puntos que agregás vs lo que ya das) — la clave de la decisión de Martin.
    // Co-fondeadas: extra de la oportunidad. Auto-fondeadas: lo que pide ML menos tu descuento actual.
    for(const x of rows){
      if(self) x.cost = (x.reqPct!=null) ? Math.round((x.reqPct-(x.sellerCost||0))*100)/100 : null;
      else x.cost = x.opp ? x.opp.extra : null;
    }
    // ORDEN POR PRIORIDAD (pedido 3/7): lo más barato de entrar primero (sin costo arriba), sin dato al
    // final; empate → más vendidas primero. Es solo orden de PRESENTACIÓN: los tildes se referencian por
    // data-id estable (no por índice), así que confirm es inmune a re-filtrados/reordenamientos.
    rows.sort((a,b)=>{
      if(a.cost==null && b.cost==null) return (b.sales||0)-(a.sales||0);
      if(a.cost==null) return 1; if(b.cost==null) return -1;
      if(a.cost!==b.cost) return a.cost-b.cost;
      return (b.sales||0)-(a.sales||0);
    });
    _pexp[pid]={ rows, type:String(type||''), self };
    renderPromoExpand(pid);
  }catch(e){ box.innerHTML='<div style="font-size:12px;color:#dc2626;padding:6px">Error: '+esc(e.message)+'</div>'; console.error('[Promos] expand',e); }
}
function renderPromoExpand(pid){
  const box=document.getElementById('pexp-'+pid); const P=_pexp[pid]; if(!box||!P) return;
  const rows=P.rows.filter(x=>!isJoined(x.id+'|'+pid));
  if(!rows.length){ box.innerHTML='<div style="font-size:12px;color:var(--text-soft);padding:6px">Sin candidatas activas para sumar.</div>'; return; }
  // Pre-tildado por COSTO (regla de Martin 3/7, reemplaza al default por tipo de campaña): agregar ≤1 punto
  // (incluido "sin costo") arranca tildada; el resto destildada. Sin dato de costo → destildada.
  const preN=rows.filter(x=>x.cost!=null&&x.cost<=1).length;
  let h='<div style="border-top:1px dashed var(--border);margin-top:8px;padding-top:8px">';
  h+='<div style="font-size:12px;color:var(--text);margin-bottom:4px"><b>'+rows.length+'</b> candidatas activas, ordenadas por lo que cuesta entrar <span style="color:var(--text-soft)">(pre-tildadas las '+preN+' que cuestan ≤1 pto)</span> · <a href="#" onclick="pexpAll(\''+esc(pid)+'\',1);return false">tildar todas</a> · <a href="#" onclick="pexpAll(\''+esc(pid)+'\',0);return false">destildar todas</a></div>';
  h+='<div style="max-height:420px;overflow:auto;border:1px solid var(--border);border-radius:6px">';
  // Notación unificada con "Cuestan extra" (pedido de Martin):
  //   das 60% · pide ~61,21% (a $97.258) · ML +2,9% → comprador ~64,11% · te cuesta +1,21 ptos
  const cuesta = c => (c==null) ? '' : (' · '+(c<=0?'<span style="color:#16a34a;font-weight:600">sin costo extra</span>':('te cuesta <b style="color:#dc2626">+'+pct2(c)+' ptos</b>')));
  h+=rows.map((x)=>{
    const o=x.opp; let info='';
    if(P.self){
      const lo=Math.max(5,(x.floorPct!=null?x.floorPct:5)), hi=Math.min(80,(x.capPct!=null?x.capPct:80));
      // El input arranca en lo NECESARIO para entrar (max entre tu descuento y lo que pide ML) — así las
      // pre-tildadas entran sin retoque. "das" muestra tu descuento actual aparte.
      const val=(x.reqPct!=null)?Math.max(x.pct!=null?x.pct:0, x.reqPct):(x.pct!=null?x.pct:'');
      info=' · das '+(x.sellerCost!=null?pct2(x.sellerCost):'<span style="color:#d97706">sin desc</span>')+'%'
        +(x.reqPct!=null?(' · pide '+(x.reqSrc!=='smart'?'~':'')+pct2(x.reqPct)+'%'+(x.list>0?(' <span style="color:var(--text-soft)">(a '+money(Math.round(x.list*(1-x.reqPct/100)))+')</span>'):'')):'')
        +' · entra con <input class="pexp-pct" data-id="'+esc(x.id)+'" type="number" min="5" max="80" value="'+val+'" placeholder="%" style="width:48px;font-size:12px" oninput="pexpCalc(\''+esc(pid)+'\')">%'
        +cuesta(x.cost)
        +((x.floorPct!=null||x.capPct!=null)?(' <span style="color:var(--text-soft)" title="Rango técnico que acepta esta campaña para esta publicación">['+pct2(lo)+'–'+pct2(hi)+']</span>'):'');
    } else if(o){
      info=' · das '+(o.base!=null?pct2(o.base):'—')+'% · pide '+(o.approx?'~':'')+pct2(o.reqSeller)+'%'+(o.target?(' <span style="color:var(--text-soft)">(a '+money(Math.round(o.target))+')</span>'):'')
        +' · ML <b style="color:#16a34a">+'+pct2(o.meli)+'%</b> → comprador '+(o.approx?'~':'')+pct2(o.buyer)+'%'
        +cuesta(o.extra);
    } else {
      info=' · <span style="color:var(--text-soft)">ML fija los valores al entrar (sin dato previo)</span>';
    }
    return '<div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;font-size:12px;padding:4px 8px;border-bottom:1px solid var(--border)'+(x.cost!=null&&x.cost<=1?';background:rgba(22,163,74,.05)':'')+'">'
      + '<input type="checkbox" class="pexp-chk" data-id="'+esc(x.id)+'"'+((x.cost!=null&&x.cost<=1)?' checked':'')+' onchange="pexpCalc(\''+esc(pid)+'\')">'
      + '<span style="text-transform:capitalize;font-weight:600;color:var(--text)">'+esc(x.model||'?')+'</span> '+tierBadgeM(x.tier)+' '+mlPromosA(x.num, x.id)
      + info
      + (x.sales?(' <span style="color:var(--text-soft);margin-left:auto">'+x.sales+' vend.</span>'):'')
      + '</div>';
  }).join('');
  h+='</div>';
  h+='<div style="margin-top:8px;display:flex;gap:8px;align-items:center;flex-wrap:wrap"><button id="pexpbtn-'+esc(pid)+'" class="btn btn-sm" onclick="pexpConfirm(\''+esc(pid)+'\')" style="background:#16a34a;color:#fff;border-color:#16a34a;font-weight:700">Entrar a las tildadas (<span id="pexpn-'+esc(pid)+'">0</span>)</button>'
    // Motivo de las destildadas (OPCIONAL, 1 clic): alimenta el loop de aprendizaje — el sistema registra
    // qué rechazaste CON tus números y el porqué → de ahí salen las reglas para sugerir/automatizar después.
    +'<select id="pexpwhy-'+esc(pid)+'" style="font-size:11px;padding:4px;border:1px solid var(--border2);border-radius:6px;background:var(--surface);color:var(--text-soft)" title="Por qué dejás afuera las destildadas — opcional, ayuda a que el sistema aprenda tu criterio"><option value="">motivo de las destildadas (opcional)</option><option value="sin-rentabilidad">sin rentabilidad (pide demasiado %)</option><option value="precio-muy-profundo">precio objetivo muy profundo</option><option value="modelo-no-prioritario">modelo no prioritario</option><option value="poco-stock">poco stock</option><option value="otro">otro</option></select>'
    +'<span id="pexpst-'+esc(pid)+'" style="font-size:11px"></span></div>';
  h+='</div>';
  box.innerHTML=h;
  pexpCalc(pid);
}
function pexpCalc(pid){
  const box=document.getElementById('pexp-'+pid); const P=_pexp[pid]; if(!box||!P) return;
  let n=0;
  box.querySelectorAll('.pexp-chk').forEach(chk=>{
    if(!chk.checked) return;
    if(P.self){ const id=chk.getAttribute('data-id'); const inp=box.querySelector('.pexp-pct[data-id="'+id+'"]'); const pct=inp?parseFloat(inp.value):NaN; if(pct>=5&&pct<=80) n++; }
    else n++;
  });
  const nEl=document.getElementById('pexpn-'+pid); if(nEl) nEl.textContent=String(n);
  const btn=document.getElementById('pexpbtn-'+pid); if(btn && !btn._arm) btn.disabled=!n;
}
function pexpAll(pid,on){ const box=document.getElementById('pexp-'+pid); if(!box) return; box.querySelectorAll('.pexp-chk').forEach(c=>{ c.checked=!!on; }); pexpCalc(pid); }
async function pexpConfirm(pid){
  const box=document.getElementById('pexp-'+pid); const P=_pexp[pid]; if(!box||!P) return;
  const btn=document.getElementById('pexpbtn-'+pid); const st=document.getElementById('pexpst-'+pid);
  const setSt=(c,t)=>{ if(st){ st.style.color=c; st.innerHTML=t; } };
  if(!btn) return;
  // CAPTURA COMPLETA para el loop de aprendizaje: cada fila ofrecida con sus números Y la decisión de
  // Martin (tildada=entra / destildada=RECHAZADA). El rechazo es la señal más valiosa — antes se perdía.
  const snap=(x,pctIn)=>({ id:x.id, m:x.model||'', t:x.tier||'', das:(x.sellerCost!=null?x.sellerCost:null), ask:(P.self?(pctIn!=null?pctIn:x.pct):(x.opp?x.opp.reqSeller:null)), ml:(x.opp?x.opp.meli:null), extra:(x.opp?x.opp.extra:null), cost:(x.cost!=null?x.cost:null), tgt:(x.opp&&x.opp.target?Math.round(x.opp.target):null), req:(x.reqPct!=null?x.reqPct:null), v:(x.sales||0) });
  const selfItems=[], coIds=[], accepted=[], rejected=[], expect={}; let invalid=0;
  // Resolver la fila por data-id ESTABLE (id de la publicación), NUNCA por índice sobre `rows` re-filtrado:
  // si isJoined cambió entre render y confirm (otro flujo, o una entrada parcial previa), los índices corren
  // y se escribiría la promo en la publicación corrida. Mismo patrón seguro que dealConfirm.
  const byId={}; for(const r of P.rows) if(r&&r.id!=null) byId[String(r.id)]=r;
  const offered=box.querySelectorAll('.pexp-chk').length;   // candidatas realmente ofrecidas (renderizadas) — para el decision_log
  box.querySelectorAll('.pexp-chk').forEach(chk=>{
    const id=chk.getAttribute('data-id'); const x=byId[String(id)]; if(!x) return;
    if(isJoined(x.id+'|'+pid)) return;   // ya entrada entre render y confirm → no re-entrar
    const inp=P.self?box.querySelector('.pexp-pct[data-id="'+id+'"]'):null;
    const pct=inp?Math.round(parseFloat(inp.value)):null;
    if(!chk.checked){ rejected.push(snap(x,pct)); return; }
    if(x.model) expect[x.id]=x.model;   // guard de modelo: Martin tildó mirando ESTE nombre de modelo
    if(P.self){ if(pct>=5&&pct<=80){ selfItems.push({id:x.id, pct}); accepted.push(snap(x,pct)); } else invalid++; }
    else { coIds.push(x.id); accepted.push(snap(x,null)); }
  });
  const total=selfItems.length+coIds.length;
  if(!total){ setSt('#dc2626', invalid?('Las tildadas no tienen % válido (5–80).'):'No hay ninguna tildada.'); return; }
  const camp=(_promosCache||[]).find(c=>String(c.id)===String(pid))||{};
  const nm=esc(camp.name||TIPO_LABEL[P.type]||'campaña');
  if(!btn._arm){
    btn._arm=setTimeout(()=>{ btn._arm=null; btn.innerHTML='Entrar a las tildadas (<span id="pexpn-'+esc(pid)+'">'+total+'</span>)'; btn.style.background='#16a34a'; btn.style.borderColor='#16a34a'; },12000);
    btn.textContent='⚠️ Confirmar — entra '+total+' en ML'; btn.style.background='#dc2626'; btn.style.borderColor='#dc2626';
    setSt('#dc2626','⚠️ Vas a ENTRAR '+total+' publicaciones a «'+nm+'» en ML.'+(invalid?(' ('+invalid+' tildadas sin % válido quedan afuera.)'):'')+' Apretá Confirmar de nuevo.');
    return;
  }
  clearTimeout(btn._arm); btn._arm=null; btn.disabled=true; btn.textContent='Entrando…'; btn.style.background='#16a34a'; btn.style.borderColor='#16a34a';
  let ok=0, already=0, skip=0, fail=0, firstErr='', firstSkip='', doneN=0; const touched=[];
  try{
    // 1) auto-fondeadas con % (promo-join-deal: banda en vivo por ítem)
    let off=0, done=selfItems.length===0, guard=0;
    while(!done && guard<600){ guard++;
      const r=await apiPostEx('/api/ml/promo-join-deal',{ items:selfItems, promotionId:pid, promotionType:P.type, expect, offset:off });
      if(!r.ok){ const tr=r.status>=500||r.status===0; if(tr&&guard<598){ setSt('var(--text-soft)','Reintentando…'); await new Promise(res=>setTimeout(res,1500)); continue; } throw new Error((r.body&&r.body.error)||('http '+r.status)); }
      for(const x of (r.body.results||[])){ doneN++; if(x.already){ already++; markJoined(x.itemId+'|'+pid); } else if(x.ok!==false&&!x.skipped){ ok++; touched.push(x.itemId); markJoined(x.itemId+'|'+pid); } else if(x.skipped){ skip++; if(!firstSkip&&x.error) firstSkip=x.error; } else { fail++; if(!firstErr&&x.error) firstErr=x.error; } }
      off=r.body.nextOffset; done=!!r.body.done;
      setSt('var(--text-soft)','Entrando… '+doneN+'/'+total+' <a href="#" onclick="return false" style="visibility:hidden">.</a>');
    }
    // 2) co-fondeadas (promo-join: offer_id de la candidata, ML fija el precio)
    off=0; done=coIds.length===0; guard=0;
    while(!done && guard<600){ guard++;
      const r=await apiPostEx('/api/ml/promo-join',{ itemIds:coIds, promotionId:pid, promotionType:P.type, expect, offset:off });
      if(!r.ok){ const tr=r.status>=500||r.status===0; if(tr&&guard<598){ setSt('var(--text-soft)','Reintentando…'); await new Promise(res=>setTimeout(res,1500)); continue; } throw new Error((r.body&&r.body.error)||('http '+r.status)); }
      for(const x of (r.body.results||[])){ doneN++; if(x.already){ already++; markJoined(x.itemId+'|'+pid); } else if(x.ok!==false&&!x.skipped){ ok++; touched.push(x.itemId); markJoined(x.itemId+'|'+pid); } else if(x.skipped){ skip++; if(!firstSkip&&x.error) firstSkip=x.error; } else { fail++; if(!firstErr&&x.error) firstErr=x.error; } }
      off=r.body.nextOffset; done=!!r.body.done;
      setSt('var(--text-soft)','Entrando… '+doneN+'/'+total);
    }
    const parts=[]; if(ok)parts.push('✓ '+ok+' entraron'); if(already)parts.push(already+' ya estaban'); if(skip)parts.push(skip+' quedaron afuera'); if(fail)parts.push('⚠️ '+fail+' fallaron');
    const detail=firstErr?(' — ML dijo: '+esc(String(firstErr))):(skip&&firstSkip?(' — '+esc(String(firstSkip))):'');
    setSt(fail?'#dc2626':((ok||already)?'#16a34a':'#b45309'),(parts.join(' · ')||'sin cambios')+detail);
    if(fail) toast('⚠️ '+fail+' fallaron en «'+nm+'»','info');
    else if(ok) toast('✓ Entraste '+ok+' a «'+nm+'»','success');
    else if(skip) toast('⚠️ No entraron a «'+nm+'»: '+(firstSkip||'quedaron afuera'),'info');
    else toast('Sin cambios en «'+nm+'»','info');
    // LOG DE DECISIÓN COMPLETO (loop de aprendizaje): ofrecidas + entradas (con números) + RECHAZADAS con
    // motivo. De este dataset salen las reglas ("Martin rechaza cuando pide >X% en Premium") que después
    // permiten sugerir el tilde/destilde automáticamente y, más adelante, operar con guardrails.
    const why=((document.getElementById('pexpwhy-'+pid)||{}).value)||null;
    try{ apiPost('/api/decisions',{ area:'promo-join-campaign', subject:(camp.name||TIPO_LABEL[P.type]||pid), suggested:{promotionId:pid, type:P.type, mode:'expand-checked', self:P.self, preChecked:'costo<=1pto', offered:offered}, applied:{entered:accepted, rejected:{n:rejected.length, reason:why, rows:rejected}}, outcome:{ok,already,skip,fail}, accepted:true }); }catch(e){}
    if(touched.length) await reconcilePrices(touched);
    renderPromoExpand(pid);
    ensureCampaignAlerts(true);
  }catch(e){ setSt('#dc2626','Error: '+esc(e.message)); toast('Error: '+e.message,'error'); }
  finally{ const b=document.getElementById('pexpbtn-'+pid); if(b){ b.disabled=false; if(!/Confirmar|Entrando/.test(b.textContent||'')) b.innerHTML='Entrar a las tildadas (<span id="pexpn-'+esc(pid)+'">0</span>)'; else b.innerHTML='Entrar a las tildadas (<span id="pexpn-'+esc(pid)+'">0</span>)'; pexpCalc(pid); } }
}
// ── "Sin ningún descuento" (tab Cayó de promo): aplicar un PRICE_DISCOUNT in-page ──────────────────
let _sinDescL = [];
function sdCalc(i){
  const inp=document.querySelector('.sd-pct[data-i="'+i+'"]'); const p=_sinDescL[i]; if(!inp||!p) return;
  const pct=parseFloat(inp.value); const ok=(pct>=5&&pct<=80)&&(p.list>0);
  const fin=document.getElementById('sdfin-'+i); if(fin) fin.textContent = ok ? money(Math.round(p.list*(1-pct/100))) : '—';
  const btn=document.getElementById('sdbtn-'+i); if(btn) btn.disabled=!ok;
}
// Campaña PROPIA activa (SELLER_CAMPAIGN started, ej. "julio"): el destino PREFERIDO de los descuentos
// nuevos (pedido de Martin: todo dentro de la campaña propia, no descuentos sueltos — un solo lugar, una
// sola vigencia). Si la pub no es candidata de la propia, fallback a PRICE_DISCOUNT con las fechas elegidas.
async function sdOwnCampaign(){
  let ps=_promosCache;
  if(!ps){ try{ const pr=await apiGet('/api/ml/promos'); ps=(pr&&pr.ok&&pr.promos)||[]; _promosCache=ps; }catch(e){ ps=[]; } }
  return (ps||[]).find(c=>String(c.type||'')==='SELLER_CAMPAIGN' && String(c.status||'').toLowerCase()==='started') || null;
}
// PLAN de multi-entrada (rediseño 3/7, pedido de Martin): el % de la fila es la LLAVE — entra a TODAS las
// promociones que ese número cubra: la campaña propia activa (julio), las co-fondeadas que pidan ≤ % (ML
// aporta encima) y los DEAL (su banda se valida en vivo al entrar). Cupones JAMÁS; Relámpago/DOD se
// EXCLUYEN del automático (agresivas: se entran a mano desde la expansión) pero se informan.
// Si no puede entrar a NINGUNA campaña → fallback Descuento por porcentaje (la única "promoción creable"
// por API: la campaña propia con nombre se crea solo desde el panel de ML y esta sección la toma sola).
function sdPlan(p, pct, own){
  const camps=_promosCache||[];
  const plan={ julio:null, co:[], deals:[], aggr:[] };
  for(const cid of (p.candCamps||[])){
    const c=camps.find(x=>String(x.id)===String(cid)); if(!c) continue;
    const t=String(c.type||''); const st=String(c.status||'').toLowerCase();
    if(/COUPON|CUPON/i.test(t)) continue;
    if(st!=='started' && st!=='pending') continue;
    if(t==='SELLER_CAMPAIGN'){ if(own && String(own.id)===String(cid)) plan.julio={ id:String(cid), name:c.name||'campaña propia' }; continue; }
    if(t==='DOD'||t==='LIGHTNING'){ plan.aggr.push({ id:String(cid), name:c.name||TIPO_LABEL[t]||t }); continue; }
    const o=(p.opps||[]).find(x=>String(x.promotionId||'')===String(cid));
    if(o && o.meli>0 && o.reqSeller!=null){ if(o.reqSeller<=pct) plan.co.push({ id:String(cid), type:t, name:c.name||TIPO_LABEL[t]||t, req:o.reqSeller, meli:o.meli }); continue; }
    if(t==='DEAL') plan.deals.push({ id:String(cid), name:c.name||TIPO_LABEL[t]||t });
  }
  plan.none=!plan.julio && !plan.co.length && !plan.deals.length;
  return plan;
}
function sdPlanTxt(plan, pct){
  const parts=[];
  if(plan.julio) parts.push('«'+plan.julio.name+'» al '+pct+'%');
  plan.co.forEach(c=>parts.push('«'+c.name+'» (pide '+pct2(c.req)+'%, ML +'+pct2(c.meli)+'%)'));
  plan.deals.forEach(d=>parts.push('«'+d.name+'» al '+pct+'% (banda se valida al entrar)'));
  return parts.join(' · ');
}
// Ejecutor agrupado por campaña (batches resumibles, guard de modelo en todos): julio → co-fondeadas →
// DEALs → fallback PRICE_DISCOUNT. Devuelve conteos por campaña + ids tocados para UN reconcile.
async function sdRunPlans(items, own, s, f, setSt){
  const expect={}; items.forEach(x=>{ if(x.p.model) expect[x.itemId]=x.p.model; });
  const julioItems=[]; const coG={}; const dealG={}; const fallb=[];
  for(const x of items){
    if(x.plan.julio) julioItems.push({ id:x.itemId, pct:x.pct });
    for(const c of x.plan.co){ (coG[c.id]=coG[c.id]||{ name:c.name, type:c.type, ids:[] }).ids.push(x.itemId); }
    for(const d of x.plan.deals){ (dealG[d.id]=dealG[d.id]||{ name:d.name, items:[] }).items.push({ id:x.itemId, pct:x.pct }); }
    if(x.plan.none) fallb.push({ itemId:x.itemId, dealPrice:Math.round(x.p.list*(1-x.pct/100)) });
  }
  const out={ camps:[], touched:[], ok:0, skip:0, fail:0, firstErr:'' };
  const track=(nm,res)=>{ const c={ name:nm, ok:0, already:0, skip:0, fail:0 };
    for(const x of (res||[])){ if(x.already){ c.already++; } else if(x.ok!==false&&!x.skipped){ c.ok++; out.touched.push(x.itemId); } else if(x.skipped){ c.skip++; if(!out.firstErr&&x.error) out.firstErr=x.error; } else { c.fail++; if(!out.firstErr&&x.error) out.firstErr=x.error; } }
    out.ok+=c.ok; out.skip+=c.skip; out.fail+=c.fail; out.camps.push(c); };
  const loop=async(post)=>{ let offset=0, done=false, guard=0, acc=[];
    while(!done && guard<300){ guard++;
      const r=await post(offset);
      if(!r.ok){ const tr=r.status>=500||r.status===0; if(tr&&guard<298){ await new Promise(res=>setTimeout(res,1500)); continue; } throw new Error((r.body&&r.body.error)||('http '+r.status)); }
      acc=acc.concat(r.body.results||[]); offset=r.body.nextOffset; done=!!r.body.done;
    } return acc; };
  if(julioItems.length && own){
    setSt('var(--text-soft)','Entrando a «'+(own.name||'campaña propia')+'»… ('+julioItems.length+')');
    track(own.name||'campaña propia', await loop(off=>apiPostEx('/api/ml/promo-join-deal',{ items:julioItems, promotionId:own.id, promotionType:'SELLER_CAMPAIGN', expect, offset:off })));
  }
  for(const cid of Object.keys(coG)){ const g=coG[cid];
    setSt('var(--text-soft)','Entrando a «'+g.name+'»… ('+g.ids.length+')');
    track(g.name, await loop(off=>apiPostEx('/api/ml/promo-join',{ itemIds:g.ids, promotionId:cid, promotionType:g.type, expect, offset:off })));
  }
  for(const did of Object.keys(dealG)){ const g=dealG[did];
    setSt('var(--text-soft)','Entrando a «'+g.name+'»… ('+g.items.length+')');
    track(g.name, await loop(off=>apiPostEx('/api/ml/promo-join-deal',{ items:g.items, promotionId:did, promotionType:'DEAL', expect, offset:off })));
  }
  if(fallb.length){
    setSt('var(--text-soft)','Descuento por porcentaje… ('+fallb.length+')');
    track('Descuento por porcentaje', await loop(off=>apiPostEx('/api/ml/promo-apply',{ items:fallb, startDate:s+'T00:00:00', finishDate:f+'T23:59:59', expect, offset:off })));
  }
  return out;
}
function sdOutTxt(out){
  const per=out.camps.filter(c=>c.ok||c.already||c.skip||c.fail).map(c=>'«'+c.name+'» '+(c.ok?('✓'+c.ok):'')+(c.already?(' ya:'+c.already):'')+(c.skip?(' afuera:'+c.skip):'')+(c.fail?(' ✗'+c.fail):'')).join(' · ');
  return per||'sin cambios';
}
async function sdApplyAll(){
  const btn=document.getElementById('sd-all'); const st=document.getElementById('sd-all-st');
  const setSt=(c,t)=>{ if(st){ st.style.color=c; st.textContent=t; } };
  if(!btn) return;
  const own=await sdOwnCampaign();
  const items=[]; let sinPct=0;
  _sinDescL.forEach((p,i)=>{
    if(!(p.list>0)) return;
    const inp=document.querySelector('.sd-pct[data-i="'+i+'"]');
    const pct=Math.round(parseFloat((inp&&inp.value)||''));
    if(!(pct>=5&&pct<=80)){ sinPct++; return; }
    const itemId=(p.ids&&p.ids[0])||p.num;
    items.push({ p, pct, itemId, plan:sdPlan(p, pct, own) });
  });
  if(!items.length){ setSt('#dc2626','Ninguna fila con % cargado (poné el % en las filas que quieras aplicar).'); return; }
  const s=(document.getElementById('sd-start')||{}).value, f=(document.getElementById('sd-finish')||{}).value;
  const nFall=items.filter(x=>x.plan.none).length;
  if(nFall && (!s||!f||f<=s)){ setSt('#dc2626','Hay '+nFall+' que no entran a ninguna campaña → revisá las fechas de vigencia del Descuento por porcentaje (fin > inicio).'); return; }
  const nJ=items.filter(x=>x.plan.julio).length;
  const nCo=items.reduce((a,x)=>a+x.plan.co.length,0);
  const nDe=items.reduce((a,x)=>a+x.plan.deals.length,0);
  const nAg=items.reduce((a,x)=>a+x.plan.aggr.length,0);
  if(!btn._arm){
    btn._arm=setTimeout(()=>{ btn._arm=null; btn.textContent='⚡ Aplicar a todas las filas con % cargado'; btn.style.background='#16a34a'; btn.style.borderColor='#16a34a'; },12000);
    btn.textContent='⚠️ Confirmar — escribe '+items.length+' publicaciones en ML'; btn.style.background='#dc2626'; btn.style.borderColor='#dc2626';
    const parts=[];
    if(nJ) parts.push(nJ+' entran a «'+((own&&own.name)||'campaña propia')+'» (vigencia de la campaña)');
    if(nCo) parts.push(nCo+' entradas co-fondeadas (ML aporta)');
    if(nDe) parts.push(nDe+' a DEALs (banda se valida al entrar)');
    if(nFall) parts.push(nFall+' como Descuento por porcentaje ('+s+' → '+f+')');
    setSt('#dc2626','⚠️ '+items.length+' publicaciones con su %: '+parts.join(' + ')+'.'+(nAg?(' '+nAg+' candidaturas Relámpago/DOD quedan AFUERA (manuales).'):'')+(sinPct?(' '+sinPct+' filas sin % no se tocan.'):'')+' Apretá Confirmar de nuevo.');
    return;
  }
  clearTimeout(btn._arm); btn._arm=null; btn.disabled=true; btn.textContent='Aplicando…'; btn.style.background='#16a34a'; btn.style.borderColor='#16a34a';
  try{
    const out=await sdRunPlans(items, own, s, f, setSt);
    setSt(out.fail?'#dc2626':(out.ok?'#16a34a':'#b45309'), sdOutTxt(out)+(out.firstErr?(' — '+esc(String(out.firstErr))):'')+(out.ok?' — actualizando…':''));
    if(out.fail) toast('⚠️ '+out.fail+' fallaron ('+out.ok+' ok)','info');
    else if(out.ok) toast('✓ '+out.ok+' entradas aplicadas','success');
    else toast('⚠️ Nada aplicado: '+(out.firstErr||'sin cambios'),'info');
    try{ apiPost('/api/decisions',{ area:'price-disc', subject:'sin-descuento (multi)', suggested:{mode:'sin-descuento-multi', rows:items.length, julio:nJ, co:nCo, deals:nDe, fallback:nFall, aggrExcluded:nAg, campaign:(own&&own.id)||null}, applied:{rows:items.map(x=>({id:x.itemId, pct:x.pct}))}, outcome:{ok:out.ok, skip:out.skip, fail:out.fail, camps:out.camps}, accepted:true }); }catch(e){}
    if(out.touched.length) await reconcilePrices([...new Set(out.touched)]);
  }catch(e){ setSt('#dc2626','Error: '+esc(e.message)); toast('Error: '+e.message,'error'); }
  finally{ btn.disabled=false; btn.textContent='⚡ Aplicar a todas las filas con % cargado'; }
}
async function sdApply(i){
  const p=_sinDescL[i]; if(!p) return;
  const inp=document.querySelector('.sd-pct[data-i="'+i+'"]'); const btn=document.getElementById('sdbtn-'+i); const st=document.getElementById('sdst-'+i);
  const setSt=(c,t)=>{ if(st){ st.style.color=c; st.textContent=t; } };
  if(!btn) return;
  const pct=Math.round(parseFloat((inp&&inp.value)||''));
  if(!(pct>=5&&pct<=80)||!(p.list>0)){ setSt('#dc2626','% inválido (5–80).'); return; }
  const itemId=(p.ids&&p.ids[0])||p.num;
  const own=await sdOwnCampaign();
  const plan=sdPlan(p, pct, own);
  const s=(document.getElementById('sd-start')||{}).value, f=(document.getElementById('sd-finish')||{}).value;
  if(plan.none && (!s||!f||f<=s)){ setSt('#dc2626','No entra a ninguna campaña → revisá las fechas del Descuento por porcentaje (fin > inicio).'); return; }
  // Doble-clic in-page (regla dura: nada de confirm() del navegador) — el mensaje LISTA el plan exacto.
  if(!btn._arm){
    btn._arm=setTimeout(()=>{ btn._arm=null; btn.textContent='Aplicar'; btn.style.background='#0ea5e9'; btn.style.borderColor='#0ea5e9'; },12000);
    btn.textContent='⚠️ Confirmar '+pct+'%'; btn.style.background='#dc2626'; btn.style.borderColor='#dc2626';
    setSt('#dc2626', plan.none
      ? ('⚠️ No es candidata de ninguna campaña: crea un Descuento por porcentaje del '+pct+'% ('+money(Math.round(p.list*(1-pct/100)))+', vigente '+s+' → '+f+'). Apretá Confirmar de nuevo.')
      : ('⚠️ Con tu '+pct+'% entra a: '+sdPlanTxt(plan, pct)+'.'+(plan.aggr.length?(' Quedan afuera (manuales): '+plan.aggr.map(a=>'«'+a.name+'»').join(', ')+'.'):'')+' Apretá Confirmar de nuevo.'));
    return;
  }
  clearTimeout(btn._arm); btn._arm=null; btn.disabled=true; btn.textContent='Aplicando…'; btn.style.background='#0ea5e9'; btn.style.borderColor='#0ea5e9';
  try{
    const out=await sdRunPlans([{ p, pct, itemId, plan }], own, s, f, setSt);
    if(out.ok){
      setSt('#16a34a','✓ '+sdOutTxt(out)+' — actualizando…');
      toast('✓ '+(p.model||itemId)+': '+pct+'% → '+sdOutTxt(out),'success');
    } else {
      setSt(out.fail?'#dc2626':'#b45309','No entró: '+sdOutTxt(out)+(out.firstErr?(' — '+esc(String(out.firstErr))):''));
      toast('⚠️ No entró: '+(out.firstErr||'sin cambios'),'info');
      btn.disabled=false; btn.textContent='Aplicar';
    }
    try{ apiPost('/api/decisions',{ area:'price-disc', subject:p.model||String(p.num), suggested:{mode:'sin-descuento-multi', pct, list:p.list, sales2w:p.sales2w||0, plan:{julio:!!plan.julio, co:plan.co.map(c=>c.name), deals:plan.deals.map(d=>d.name), aggrExcluded:plan.aggr.map(a=>a.name), fallback:plan.none}}, applied:{ids:[itemId], pct}, outcome:{ok:out.ok, skip:out.skip, fail:out.fail, camps:out.camps}, accepted:true }); }catch(e){}
    if(out.touched.length) await reconcilePrices([...new Set(out.touched)]);
  }catch(e){ setSt('#dc2626','Error: '+esc(e.message)); btn.disabled=false; btn.textContent='Aplicar'; }
}
// Confirmar (doble-clic) + entrada masiva resumible. Marca cada entrada al instante (markJoined) → reanudable
// sin reprocesar; reconcilía y recalcula la card al terminar.
async function dealConfirm(pid){
  const P=_dealPrev[pid]; if(!P) return;
  const box=document.getElementById('dealprev-'+pid);
  const btn=document.getElementById('dealconfirm-'+pid); const st=document.getElementById('dealprogress-'+pid);
  const setSt=(c,html)=>{ if(st){ st.style.color=c; st.innerHTML=html; } };
  if(!btn||!box) return;
  // La LISTA editable es la fuente de verdad: cada fila con su % (default = descuento actual). Excluir
  // ya-entradas (reanudar) y las que quedaron con % inválido.
  // Cada fila = una publicación; al entrar se EXPANDE a todos sus item_id (data-ids, la familia activa). El
  // backend re-valida cada item_id en vivo (banda + estado) → expandir de más es inocuo. rows=filas (pubs),
  // all=item_ids a escribir (≥ pubs si hay familias multi-MLA).
  const all=[]; let invalid=0, rowsN=0; const id2rep={};
  box.querySelectorAll('.dealrow-pct').forEach(inp=>{ const id=inp.getAttribute('data-id'); if(isJoined(id+'|'+pid)) return; const pct=Math.round(parseFloat(inp.value)); const fl=parseFloat(inp.getAttribute('data-floor')); const cp=parseFloat(inp.getAttribute('data-cap')); const rq=parseFloat(inp.getAttribute('data-req')); const lo=Math.max(5,isNaN(fl)?5:fl), hi=Math.min(80,isNaN(cp)?80:cp); if(pct>=lo&&pct<=hi && (isNaN(rq)||pct>=rq)){ rowsN++; const ids=(inp.getAttribute('data-ids')||id).split(',').filter(Boolean); for(const iid of ids){ id2rep[iid]=id; all.push({id:iid,pct}); } } else invalid++; });
  if(!all.length){ setSt('#dc2626', invalid?('Hay '+invalid+' con % inválido (5–80). Corregí y reintentá.'):'No queda ninguna para entrar.'); return; }
  const camp=(_campaignAlerts||[]).find(c=>c.id===pid)||{};
  const nm=esc(camp.name||TIPO_LABEL[P.type]||'campaña');
  // Honesto: rowsN = publicaciones verificadas (el rep pasó el dryRun). Al entrar se INTENTAN también los MLA
  // hermanos de cada familia (data-ids); el backend re-valida cada uno en vivo y saltea los que no entren → el
  // total de ítems es un TOPE, no una promesa. No afirmar un número verificado que no podemos garantizar.
  const escrTxt = rowsN+' publicacion'+(rowsN===1?'':'es')+(all.length!==rowsN?(' (hasta '+all.length+' ítems; ML saltea los que no entren en su banda)'):'');
  if(!btn._arm){
    btn._arm=setTimeout(()=>{ btn._arm=null; btn.innerHTML='Confirmar entrada de <span id="dealbtnN-'+pid+'">'+rowsN+'</span>'; btn.style.background='#16a34a'; btn.style.borderColor='#16a34a'; },12000);
    btn.textContent='⚠️ Confirmar — entra '+escrTxt+' en ML'; btn.style.background='#dc2626'; btn.style.borderColor='#dc2626';
    setSt('#dc2626','⚠️ Vas a ESCRIBIR '+escrTxt+' en «'+nm+'» en ML. Apretá Confirmar de nuevo.'+(invalid?(' ('+invalid+' con % inválido quedan afuera)'):''));
    return;
  }
  clearTimeout(btn._arm); btn._arm=null; btn.disabled=true; btn.textContent='Entrando…'; btn.style.background='#16a34a'; btn.style.borderColor='#16a34a';
  _dealPaused[pid]=false;
  const payload=all;
  let offset=0, done=false, guard=0, results=[];
  const prog=()=>{ const okN=results.filter(x=>x.ok!==false&&!x.skipped&&!x.already).length; setSt('var(--text-soft)','Entraron '+okN+' / '+payload.length+' <a href="#" onclick="dealPause(\''+pid+'\');return false" style="color:#dc2626">Pausar</a>'); };
  try{
    while(!done && guard<600){ guard++;
      if(_dealPaused[pid]){ setSt('#854d0e','Pausado en '+results.length+'/'+payload.length+'. Tocá Confirmar para reanudar.'); btn.disabled=false; btn.textContent='Reanudar'; return; }
      const r=await apiPostEx('/api/ml/promo-join-deal', { items:payload, promotionId:pid, promotionType:(P.type||'DEAL'), offset });
      if(!r.ok){ const transient=r.status>=500||r.status===0; if(transient&&guard<598){ setSt('var(--text-soft)','Reintentando…'); await new Promise(res=>setTimeout(res,1500)); continue; } throw new Error((r.body&&r.body.error)||('http '+r.status)); }
      const chunk=r.body.results||[]; results=results.concat(chunk); offset=r.body.nextOffset; done=!!r.body.done;
      // Marcar por chunk → reanudable. Marco el item_id entrado Y su rep de familia: la card/preview/panel
      // saltean por rep, así que si entra CUALQUIER miembro (aunque el rep mismo se haya salteado) la fila se
      // limpia y no se re-postea en el siguiente confirm/resume (evita re-intentos que inflan el audit).
      chunk.forEach(x=>{ if(x&&x.ok!==false&&!x.skipped){ markJoined(x.itemId+'|'+pid); const rep=id2rep[x.itemId]; if(rep && rep!==x.itemId) markJoined(rep+'|'+pid); } });
      prog();
    }
    const ok=results.filter(x=>x.ok!==false&&!x.skipped&&!x.already).length;
    const already=results.filter(x=>x.already).length;
    const skip=results.filter(x=>x.skipped).length;
    const fail=results.filter(x=>x.ok===false&&!x.skipped).length;
    const parts=[]; if(ok)parts.push('✓ '+ok+' entraron'); if(already)parts.push(already+' ya estaban'); if(skip)parts.push(skip+' quedaron afuera'); if(fail)parts.push('⚠️ '+fail+' fallaron');
    const firstErr=(results.find(x=>x.ok===false&&!x.skipped)||{}).error;
    const firstSkip=(results.find(x=>x.skipped)||{}).error;
    const detail=firstErr?(' — ML dijo: '+esc(firstErr)):(skip&&!ok?(' — '+esc(firstSkip||'')):'');
    setSt(fail?'#dc2626':'#16a34a',(parts.join(' · ')||'sin cambios')+detail);
    if(fail||skip) console.warn('[Promos] dealJoin results',results);
    toast(fail?('⚠️ '+fail+' fallaron'):'✓ Entraste '+ok+' a '+(camp.name||TIPO_LABEL[P.type]||'la campaña'),'success');
    try{ apiPost('/api/decisions',{ area:'promo-join-campaign', subject:(camp.name||TIPO_LABEL[P.type]||pid), suggested:{promotionId:pid, type:P.type, name:camp.name, mode:'per-item', batch:true, count:payload.length, pcts:payload.map(x=>x.pct)}, applied:{promotionId:pid, ids:payload.map(x=>x.id)}, outcome:{ok,already,skip,fail}, accepted:true }); }catch(e){}
    await reconcilePrices([...new Set(all.map(x=>x.id))]);
    await ensureCampaignAlerts(true);   // recalcula la card (bajan los "sin sumar")
  }catch(e){ setSt('#dc2626','Error: '+esc(e.message)); toast('Error: '+e.message,'error'); console.error('[Promos] dealConfirm',e); if(btn){ btn.disabled=false; btn.textContent='Confirmar entrada de '+rowsN; } }
}

// ── Costos reales de ML por modelo (comisión + envío de ventas reales) + MARGEN ─────────────────
// Trae de las ventas reales (no estima): comisión real (sale_fee, incluye cuotas) por modelo + envío neto
// (del shipment, ya descontado el reintegro de ML). Vos solo cargás el costo landed (sección Costos).
// ATRIBUCIÓN (regla dura): el Worker entrega crudo por seller_sku de la ORDEN; ACÁ resolvemos SKU→modelo
// con el resolver ÚNICO (maestro D1 + PC_PRODUCTS, igual que Devoluciones/resumen) → nunca por el modelo
// vivo de la publicación (se reusan). Devuelve `out` keyed por MODELO → los consumidores (costosMargenReal,
// mstMargin, margenRealRow) no cambian de forma.
let _mlcosts=null, _mlcostsTs=0, _mlcostsUnres=null, _mlcostsComplete=false;
async function ensureMlCosts(force){
  if(_mlcosts && !force && (Date.now()-_mlcostsTs < 24*60*60*1000)) return _mlcosts;
  if(!force){ try{ const c=JSON.parse(localStorage.getItem('parka_mlcosts_v3')||'null'); if(c && c.data && (Date.now()-c.ts < 24*60*60*1000)){ _mlcosts=c.data; _mlcostsTs=c.ts; return _mlcosts; } }catch(e){} }
  await ensureSkuMaster();   // maestro SKU↔modelo (D1 compartido) — el resolver lo necesita
  const lt=document.getElementById('cv-margen-txt');
  // 1) scan de órdenes (resumible) → acumular comisión/revenue/unidades por SELLER_SKU + ids de envío
  const bySku={}; let from=null, done=false, g=0;
  while(!done && g<15){ g++;
    if(lt) lt.textContent='Comisión real desde ventas… '+Object.keys(bySku).length+' SKUs';
    // reintentar la página ante fallo transitorio (502 del edge / rate-limit de ML) — no tirar todo el scan
    let r=null;
    for(let tryN=0; tryN<3; tryN++){
      r=await apiGet('/api/ml/mlcosts'+(from?('?from='+encodeURIComponent(from)):''));
      if(r && r.ok) break;
      if(lt) lt.textContent='Comisión real desde ventas… reintentando ('+Object.keys(bySku).length+' SKUs)';
      await new Promise(res=>setTimeout(res, 1500*(tryN+1)));
    }
    if(!r || !r.ok) break;
    for(const k in (r.acc||{})){ const a=bySku[k]||(bySku[k]={fee:0,rev:0,qty:0,ship:[]}); a.fee+=r.acc[k].fee; a.rev+=r.acc[k].rev; a.qty+=r.acc[k].qty; for(const s of (r.acc[k].ship||[])){ if(a.ship.length<3 && a.ship.indexOf(s)<0) a.ship.push(s); } }
    from=r.nextFrom; done=!!r.done || !from;
  }
  // 1b) resolver SKU→modelo (mismo criterio que Devoluciones) y agregar por modelo. Los SKU que no
  //     resuelven quedan fuera (no inventamos modelo) — como en devoluciones/resumen. Contamos lo NO
  //     resuelto (unidades/revenue/SKUs) para exponerlo: un maestro incompleto se ve como "faltan uds",
  //     no se traga en silencio (regla dura "no silent caps / degradar honesto").
  const resolveModel=makeSkuModelResolver(_skuMaster||{}, (S&&S.PC_PRODUCTS)||[]);
  const acc={}; let qtyTot=0, qtyUnres=0, revUnres=0; const skuUnres=[];
  for(const sku in bySku){ const s=bySku[sku]; qtyTot+=s.qty;
    const base=vmlBaseCode(String(sku).toLowerCase().replace(/\s+/g,'-')); const mdl=resolveModel(base);
    if(!mdl){ qtyUnres+=s.qty; revUnres+=s.rev; if(skuUnres.length<40) skuUnres.push(sku); continue; }
    const a=acc[mdl]||(acc[mdl]={fee:0,rev:0,qty:0,ship:[]});
    a.fee+=s.fee; a.rev+=s.rev; a.qty+=s.qty; for(const sh of (s.ship||[])){ if(a.ship.length<3 && a.ship.indexOf(sh)<0) a.ship.push(sh); } }
  _mlcostsUnres={ qtyTot, qtyUnres, revUnres, skus:skuUnres, nSku:skuUnres.length };
  // 2) muestrear costos de envío (hasta 3 por modelo), en lotes de 20
  const allShip=[]; for(const m in acc){ for(const s of acc[m].ship){ if(allShip.indexOf(s)<0) allShip.push(s); } }
  const shipCost={};
  for(let i=0;i<allShip.length;i+=20){
    if(lt) lt.textContent='Costos de envío… '+i+'/'+allShip.length;
    const r=await apiGet('/api/ml/shipcost?ids='+encodeURIComponent(allShip.slice(i,i+20).join(',')));
    if(r && r.ok){ for(const id in (r.costs||{})){ const c=r.costs[id]; if(c && c.cost!=null) shipCost[id]=c.cost; } }
  }
  // 3) por modelo: comisión % + envío promedio. OJO: descartar envíos en 0 — en camperas el envío es
  //    gratis (lo paga el vendedor, costo>0); un 0 = comprador pagó / retiro / anomalía → no representa
  //    el costo real y deflactaría el promedio. Guardamos envN (tamaño de muestra) para mostrarlo.
  // Estos valores son BRUTOS (como los reporta ML / los ves en tu liquidación). El neteo de IVA se hace
  // en costosMargenReal según condición frente al IVA (RI → crédito fiscal recuperable).
  const out={};
  for(const m in acc){ const a=acc[m]; const envs=a.ship.map(s=>shipCost[s]).filter(x=>x!=null && x>0);
    out[m]={ comisionPct: a.rev>0 ? a.fee/a.rev*100 : null,
             comisUnit: a.qty>0 ? a.fee/a.qty : null,        // comisión REAL por unidad, BRUTA (sale_fee, incluye cuotas + IVA)
             precioReal: a.qty>0 ? a.rev/a.qty : null,        // precio promedio REAL de venta (revenue/unidades, ya con descuento)
             envio: envs.length ? envs.reduce((s,v)=>s+v,0)/envs.length : null, envN: envs.length, qty:a.qty }; }
  _mlcosts=out; _mlcostsComplete=done;
  // Solo CONGELAR (cache 24h local + TTL) si el scan COMPLETÓ. Si quedó parcial (un fetch rebotó las 3
  // veces), lo usamos en la sesión —parcial es mejor que nada para mostrar— pero NO lo freezamos: dejamos
  // _mlcostsTs=0 → la próxima llamada re-escanea (mismo criterio que ensureSales2w; A5 del audit). Antes un
  // scan parcial se cacheaba como verdad 24h y subcontaba comisión/velocidad del margen.
  if(done){ _mlcostsTs=Date.now(); try{ localStorage.setItem('parka_mlcosts_v3', JSON.stringify({ts:_mlcostsTs, data:out})); }catch(e){} }
  else { _mlcostsTs=0; }
  return out;
}

// Costo de PUBLICIDAD real (Product Ads) por modelo — Parte 2 del margen. 1 request al Worker
// (/api/ml/ads-costs agrega por modelo con el mismo id→model del catálogo que mlcosts → las keys cruzan).
// Cache 24h local, igual que ensureMlCosts (ML actualiza las métricas de ads 1×/día, 10:00 GMT-3).
let _adscosts=null, _adscostsTs=0;
async function ensureAdsCosts(force){
  if(_adscosts && !force && (Date.now()-_adscostsTs < 24*60*60*1000)) return _adscosts;
  if(!force){ try{ const c=JSON.parse(localStorage.getItem('parka_adscosts_v1')||'null'); if(c && c.data && (Date.now()-c.ts < 24*60*60*1000)){ _adscosts=c.data; _adscostsTs=c.ts; return _adscosts; } }catch(e){} }
  const r=await apiGet('/api/ml/ads-costs');
  if(!r || !r.ok) throw new Error('publicidad'+(r&&r.error?(' ('+r.error+')'):''));
  _adscosts=r; _adscostsTs=Date.now();
  try{ localStorage.setItem('parka_adscosts_v1', JSON.stringify({ts:_adscostsTs, data:r})); }catch(e){}
  return r;
}

// Margen real por modelo: precio (neto IVA 21%) − costo landed (vos) − comisión real − envío neto − publicidad.
async function costosMargenReal(force){
  const btn=document.getElementById('cv-margen-btn'), res=document.getElementById('cv-margen-results'), ld=document.getElementById('cv-margen-loading');
  if(btn) btn.disabled=true; if(ld) ld.style.display='flex';
  try{
    await ensureCatalog(false); await ensureSkuMaster();
    const ml=await ensureMlCosts(!!force);
    // Publicidad real (Parte 2) — best-effort: si falla, el margen sigue mostrándose SIN ads (con aviso).
    let ads=null; try{ ads=await ensureAdsCosts(!!force); }catch(e){ console.warn('[Costos] ads-costs',e); }
    const adsModels=(ads&&ads.models)||{};
    // costo landed por modelo desde PC_PRODUCTS (canal ML). OJO ambigüedad: skuToModels hace prefix-match
    // y puede devolver VARIOS modelos → asignaría el mismo costo a modelos distintos (margen confiado pero
    // equivocado). Para costo usamos la derivación por SKU SOLO cuando es unívoca (1 modelo); más los keys
    // directos (nombre / sku). Si no matchea, mejor "cargá costo" que un número mal.
    const landedOf={};
    try{ (S.PC_PRODUCTS||[]).forEach(p=>{ if(p.canal!=='ML') return; let landed=null; try{ landed=calcCostoARS(p); }catch(e){} if(landed==null) return;
      const v1=skuToModels(p.sku), v2=skuToModels(norm(p.sku).replace(/^([a-z]+)(\d)/,'$1-$2'));
      const cands=[norm(p.name), norm(p.sku)].concat(v1.length===1?v1:[]).concat(v2.length===1?v2:[]);
      for(const c of cands){ if(c && !landedOf[c]) landedOf[c]=landed; }
    }); }catch(e){}
    // Margen NETO de IVA (responsable inscripto) — la fórmula vive en margenRealRow (promo-math.ts,
    // testeada): precio/1.21 − landed − comisión/1.21 − envío/1.21 − publicidad/1.21 (el landed ya es neto).
    const rows=Object.keys(ml).map(m=>({ m, ...margenRealRow(ml[m], landedOf[m], adsModels[m]) })).filter(r=>r.price>0).sort((a,b)=>b.qty-a.qty);
    const conCosto=rows.filter(r=>r.margen!=null).length;
    const adsHdr = ads
      ? '<b>Publicidad real</b> ('+ads.dateFrom+' → '+ads.dateTo+'): total '+money(ads.summary&&ads.summary.cost)+' · ACOS '+(ads.summary&&ads.summary.acos!=null?ads.summary.acos+'%':'—')+' · ROAS '+(ads.summary&&ads.summary.roas!=null?ads.summary.roas:'—')+'. Repartida por unidad vendida y neteada de IVA.'
      : '<span style="color:#d97706">No pude traer la publicidad — el margen se muestra SIN ads (reintentá con ↻).</span>';
    // Aviso de atribución: unidades vendidas cuyo seller_sku no resuelve a modelo (maestro incompleto) →
    // quedan fuera del margen. Honesto: se ve el faltante en vez de tragarlo (regla "no silent caps").
    const unr=_mlcostsUnres; const unrPct=(unr&&unr.qtyTot>0)?Math.round(unr.qtyUnres/unr.qtyTot*100):0;
    const unrHdr=(unr&&unr.qtyUnres>0)?' <span style="color:#d97706" title="'+unr.nSku+' SKU vendidos no matchean un modelo del maestro/Costos → alineá el SKU en Precios→Maestro. Ej: '+esc(unr.skus.slice(0,8).join(', '))+'">· '+unr.qtyUnres+' uds ('+unrPct+'%) sin atribuir por SKU</span>':'';
    // Honesto: si el scan de ventas quedó a medias (algún fetch rebotó), no lo mostramos como completo.
    const incHdr=_mlcostsComplete?'':' <span style="color:#d97706" title="El barrido de ventas no completó (un fetch rebotó); los números pueden subcontar. Reintentá con ↻.">· scan incompleto (↻)</span>';
    let html='<div style="font-size:11px;color:var(--text-muted);margin-bottom:8px">'+rows.length+' modelos con ventas · '+conCosto+' con costo cargado'+unrHdr+incHdr+'. <b>Ventas reales (30 días)</b>; columnas en BRUTO (como en ML). <b>Margen NETO de IVA</b> = precio/1.21 − costo − comisión/1.21 − envío/1.21 − publicidad/1.21 (el costo ya es neto). '+adsHdr+' Monotributista: avisá, cambia el tratamiento de IVA.</div>';
    html+='<table style="width:100%;font-size:12px;border-collapse:collapse"><thead><tr style="text-align:right;color:var(--text-muted);font-size:11px">'
      +'<th style="text-align:left;padding:4px 6px">Modelo</th><th style="padding:4px 6px">Uds</th><th style="padding:4px 6px" title="Promedio real de venta 30 días (con descuento; puede mezclar períodos con distinto descuento)">Precio venta</th><th style="padding:4px 6px" title="Bruta, como te la descuenta ML (incluye cuotas + IVA)">Comisión</th><th style="padding:4px 6px" title="Costo de envío neto de reintegro, bruto con IVA">Envío</th><th style="padding:4px 6px">Costo</th><th style="padding:4px 6px" title="Inversión en Product Ads del modelo (30d) repartida por unidad vendida. Entre paréntesis, el ACOS = % de la venta que se va en ads">Publicidad</th><th style="padding:4px 6px" title="Margen NETO de IVA, DESPUÉS de publicidad (real)">Margen</th><th style="padding:4px 6px">%</th></tr></thead><tbody>';
    html+=rows.map(r=>{ const mcol = r.margenPct==null?'var(--text-soft)':(r.margenPct<10?'#dc2626':(r.margenPct<25?'#d97706':'#16a34a'));
      return '<tr style="border-top:1px solid var(--border2);text-align:right">'
        +'<td style="text-align:left;padding:5px 6px;text-transform:capitalize;font-weight:600">'+esc(r.m)+'</td>'
        +'<td style="padding:5px 6px;color:var(--text-soft)">'+r.qty+'</td>'
        +'<td style="padding:5px 6px">'+money(r.price)+'</td>'
        +'<td style="padding:5px 6px;color:#dc2626">'+(r.comis!=null?('−'+money(r.comis)+' <span style="color:var(--text-soft)">'+Math.round(r.comisionPct)+'%</span>'):'—')+'</td>'
        +'<td style="padding:5px 6px;color:#dc2626" title="'+(r.envN?('promedio de '+r.envN+' envío(s) reales >0'):'sin muestra de envío')+'">'+(r.env!=null?('−'+money(r.env)):'—')+'</td>'
        +'<td style="padding:5px 6px">'+(r.landed!=null?('−'+money(r.landed)):'<span style="color:#d97706">cargá costo</span>')+'</td>'
        +'<td style="padding:5px 6px;color:#dc2626" title="'+(r.adsM?(r.adsM.pubs+' pub · gasto 30d '+money(r.adsM.cost)+' · '+r.qty+' uds · ROAS '+(r.adsM.roas!=null?r.adsM.roas:'—')):'sin inversión de ads en el período')+'">'+(r.adsM?('−'+money(r.adsUnit)+(r.acos!=null?' <span style="color:var(--text-soft)">'+r.acos+'%</span>':'')):(ads?'<span style="color:var(--text-soft)">$0</span>':'—'))+'</td>'
        +'<td style="padding:5px 6px;font-weight:700;color:'+mcol+'">'+(r.margen!=null?money(r.margen):'—')+'</td>'
        +'<td style="padding:5px 6px;font-weight:700;color:'+mcol+'">'+(r.margenPct!=null?(Math.round(r.margenPct)+'%'):'—')+'</td>'
        +'</tr>';
    }).join('')+'</tbody></table>';
    html+='<div style="font-size:10px;color:var(--text-soft);margin-top:8px">Los modelos "cargá costo" no matchean con un artículo de Costos (alineá el nombre/SKU). Publicidad = ACOS real de Mercado Ads; "$0" = ese modelo no tuvo inversión de ads en el período'+(ads&&ads.unmatched&&ads.unmatched.pubs?('. '+ads.unmatched.pubs+' pub de ads ('+money(ads.unmatched.cost)+') no matchearon modelo del catálogo (fuera de la tabla)'):'')+'.</div>';
    if(res) res.innerHTML=html;
  }catch(e){ if(res) res.innerHTML='<div style="color:#dc2626;font-size:13px;padding:8px">Error: '+esc(e.message)+'</div>'; console.error('[Costos] margen',e); }
  finally{ if(btn) btn.disabled=false; if(ld) ld.style.display='none'; }
}

// ── Caídas de stock ──────────────────────────────────────────────────────────
// Red de seguridad para cuando el sync de stock falla (ej. asgard: el sistema llevó todo a 0 → ML pausó
// las publicaciones). DOS capas: (1) ESTADO ACTUAL — publicaciones en 0 cuyo ARTÍCULO tiene stock en otras
// (el producto claramente tiene stock, esa quedó rota); (2) CAÍDA vs el snapshot diario anterior (cron) —
// cayó a 0, cayó >60%, o pasó a pausada/under_review. Orden por visibilidad.
async function promoStockDrops(force){
  const btn=document.getElementById('promo-drops-btn');
  const ld=document.getElementById('promo-drops-loading');
  const txt=document.getElementById('promo-drops-txt');
  const res=document.getElementById('promo-drops-results');
  const cnt=document.getElementById('promo-drops-count');
  if(btn) btn.disabled=true; if(ld) ld.style.display='flex'; if(res) res.innerHTML='';
  try{
    if(txt) txt.textContent='Indexando catálogo (incluye pausadas)…';
    await ensureCatalog(!!force);
    await ensureSales2w(force);
    const sales=_sales2w||{};
    // CAPA 1 (estado actual): artículos con publicaciones en 0. Rankeado por VENTAS 14d — las pausadas no
    // tienen visitas (invisibles), pero si VENDIERON hace poco = producto vivo = la caída a 0 es falla real;
    // un descontinuado vendió 0 → al fondo. Marca: ≥2 publicaciones en 0, o alguna en 0 + otra con stock.
    const arts={};
    for(const it of _catalog){
      const m=norm(it.model); if(!m) continue;
      const a=arts[m]||(arts[m]={pubs:{}});
      const pk=it.familyId?('fam:'+it.familyId):('id:'+it.id);
      const p=a.pubs[pk]||(a.pubs[pk]={stock:0, ids:[], num:it.familyId||it.id, fam:!!it.familyId, status:it.status||''});
      p.stock += (it.stock||0); p.ids.push(it.id);
      if(it.status==='active') p.status='active'; else if(p.status!=='active' && it.status) p.status=it.status;
    }
    const flaggedArts=[];
    for(const m in arts){
      const pubs=Object.values(arts[m].pubs);
      const zeros=pubs.filter(p=>p.stock===0);
      const stocked=pubs.filter(p=>p.stock>=10);
      if(!(zeros.length>=2 || (zeros.length>=1 && stocked.length>=1))) continue;
      const artSales=pubs.reduce((s,p)=>s+p.ids.reduce((x,id)=>x+(sales[id]||0),0),0);
      flaggedArts.push({ model:m, zeros, maxStock:Math.max(0,...pubs.map(p=>p.stock)), artSales });
    }
    flaggedArts.sort((a,b)=> (b.artSales-a.artSales) || (b.zeros.length-a.zeros.length));
    // CAPA 2 (vs snapshot): caídas día-a-día.
    if(txt) txt.textContent='Tomando snapshot de stock…';
    let drops=[], snapInfo='';
    try{
      // tomar snapshot ahora: el front paginó el catálogo sin el límite de subrequests del Worker.
      const smap={}; _catalog.forEach(c=>{ if(c.id) smap[c.id]={s:c.stock||0, st:c.status||''}; });
      try{ await apiPost('/api/stock-snap', { map: smap }); }catch(e){}
      const snap=await apiGet('/api/stock-snap');
      const prev=JSON.parse(snap.prev||'{}'), curr=JSON.parse(snap.curr||'{}');
      const cm={}; _catalog.forEach(c=>{ cm[c.id]=c.model; });
      if(snap.prevTs && Object.keys(prev).length){
        for(const id in curr){
          const c=curr[id], p=prev[id]; if(!p) continue;
          const ps=p.s||0, cs=c.s||0;
          if(ps>=10 && cs===0) drops.push({id, model:cm[id]||'?', ps, cs, kind:'cero', st:c.st});
          else if(ps>=10 && cs<ps*0.4) drops.push({id, model:cm[id]||'?', ps, cs, kind:'caida', st:c.st});
          else if(p.st==='active' && (c.st==='paused'||c.st==='under_review')) drops.push({id, model:cm[id]||'?', ps, cs, kind:'pausa', st:c.st});
        }
        snapInfo='vs snapshot del '+String(snap.prevTs).slice(0,16).replace('T',' ');
      } else {
        snapInfo='(todavía no hay snapshot anterior — la comparación día-a-día arranca con 2 snapshots)';
      }
      await ensureVisits(drops.map(d=>d.id));
    }catch(e){ snapInfo='(no pude leer el snapshot)'; }
    drops.forEach(d=>{ d.visits=_visits[d.id]||0; });
    drops.sort((a,b)=>(b.visits||0)-(a.visits||0));
    const nZeroPubs=flaggedArts.reduce((a,x)=>a+x.zeros.length,0);
    if(cnt) cnt.textContent = flaggedArts.length+' artículo'+(flaggedArts.length===1?'':'s')+' con stock en 0 ('+nZeroPubs+' pub) · '+drops.length+' caídas vs snapshot'+(_catalogTs?(' · datos '+agoTxt(_catalogTs)):'');
    const link = (num,fam,ids) => mlEditA(num, (fam&&ids&&ids[0])||num);
    const stTag = s => s==='active'?'':(' <span class="badge" style="background:#fef9c3;color:#854d0e">'+esc(s==='under_review'?'en revisión':'pausada')+'</span>');
    const visTxt = v => (v!=null&&v>0)?(v.toLocaleString('es-AR')+' visitas 14d'):'';
    let html='';
    if(!flaggedArts.length && !drops.length){
      html='<div style="font-size:13px;color:#16a34a;padding:8px">✓ Sin stocks rotos: no hay artículos con publicaciones en 0 sospechosas ni caídas bruscas vs el snapshot.</div>';
    } else {
      if(flaggedArts.length){
        html+='<div style="font-size:12px;font-weight:600;color:var(--text);margin:2px 0 6px">Artículos con publicaciones en 0 ('+flaggedArts.length+') <span style="font-weight:400;color:var(--text-soft)">— por ventas 14d (vendió hace poco = vivo = probable falla de sync)</span></div>';
        html+=flaggedArts.map(a=>(
          '<div style="padding:10px;border:1px solid var(--border);border-left:3px solid #dc2626;border-radius:8px;margin-bottom:6px">'
          +'<div style="font-size:13px;font-weight:600;color:var(--text);text-transform:capitalize">'+esc(a.model)+' <span style="font-weight:400;color:var(--text-soft)">· '+a.zeros.length+' en 0 · '+a.artSales+' vendidas 14d'+(a.maxStock>=10?(' · otra con stock ('+a.maxStock+')'):' · todas en 0')+'</span></div>'
          +'<div style="display:flex;flex-direction:column;gap:2px;margin-top:4px">'+a.zeros.map(p=>('<div style="font-size:11px;color:var(--text-muted)">'+link(p.num,p.fam,p.ids)+stTag(p.status)+' · stock 0</div>')).join('')+'</div>'
          +'</div>'
        )).join('');
      }
      if(drops.length){
        html+='<div style="font-size:12px;font-weight:600;color:var(--text);margin:14px 0 6px">Caídas bruscas '+esc(snapInfo)+' ('+drops.length+')</div>';
        html+=drops.map(d=>{
          const txt2 = d.kind==='cero'?('cayó a 0 (estaba en '+d.ps+')'):(d.kind==='caida'?('cayó de '+d.ps+' a '+d.cs):('pasó a '+(d.st==='under_review'?'revisión':'pausada')+' (stock '+d.cs+')'));
          return '<div style="display:flex;gap:10px;padding:9px 10px;border:1px solid var(--border);border-left:3px solid #d97706;border-radius:8px;align-items:flex-start">'
          +'<div style="font-size:16px;color:#d97706">▼</div>'
          +'<div style="flex:1;min-width:0"><div style="font-size:13px;font-weight:600;color:var(--text);text-transform:capitalize">'+esc(d.model)+' · '+link(d.id,d.id)+'</div>'
          +'<div style="font-size:12px;color:#d97706;font-weight:600;margin:2px 0">'+esc(txt2)+'</div>'
          +'<div style="font-size:11px;color:var(--text-soft)">'+visTxt(d.visits)+'</div></div></div>';
        }).join('');
      } else if(snapInfo){
        html+='<div style="font-size:11px;color:var(--text-soft);margin-top:10px">Caídas día-a-día: '+esc(snapInfo)+'</div>';
      }
    }
    if(res) res.innerHTML=html;
  }catch(e){ if(res) res.innerHTML='<div style="color:#dc2626;font-size:13px;padding:8px">Error: '+esc(e.message)+'</div>'; console.error('[Promos] drops',e); }
  finally{ if(btn) btn.disabled=false; if(ld) ld.style.display='none'; }
}

// ── EDICIÓN MASIVA · DESCRIPCIÓN ─────────────────────────────────────────────
// Filtrar publicaciones (modelo/SKU/título, reusa matchCatalog) y reescribir su descripción en masa.
// ESCRIBE en ML (PUT /items/{id}/description por variante) → preview + backup + confirmación doble-clic.
// Soporta {modelo} en el texto (se reemplaza por el modelo de cada publicación). Edita TODAS las variantes
// activas que matchean. NO toca cupones ni promos — solo el texto de la descripción.
let _edPubs = [];   // publicaciones matcheadas: {key, num, fam, model, title, ids:[itemIds activos]}
let _edArm = null;
let _edField = 'desc';   // tab activo del editor masivo (para recargar su contenido al filtrar)
const _edTextOf = (tpl,model) => String(tpl).replace(/\{modelo\}/gi, model||'');
function edLink(p){ return p.fam ? ('#'+esc(p.num)) : ('<a href="https://articulo.mercadolibre.com.ar/MLA-'+String(p.num).replace(/^MLA/,'')+'" target="_blank" rel="noopener" style="color:#0ea5e9;text-decoration:none">#'+esc(p.num)+'</a>'); }
function edSelectedPubs(){ const keys=new Set(); document.querySelectorAll('.ed-chk:checked').forEach(c=>keys.add(c.getAttribute('data-key'))); return _edPubs.filter(p=>keys.has(p.key)); }
function edicionToggleAll(on){ document.querySelectorAll('.ed-chk').forEach(c=>c.checked=on); edicionSelChanged(); }
// Al cambiar la selección (tildar/destildar arriba), la sección de edición debe seguirla: re-render del tab
// activo (debounced para no re-leer en cada clic). Cada loader reconstruye desde edSelectedPubs().
let _edSelT=null;
function edicionSelChanged(){ edicionUpdateCount(); if(_edSelT) clearTimeout(_edSelT); _edSelT=setTimeout(()=>{ _edSelT=null; try{ edicionField(_edField); }catch(e){} }, 350); }
function edicionUpdateCount(){ const sel=edSelectedPubs(); const nIt=sel.reduce((a,p)=>a+p.ids.length,0); const el=document.getElementById('ed-count'); if(el) el.textContent=sel.length+'/'+_edPubs.length+' seleccionadas ('+nIt+' variantes)'; const ex=document.getElementById('ed-exec'); if(ex && !ex.disabled && !_edArm) ex.textContent='Aplicar a '+nIt+' variantes'; }
// Pastilla Premium/Clásica (tier = listing_type_id): gold_pro=Premium, gold_special=Clásica, resto=Otro.
function edTierPill(lt){ const t= lt==='gold_pro'?'Premium':(lt==='gold_special'?'Clásica':'Otro'); const c= lt==='gold_pro'?['#ede9fe','#6d28d9']:(lt==='gold_special'?['#e0f2fe','#0369a1']:['#f1f5f9','#64748b']); return '<span style="font-size:9px;font-weight:700;padding:1px 6px;border-radius:9px;background:'+c[0]+';color:'+c[1]+'">'+t+'</span>'; }
async function edicionFilter(){
  const term=(document.getElementById('ed-term')?.value||'').trim();
  const res=document.getElementById('ed-filter-result');
  if(!term){ toast('Escribí un modelo, SKU o título para filtrar','error'); return; }
  const btn=document.getElementById('ed-filter-btn'); if(btn) btn.disabled=true;
  try{
    await ensureCatalog(false); await ensureSkuMaster();
    if(!_catalog.some(it=> 'thumbnail' in it)){ if(res) res.innerHTML='<div style="font-size:12px;color:var(--text-soft)">Actualizando índice con fotos (~25s)…</div>'; await ensureCatalog(true); }
    const matched = matchCatalog(term).filter(it=>it.status==='active'||it.status==='paused');
    const map={};
    for(const it of matched){ const k=it.familyId?('fam:'+it.familyId):('id:'+it.id); const p=map[k]||(map[k]={key:k, num:it.familyId||it.id, fam:!!it.familyId, model:it.model||'', title:it.title||'', thumb:it.thumbnail||'', status:'', ids:[]}); p.ids.push(it.id); if(it.status==='active') p.status='active'; else if(p.status!=='active') p.status=it.status||'paused'; }
    _edPubs = Object.values(map);
    const pv=document.getElementById('ed-preview'); if(pv) pv.innerHTML='';
    const rep=document.getElementById('ed-report'); if(rep) rep.innerHTML='';
    const ex=document.getElementById('ed-exec'); if(ex){ ex.disabled=true; ex.textContent='Aplicar'; } _edArm=null;
    if(!_edPubs.length){ if(res) res.innerHTML='<div style="color:var(--text-soft);font-size:13px">No matcheó ninguna publicación (activa o pausada).</div>'; return; }
    // Enriquecer cada publicación con tier (Premium/Clásica), visitas y ventas 14d (por publicación = suma de sus variantes).
    if(res) res.innerHTML='<div style="font-size:12px;color:var(--text-soft)">Trayendo tier, visitas y ventas 14d…</div>';
    try{
      const allIds=_edPubs.flatMap(p=>p.ids);
      await ensureVisits(allIds); await ensureSales2w();
      const mr=await apiGet('/api/ml/items-meta?ids='+encodeURIComponent(allIds.join(',')));
      const meta=(mr&&mr.ok&&mr.meta)||{}; const sales=_sales2w||{};
      _edPubs.forEach(p=>{
        p.lt=(meta[p.ids[0]]&&meta[p.ids[0]].listingType)||'';
        p._hasVis=p.ids.some(id=>_visits[id]!=null); p._hasVen=p.ids.some(id=>sales[id]!=null);
        p.visits=p.ids.reduce((a,id)=>a+(_visits[id]!=null?_visits[id]:0),0);
        p.ventas=p.ids.reduce((a,id)=>a+(sales[id]!=null?sales[id]:0),0);
      });
    }catch(e){ console.error('[Edición] enrich pubs',e); }
    let html='<div style="display:flex;justify-content:space-between;align-items:center;margin:6px 0">'
      +'<span id="ed-count" style="font-size:12px;font-weight:600;color:var(--text)"></span>'
      +'<span style="font-size:11px"><a href="#" onclick="edicionToggleAll(true);return false" style="color:#0ea5e9;text-decoration:none">marcar todas</a> · <a href="#" onclick="edicionToggleAll(false);return false" style="color:#0ea5e9;text-decoration:none">ninguna</a></span></div>';
    html+='<div style="display:flex;flex-direction:column;gap:3px;max-height:340px;overflow:auto;border:1px solid var(--border);border-radius:8px;padding:6px">';
    html+=_edPubs.map((p,i)=>{
      const active=p.status==='active';
      return '<div style="display:flex;gap:8px;align-items:center;padding:4px 6px;border-radius:6px">'
      +'<input type="checkbox" class="ed-chk" data-key="'+esc(p.key)+'" checked onchange="edicionSelChanged()" style="width:15px;height:15px;flex-shrink:0;cursor:pointer">'
      +(p.thumb?('<img src="'+esc(p.thumb)+'" loading="lazy" style="width:40px;height:40px;object-fit:cover;border-radius:5px;flex-shrink:0;background:var(--surface2)" onerror="this.style.display=\'none\'">'):'<div style="width:40px;height:40px;border-radius:5px;background:var(--surface2);flex-shrink:0"></div>')
      +'<div style="min-width:0;flex:1">'
      +  '<div style="font-size:12px;color:var(--text);overflow:hidden;text-overflow:ellipsis;white-space:nowrap"><b style="text-transform:capitalize">'+esc(p.model||'?')+'</b> · '+edLink(p)+(p.fam&&p.ids.length>1?(' · '+p.ids.length+' var.'):'')+'</div>'
      +  '<div style="font-size:11px;color:var(--text-muted);overflow:hidden;text-overflow:ellipsis;white-space:nowrap">'+esc((p.title||'').slice(0,60))+'</div>'
      +'</div>'
      +'<div style="text-align:right;flex-shrink:0;min-width:104px;font-size:10px;color:var(--text-soft);line-height:1.6">'
      +  edTierPill(p.lt)
      +  '<div title="visitas · ventas últimos 14 días (suma de las variantes)">'+(p._hasVis?p.visits:'—')+' vis · '+(p._hasVen?p.ventas:'—')+' vtas <span style="opacity:.65">14d</span></div>'
      +'</div>'
      +'<span id="ed-badge-'+i+'" style="font-size:10px;font-weight:700;padding:1px 8px;border-radius:9px;flex-shrink:0;background:'+(active?'#dcfce7':'#fee2e2')+';color:'+(active?'#166534':'#991b1b')+'">'+(active?'Activa':'Pausada')+'</span>'
      +'<button id="ed-flip-'+i+'" onclick="edicionStatusFlip('+i+')" class="btn btn-sm" title="Pasar al estado contrario" style="flex-shrink:0'+(active?'':';background:#16a34a;color:#fff;border-color:#16a34a')+'">'+(active?'Pausar':'Activar')+'</button>'
      +'</div>';
    }).join('');
    html+='</div>';
    if(res) res.innerHTML=html;
    edicionUpdateCount();
    // Al filtrar, TODAS las secciones de abajo deben reflejar la selección nueva (no quedar con datos viejos):
    // limpio la descripción (para que precargue la de la nueva referencia) y reseteo los caches de los otros
    // tabs; cada uno se reconstruye desde la selección al mostrarse.
    const _ta=document.getElementById('ed-text'); if(_ta) _ta.value='';
    _titleRows=[]; _varsRows=[]; _varsRefId=''; _caractRefId='';
    edicionField(_edField);   // recarga el contenido del tab activo con la selección nueva
  }catch(e){ toast('Error: '+e.message,'error'); console.error('[Edición] filtrar',e); }
  finally{ if(btn) btn.disabled=false; }
}
async function edicionPreview(){
  const sel=edSelectedPubs();
  if(!sel.length){ toast('No hay publicaciones seleccionadas','error'); return; }
  const tpl=document.getElementById('ed-text')?.value||'';
  if(!tpl.trim()){ toast('Escribí la nueva descripción','error'); return; }
  const pv=document.getElementById('ed-preview'); const btn=document.getElementById('ed-preview-btn'); if(btn) btn.disabled=true;
  try{
    const sample=sel.slice(0,6);
    await ensureDescriptions(sample.map(p=>p.ids[0]));
    const nIt=sel.reduce((a,p)=>a+p.ids.length,0);
    let html='<div style="font-size:12px;font-weight:600;margin:4px 0">Vista previa — '+sel.length+' publicaciones · '+nIt+' variantes</div>';
    html+=sample.map(p=>(
      '<div style="padding:8px 10px;border:1px solid var(--border);border-radius:8px;margin-bottom:6px">'
      +'<div style="font-size:12px;font-weight:600;text-transform:capitalize">'+esc(p.model||'?')+' · #'+esc(p.num)+'</div>'
      +'<div style="font-size:11px;color:var(--text-muted);margin-top:3px"><span style="color:#dc2626">actual:</span> “'+esc((_desc&&_desc[p.ids[0]]||'(sin descripción)').slice(0,130))+'…”</div>'
      +'<div style="font-size:11px;color:var(--text);margin-top:2px"><span style="color:#16a34a">nueva:</span> “'+esc(_edTextOf(tpl,p.model).slice(0,130))+'…”</div>'
      +'</div>'
    )).join('');
    if(sel.length>sample.length) html+='<div style="font-size:11px;color:var(--text-soft)">… y '+(sel.length-sample.length)+' publicaciones más (misma plantilla)</div>';
    if(pv) pv.innerHTML=html;
    const ex=document.getElementById('ed-exec'); if(ex){ ex.disabled=false; ex.textContent='Aplicar a '+nIt+' variantes'; }
  }catch(e){ toast('Error: '+e.message,'error'); console.error('[Edición] preview',e); }
  finally{ if(btn) btn.disabled=false; }
}
async function edicionBackup(){
  const sel=edSelectedPubs();
  if(!sel.length){ toast('No hay publicaciones seleccionadas','error'); return; }
  const btn=document.getElementById('ed-backup-btn'); if(btn){ btn.disabled=true; btn.textContent='Bajando…'; }
  try{
    const ids=sel.flatMap(p=>p.ids); const out={};
    for(let i=0;i<ids.length;i+=40){ const b=ids.slice(i,i+40); const r=await apiGet('/api/ml/descriptions?full=1&ids='+encodeURIComponent(b.join(','))); if(r&&r.ok) Object.assign(out,r.descriptions||{}); if(btn) btn.textContent='Bajando… '+i+'/'+ids.length; }
    const blob=new Blob([JSON.stringify(out,null,2)],{type:'application/json'});
    const a=document.createElement('a'); a.href=URL.createObjectURL(blob); a.download='backup-descripciones-'+ids.length+'.json'; a.click(); setTimeout(()=>URL.revokeObjectURL(a.href),2000);
    toast('✓ Backup de '+Object.keys(out).length+' descripciones','success');
  }catch(e){ toast('Error: '+e.message,'error'); console.error('[Edición] backup',e); }
  finally{ if(btn){ btn.disabled=false; btn.textContent='Descargar backup actual'; } }
}
async function edicionExecute(){
  const btn=document.getElementById('ed-exec'); const rep=document.getElementById('ed-report');
  const sel=edSelectedPubs();
  if(!sel.length){ toast('No hay publicaciones seleccionadas','error'); return; }
  const tpl=document.getElementById('ed-text')?.value||'';
  if(!tpl.trim()){ toast('Escribí la nueva descripción','error'); return; }
  const items=sel.flatMap(p=>p.ids.map(id=>({id, text:_edTextOf(tpl,p.model)})));
  if(!_edArm){
    if(btn){ btn.textContent='⚠️ Confirmar — escribe en ML'; }
    if(rep) rep.innerHTML='<span style="color:#dc2626;font-weight:600">⚠️ Vas a SOBRESCRIBIR la descripción de '+items.length+' variantes REALES de ML. ¿Bajaste el backup? Apretá "Confirmar" de nuevo para escribir.</span>';
    _edArm=setTimeout(()=>{ _edArm=null; if(btn) btn.textContent='Aplicar a '+items.length+' variantes'; }, 12000);
    return;
  }
  clearTimeout(_edArm); _edArm=null;
  if(btn){ btn.disabled=true; btn.textContent='Aplicando…'; }
  if(rep) rep.innerHTML='<span style="color:var(--text-soft)">Aplicando… no cierres la pestaña.</span>';
  try{
    let offset=0, done=false, guard=0, results=[];
    while(!done && guard<300){ guard++;
      const r=await apiPost('/api/ml/edit-desc-bulk', { items, offset });
      if(!r||!r.ok) throw new Error(r&&r.error?r.error:'sin respuesta');
      results=results.concat(r.results||[]); offset=r.nextOffset; done=!!r.done;
      if(rep) rep.innerHTML='<span style="color:var(--text-soft)">Aplicando… '+results.length+'/'+items.length+'</span>';
    }
    const ok=results.filter(x=>x.ok).length, fail=results.filter(x=>!x.ok);
    const errs=[...new Set(fail.map(f=>(f.error||'').slice(0,50)))].slice(0,4);
    if(rep) rep.innerHTML='<span style="color:'+(fail.length?'#dc2626':'#16a34a')+'">✓ '+ok+' descripciones actualizadas'+(fail.length?(' · '+fail.length+' fallaron ('+errs.map(esc).join(' · ')+')'):'')+'</span>';
    toast('✓ '+ok+' actualizadas'+(fail.length?(' · '+fail.length+' fallaron'):''), fail.length?'info':'success');
    try{ localStorage.removeItem('parka_desc'); _desc=null; }catch(e){}   // la descripción cambió → invalidar cache
  }catch(e){ if(rep) rep.innerHTML='<span style="color:#dc2626">Error: '+esc(e.message)+'</span>'; toast('Error: '+e.message,'error'); console.error('[Edición] execute',e); }
  finally{ if(btn){ btn.disabled=false; btn.textContent='Aplicar'; } }
}

// --- Editor masivo · campos genéricos (Estado / Stock) ------------------------
// Selector de campo: muestra el panel elegido y marca el tab. La selección de publicaciones (arriba) se
// comparte entre todos los campos — filtrás una vez y editás lo que quieras.
function edicionField(f){
  _edField=f;
  document.querySelectorAll('.ed-fpanel').forEach(p=>{ p.style.display = (p.getAttribute('data-edfield')===f)?'':'none'; });
  document.querySelectorAll('.ed-ftab').forEach(b=>{ const on=b.getAttribute('data-edtab')===f; b.style.background=on?'#0ea5e9':''; b.style.color=on?'#fff':''; b.style.borderColor=on?'#0ea5e9':''; });
  if(f==='attr') edicionCaractLoad();
  if(f==='vars') edicionVarsRender();
  if(f==='desc') edicionDescPrefill();
  if(f==='title') edicionTitleRender();
  if(f==='grid') edicionGridRender();
  if(f==='price') edicionPriceRender();
  if(f==='offstore') edicionOffStoreRender();
}
// Descripción: pre-carga la descripción ACTUAL de la referencia (más visitas) si el textarea está vacío
// (no pisa lo que el usuario ya escribió). Podés editar y aplicar a todas (con {modelo} si hay varios).
async function edicionDescPrefill(){
  const ta=document.getElementById('ed-text'); if(!ta || ta.value.trim()) return;
  const sel=edSelectedPubs(); if(!sel.length) return;
  // Texto COMPLETO (el almacén cachea las descripciones truncadas a ~300 → para editar traemos full=1)
  try{ const ids=sel.flatMap(p=>p.ids); const refId=await edicionRefId(ids); const r=await apiGet('/api/ml/descriptions?full=1&ids='+encodeURIComponent(refId)); const d=(r&&r.ok&&r.descriptions&&r.descriptions[refId])||''; if(d && !ta.value.trim()) ta.value=d; }catch(e){}
}
// Ejecutor resumible genérico por campo (Estado/Stock) → POST /api/ml/edit-bulk (ESCRIBE en ML). Doble-clic
// para armar (ruta de escritura real), guard de modelo (manda expect={itemId:modelo}; el Worker excluye las
// publicaciones cuyo MODEL vivo ya no coincide — item_id NO estable) y reporte con excluidas/fallos.
const _edBulkArm = {};
async function edicionBulkExecute(field, value, btnId, repId, confirmMsg, extra){
  const btn=document.getElementById(btnId); const rep=document.getElementById(repId);
  const sel=edSelectedPubs();
  if(!sel.length){ toast('No hay publicaciones seleccionadas','error'); return; }
  const items=[], expect={};
  for(const p of sel){ for(const id of p.ids){ items.push({ id, value }); if(p.model) expect[id]=p.model; } }
  if(!_edBulkArm[field]){
    if(btn) btn.textContent='⚠️ Confirmar — escribe en ML';
    if(rep) rep.innerHTML='<span style="color:#dc2626;font-weight:600">⚠️ '+esc(confirmMsg)+' en '+items.length+' variantes REALES de ML. Apretá "Confirmar" de nuevo.</span>';
    _edBulkArm[field]=setTimeout(()=>{ _edBulkArm[field]=null; if(btn) btn.textContent='Aplicar'; }, 12000);
    return;
  }
  clearTimeout(_edBulkArm[field]); _edBulkArm[field]=null;
  if(btn){ btn.disabled=true; btn.textContent='Aplicando…'; }
  if(rep) rep.innerHTML='<span style="color:var(--text-soft)">Aplicando… no cierres la pestaña.</span>';
  try{
    let offset=0, done=false, guard=0, results=[];
    while(!done && guard<400){ guard++;
      const r=await apiPostEx('/api/ml/edit-bulk', { field, items, expect, offset, ...(extra||{}) });
      if(!r||!r.ok||!r.body||!r.body.ok) throw new Error((r&&r.body&&r.body.error)||('http '+(r&&r.status)));
      const b=r.body;
      results=results.concat(b.results||[]); offset=b.nextOffset; done=!!b.done;
      if(rep) rep.innerHTML='<span style="color:var(--text-soft)">Aplicando… '+results.length+'/'+items.length+'</span>';
    }
    // Un 200 de ML PUEDE traer warning "lo ignoré" (patrón documentado): esos NO son "actualizadas" limpias
    // (regla 13 — un skip no se cuenta como éxito). Los separo y muestro el texto del warning.
    const clean  =results.filter(x=>x.ok && !(x.warnings&&x.warnings.length));
    const warned =results.filter(x=>x.ok && x.warnings&&x.warnings.length);
    const guarded=results.filter(x=>x.guard);
    const fail   =results.filter(x=>!x.ok && !x.guard);
    const errs=[...new Set(fail.map(f=>(f.error||'').slice(0,50)))].slice(0,4);
    const warnTxts=[...new Set(warned.flatMap(w=>(w.warnings||[]).map(t=>String(t).slice(0,90))))].slice(0,4);
    const issue=warned.length||guarded.length||fail.length;
    let msg='<span style="color:'+(issue?'#b45309':'#16a34a')+'">✓ '+clean.length+' actualizadas';
    if(warned.length) msg+=' · ⚠ '+warned.length+' con warning de ML (puede que NO se haya aplicado)';
    if(guarded.length) msg+=' · '+guarded.length+' excluidas por guard de modelo';
    if(fail.length) msg+=' · '+fail.length+' fallaron ('+errs.map(esc).join(' · ')+')';
    msg+='</span>';
    if(warnTxts.length) msg+='<div style="color:#b45309;font-size:11px;margin-top:4px">⚠ '+warnTxts.map(esc).join('<br>⚠ ')+'</div>';
    if(rep) rep.innerHTML=msg;
    toast('✓ '+clean.length+' actualizadas'+(warned.length?(' · '+warned.length+' con warning'):'')+(fail.length?(' · '+fail.length+' fallaron'):'')+(guarded.length?(' · '+guarded.length+' excluidas'):''), issue?'info':'success');
  }catch(e){ if(rep) rep.innerHTML='<span style="color:#dc2626">Error: '+esc(e.message)+'</span>'; toast('Error: '+e.message,'error'); console.error('[Edición] bulk '+field,e); }
  finally{ if(btn){ btn.disabled=false; btn.textContent='Aplicar'; } }
}
// Estado POR PUBLICACIÓN, inline en la grilla del filtro (no es un tab): cada fila trae su badge Activa/
// Pausada y un botón para pasarla al estado contrario (doble-clic por fila). El filtro trae activas+pausadas.
const _edStArm={};
function edicionStatusPaint(i){
  const p=_edPubs[i]; if(!p) return;
  const active=p.status==='active';
  const badge=document.getElementById('ed-badge-'+i); const btn=document.getElementById('ed-flip-'+i);
  if(badge){ badge.textContent=active?'Activa':'Pausada'; badge.style.background=active?'#dcfce7':'#fee2e2'; badge.style.color=active?'#166534':'#991b1b'; }
  if(btn){ btn.disabled=false; btn.textContent=active?'Pausar':'Activar'; btn.style.background=active?'':'#16a34a'; btn.style.color=active?'':'#fff'; btn.style.borderColor=active?'':'#16a34a'; }
}
async function edicionStatusFlip(i){
  const p=_edPubs[i]; if(!p) return;
  const target=p.status==='active'?'paused':'active';
  const btn=document.getElementById('ed-flip-'+i);
  if(!_edStArm[i]){ if(btn){ btn.textContent='⚠️ Confirmar'; btn.style.background='#b45309'; btn.style.color='#fff'; btn.style.borderColor='#b45309'; } _edStArm[i]=setTimeout(()=>{ _edStArm[i]=null; edicionStatusPaint(i); }, 8000); return; }
  clearTimeout(_edStArm[i]); _edStArm[i]=null;
  if(btn){ btn.disabled=true; btn.textContent='…'; }
  try{
    const items=p.ids.map(id=>({id, value:target})); const expect={}; if(p.model) p.ids.forEach(id=>expect[id]=p.model);
    let offset=0,done=false,guard=0,res=[];
    while(!done && guard<60){ guard++; const r=await apiPostEx('/api/ml/edit-bulk',{ field:'status', items, expect, offset }); if(!r||!r.ok||!r.body||!r.body.ok) throw new Error((r&&r.body&&r.body.error)||('http '+(r&&r.status))); res=res.concat(r.body.results||[]); offset=r.body.nextOffset; done=!!r.body.done; }
    const okc=res.filter(x=>x.ok).length, guarded=res.filter(x=>x.guard).length, fail=res.filter(x=>!x.ok&&!x.guard).length;
    if(okc && !fail){ p.status=target; toast('✓ '+(target==='paused'?'Pausada':'Activada')+': '+(p.model||p.num),'success'); }
    else if(guarded && !okc){ toast('Excluida por guard de modelo (¿cambió el artículo? reindexá)','info'); }
    else { toast('No se pudo del todo ('+fail+' fallaron'+(guarded?', '+guarded+' excluidas':'')+')', fail?'error':'info'); }
  }catch(e){ toast('Error: '+e.message,'error'); console.error('[Edición] status flip',e); }
  edicionStatusPaint(i);
}
// ── Editor de CARACTERÍSTICAS (igual que ML): ficha de la categoría = tipos de widget; y arranca
// PRE-CARGADO con los valores ACTUALES de la publicación de referencia (más visitas). Tildás lo que
// querés cambiar y aplicás a TODAS las seleccionadas. Marca acotada a las marcas de Parka. Multivalor
// = coma-separado (formato values[]). "Recargar" re-lee la referencia.
const CAT_CAMPERAS='MLA109096';
const CARCT_SKIP=new Set(['VALUE_ADDED_TAX','IMPORT_DUTY']);   // fiscales — no van en Características
const CARCT_INP='width:100%;max-width:340px;padding:6px 8px;border:1px solid var(--border2);border-radius:6px;background:var(--surface);color:var(--text);font-size:12px';
const BRAND_OPTS=['Parka','Puffers','PRK Cycling Club'];   // marcas de Parka (Marca acotada a estas)
let _caractSchema=null; let _caractCurrent={}; let _caractRefId='';
// Referencia compartida (Variantes + Características): la publicación de más visitas 14d entre las seleccionadas.
async function edicionRefId(ids){ await ensureVisits(ids); let refId=ids[0], best=-1; for(const id of ids){ const v=_visits[id]; if(v!=null && v>best){ best=v; refId=id; } } return refId; }
async function edicionCaractLoad(force){
  const box=document.getElementById('ed-caract'); const head=document.getElementById('ed-caract-head'); if(!box) return;
  const sel=edSelectedPubs();
  if(!sel.length){ if(head) head.innerHTML=''; box.innerHTML='<div style="font-size:12px;color:var(--text-soft)">Filtrá y tildá publicaciones arriba; después volvé a este tab.</div>'; return; }
  box.innerHTML='<div style="font-size:12px;color:var(--text-soft)">Cargando la ficha y los valores actuales…</div>';
  try{
    if(!_caractSchema || force){ const r=await apiGet('/api/ml/cat-attributes?cat='+CAT_CAMPERAS); if(!r||!r.ok) throw new Error((r&&r.error)||'sin ficha'); _caractSchema=r.attributes||[]; }
    const ids=sel.flatMap(p=>p.ids); const refId=await edicionRefId(ids); _caractRefId=refId;
    const rv=await apiGet('/api/ml/item-variations?id='+encodeURIComponent(refId));
    _caractCurrent={};
    if(rv&&rv.ok&&Array.isArray(rv.attributes)){ for(const a of rv.attributes){ _caractCurrent[a.id]={value_name:a.value_name, values:a.values}; } }
    const refPub=sel.find(p=>p.ids.includes(refId));
    if(head) head.innerHTML='<b>Referencia:</b> <span style="text-transform:capitalize">'+esc((refPub&&refPub.model)||'?')+'</span> · '+esc(refId)+' — al aplicar escribe en las <b>'+sel.length+'</b> seleccionadas. Tildá lo que quieras cambiar.';
    edicionCaractRender();
  }catch(e){ box.innerHTML='<div style="color:#dc2626;font-size:12px">No pude cargar: '+esc(e.message)+'</div>'; }
}
function caractWidget(a){
  const wid='carct-'+a.id; const cur=_caractCurrent[a.id]||{};
  const curName=cur.value_name!=null?String(cur.value_name):''; const curVals=Array.isArray(cur.values)?cur.values:[];
  const selOpt=(v)=>' '+(String(v)===curName?'selected':'');
  if(a.id==='BRAND'){ // Marca acotada a las marcas de Parka
    return '<input list="'+wid+'-dl" id="'+wid+'" value="'+esc(curName)+'" style="'+CARCT_INP+'"><datalist id="'+wid+'-dl">'+BRAND_OPTS.map(v=>'<option value="'+esc(v)+'"></option>').join('')+'</datalist>';
  }
  if(a.multivalued){ // coma-separado, pre-cargado con los valores actuales
    return '<input type="text" id="'+wid+'" value="'+esc(curVals.join(', '))+'" placeholder="coma-separado" style="'+CARCT_INP+'">';
  }
  if(a.value_type==='boolean') return '<select id="'+wid+'" style="'+CARCT_INP+'"><option value="">—</option><option'+selOpt('Sí')+'>Sí</option><option'+selOpt('No')+'>No</option></select>';
  if(a.value_type==='list') return '<select id="'+wid+'" style="'+CARCT_INP+'"><option value="">—</option>'+(a.values||[]).map(v=>'<option'+selOpt(v.name)+'>'+esc(v.name)+'</option>').join('')+'</select>';
  if(a.value_type==='number') return '<input type="number" id="'+wid+'" step="1" value="'+esc(curName)+'" style="'+CARCT_INP+'">';
  if(a.value_type==='number_unit'){ const m=curName.match(/^([\d.,]+)\s*(.*)$/); const cn=m?m[1]:''; const cu=m?m[2].trim():''; return '<input type="number" id="'+wid+'-n" step="1" value="'+esc(cn)+'" style="width:120px;'+CARCT_INP+'"> <select id="'+wid+'-u" style="width:90px;'+CARCT_INP+'">'+(a.units||[]).map(u=>'<option'+(u===cu?' selected':'')+'>'+esc(u)+'</option>').join('')+'</select>'; }
  if((a.values||[]).length) return '<input list="'+wid+'-dl" id="'+wid+'" value="'+esc(curName)+'" placeholder="escribí o elegí" style="'+CARCT_INP+'"><datalist id="'+wid+'-dl">'+(a.values||[]).map(v=>'<option value="'+esc(v.name)+'"></option>').join('')+'</datalist>';
  return '<input type="text" id="'+wid+'" value="'+esc(curName)+'" style="'+CARCT_INP+'">';
}
function edicionCaractRender(){
  const box=document.getElementById('ed-caract'); if(!box||!_caractSchema) return;
  const vis=_caractSchema.filter(a=>!a.hidden && !a.read_only && !a.variation && !CARCT_SKIP.has(a.id) && ['string','list','boolean','number','number_unit'].includes(a.value_type));
  const row=a=>(
    '<div style="display:flex;gap:10px;align-items:center;padding:5px 2px;border-bottom:1px solid var(--border)">'
    +'<label style="display:flex;gap:6px;align-items:center;min-width:240px;cursor:pointer;font-size:12px;color:var(--text)"><input type="checkbox" class="carct-chk" data-attr="'+esc(a.id)+'" style="width:14px;height:14px;flex-shrink:0"><span><b>'+esc(a.name)+'</b>'+(a.required?' <span style="color:#dc2626;font-size:10px">req</span>':'')+(a.multivalued?' <span style="color:var(--text-soft);font-size:10px">(varios)</span>':'')+'</span></label>'
    +'<div style="flex:1;min-width:0">'+caractWidget(a)+'</div>'
    +'</div>');
  const prin=vis.filter(a=>a.required), sec=vis.filter(a=>!a.required);
  box.innerHTML='<div style="font-size:12px;font-weight:700;color:var(--text);margin:2px 0 4px">Características principales</div>'
    +prin.map(row).join('')
    +'<div style="font-size:12px;font-weight:700;color:var(--text);margin:14px 0 4px">Características secundarias</div>'
    +sec.map(row).join('');
}
function edicionCaractApply(){
  if(!_caractSchema){ toast('Cargá la referencia primero','error'); return; }
  const attrs=[];
  document.querySelectorAll('.carct-chk:checked').forEach(chk=>{
    const id=chk.getAttribute('data-attr'); const a=_caractSchema.find(x=>x.id===id); if(!a) return;
    if(a.multivalued){ const raw=String((document.getElementById('carct-'+id)||{}).value||'').split(',').map(s=>s.trim()).filter(Boolean); if(raw.length) attrs.push({ id, values: raw }); return; }
    let val='';
    if(a.value_type==='number_unit'){ const n=(document.getElementById('carct-'+id+'-n')||{}).value; const u=(document.getElementById('carct-'+id+'-u')||{}).value; if(String(n).trim()!=='') val=String(n).trim()+' '+u; }
    else { val=String((document.getElementById('carct-'+id)||{}).value||'').trim(); }
    if(val) attrs.push({ id, value_name: val });
  });
  if(!attrs.length){ toast('Tildá al menos una característica y ponele valor','error'); return; }
  const label=attrs.map(a=>a.id+'='+(a.values?('['+a.values.join(', ')+']'):('«'+a.value_name+'»'))).join(' · ');
  edicionBulkExecute('attribute', null, 'edcaract-exec', 'edcaract-report', 'Vas a setear '+attrs.length+' característica(s) — '+label, { attrs });
}

// ── Variantes y fotos EN MASA: la grilla arranca con la publicación de MÁS visitas (referencia), editás
// stock/SKU y aplicás a TODAS las seleccionadas (match por color+talle). SIEMPRE se manda el id de variación
// (no recrea → no pierde historial). Fotos/borrar-color = próximo paso. Data viva vía /api/ml/item-variations.
let _varsRows=[]; let _varsRefId=''; const _varsArm={};
let _varsPhotos={}; let _varsPicUrl={}; let _varsColors=[]; const _varsPhArm={};
let _varsAllSizes=[]; let _addColorPics=[]; let _addColorArm=null;   // agregar color: talles del modelo + fotos subidas
async function edicionVarsRender(){
  const head=document.getElementById('ed-vars-head'), det=document.getElementById('ed-vars-detail'), act=document.getElementById('ed-vars-actions'), rep=document.getElementById('ed-vars-report');
  if(rep) rep.innerHTML=''; if(act) act.style.display='none'; _varsRows=[];
  const sel=edSelectedPubs();
  if(!sel.length){ if(head) head.innerHTML=''; if(det) det.innerHTML='<div style="font-size:12px;color:var(--text-soft)">Filtrá y tildá publicaciones arriba; después volvé a este tab.</div>'; return; }
  const ids=sel.flatMap(p=>p.ids);
  if(det) det.innerHTML='<div style="font-size:12px;color:var(--text-soft)">Buscando la de más exposición…</div>';
  try{
    await ensureVisits(ids);
    let refId=ids[0], best=-1;
    for(const id of ids){ const v=_visits[id]; if(v!=null && v>best){ best=v; refId=id; } }
    _varsRefId=refId;
    const r=await apiGet('/api/ml/item-variations?id='+encodeURIComponent(refId));
    if(!r||!r.ok) throw new Error((r&&r.error)||'sin respuesta');
    const refPub=sel.find(p=>p.ids.includes(refId));
    if(head) head.innerHTML='<b>Referencia:</b> <span style="text-transform:capitalize">'+esc((refPub&&refPub.model)||'?')+'</span> · '+esc(refId)+(best>=0?(' · '+best+' visitas 14d'):'')+' — al aplicar escribe en las <b>'+sel.length+'</b> publicaciones seleccionadas (match por color+talle).';
    edicionVarsPaintEditable(r);
    if(act) act.style.display='flex';
  }catch(e){ if(det) det.innerHTML='<div style="color:#dc2626;font-size:12px">No pude cargar la referencia: '+esc(e.message)+'</div>'; }
}
function edicionVarsPaintEditable(d){
  const det=document.getElementById('ed-vars-detail'); if(!det) return;
  if(!d.hasVariations){ det.innerHTML='<div style="font-size:12px;color:var(--text-muted)">La referencia no tiene variaciones (stock top-level: '+(d.topQty!=null?d.topQty:'s/d')+').</div>'; _varsRows=[]; return; }
  _varsPicUrl={}; (d.pictures||[]).forEach(p=>{ _varsPicUrl[p.id]=p.url; });
  const byColor={};
  for(const v of d.variations){ const c=v.color||'(sin color)'; (byColor[c]||(byColor[c]=[])).push(v); }
  _varsAllSizes=[...new Set(d.variations.map(v=>v.size).filter(Boolean))];   // talles del modelo (para agregar color)
  _varsRows=[]; _varsPhotos={}; _varsColors=[];
  let html='';
  Object.keys(byColor).forEach((color,ci)=>{
    const vs=byColor[color]; _varsColors[ci]=color;
    const seen=new Set(); const pids=[]; for(const v of vs){ for(const pid of (v.pictureIds||[])){ if(!seen.has(pid)){ seen.add(pid); pids.push(String(pid)); } } }
    _varsPhotos[color]=pids;
    html+='<div style="border:1px solid var(--border);border-radius:8px;padding:10px;margin-bottom:8px">'
      +'<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px"><div style="font-size:13px;font-weight:700;text-transform:capitalize">'+esc(color)+'</div>'
      +'<button id="edv-delcolor-'+ci+'" onclick="edicionColorDelete('+ci+')" class="btn btn-sm" style="color:#dc2626;border-color:#dc2626;padding:2px 8px" title="Borrar este color entero (todas sus variantes) en las seleccionadas">Borrar color</button></div>';
    html+='<div id="edv-pics-'+ci+'">'+edicionPhotoStrip(ci)+'</div>';
    html+='<div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin:2px 0 10px">'
      +'<button id="edv-applypics-'+ci+'" onclick="edicionColorPhotoApplyAll('+ci+')" class="btn btn-sm" style="padding:2px 10px;background:#dc2626;color:#fff;border-color:#dc2626;font-weight:600">Aplicar a las seleccionadas</button>'
      +'<span style="font-size:10px;color:var(--text-soft)">pone estas fotos en TODAS las tildadas (la referencia + hermanas, mismo color)</span></div>';
    html+='<table style="width:100%;border-collapse:collapse;font-size:12px"><thead><tr style="color:var(--text-muted);text-align:left"><th style="padding:2px 8px 4px 0">Talle</th><th style="padding:2px 8px 4px 0">Stock</th><th style="padding:2px 0 4px 0">SKU</th></tr></thead><tbody>';
    for(const v of vs){ const i=_varsRows.length; _varsRows.push({color, size:v.size});
      html+='<tr><td style="padding:2px 8px 2px 0"><b>'+esc(v.size||'—')+'</b></td>'
        +'<td style="padding:2px 8px 2px 0"><input id="edv-qty-'+i+'" type="number" min="0" step="1" value="'+(v.qty!=null?v.qty:'')+'" style="width:78px;padding:3px 6px;border:1px solid var(--border2);border-radius:5px;background:var(--surface);color:var(--text);font-size:12px"></td>'
        +'<td style="padding:2px 0"><input id="edv-sku-'+i+'" type="text" value="'+esc(v.sku||'')+'" style="width:170px;padding:3px 6px;border:1px solid var(--border2);border-radius:5px;background:var(--surface);color:var(--text);font-size:11px;font-family:monospace"></td></tr>';
    }
    html+='</tbody></table></div>';
  });
  // ➕ Agregar color (a TODAS las seleccionadas): nombre + fotos subidas + stock/SKU por talle (los del modelo).
  html+='<div style="border:1px dashed var(--border2);border-radius:8px;padding:10px;margin-top:2px">'
    +'<div style="font-size:13px;font-weight:700;margin-bottom:8px">➕ Agregar color</div>'
    +'<div style="margin-bottom:8px"><input id="edac-color" placeholder="nombre del color nuevo (ej. Verde Militar)" style="width:280px;max-width:100%;padding:5px 8px;border:1px solid var(--border2);border-radius:6px;background:var(--surface);color:var(--text);font-size:12px"></div>'
    +'<div style="font-size:11px;color:var(--text-soft);margin-bottom:4px">Fotos del color nuevo:</div>'
    +'<div id="edac-pics" style="margin-bottom:8px"></div>'
    +'<table style="border-collapse:collapse;font-size:12px;margin-bottom:8px"><thead><tr style="color:var(--text-muted);text-align:left"><th style="padding:2px 10px 4px 0">Talle</th><th style="padding:2px 10px 4px 0">Stock</th><th style="padding:2px 0 4px 0">SKU</th></tr></thead><tbody>'
    +(_varsAllSizes||[]).map((sz,si)=>'<tr><td style="padding:2px 10px 2px 0"><b>'+esc(sz)+'</b></td>'
      +'<td style="padding:2px 10px 2px 0"><input id="edac-qty-'+si+'" type="number" min="0" step="1" placeholder="0" style="width:70px;padding:3px 6px;border:1px solid var(--border2);border-radius:5px;background:var(--surface);color:var(--text);font-size:12px"></td>'
      +'<td style="padding:2px 0"><input id="edac-sku-'+si+'" type="text" placeholder="SKU…" style="width:170px;padding:3px 6px;border:1px solid var(--border2);border-radius:5px;background:var(--surface);color:var(--text);font-size:11px;font-family:monospace"></td></tr>').join('')
    +'</tbody></table>'
    +'<div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap"><button id="edac-exec" onclick="edicionAddColorApply()" class="btn btn-sm" style="background:#dc2626;color:#fff;border-color:#dc2626;font-weight:600">Agregar color a las seleccionadas</button><span style="font-size:10px;color:var(--text-soft)">crea el color en TODAS las tildadas (solo los talles con datos)</span></div>'
    +'<div id="edac-report" style="font-size:12px;margin-top:8px"></div>'
    +'</div>';
  det.innerHTML=html;
  _addColorPics=[]; _addColorArm=null; edicionAddColorPaintPics();
}
function edicionAddColorPaintPics(){
  const el=document.getElementById('edac-pics'); if(!el) return;
  const tile=(p,i)=>'<div style="position:relative;width:80px;height:80px;border-radius:8px;overflow:hidden;background:var(--surface2);display:inline-block;margin:0 6px 6px 0;vertical-align:top">'+(p.url?('<img src="'+esc(p.url)+'" style="width:100%;height:100%;object-fit:cover">'):'')+'<div onclick="edicionAddColorPhotoDel('+i+')" title="quitar" style="position:absolute;top:2px;right:2px;width:18px;height:18px;border-radius:5px;background:rgba(0,0,0,.6);color:#fff;display:flex;align-items:center;justify-content:center;cursor:pointer;font-size:11px">✕</div></div>';
  const add='<div onclick="edicionAddColorPhotoAdd()" title="subir fotos" style="width:80px;height:80px;border-radius:8px;border:1.5px dashed var(--border2);display:inline-flex;flex-direction:column;align-items:center;justify-content:center;cursor:pointer;color:var(--text-soft);vertical-align:top"><div style="font-size:22px;line-height:1">+</div><div style="font-size:10px">subir</div></div>';
  el.innerHTML=(_addColorPics||[]).map(tile).join('')+add;
}
function edicionAddColorPhotoAdd(){
  const inp=document.createElement('input'); inp.type='file'; inp.accept='image/*'; inp.multiple=true;
  inp.onchange=async()=>{ const files=[...(inp.files||[])]; if(!files.length) return; toast('Subiendo '+files.length+' foto(s)…','info'); let n=0;
    for(const f of files){ try{ const fd=new FormData(); fd.append('file',f); const r=await fetch('/api/ml/upload-picture',{method:'POST',body:fd}); const d=await r.json().catch(()=>null); if(d&&d.ok&&d.id){ (_addColorPics||(_addColorPics=[])).push({id:String(d.id),url:d.url||''}); n++; edicionAddColorPaintPics(); } else toast('No pude subir una foto: '+((d&&d.error)||('http '+r.status)),'error'); }catch(e){ toast('Error subiendo: '+e.message,'error'); } }
    if(n) toast('✓ '+n+' foto(s) subidas','success'); };
  inp.click();
}
function edicionAddColorPhotoDel(i){ if(_addColorPics) _addColorPics.splice(i,1); edicionAddColorPaintPics(); }
async function edicionAddColorApply(){
  const btn=document.getElementById('edac-exec'), rep=document.getElementById('edac-report');
  const color=String((document.getElementById('edac-color')||{}).value||'').trim();
  const sel=edSelectedPubs();
  if(!color){ toast('Poné el nombre del color','error'); return; }
  if(!sel.length){ toast('No hay publicaciones tildadas','error'); return; }
  if(!(_addColorPics&&_addColorPics.length)){ toast('Subí al menos una foto del color','error'); return; }
  const sizes=[]; (_varsAllSizes||[]).forEach((sz,si)=>{ const qv=(document.getElementById('edac-qty-'+si)||{}).value; const qty=parseInt(qv,10); const sku=String((document.getElementById('edac-sku-'+si)||{}).value||'').trim(); if((qv!=='' && qty>=0) || sku){ sizes.push({ size:sz, qty:(qv!==''&&qty>=0)?qty:0, sku }); } });
  if(!sizes.length){ toast('Completá stock/SKU de al menos un talle','error'); return; }
  const items=sel.flatMap(p=>p.ids.map(id=>({id}))); const expect={}; for(const p of sel){ if(p.model) p.ids.forEach(id=>expect[id]=p.model); }
  const pictureIds=_addColorPics.map(p=>p.id);
  if(!_addColorArm){ if(btn) btn.textContent='⚠️ Confirmar — escribe en ML'; if(rep) rep.innerHTML='<span style="color:#dc2626;font-weight:600">⚠️ Vas a AGREGAR el color «'+esc(color)+'» ('+sizes.length+' talle(s)) a '+items.length+' publicación(es) REALES de ML. Apretá de nuevo.</span>'; _addColorArm=setTimeout(()=>{ _addColorArm=null; if(btn) btn.textContent='Agregar color a las seleccionadas'; },12000); return; }
  clearTimeout(_addColorArm); _addColorArm=null; if(btn){ btn.disabled=true; btn.textContent='Agregando…'; }
  if(rep) rep.innerHTML='<span style="color:var(--text-soft)">Agregando… no cierres la pestaña.</span>';
  try{
    let offset=0,done=false,g=0,res=[];
    while(!done&&g<600){ g++; const r=await apiPostEx('/api/ml/add-color-variations',{ color, sizes, pictureIds, items, expect, offset }); if(!r||!r.ok||!r.body||!r.body.ok) throw new Error((r&&r.body&&r.body.error)||('http '+(r&&r.status))); res=res.concat(r.body.results||[]); offset=r.body.nextOffset; done=!!r.body.done; if(rep) rep.innerHTML='<span style="color:var(--text-soft)">Agregando… '+res.length+'/'+items.length+'</span>'; }
    const okc=res.filter(x=>x.ok).length; const guarded=res.filter(x=>x.guard); const skipped=res.filter(x=>x.skipped&&!x.guard); const fail=res.filter(x=>!x.ok&&!x.skipped&&!x.guard);
    const errs=[...new Set([...skipped,...guarded,...fail].map(f=>esc(f.id||f.itemId||'?')+': '+(f.error||f.detail||'').slice(0,60)))].slice(0,6);
    const issue=guarded.length||skipped.length||fail.length;
    let msg='<span style="color:'+(issue?'#b45309':'#16a34a')+'">✓ color «'+esc(color)+'» agregado en '+okc+'/'+items.length+' publicación(es)';
    if(skipped.length) msg+=' · '+skipped.length+' salteadas'; if(guarded.length) msg+=' · '+guarded.length+' excluidas por guard'; if(fail.length) msg+=' · '+fail.length+' fallaron';
    msg+='</span>'; if(errs.length) msg+='<div style="color:#b45309;font-size:11px;margin-top:4px">'+errs.join('<br>')+'</div>';
    if(rep) rep.innerHTML=msg;
    toast('✓ '+okc+' con el color nuevo'+(fail.length?(' · '+fail.length+' fallaron'):''), issue?'info':'success');
  }catch(e){ if(rep) rep.innerHTML='<span style="color:#dc2626">Error: '+esc(e.message)+'</span>'; toast('Error: '+e.message,'error'); console.error('[Edición] agregar color',e); }
  finally{ if(btn){ btn.disabled=false; btn.textContent='Agregar color a las seleccionadas'; } }
}
try{Object.assign(window,{edicionAddColorPhotoAdd,edicionAddColorPhotoDel,edicionAddColorApply});}catch(e){}
// Fotos de un color (sobre la REFERENCIA): se ARRASTRAN para reordenar (la primera = portada), X al pasar
// el mouse para eliminar, y un tile "+" al final para subir nuevas. Mutan _varsPhotos[color] en memoria;
// "Guardar fotos" escribe los picture_ids en la referencia.
let _varsPhDrag=null;
function edicionPhotoStrip(ci){
  const color=_varsColors[ci]; const pids=_varsPhotos[color]||[];
  const tile=(pid,i)=>{
    const url=_varsPicUrl[pid]||'';
    return '<div draggable="true" ondragstart="edicionPhotoDragStart(event,'+ci+','+i+')" ondragover="edicionPhotoDragOver(event)" ondrop="edicionPhotoDrop(event,'+ci+','+i+')" '
      +'onmouseenter="var x=this.querySelector(\'.edv-del\');if(x)x.style.display=\'flex\'" onmouseleave="var x=this.querySelector(\'.edv-del\');if(x)x.style.display=\'none\'" '
      +'style="position:relative;width:96px;height:96px;border-radius:8px;overflow:hidden;background:var(--surface2);cursor:grab'+(i===0?';outline:2px solid #0ea5e9;outline-offset:1px':'')+'">'
      +(url?('<img src="'+esc(url)+'" loading="lazy" draggable="false" style="width:100%;height:100%;object-fit:cover;pointer-events:none">'):'')
      +(i===0?'<span style="position:absolute;bottom:0;left:0;right:0;background:rgba(0,0,0,.62);color:#fff;font-size:9px;font-weight:700;text-align:center;padding:1px 0;pointer-events:none">PORTADA</span>':'')
      +'<div class="edv-del" onclick="event.stopPropagation();edicionPhotoDelete('+ci+','+i+')" title="eliminar" style="display:none;position:absolute;top:3px;right:3px;width:20px;height:20px;border-radius:5px;background:rgba(0,0,0,.62);color:#fff;align-items:center;justify-content:center;cursor:pointer;font-size:12px">✕</div>'
      +'</div>';
  };
  const addTile='<div onclick="edicionPhotoAdd('+ci+')" title="agregar fotos" style="width:96px;height:96px;border-radius:8px;border:1.5px dashed var(--border2);display:flex;flex-direction:column;align-items:center;justify-content:center;cursor:pointer;color:var(--text-soft)"><div style="font-size:26px;line-height:1">+</div><div style="font-size:10px">agregar</div></div>';
  return '<div style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:8px">'+pids.map(tile).join('')+addTile+'</div>';
}
function _edPhRepaint(ci){ const el=document.getElementById('edv-pics-'+ci); if(el) el.innerHTML=edicionPhotoStrip(ci); }
function edicionPhotoDragStart(ev,ci,i){ _varsPhDrag={ci,i}; try{ev.dataTransfer.effectAllowed='move';}catch(e){} }
function edicionPhotoDragOver(ev){ ev.preventDefault(); try{ev.dataTransfer.dropEffect='move';}catch(e){} }
function edicionPhotoDrop(ev,ci,i){ ev.preventDefault(); if(!_varsPhDrag||_varsPhDrag.ci!==ci){ _varsPhDrag=null; return; } const from=_varsPhDrag.i; _varsPhDrag=null; if(from===i) return; const a=_varsPhotos[_varsColors[ci]]; const [x]=a.splice(from,1); a.splice(i,0,x); _edPhRepaint(ci); }
function edicionPhotoDelete(ci,i){ const c=_varsColors[ci]; const a=_varsPhotos[c]; if(a.length<=1){ toast('Tiene que quedar al menos 1 foto','error'); return; } a.splice(i,1); _edPhRepaint(ci); }
function edicionPhotoAdd(ci){
  const inp=document.createElement('input'); inp.type='file'; inp.accept='image/*'; inp.multiple=true;
  inp.onchange=async()=>{
    const files=[...(inp.files||[])]; if(!files.length) return; const color=_varsColors[ci];
    toast('Subiendo '+files.length+' foto(s)…','info'); let n=0;
    for(const f of files){ try{ const fd=new FormData(); fd.append('file',f); const r=await fetch('/api/ml/upload-picture',{method:'POST',body:fd}); const d=await r.json().catch(()=>null); if(d&&d.ok&&d.id){ _varsPicUrl[d.id]=d.url||''; (_varsPhotos[color]||(_varsPhotos[color]=[])).push(String(d.id)); n++; _edPhRepaint(ci); } else { toast('No pude subir una foto: '+((d&&d.error)||('http '+r.status)),'error'); } }catch(e){ toast('Error subiendo: '+e.message,'error'); } }
    if(n) toast('✓ '+n+' foto(s) subidas — apretá "Guardar fotos" para aplicarlas a la referencia','success');
  };
  inp.click();
}
// UN botón: pone el arreglo de fotos de ESTE color en TODAS las publicaciones tildadas. Primero lo guarda en
// la REFERENCIA (persiste reordenar/borrar/agregar sobre sus propios ids) y después lo REPLICA a las hermanas
// (copia por id → ids nuevos por pub). Resumible + guard de modelo + doble-clic + read-back.
async function edicionColorPhotoApplyAll(ci){
  const color=_varsColors[ci]; const pids=_varsPhotos[color]||[]; const btn=document.getElementById('edv-applypics-'+ci); const rep=document.getElementById('ed-vars-report');
  const sel=edSelectedPubs();
  if(!_varsRefId){ toast('No hay referencia cargada','error'); return; }
  if(!pids.length){ toast('Tiene que quedar al menos 1 foto','error'); return; }
  if(!sel.length){ toast('No hay publicaciones seleccionadas','error'); return; }
  const targetItems=[]; const expect={}; let noModel=0;
  // Hermanas SIN modelo cargado: no se escriben a ciegas (no puedo verificar identidad con el guard, y el
  // item_id no es estable) → se saltean y se avisan.
  for(const p of sel){ if(!p.model){ noModel++; continue; } for(const id of p.ids){ if(id!==_varsRefId){ targetItems.push({id}); expect[id]=p.model; } } }
  const total=1+targetItems.length;   // la referencia + las hermanas con modelo
  const key='apply'+ci;
  if(!_varsPhArm[key]){ if(btn) btn.textContent='⚠️ Confirmar — escribe en ML'; if(rep) rep.innerHTML='<span style="color:#dc2626;font-weight:600">⚠️ Vas a poner estas '+pids.length+' foto(s) del color «'+esc(color)+'» en '+total+' publicación(es) REALES de ML (la referencia + '+targetItems.length+' hermana(s)). Apretá de nuevo.</span>'; _varsPhArm[key]=setTimeout(()=>{ _varsPhArm[key]=null; if(btn) btn.textContent='Aplicar a las seleccionadas'; },12000); return; }
  clearTimeout(_varsPhArm[key]); _varsPhArm[key]=null; if(btn){ btn.disabled=true; btn.textContent='Aplicando…'; }
  if(rep) rep.innerHTML='<span style="color:var(--text-soft)">Aplicando… no cierres la pestaña.</span>';
  try{
    // 1) REFERENCIA: guardar el arreglo actual (reordenar/borrar/agregar sobre sus propios picture ids)
    let refOk=false, refErr='';
    try{ const r=await apiPostEx('/api/ml/edit-color-photos',{ itemId:_varsRefId, color, pictureIds:pids }); refOk=!!(r&&r.ok&&r.body&&r.body.ok); if(!refOk) refErr=(r&&r.body&&r.body.error)||('http '+(r&&r.status)); }catch(e){ refErr=e.message; }
    // 2) HERMANAS: replicar por id (resumible)
    let res=[];
    if(targetItems.length){
      let offset=0,done=false,guard=0;
      while(!done && guard<400){ guard++;
        const r=await apiPostEx('/api/ml/replicate-color-photos',{ refPictureIds:pids, color, items:targetItems, expect, offset });
        if(!r||!r.ok||!r.body||!r.body.ok) throw new Error((r&&r.body&&r.body.error)||('http '+(r&&r.status)));
        res=res.concat(r.body.results||[]); offset=r.body.nextOffset; done=!!r.body.done;
        if(rep) rep.innerHTML='<span style="color:var(--text-soft)">Aplicando… '+res.length+'/'+targetItems.length+' hermanas</span>';
      }
    }
    const okc=res.filter(x=>x.ok).length + (refOk?1:0);
    const guarded=res.filter(x=>x.guard);
    const skipped=res.filter(x=>x.skipped&&!x.guard);
    const fail=res.filter(x=>!x.ok&&!x.skipped&&!x.guard);
    const errList=[...(refOk?[]:[{id:_varsRefId+' (referencia)',error:refErr}]),...skipped,...guarded,...fail];
    const errs=[...new Set(errList.map(f=>esc(f.id||f.itemId||'?')+': '+(f.error||'').slice(0,70)))].slice(0,6);
    const issue=!refOk||skipped.length||guarded.length||fail.length||noModel;
    let msg='<span style="color:'+(issue?'#b45309':'#16a34a')+'">✓ fotos de «'+esc(color)+'» aplicadas en '+okc+'/'+total+' publicación(es)';
    if(noModel) msg+=' · '+noModel+' sin modelo (salteadas)';
    if(skipped.length) msg+=' · '+skipped.length+' salteadas';
    if(guarded.length) msg+=' · '+guarded.length+' excluidas por guard';
    if(fail.length||!refOk) msg+=' · '+(fail.length+(refOk?0:1))+' fallaron';
    msg+='</span>';
    if(errs.length) msg+='<div style="color:#b45309;font-size:11px;margin-top:4px">'+errs.join('<br>')+'</div>';
    if(rep) rep.innerHTML=msg;
    toast('✓ '+okc+'/'+total+' con estas fotos'+((fail.length||!refOk)?' · algunas fallaron':''), issue?'info':'success');
  }catch(e){ if(rep) rep.innerHTML='<span style="color:#dc2626">Error: '+esc(e.message)+'</span>'; toast('Error: '+e.message,'error'); console.error('[Edición] aplicar fotos',e); }
  finally{ if(btn){ btn.disabled=false; btn.textContent='Aplicar a las seleccionadas'; } }
}
async function edicionColorDelete(ci){
  const color=_varsColors[ci]; const sel=edSelectedPubs(); const btn=document.getElementById('edv-delcolor-'+ci); const rep=document.getElementById('ed-vars-report');
  if(!sel.length){ toast('No hay publicaciones seleccionadas','error'); return; }
  const key='del'+ci;
  if(!_varsPhArm[key]){ if(btn) btn.textContent='⚠️ Confirmar borrado'; if(rep) rep.innerHTML='<span style="color:#dc2626;font-weight:600">⚠️ Vas a BORRAR el color «'+esc(color)+'» (todas sus variantes) en '+sel.length+' publicaciones. Apretá de nuevo.</span>'; _varsPhArm[key]=setTimeout(()=>{ _varsPhArm[key]=null; if(btn) btn.textContent='Borrar color'; },10000); return; }
  clearTimeout(_varsPhArm[key]); _varsPhArm[key]=null; if(btn){ btn.disabled=true; btn.textContent='Borrando…'; }
  if(rep) rep.innerHTML='<span style="color:var(--text-soft)">Borrando color…</span>';
  try{
    const items=sel.flatMap(p=>p.ids.map(id=>({id}))); const expect={}; for(const p of sel){ if(p.model) p.ids.forEach(id=>expect[id]=p.model); }
    let offset=0,done=false,guard=0,res=[];
    while(!done && guard<400){ guard++; const r=await apiPostEx('/api/ml/delete-color-bulk',{ items, color, expect, offset }); if(!r||!r.ok||!r.body||!r.body.ok) throw new Error((r&&r.body&&r.body.error)||('http '+(r&&r.status))); res=res.concat(r.body.results||[]); offset=r.body.nextOffset; done=!!r.body.done; }
    const okc=res.filter(x=>x.ok).length, guarded=res.filter(x=>x.guard).length, fail=res.filter(x=>!x.ok&&!x.guard);
    const errs=[...new Set(fail.map(f=>(f.error||'').slice(0,50)))].slice(0,4);
    let msg='<span style="color:'+((fail.length||guarded)?'#b45309':'#16a34a')+'">✓ color «'+esc(color)+'» borrado en '+okc+' publicaciones';
    if(guarded) msg+=' · '+guarded+' excluidas por guard'; if(fail.length) msg+=' · '+fail.length+' no se pudo ('+errs.map(esc).join(' · ')+')';
    if(rep) rep.innerHTML=msg+'</span>';
    toast('✓ '+okc+' actualizadas'+(fail.length?(' · '+fail.length+' fallaron'):''), (fail.length||guarded)?'info':'success');
    edicionVarsRender();
  }catch(e){ if(rep) rep.innerHTML='<span style="color:#dc2626">Error: '+esc(e.message)+'</span>'; toast('Error: '+e.message,'error'); console.error('[Edición] delete color',e); }
  finally{ if(btn){ btn.disabled=false; btn.textContent='Borrar color'; } }
}
async function edicionVarsApply(kind){   // kind: 'stock' | 'sku'
  const sel=edSelectedPubs();
  if(!sel.length){ toast('No hay publicaciones seleccionadas','error'); return; }
  if(!_varsRows.length){ toast('Cargá la referencia primero','error'); return; }
  const changes=_varsRows.map((row,i)=>{
    const c={ color:row.color, size:row.size };
    if(kind==='stock'){ const q=parseInt((document.getElementById('edv-qty-'+i)||{}).value,10); if(q>=0) c.qty=q; }
    else { const s=String((document.getElementById('edv-sku-'+i)||{}).value||'').trim(); if(s) c.sku=s; }
    return c;
  }).filter(c=> kind==='stock' ? c.qty!=null : !!c.sku);
  if(!changes.length){ toast('No hay valores de '+kind+' para aplicar','error'); return; }
  const btnId=kind==='stock'?'edv-stock-btn':'edv-sku-btn'; const btn=document.getElementById(btnId); const rep=document.getElementById('ed-vars-report');
  const lbl=kind==='stock'?'Aplicar stock a las seleccionadas':'Aplicar SKU a las seleccionadas';
  const items=sel.flatMap(p=>p.ids.map(id=>({id}))); const expect={}; for(const p of sel){ if(p.model) p.ids.forEach(id=>expect[id]=p.model); }
  if(!_varsArm[kind]){
    if(btn) btn.textContent='⚠️ Confirmar — escribe en ML';
    if(rep) rep.innerHTML='<span style="color:#dc2626;font-weight:600">⚠️ Vas a escribir '+kind.toUpperCase()+' en '+changes.length+' variante(s) × '+sel.length+' publicaciones REALES de ML. Apretá de nuevo.</span>';
    _varsArm[kind]=setTimeout(()=>{ _varsArm[kind]=null; if(btn) btn.textContent=lbl; }, 12000);
    return;
  }
  clearTimeout(_varsArm[kind]); _varsArm[kind]=null;
  if(btn){ btn.disabled=true; btn.textContent='Aplicando…'; }
  if(rep) rep.innerHTML='<span style="color:var(--text-soft)">Aplicando… no cierres la pestaña.</span>';
  try{
    let offset=0,done=false,guard=0,res=[];
    while(!done && guard<400){ guard++;
      const r=await apiPostEx('/api/ml/edit-variations-bulk',{ items, changes, expect, offset });
      if(!r||!r.ok||!r.body||!r.body.ok) throw new Error((r&&r.body&&r.body.error)||('http '+(r&&r.status)));
      res=res.concat(r.body.results||[]); offset=r.body.nextOffset; done=!!r.body.done;
      if(rep) rep.innerHTML='<span style="color:var(--text-soft)">Aplicando… '+res.length+'/'+items.length+'</span>';
    }
    const okc=res.filter(x=>x.ok).length, guarded=res.filter(x=>x.guard).length, fail=res.filter(x=>!x.ok&&!x.guard);
    const errs=[...new Set(fail.map(f=>(f.error||'').slice(0,50)))].slice(0,4);
    let msg='<span style="color:'+((fail.length||guarded)?'#b45309':'#16a34a')+'">✓ '+okc+' publicaciones actualizadas ('+kind+')';
    if(guarded) msg+=' · '+guarded+' excluidas por guard';
    if(fail.length) msg+=' · '+fail.length+' fallaron ('+errs.map(esc).join(' · ')+')';
    if(rep) rep.innerHTML=msg+'</span>';
    toast('✓ '+okc+' actualizadas'+(fail.length?(' · '+fail.length+' fallaron'):'')+(guarded?(' · '+guarded+' excluidas'):''), (fail.length||guarded)?'info':'success');
  }catch(e){ if(rep) rep.innerHTML='<span style="color:#dc2626">Error: '+esc(e.message)+'</span>'; toast('Error: '+e.message,'error'); console.error('[Edición] vars apply',e); }
  finally{ if(btn){ btn.disabled=false; btn.textContent=lbl; } }
}

// --- window-expose -----------------------------------------------------------
try{window.renderPromosPanel=renderPromosPanel;}catch(e){}
try{window.promoLoad=promoLoad;}catch(e){}
try{window.promoReindex=promoReindex;}catch(e){}
try{window.promoSetAlias=promoSetAlias;}catch(e){}
try{window.promoLoadSkuMaster=promoLoadSkuMaster;}catch(e){}
try{window.promoSetSkuMaster=promoSetSkuMaster;}catch(e){}
try{window.promoCuotasPreview=promoCuotasPreview;}catch(e){}
try{window.promoCuotasExecute=promoCuotasExecute;}catch(e){}
try{window.promoRetryFailed=promoRetryFailed;}catch(e){}
try{window.promoLeaveAll=promoLeaveAll;}catch(e){}
try{window.promoStockIncong=promoStockIncong;}catch(e){}
try{window.promoTallesIncong=promoTallesIncong;}catch(e){}
try{window.promoSkuIncong=promoSkuIncong;}catch(e){}
try{window.promoStockDrops=promoStockDrops;}catch(e){}
try{window.promoDescIncong=promoDescIncong;}catch(e){}
try{window.promoPriceIncong=promoPriceIncong;}catch(e){}
try{window.promoPriceEnter=promoPriceEnter;}catch(e){}
try{window.promoPriceForce=promoPriceForce;}catch(e){}
try{window.pxTab=pxTab;}catch(e){}
try{window.promoProbe=promoProbe;}catch(e){}
try{window.promoProbeItem=promoProbeItem;}catch(e){}
try{window.promoProbeRaw=promoProbeRaw;}catch(e){}
try{window.promoFixDisc=promoFixDisc;}catch(e){}
try{window.promoJoinOpp=promoJoinOpp;}catch(e){}
try{window.promoJoinAllFree=promoJoinAllFree;}catch(e){}
try{Object.assign(window,{dealOpenPreview,dealConfirm,dealPause,dealRowCalc,sdCalc,sdApply,sdApplyAll,promoExpand,pexpCalc,pexpAll,pexpConfirm});}catch(e){}
try{window.costosMargenReal=costosMargenReal;}catch(e){}
// Compartido con la sección Maestro (columnas de costo/margen real): reusa el scan de comisión+envío
// reales de ventas (cache 24h en parka_mlcosts_v3), sin duplicar el barrido de órdenes.
try{window.ensureMlCosts=ensureMlCosts;}catch(e){}
try{window.edicionFilter=edicionFilter;}catch(e){}
try{window.edicionToggleAll=edicionToggleAll;}catch(e){}
try{window.edicionUpdateCount=edicionUpdateCount;}catch(e){}
try{window.edicionSelChanged=edicionSelChanged;}catch(e){}
try{window.edicionPreview=edicionPreview;}catch(e){}
try{window.edicionBackup=edicionBackup;}catch(e){}
try{window.edicionExecute=edicionExecute;}catch(e){}
try{window.edicionField=edicionField;}catch(e){}
try{window.edicionStatusFlip=edicionStatusFlip;}catch(e){}
try{window.edicionCaractLoad=edicionCaractLoad;}catch(e){}
try{window.edicionCaractApply=edicionCaractApply;}catch(e){}
try{window.edicionVarsRender=edicionVarsRender;}catch(e){}
try{window.edicionVarsApply=edicionVarsApply;}catch(e){}
try{Object.assign(window,{edicionPhotoDragStart,edicionPhotoDragOver,edicionPhotoDrop,edicionPhotoDelete,edicionPhotoAdd,edicionColorPhotoApplyAll,edicionColorDelete});}catch(e){}

// ── Editor de TÍTULO EN MASA: una fila por PUBLICACIÓN (MLA) de las seleccionadas, con su título VIVO
// (item_id no estable → NO confiar en el catálogo cacheado para editar el título). Editás, contador vs tope,
// y aplicás solo lo cambiado → POST /api/ml/edit-bulk field='title' (resumible + guard de modelo + read-back).
// ML puede responder 200 y NO aplicar (limitaciones con ventas) → el ejecutor lo verifica releyendo el título
// y lo marca como no-aplicado (queda manual). Tip: la palabra entra mejor si está en Tipo de prenda (Características).
const ED_TITLE_MAX = 60;
let _titleRows = [];     // [{id, model, cur, status, lt, visits, sales14}] — una por MLA (título vivo + tier + 14d)
let _titleArm = null;
let _titleTrends = null;   // keywords de las Trends de ML (categoría de las pubs seleccionadas), cache de sesión
async function edicionTitleRender(){
  const head=document.getElementById('ed-title-head'), grid=document.getElementById('ed-title-grid'), act=document.getElementById('ed-title-actions'), rep=document.getElementById('ed-title-report');
  // Preservar títulos ya tipeados (por id) para no perderlos si re-renderiza por cambio de selección.
  const _typed={}; try{ document.querySelectorAll('.ed-title-inp').forEach(inp=>{ const i=+inp.getAttribute('data-i'); const r=_titleRows[i]; if(r && String(inp.value)!==String(r.cur||'')) _typed[r.id]=inp.value; }); }catch(e){}
  if(rep) rep.innerHTML=''; if(act) act.style.display='none'; _titleRows=[]; _titleArm=null;
  const sel=edSelectedPubs();
  if(!sel.length){ if(head) head.innerHTML=''; if(grid) grid.innerHTML='<div style="font-size:12px;color:var(--text-soft)">Filtrá y tildá publicaciones arriba; después volvé a este tab.</div>'; return; }
  const rows=[]; for(const p of sel){ for(const id of p.ids){ rows.push({ id, model:p.model||'' }); } }   // el título es por MLA individual
  if(grid) grid.innerHTML='<div style="font-size:12px;color:var(--text-soft)">Trayendo títulos vivos y datos…</div>';
  try{
    const ids=rows.map(r=>r.id);
    await ensureVisits(ids); await ensureSales2w();
    const mr=await apiGet('/api/ml/items-meta?ids='+encodeURIComponent(ids.join(',')));
    const meta=(mr&&mr.ok&&mr.meta)||{};
    const sales=_sales2w||{};
    _titleRows=rows.map(r=>{ const m=meta[r.id]||{}; return { id:r.id, model:r.model, cur:String(m.title||''), status:String(m.status||''), lt:String(m.listingType||''), sales14:(sales[r.id]!=null?sales[r.id]:null), visits:(_visits[r.id]!=null?_visits[r.id]:null), gender:String(m.gender||'') }; });
    // Trends de ML por categoría (keywords reales de búsqueda) — para recomendar palabras de título. Una sola
    // llamada (todas las pubs comparten categoría de camperas); cache de sesión.
    if(_titleTrends===null){ _titleTrends=[]; try{ const cat=String((meta[rows[0].id]||{}).category||''); const tr=await apiGet('/api/ml/trends'+(cat?('?category='+encodeURIComponent(cat)):'')); if(tr&&tr.ok&&Array.isArray(tr.keywords)) _titleTrends=tr.keywords; }catch(e){} }
    const topWords=titleSuggest(_titleTrends||[], '', '', []).trendWords;   // ya viene capado a 10 en titleSuggest
    if(head) head.innerHTML='<b>'+_titleRows.length+'</b> publicación(es) — una fila por MLA. Editá el título y aplicá; se escribe <b>solo lo que cambiaste</b>.'
      +(topWords.length?('<div style="font-size:11px;color:#0369a1;margin-top:4px">🔎 Más buscadas en ML (categoría, refresco semanal): <b>'+topWords.map(esc).join(' · ')+'</b> <span style="color:var(--text-soft)">— abajo, por fila, ves cuáles le faltan a cada título.</span></div>'):'');
    edicionTitlePaint();
    // restaurar lo tipeado antes del re-render
    Object.keys(_typed).forEach(id=>{ const i=_titleRows.findIndex(r=>r.id===id); if(i>=0){ const inp=document.querySelector('.ed-title-inp[data-i="'+i+'"]'); if(inp){ inp.value=_typed[id]; edicionTitleCount(i); } } });
    if(act) act.style.display='flex';
  }catch(e){ if(grid) grid.innerHTML='<div style="color:#dc2626;font-size:12px">No pude traer los títulos: '+esc(e.message)+'</div>'; }
}
function edicionTitlePaint(){
  const grid=document.getElementById('ed-title-grid'); if(!grid) return;
  const cols='grid-template-columns:116px 58px 66px 54px 54px 1fr';
  const hdr='<div style="display:grid;'+cols+';gap:8px;font-size:10px;color:var(--text-muted);font-weight:700;padding:0 2px 4px"><div>MLA</div><div>Estado</div><div>Tipo</div><div>Vis. 14d</div><div>Vtas 14d</div><div>Título</div></div>';
  const rowH=(r,i)=>{
    const active=r.status==='active';
    const badge='<span style="font-size:9px;font-weight:700;padding:1px 6px;border-radius:9px;background:'+(active?'#dcfce7':'#fee2e2')+';color:'+(active?'#166534':'#991b1b')+'">'+(active?'Activa':'Pausada')+'</span>';
    const link='<a href="https://articulo.mercadolibre.com.ar/MLA-'+String(r.id).replace(/^MLA/,'')+'" target="_blank" rel="noopener" style="color:#0ea5e9;text-decoration:none;font-size:11px">'+esc(r.id)+'</a>';
    return '<div style="display:grid;'+cols+';gap:8px;align-items:start;padding:6px 2px;border-top:1px solid var(--border)">'
      +'<div style="min-width:0"><div>'+link+'</div><div style="font-size:10px;color:var(--text-soft);text-transform:capitalize;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">'+esc(r.model||'')+'</div></div>'
      +'<div>'+badge+'</div>'
      +'<div>'+edTierPill(r.lt)+'</div>'
      +'<div style="font-size:12px;color:var(--text)">'+(r.visits!=null?r.visits:'—')+'</div>'
      +'<div style="font-size:12px;color:var(--text)">'+(r.sales14!=null?r.sales14:'—')+'</div>'
      +'<div style="min-width:0">'
      +  '<div style="font-size:11px;color:var(--text-muted);margin-bottom:3px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="'+esc(r.cur)+'">actual: '+esc(r.cur||'—')+'</div>'
      +  '<input type="text" class="ed-title-inp" data-i="'+i+'" value="'+esc(r.cur)+'" maxlength="'+ED_TITLE_MAX+'" oninput="edicionTitleCount('+i+')" style="width:100%;padding:5px 8px;border:1px solid var(--border2);border-radius:6px;background:var(--surface);color:var(--text);font-size:12px">'
      +  '<div style="display:flex;justify-content:space-between;gap:8px"><div id="ed-title-kw-'+i+'" style="font-size:10px;color:#0369a1;min-width:0;flex:1"></div><div id="ed-title-cnt-'+i+'" style="font-size:10px;color:var(--text-soft);text-align:right;flex-shrink:0"></div></div>'
      +'</div></div>';
  };
  grid.innerHTML=hdr+_titleRows.map(rowH).join('');
  _titleRows.forEach((r,i)=>edicionTitleCount(i));
}
function edicionTitleCount(i){
  const inp=document.querySelector('.ed-title-inp[data-i="'+i+'"]'); const cnt=document.getElementById('ed-title-cnt-'+i); if(!inp||!cnt) return;
  const n=inp.value.length; const changed=inp.value.trim()!==String((_titleRows[i]&&_titleRows[i].cur)||'').trim();
  cnt.textContent=n+'/'+ED_TITLE_MAX+(changed?' · cambiado':'');
  cnt.style.color = n>=ED_TITLE_MAX ? '#dc2626' : (changed?'#0ea5e9':'var(--text-soft)');
  // Palabras trending que le faltan a ESTE título (según lo que hay tipeado ahora)
  const kwEl=document.getElementById('ed-title-kw-'+i);
  if(kwEl){ const gd=String((_titleRows[i]&&_titleRows[i].gender)||''); const miss=titleSuggest(_titleTrends||[], inp.value||'', gd, []).trendWords.slice(0,6); kwEl.innerHTML = miss.length?('faltan: '+miss.map(esc).join(', ')):''; }
}
async function edicionTitleApply(){
  const btn=document.getElementById('edt-exec'); const rep=document.getElementById('ed-title-report');
  if(!_titleRows.length){ toast('No hay publicaciones','error'); return; }
  const items=[], expect={};
  document.querySelectorAll('.ed-title-inp').forEach(inp=>{ const i=+inp.getAttribute('data-i'); const r=_titleRows[i]; if(!r) return; const v=String(inp.value||'').trim(); if(v && v!==String(r.cur||'').trim() && v.length<=ED_TITLE_MAX){ items.push({ id:r.id, value:v }); if(r.model) expect[r.id]=r.model; } });
  if(!items.length){ if(rep) rep.innerHTML='<span style="color:var(--text-soft)">No cambiaste ningún título.</span>'; toast('No hay títulos cambiados','info'); return; }
  if(!_titleArm){
    if(btn) btn.textContent='⚠️ Confirmar — escribe en ML';
    if(rep) rep.innerHTML='<span style="color:#dc2626;font-weight:600">⚠️ Vas a cambiar el título de '+items.length+' publicación(es) REALES de ML. Apretá "Confirmar" de nuevo.</span>';
    _titleArm=setTimeout(()=>{ _titleArm=null; if(btn) btn.textContent='Aplicar títulos cambiados'; },12000);
    return;
  }
  clearTimeout(_titleArm); _titleArm=null;
  if(btn){ btn.disabled=true; btn.textContent='Aplicando…'; }
  if(rep) rep.innerHTML='<span style="color:var(--text-soft)">Aplicando… no cierres la pestaña.</span>';
  try{
    let offset=0,done=false,guard=0,results=[];
    while(!done && guard<400){ guard++;
      const r=await apiPostEx('/api/ml/edit-bulk',{ field:'title', items, expect, offset });
      if(!r||!r.ok||!r.body||!r.body.ok) throw new Error((r&&r.body&&r.body.error)||('http '+(r&&r.status)));
      results=results.concat(r.body.results||[]); offset=r.body.nextOffset; done=!!r.body.done;
      if(rep) rep.innerHTML='<span style="color:var(--text-soft)">Aplicando… '+results.length+'/'+items.length+'</span>';
    }
    const clean=results.filter(x=>x.ok && !(x.warnings&&x.warnings.length));
    const warned=results.filter(x=>x.ok && x.warnings&&x.warnings.length);
    const guarded=results.filter(x=>x.guard);
    const fail=results.filter(x=>!x.ok && !x.guard);
    const errs=[...new Set(fail.map(f=>(f.error||'').slice(0,50)))].slice(0,4);
    const issue=warned.length||guarded.length||fail.length;
    let msg='<span style="color:'+(issue?'#b45309':'#16a34a')+'">✓ '+clean.length+' título(s) aplicados';
    if(warned.length) msg+=' · ⚠ '+warned.length+' ML NO aplicó (quedan manuales)';
    if(guarded.length) msg+=' · '+guarded.length+' excluidas por guard de modelo';
    if(fail.length) msg+=' · '+fail.length+' fallaron ('+errs.map(esc).join(' · ')+')';
    msg+='</span>';
    if(warned.length) msg+='<div style="color:#b45309;font-size:11px;margin-top:4px">'+warned.map(w=>'⚠ '+esc(w.id)+': '+esc((w.warnings||[]).join(' · ').slice(0,90))).join('<br>')+'</div>';
    if(fail.length) msg+='<div style="color:#dc2626;font-size:11px;margin-top:4px">'+fail.map(w=>'✗ '+esc(w.id)+': '+esc(String(w.error||'').slice(0,90))).join('<br>')+'</div>';
    if(rep) rep.innerHTML=msg;
    toast('✓ '+clean.length+' aplicados'+(warned.length?(' · '+warned.length+' no'):'')+(fail.length?(' · '+fail.length+' fallaron'):''), issue?'info':'success');
  }catch(e){ if(rep) rep.innerHTML='<span style="color:#dc2626">Error: '+esc(e.message)+'</span>'; toast('Error: '+e.message,'error'); console.error('[Edición] título',e); }
  finally{ if(btn){ btn.disabled=false; btn.textContent='Aplicar títulos cambiados'; } }
}
try{Object.assign(window,{edicionTitleRender,edicionTitleCount,edicionTitleApply});}catch(e){}

// ── Editor de GUÍA DE TALLES: asignar una guía (SPECIFIC) a las pubs tildadas. El selector se arma con los
// gridId distintos del catálogo (+ nombres). El preview usa el MISMO endpoint en dryRun (lee variaciones
// vivas, matchea SIZE↔fila EXACTO, no escribe) → dice cuáles se pueden asignar y a cuál le falta un talle.
// Aplicar = mismo endpoint sin dryRun. Guard de modelo + doble-clic + read-back (no pausa) + write_audit.
let _gridChartId=''; let _gridPrevRes=[]; let _gridArm=null; let _gridPrevT=null; let _gridChoices={};
function edicionGridPickChanged(){ if(_gridPrevT) clearTimeout(_gridPrevT); _gridPrevT=setTimeout(()=>{ _gridPrevT=null; edicionGridPreview(); },450); }
async function edicionGridRender(){
  const dl=document.getElementById('ed-grid-list'), head=document.getElementById('ed-grid-head'), pv=document.getElementById('ed-grid-preview'), act=document.getElementById('ed-grid-actions'), rep=document.getElementById('ed-grid-report');
  if(head) head.innerHTML=''; if(rep) rep.innerHTML=''; if(act) act.style.display='none';
  const sel=edSelectedPubs();
  if(!sel.length){ if(pv) pv.innerHTML='<div style="font-size:12px;color:var(--text-soft)">Filtrá y tildá publicaciones arriba; después volvé a este tab.</div>'; return; }
  try{
    await ensureCatalog(false);
    const gids=[...new Set(_catalog.filter(it=>(it.status==='active'||it.status==='paused')&&it.gridId).map(it=>String(it.gridId)))];
    await ensureChartNames(gids);
    _gridChoices={};
    if(dl) dl.innerHTML=gids.map(id=>{ const nm=_chartNames[id]||id; _gridChoices[nm]=id; return '<option value="'+esc(nm)+'"></option>'; }).join('');
    const pick=document.getElementById('ed-grid-pick');
    if(pick && pick.value){ edicionGridPreview(); return; }
    // Por defecto: la guía de la publicación MÁS IMPORTANTE (más visitas 14d) de la selección → muestra su tabla.
    const ids=sel.flatMap(p=>p.ids);
    const refId=await edicionRefId(ids);
    const refIt=_catalog.find(it=>String(it.id)===String(refId));
    const gid=refIt&&refIt.gridId?String(refIt.gridId):'';
    if(gid){ const nm=_chartNames[gid]||gid; _gridChoices[nm]=gid; if(pick) pick.value=nm; edicionGridPreview(); return; }
    if(pv) pv.innerHTML='<div style="font-size:12px;color:var(--text-soft)">La publicación de referencia (más visitas) no tiene guía asignada. Elegí una del desplegable.</div>';
  }catch(e){ if(pv) pv.innerHTML='<div style="color:#dc2626;font-size:12px">No pude armar la lista de guías: '+esc(e.message)+'</div>'; }
}
async function edicionGridPreview(){
  const pick=document.getElementById('ed-grid-pick'), head=document.getElementById('ed-grid-head'), pv=document.getElementById('ed-grid-preview'), act=document.getElementById('ed-grid-actions'), rep=document.getElementById('ed-grid-report');
  if(rep) rep.innerHTML='';
  const nm=String((pick&&pick.value)||'').trim(); const chartId=_gridChoices[nm]||'';
  _gridChartId=chartId; _gridPrevRes=[];
  if(!chartId){ if(head) head.innerHTML=''; if(act) act.style.display='none'; if(pv) pv.innerHTML='<div style="font-size:12px;color:var(--text-soft)">Elegí una guía.</div>'; return; }
  const sel=edSelectedPubs(); if(!sel.length){ if(pv) pv.innerHTML='<div style="font-size:12px;color:var(--text-soft)">No hay publicaciones tildadas.</div>'; return; }
  if(pv) pv.innerHTML='<div style="font-size:12px;color:var(--text-soft)">Leyendo la guía y las publicaciones en vivo…</div>';
  try{
    const cr=await apiGet('/api/ml/chart?id='+encodeURIComponent(chartId));
    if(!cr||!cr.ok) throw new Error((cr&&cr.error)||'no pude leer la guía');
    if(!cr.mine){ if(head) head.innerHTML='<span style="color:#dc2626">⚠️ Esa guía no es de esta cuenta.</span>'; if(act) act.style.display='none'; if(pv) pv.innerHTML=''; return; }
    if(head) head.innerHTML='Guía <b>'+esc(cr.name||chartId)+'</b> · talles: <b>'+(cr.rows||[]).map(r=>esc(r.size)).filter(Boolean).join(', ')+'</b>'+(cr.gender?(' · género '+esc(cr.gender)):'');
    const items=sel.flatMap(p=>p.ids.map(id=>({id})));
    let offset=0,done=false,guard=0,res=[];
    while(!done && guard<400){ guard++;
      const r=await apiPostEx('/api/ml/assign-size-guide',{ chartId, items, dryRun:true, offset });
      if(!r||!r.ok||!r.body||!r.body.ok) throw new Error((r&&r.body&&r.body.error)||('http '+(r&&r.status)));
      res=res.concat(r.body.results||[]); offset=r.body.nextOffset; done=!!r.body.done;
      if(pv) pv.innerHTML='<div style="font-size:12px;color:var(--text-soft)">Analizando… '+res.length+'/'+items.length+'</div>';
    }
    _gridPrevRes=res;
    const okr=res.filter(x=>x.ok&&x.dryRun);
    const rowH=r=>{ const okk=r.ok&&r.dryRun; const id=String(r.id||r.itemId||'');
      return '<div style="display:flex;gap:8px;align-items:center;padding:4px 2px;border-top:1px solid var(--border);font-size:12px">'
        +'<span style="width:16px;text-align:center;color:'+(okk?'#16a34a':'#b45309')+'">'+(okk?'✓':'✗')+'</span>'
        +'<a href="https://articulo.mercadolibre.com.ar/MLA-'+id.replace(/^MLA/,'')+'" target="_blank" rel="noopener" style="color:#0ea5e9;text-decoration:none;width:120px;flex-shrink:0">'+esc(id)+'</a>'
        +'<span style="color:'+(okk?'#16a34a':'#b45309')+'">'+(okk?('asignable · '+r.vars+' variantes'):esc(r.error||'no'))+'</span></div>'; };
    let tbl='';
    if(cr.columns&&cr.columns.length&&cr.rows&&cr.rows.length){
      tbl='<div style="margin-top:16px"><div style="font-size:12px;font-weight:600;margin:0 0 4px">Tabla de «'+esc(cr.name||chartId)+'»'+(cr.gender?(' · '+esc(cr.gender)):'')+'</div>'
        +'<div style="overflow:auto;border:1px solid var(--border);border-radius:8px"><table style="width:100%;border-collapse:collapse;font-size:12px"><thead><tr>'
        +cr.columns.map(c=>'<th style="text-align:left;padding:6px 10px;background:var(--surface2);border-bottom:1px solid var(--border);font-size:10px;text-transform:uppercase;letter-spacing:.05em;color:var(--text-muted);white-space:nowrap">'+esc(c.name)+'</th>').join('')
        +'</tr></thead><tbody>'
        +cr.rows.map(r=>'<tr>'+(r.cells||[]).map((v,i)=>'<td style="padding:6px 10px;border-bottom:1px solid var(--border2)'+(i===0?';font-weight:700':'')+'">'+esc(v)+'</td>').join('')+'</tr>').join('')
        +'</tbody></table></div></div>';
    }
    if(pv) pv.innerHTML='<div style="font-size:12px;font-weight:600;margin:2px 0 4px">'+okr.length+'/'+res.length+' asignables</div>'+res.map(rowH).join('')+tbl;
    if(act) act.style.display=okr.length?'flex':'none';
  }catch(e){ if(pv) pv.innerHTML='<div style="color:#dc2626;font-size:12px">Error: '+esc(e.message)+'</div>'; if(act) act.style.display='none'; }
}
async function edicionGridApply(){
  const btn=document.getElementById('edg-exec'), rep=document.getElementById('ed-grid-report');
  const chartId=_gridChartId; if(!chartId){ toast('Elegí una guía','error'); return; }
  const sel=edSelectedPubs(); if(!sel.length){ toast('No hay publicaciones','error'); return; }
  const okIds=new Set(_gridPrevRes.filter(x=>x.ok&&x.dryRun).map(x=>String(x.id||x.itemId)));
  const items=[], expect={};
  for(const p of sel){ for(const id of p.ids){ if(okIds.has(id)){ items.push({id}); if(p.model) expect[id]=p.model; } } }
  if(!items.length){ toast('Nada asignable — revisá el preview','error'); return; }
  if(!_gridArm){ if(btn) btn.textContent='⚠️ Confirmar — escribe en ML'; if(rep) rep.innerHTML='<span style="color:#dc2626;font-weight:600">⚠️ Vas a asignar la guía a '+items.length+' publicación(es) REALES de ML. Apretá de nuevo.</span>'; _gridArm=setTimeout(()=>{ _gridArm=null; if(btn) btn.textContent='Asignar a las seleccionadas'; },12000); return; }
  clearTimeout(_gridArm); _gridArm=null; if(btn){ btn.disabled=true; btn.textContent='Asignando…'; }
  if(rep) rep.innerHTML='<span style="color:var(--text-soft)">Asignando… no cierres la pestaña.</span>';
  try{
    let offset=0,done=false,guard=0,res=[];
    while(!done && guard<400){ guard++;
      const r=await apiPostEx('/api/ml/assign-size-guide',{ chartId, items, expect, offset });
      if(!r||!r.ok||!r.body||!r.body.ok) throw new Error((r&&r.body&&r.body.error)||('http '+(r&&r.status)));
      res=res.concat(r.body.results||[]); offset=r.body.nextOffset; done=!!r.body.done;
      if(rep) rep.innerHTML='<span style="color:var(--text-soft)">Asignando… '+res.length+'/'+items.length+'</span>';
    }
    const okc=res.filter(x=>x.ok).length;
    const guarded=res.filter(x=>x.guard);
    const skipped=res.filter(x=>x.skipped&&!x.guard);
    const fail=res.filter(x=>!x.ok&&!x.skipped&&!x.guard);
    const errs=[...new Set([...skipped,...guarded,...fail].map(f=>esc(f.id||f.itemId||'?')+': '+(f.error||f.detail||'').slice(0,70)))].slice(0,6);
    const issue=guarded.length||skipped.length||fail.length;
    let msg='<span style="color:'+(issue?'#b45309':'#16a34a')+'">✓ guía asignada en '+okc+'/'+items.length+' publicación(es)';
    if(skipped.length) msg+=' · '+skipped.length+' salteadas'; if(guarded.length) msg+=' · '+guarded.length+' excluidas por guard'; if(fail.length) msg+=' · '+fail.length+' fallaron';
    msg+='</span>'; if(errs.length) msg+='<div style="color:#b45309;font-size:11px;margin-top:4px">'+errs.join('<br>')+'</div>';
    if(rep) rep.innerHTML=msg;
    toast('✓ '+okc+' asignadas'+(fail.length?(' · '+fail.length+' fallaron'):'')+(guarded.length?(' · '+guarded.length+' excluidas'):''), issue?'info':'success');
  }catch(e){ if(rep) rep.innerHTML='<span style="color:#dc2626">Error: '+esc(e.message)+'</span>'; toast('Error: '+e.message,'error'); console.error('[Edición] asignar guía',e); }
  finally{ if(btn){ btn.disabled=false; btn.textContent='Asignar a las seleccionadas'; } }
}
try{Object.assign(window,{edicionGridRender,edicionGridPickChanged,edicionGridPreview,edicionGridApply});}catch(e){}

// ── Editor de PRECIO EN MASA (reprecio): UN precio para todas las tildadas. Por ítem: salir de promos →
// cambiar precio (item-update, guardado contra dynamic_standard_price + read-back) → reentrar (promo-bulk
// reenter con {con:descPrem, sin:descClas} del maestro por modelo). Salteo los que ya están al precio, los
// automatizados y los sin descuento en el maestro (no podría reentrar). Preview vía items-meta + maestro.
let _priceArm=null; let _pricePrevRes=[]; let _priceMaestro=null; let _pricePrevT=null;
function edicionPricePreviewDebounced(){ if(_pricePrevT) clearTimeout(_pricePrevT); _pricePrevT=setTimeout(()=>{ _pricePrevT=null; edicionPricePreview(); },500); }
async function ensurePriceMaestro(){ if(_priceMaestro) return _priceMaestro; try{ const r=await apiGet('/api/pub-master'); const d=r&&r.data?JSON.parse(r.data):null; _priceMaestro=(d&&d.models)?d:{models:{}}; }catch(e){ _priceMaestro={models:{}}; } return _priceMaestro; }
async function edicionPriceRender(){
  const pv=document.getElementById('ed-price-preview'), act=document.getElementById('ed-price-actions'), rep=document.getElementById('ed-price-report');
  if(rep) rep.innerHTML=''; if(act) act.style.display='none'; _pricePrevRes=[];
  const sel=edSelectedPubs();
  if(!sel.length){ if(pv) pv.innerHTML='<div style="font-size:12px;color:var(--text-soft)">Filtrá y tildá publicaciones arriba; después volvé a este tab.</div>'; return; }
  // Default: precios del maestro (precioPrem/precioClas) del modelo de la pub de referencia (más visitas).
  try{
    await ensurePriceMaestro();
    const ids=sel.flatMap(p=>p.ids); const refId=await edicionRefId(ids); const refPub=sel.find(p=>p.ids.includes(refId));
    const mm=refPub?(_priceMaestro.models||{})[norm(refPub.model)]:null;
    const pe=document.getElementById('ed-price-prem'), pc=document.getElementById('ed-price-clas');
    if(mm){ if(pe && !pe.value && mm.precioPrem!=null) pe.value=Math.round(mm.precioPrem); if(pc && !pc.value && mm.precioClas!=null) pc.value=Math.round(mm.precioClas); }
  }catch(e){}
  const pe=document.getElementById('ed-price-prem'), pc=document.getElementById('ed-price-clas');
  if((pe&&pe.value)||(pc&&pc.value)) edicionPricePreview();
  else if(pv) pv.innerHTML='<div style="font-size:12px;color:var(--text-soft)">Poné los precios nuevos (Premium / Clásica) para ver cuáles se van a repreciar.</div>';
}
async function edicionPricePreview(){
  const pv=document.getElementById('ed-price-preview'), act=document.getElementById('ed-price-actions'), rep=document.getElementById('ed-price-report');
  if(rep) rep.innerHTML='';
  const prem=Math.round(parseFloat((document.getElementById('ed-price-prem')||{}).value));
  const clas=Math.round(parseFloat((document.getElementById('ed-price-clas')||{}).value));
  _pricePrevRes=[];
  if(!(prem>=1000) && !(clas>=1000)){ if(act) act.style.display='none'; if(pv) pv.innerHTML='<div style="font-size:12px;color:var(--text-soft)">Poné al menos un precio válido (≥ 1000) para Premium o Clásica.</div>'; return; }
  const sel=edSelectedPubs(); if(!sel.length){ if(pv) pv.innerHTML='<div style="font-size:12px;color:var(--text-soft)">No hay publicaciones tildadas.</div>'; return; }
  if(pv) pv.innerHTML='<div style="font-size:12px;color:var(--text-soft)">Leyendo precios vivos y descuentos del maestro…</div>';
  try{
    await ensurePriceMaestro();
    const idModel={}, ids=[];
    for(const p of sel){ for(const id of p.ids){ ids.push(id); idModel[id]=p.model||''; } }
    const mr=await apiGet('/api/ml/items-meta?ids='+encodeURIComponent(ids.join(',')));
    const meta=(mr&&mr.ok&&mr.meta)||{};
    const money2=n=>'$'+Number(n).toLocaleString('es-AR');
    const rows=ids.map(id=>{
      const m=meta[id]||{}; const tier=m.listingType||''; const model=idModel[id]; const mm=(_priceMaestro.models||{})[norm(model)]||null;
      const con=mm?(mm.descPrem!=null?mm.descPrem:mm.desc):null; const sin=mm?(mm.descClas!=null?mm.descClas:mm.desc):null;
      const cur=m.price!=null?Math.round(m.price):null;
      const target = tier==='gold_pro' ? prem : (tier==='gold_special' ? clas : NaN);
      let action='reprice', reason='';
      if(m.priceAuto){ action='skip'; reason='automatización de precios de ML activa'; }
      else if(m.status && m.status!=='active'){ action='skip'; reason='pausada — no reentra promos (reactivala primero)'; }
      else if(!(target>=1000)){ action='skip'; reason = tier==='gold_pro'?'falta el precio Premium':(tier==='gold_special'?'falta el precio Clásica':'tier desconocido (ni Premium ni Clásica)'); }
      else if(cur!=null && cur===target){ action='skip'; reason='ya está a '+money2(target); }
      else if(con==null && sin==null){ action='skip'; reason='sin descuento en el maestro para «'+(model||'?')+'» (no puedo reentrar)'; }
      return { id, model, cur, target, action, reason, con, sin, tier };
    });
    _pricePrevRes=rows;
    const doIt=rows.filter(r=>r.action==='reprice');
    const rowH=r=>'<div style="display:flex;gap:8px;align-items:center;padding:4px 2px;border-top:1px solid var(--border);font-size:12px">'
      +'<span style="width:16px;text-align:center;color:'+(r.action==='reprice'?'#16a34a':'#b45309')+'">'+(r.action==='reprice'?'✓':'·')+'</span>'
      +'<a href="https://articulo.mercadolibre.com.ar/MLA-'+String(r.id).replace(/^MLA/,'')+'" target="_blank" rel="noopener" style="color:#0ea5e9;text-decoration:none;width:118px;flex-shrink:0">'+esc(r.id)+'</a>'
      +'<span style="width:110px;flex-shrink:0;text-transform:capitalize;color:var(--text-soft);overflow:hidden;text-overflow:ellipsis;white-space:nowrap">'+esc(r.model||'')+'</span>'
      +'<span style="color:'+(r.action==='reprice'?'var(--text)':'#b45309')+'">'+(r.action==='reprice'?((r.cur!=null?money2(r.cur):'?')+' → '+money2(r.target)+' · reentra '+(r.tier==='gold_pro'?('Premium '+(r.con!=null?r.con:'?')+'%'):('Clásica '+(r.sin!=null?r.sin:'?')+'%'))):('salteada — '+esc(r.reason)))+'</span></div>';
    if(pv) pv.innerHTML='<div style="font-size:12px;font-weight:600;margin:2px 0 4px">'+doIt.length+'/'+rows.length+' se van a repreciar</div>'+rows.map(rowH).join('');
    if(act) act.style.display=doIt.length?'flex':'none';
  }catch(e){ if(pv) pv.innerHTML='<div style="color:#dc2626;font-size:12px">Error: '+esc(e.message)+'</div>'; if(act) act.style.display='none'; }
}
async function edicionPriceApply(){
  const btn=document.getElementById('edp-exec'), rep=document.getElementById('ed-price-report');
  const doIt=_pricePrevRes.filter(r=>r.action==='reprice');
  if(!doIt.length){ toast('Nada para repreciar (revisá el preview)','error'); return; }
  const money2=n=>'$'+Number(n).toLocaleString('es-AR');
  const modelOf={}, targetOf={}; doIt.forEach(r=>{ modelOf[r.id]=r.model||''; targetOf[r.id]=r.target; });
  const nPrem=doIt.filter(r=>r.tier==='gold_pro').length, nClas=doIt.filter(r=>r.tier==='gold_special').length;
  const premP=(doIt.find(r=>r.tier==='gold_pro')||{}).target, clasP=(doIt.find(r=>r.tier==='gold_special')||{}).target;
  const priceLbl=[nPrem?('Premium '+money2(premP)):'', nClas?('Clásica '+money2(clasP)):''].filter(Boolean).join(' · ');
  if(!_priceArm){ if(btn) btn.textContent='⚠️ Confirmar — escribe en ML'; if(rep) rep.innerHTML='<span style="color:#dc2626;font-weight:600">⚠️ Vas a REPRECIAR '+doIt.length+' publicación(es) ('+priceLbl+') — sale de promos, cambia el precio y reentra. Mueve PLATA real. Apretá de nuevo.</span>'; _priceArm=setTimeout(()=>{ _priceArm=null; if(btn) btn.textContent='Repreciar las seleccionadas'; },12000); return; }
  clearTimeout(_priceArm); _priceArm=null; if(btn){ btn.disabled=true; btn.textContent='Repreciando…'; }
  const logL=[]; const pline=t=>{ logL.push(t); if(rep) rep.innerHTML=logL.map(x=>'<div>'+x+'</div>').join(''); };
  // agrupar por modelo (para el {con,sin} del preflight y del reenter)
  const groups={}; for(const r of doIt){ const k=norm(r.model); (groups[k]||(groups[k]={con:r.con,sin:r.sin,ids:[]})).ids.push(r.id); }
  const expectAll={}; doIt.forEach(r=>{ if(r.model) expectAll[r.id]=r.model; });
  try{
    // FASE 0 — PREFLIGHT (dryRun, NO escribe): excluye las que quedarían SIN descuento (inelegibles / % fuera de
    // banda) y las excluidas por guard de modelo, ANTES de sacarlas de promos. Reusa el preflight de promo-bulk.
    pline('0️⃣ Chequeando elegibilidad (sin escribir)…');
    const safe=new Set(); const blocked=[];
    for(const k in groups){ const grp=groups[k]; const reenter={}; if(grp.con!=null) reenter.con=grp.con; if(grp.sin!=null) reenter.sin=grp.sin;
      let off=0,done=false,g=0; while(!done&&g<800){ g++; const r=await apiPostEx('/api/ml/promo-bulk',{ itemIds:grp.ids, leaveAll:true, reenter, expect:expectAll, dryRun:true, preflight:true, offset:off }); if(!r||!r.ok||!r.body||!r.body.ok){ const tr=r&&(r.status>=500||r.status===0); if(tr&&g<790){ await new Promise(res=>setTimeout(res,1200)); continue; } throw new Error('preflight «'+k+'»: '+((r&&r.body&&r.body.error)||('http '+(r&&r.status)))); }
        (r.body.results||[]).forEach(x=>{ const id=x.itemId; if(x.guard){ blocked.push({id, why:'cambió el artículo (guard de modelo)'}); } else if(x.preflightBlocked){ const w=x.skipped&&x.skipped.find(s=>s.stage==='preflight'); blocked.push({id, why:(w&&w.why)||'quedaría sin descuento'}); } else { safe.add(id); } });
        off=r.body.nextOffset; done=!!r.body.done; } }
    const safeIds=doIt.map(r=>r.id).filter(id=>safe.has(id));
    if(blocked.length) pline('&nbsp;&nbsp;⚠ '+blocked.length+' excluida(s) para no dejarlas sin descuento: '+[...new Set(blocked.map(b=>esc(b.id)))].slice(0,5).join(', '));
    if(!safeIds.length){ pline('<b style="color:#b45309">Ninguna es segura de repreciar (quedarían sin descuento o cambiaron de artículo). No toqué nada.</b>'); toast('Nada seguro para repreciar','info'); if(btn){ btn.disabled=false; btn.textContent='Repreciar las seleccionadas'; } _priceArm=null; return; }
    pline('&nbsp;&nbsp;✓ '+safeIds.length+' seguras');
    const expectSafe={}; safeIds.forEach(id=>{ if(modelOf[id]) expectSafe[id]=modelOf[id]; });
    // FASE 1 — salir de promos (SOLO las seguras)
    pline('1️⃣ Saliendo de promos ('+safeIds.length+')…');
    { let off=0,done=false,g=0; while(!done&&g<800){ g++; const r=await apiPostEx('/api/ml/promo-bulk',{ itemIds:safeIds, leaveAll:true, expect:expectSafe, offset:off }); if(!r||!r.ok||!r.body||!r.body.ok){ const tr=r&&(r.status>=500||r.status===0); if(tr&&g<790){ await new Promise(res=>setTimeout(res,1500)); continue; } throw new Error('salida de promos: '+((r&&r.body&&r.body.error)||('http '+(r&&r.status)))); } off=r.body.nextOffset; done=!!r.body.done; } }
    pline('&nbsp;&nbsp;✓ salieron de sus promos');
    await new Promise(res=>setTimeout(res,2500));   // consistencia eventual de ML post-leave
    // FASE 2 — cambiar precio (SOLO las seguras; item-update con guard dynamic_standard_price + read-back)
    pline('2️⃣ Cambiando precio ('+priceLbl+')…');
    const priced=[]; let pFail=0, pAuto=0;
    for(const id of safeIds){
      try{
        const r=await apiPostEx('/api/ml/item-update',{ itemId:id, price:targetOf[id] });
        const steps=(r&&r.body&&r.body.steps)||[];
        const ps=steps.find(s=>s.step==='price'); const pvf=steps.find(s=>s.step==='price-verify');
        if(ps&&ps.skipped){ pAuto++; continue; }
        if(pvf&&pvf.applied){ priced.push(id); } else { pFail++; }
      }catch(e){ pFail++; }
    }
    pline('&nbsp;&nbsp;✓ '+priced.length+' con precio nuevo'+(pAuto?(' · '+pAuto+' automatizadas'):'')+(pFail?(' · '+pFail+' ML no aplicó'):''));
    // FASE 3 — reentrar TODAS las que salieron (aunque el precio no haya cambiado) para NO dejar ninguna pelada
    pline('3️⃣ Reentrando promos…');
    const reentered=new Set();
    for(const k in groups){ const grp=groups[k]; const gids=grp.ids.filter(id=>safe.has(id)); if(!gids.length) continue; const reenter={}; if(grp.con!=null) reenter.con=grp.con; if(grp.sin!=null) reenter.sin=grp.sin;
      let off=0,done=false,g=0; while(!done&&g<800){ g++; const r=await apiPostEx('/api/ml/promo-bulk',{ itemIds:gids, reenter, expect:expectSafe, offset:off }); if(!r||!r.ok||!r.body||!r.body.ok){ const tr=r&&(r.status>=500||r.status===0); if(tr&&g<790){ await new Promise(res=>setTimeout(res,1500)); continue; } throw new Error('reenter «'+k+'»: '+((r&&r.body&&r.body.error)||('http '+(r&&r.status)))); } (r.body.results||[]).forEach(x=>{ if((x.joined||[]).some(j=>j.ok!==false)) reentered.add(x.itemId); }); off=r.body.nextOffset; done=!!r.body.done; } }
    const pelada=safeIds.filter(id=>!reentered.has(id));
    pline('&nbsp;&nbsp;✓ reentraron '+reentered.size+(pelada.length?(' · <span style="color:#b45309">⚠ '+pelada.length+' sin promo (reintentá más tarde): '+pelada.slice(0,4).map(esc).join(', ')+'</span>'):''));
    pline('<b style="color:'+((pFail||pAuto||pelada.length||blocked.length)?'#b45309':'#16a34a')+'">✓ Listo: '+priced.length+' repreciadas ('+priceLbl+').</b>');
    toast('✓ '+priced.length+' repreciadas'+(pelada.length?(' · '+pelada.length+' sin promo'):'')+(blocked.length?(' · '+blocked.length+' excluidas'):''),(pFail||pAuto||pelada.length||blocked.length)?'info':'success');
    for(const id of priced){ try{ apiPost('/api/decisions',{ area:'price', subject:modelOf[id]||id, suggested:{itemId:id, price:targetOf[id]}, applied:{price:targetOf[id]}, outcome:{ok:true, reentered:reentered.has(id)}, accepted:true }); }catch(e){} }
  }catch(e){ pline('<span style="color:#dc2626">Error: '+esc(e.message)+' — el detalle de arriba muestra hasta dónde llegó; reintentá o revisá en ML.</span>'); toast('Error: '+e.message,'error'); console.error('[Edición] precio',e); }
  finally{ if(btn){ btn.disabled=false; btn.textContent='Repreciar las seleccionadas'; } }
}
try{Object.assign(window,{edicionPriceRender,edicionPricePreview,edicionPricePreviewDebounced,edicionPriceApply});}catch(e){}

// ── Editor de TIENDA OFICIAL: mover pubs entre las tiendas oficiales de la cuenta (/users/{seller}/brands).
// Pills de tiendas (default = la tienda actual de la referencia), preview vía items-meta (official_store_id),
// aplicar = PUT official_store_id por ítem (guard de modelo + read-back + doble-clic). Saltea las que ya están.
let _offStores=null; let _offTarget=''; let _offPrevRes=[]; let _offArm=null; let _offMeta={};
async function ensureOffStores(){ if(_offStores) return _offStores; try{ const r=await apiGet('/api/ml/official-stores'); _offStores=(r&&r.ok&&r.stores)?r.stores:[]; }catch(e){ _offStores=[]; } return _offStores; }
function offStoreName(id){ const s=(_offStores||[]).find(x=>x.id===String(id)); return s?s.name:(id?('#'+id):'(sin tienda)'); }
function edicionOffPaintHead(){ const head=document.getElementById('ed-off-head'); if(!head) return; head.innerHTML='<span style="font-size:12px;color:var(--text)">Mover a:</span> '+(_offStores||[]).map(s=>{ const on=s.id===_offTarget; return '<button onclick="edicionOffStorePick(\''+esc(s.id)+'\')" class="btn btn-sm" style="margin:2px 4px 2px 0;'+(on?'background:#0ea5e9;color:#fff;border-color:#0ea5e9;font-weight:700':'')+'">'+esc(s.name)+(s.status!=='active'?(' <span style="font-size:10px;opacity:.7">'+esc(s.status)+'</span>'):'')+'</button>'; }).join(''); }
async function edicionOffStoreRender(){
  const head=document.getElementById('ed-off-head'), pv=document.getElementById('ed-off-preview'), act=document.getElementById('ed-off-actions'), rep=document.getElementById('ed-off-report');
  if(rep) rep.innerHTML=''; if(act) act.style.display='none'; _offPrevRes=[];
  const sel=edSelectedPubs();
  if(!sel.length){ if(head) head.innerHTML=''; if(pv) pv.innerHTML='<div style="font-size:12px;color:var(--text-soft)">Filtrá y tildá publicaciones arriba; después volvé a este tab.</div>'; return; }
  if(pv) pv.innerHTML='<div style="font-size:12px;color:var(--text-soft)">Leyendo tiendas y publicaciones en vivo…</div>';
  try{
    await ensureOffStores();
    const ids=sel.flatMap(p=>p.ids);
    const refId=await edicionRefId(ids);
    const mr=await apiGet('/api/ml/items-meta?ids='+encodeURIComponent(ids.join(',')));
    _offMeta=(mr&&mr.ok&&mr.meta)||{};
    if(!_offTarget){ _offTarget=(_offMeta[refId]&&_offMeta[refId].officialStore)||(((_offStores||[])[0]||{}).id||''); }
    edicionOffPaintHead();
    edicionOffStorePreview();
  }catch(e){ if(pv) pv.innerHTML='<div style="color:#dc2626;font-size:12px">No pude cargar: '+esc(e.message)+'</div>'; }
}
function edicionOffStorePick(id){ _offTarget=String(id); edicionOffPaintHead(); edicionOffStorePreview(); }
function edicionOffStorePreview(){
  const pv=document.getElementById('ed-off-preview'), act=document.getElementById('ed-off-actions'), rep=document.getElementById('ed-off-report');
  if(rep) rep.innerHTML='';
  if(!_offTarget){ if(pv) pv.innerHTML='<div style="font-size:12px;color:var(--text-soft)">Elegí la tienda destino.</div>'; if(act) act.style.display='none'; return; }
  const sel=edSelectedPubs(); const ids=sel.flatMap(p=>p.ids); const idModel={}; for(const p of sel) for(const id of p.ids) idModel[id]=p.model||'';
  const rows=ids.map(id=>{ const m=_offMeta[id]||{}; const cur=m.officialStore||''; return { id, model:idModel[id], cur, already:cur===_offTarget }; });
  _offPrevRes=rows;
  const move=rows.filter(r=>!r.already);
  const rowH=r=>'<div style="display:flex;gap:8px;align-items:center;padding:4px 2px;border-top:1px solid var(--border);font-size:12px">'
    +'<span style="width:16px;text-align:center;color:'+(r.already?'#b45309':'#16a34a')+'">'+(r.already?'·':'✓')+'</span>'
    +'<a href="https://articulo.mercadolibre.com.ar/MLA-'+String(r.id).replace(/^MLA/,'')+'" target="_blank" rel="noopener" style="color:#0ea5e9;text-decoration:none;width:118px;flex-shrink:0">'+esc(r.id)+'</a>'
    +'<span style="width:110px;flex-shrink:0;text-transform:capitalize;color:var(--text-soft);overflow:hidden;text-overflow:ellipsis;white-space:nowrap">'+esc(r.model||'')+'</span>'
    +'<span style="color:'+(r.already?'#b45309':'var(--text)')+'">'+(r.already?('ya está en «'+esc(offStoreName(r.cur))+'»'):(esc(offStoreName(r.cur))+' → '+esc(offStoreName(_offTarget))))+'</span></div>';
  if(pv) pv.innerHTML='<div style="font-size:12px;font-weight:600;margin:2px 0 4px">'+move.length+'/'+rows.length+' se van a mover a «'+esc(offStoreName(_offTarget))+'»</div>'+rows.map(rowH).join('');
  if(act) act.style.display=move.length?'flex':'none';
}
async function edicionOffStoreApply(){
  const btn=document.getElementById('edoff-exec'), rep=document.getElementById('ed-off-report');
  if(!_offTarget){ toast('Elegí la tienda destino','error'); return; }
  const move=_offPrevRes.filter(r=>!r.already);
  if(!move.length){ toast('Nada para mover (revisá el preview)','error'); return; }
  const items=move.map(r=>({id:r.id})); const expect={}; move.forEach(r=>{ if(r.model) expect[r.id]=r.model; });
  const tname=offStoreName(_offTarget);
  if(!_offArm){ if(btn) btn.textContent='⚠️ Confirmar — escribe en ML'; if(rep) rep.innerHTML='<span style="color:#dc2626;font-weight:600">⚠️ Vas a mover '+move.length+' publicación(es) a «'+esc(tname)+'» (REAL). Apretá de nuevo.</span>'; _offArm=setTimeout(()=>{ _offArm=null; if(btn) btn.textContent='Mover a las seleccionadas'; },12000); return; }
  clearTimeout(_offArm); _offArm=null; if(btn){ btn.disabled=true; btn.textContent='Moviendo…'; }
  if(rep) rep.innerHTML='<span style="color:var(--text-soft)">Moviendo… no cierres la pestaña.</span>';
  try{
    let offset=0,done=false,g=0,res=[];
    while(!done&&g<600){ g++; const r=await apiPostEx('/api/ml/assign-official-store',{ storeId:_offTarget, items, expect, offset }); if(!r||!r.ok||!r.body||!r.body.ok) throw new Error((r&&r.body&&r.body.error)||('http '+(r&&r.status))); res=res.concat(r.body.results||[]); offset=r.body.nextOffset; done=!!r.body.done; if(rep) rep.innerHTML='<span style="color:var(--text-soft)">Moviendo… '+res.length+'/'+items.length+'</span>'; }
    const okc=res.filter(x=>x.ok).length; const guarded=res.filter(x=>x.guard); const skipped=res.filter(x=>x.skipped&&!x.guard); const fail=res.filter(x=>!x.ok&&!x.skipped&&!x.guard);
    const errs=[...new Set([...skipped,...guarded,...fail].map(f=>esc(f.id||f.itemId||'?')+': '+(f.error||f.detail||'').slice(0,60)))].slice(0,6);
    const issue=guarded.length||skipped.length||fail.length;
    let msg='<span style="color:'+(issue?'#b45309':'#16a34a')+'">✓ '+okc+'/'+items.length+' movidas a «'+esc(tname)+'»';
    if(guarded.length) msg+=' · '+guarded.length+' excluidas por guard'; if(fail.length) msg+=' · '+fail.length+' fallaron';
    msg+='</span>'; if(errs.length) msg+='<div style="color:#b45309;font-size:11px;margin-top:4px">'+errs.join('<br>')+'</div>';
    if(rep) rep.innerHTML=msg;
    toast('✓ '+okc+' movidas'+(fail.length?(' · '+fail.length+' fallaron'):''), issue?'info':'success');
  }catch(e){ if(rep) rep.innerHTML='<span style="color:#dc2626">Error: '+esc(e.message)+'</span>'; toast('Error: '+e.message,'error'); console.error('[Edición] tienda oficial',e); }
  finally{ if(btn){ btn.disabled=false; btn.textContent='Mover a las seleccionadas'; } }
}
try{Object.assign(window,{edicionOffStoreRender,edicionOffStorePick,edicionOffStorePreview,edicionOffStoreApply});}catch(e){}

export { renderPromosPanel }
