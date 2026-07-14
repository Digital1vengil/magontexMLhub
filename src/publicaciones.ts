// @ts-nocheck
// ── SECCIÓN PUBLICACIONES: wizard de SWAP de artículo ────────────────────────────────────────────────
// Parka REUSA publicaciones (misma MLA, otra campera adentro → hereda historial y posicionamiento). El
// wizard automatiza el flujo definido por Martin (2/7/2026):
//   1) SALIR de todas las promos de la publicación (con descuentos activos no se puede tocar el precio;
//      además bajar el precio por debajo de la oferta activa BORRA la promo — mejor salir limpio primero).
//   2) EDITAR todos los campos editables (precio por variación, SKUs, MODEL, título con intento+verificación,
//      fotos/descripción copiadas de otra publicación propia), marcando lo que ML no deje.
//   3) SETEAR el descuento nuevo: campaña PROPIA (julio) si es candidata; si no, Descuento por porcentaje.
// La data del artículo destino sale del MAESTRO EXTENDIDO (Excel: ART · SKU · Nombre Modelo · Landed cost ·
// Precio · Descuento julio) guardado en D1 (/api/pub-master). Todo con doble-clic + write_audit + decision_log.
import { toast } from './core-ui'
import { apiGet, apiPut, apiPost, apiPostEx, apiPutEx } from './api'
import { S } from './state'   // PC_PARAMS (dólar + impuestos, compartidos con la Matriz) para el margen real
import { vmlBaseCode, titleSuggest } from './util'
import { mstMarginCalc } from './mst-math'   // aritmética PURA del margen del MAESTRO (métrica 1), testeada
import { stockMode, daysOfStock, conversionRate, shipAvg } from './inventory-math'   // MODA/cobertura/conversión/flete (métricas 4-6,9)
import { returnsModelStats } from './returns-math'   // tasa + costo esperado de devolución por modelo (métricas 7-8)
import { acosLight } from './ads-math'   // semáforo ACOS <12/<18 (métrica 3)
import { garmentClimate } from './garment'
import { makeSkuModelResolver } from './sku-resolver'   // MISMO resolver SKU→modelo que Devoluciones/rsmBuild
import { getWarehouse } from './warehouse-cache'
import { SCAN_SV } from './promos'   // versión de esquema del blob de precios (fuente única en promos.ts) para el sv-gate de ensurePubPrices
import { acceptPriceBlob } from './price-blob'   // MISMO sv-gate que promos.ts (criterio único; ver price-blob.ts)

declare const XLSX: any;

let _pm = null;        // maestro extendido {models:{norm:{model,landed,price,desc,skus[]}}, cols, ts}
let _pcat = null;      // catálogo del warehouse (para buscar publicaciones)
let _sel = null;       // publicación seleccionada: {item (raw ML), promosAct:[], id}
let _julio = null;     // campaña propia activa (SELLER_CAMPAIGN started) — cache

const norm = s => String(s||'').toLowerCase().trim();
const esc = s => String(s??'').replace(/[&<>"']/g, c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const money = n => '$'+Math.round(n||0).toLocaleString('es-AR');
const normSize = s => String(s||'').toUpperCase().trim();
// Canon de TALLE: espeja SIZE_CANON del backend (index.ts) — XXL≡2XL, XXXL≡3XL, etc. Mapa chico y estable →
// copia local (a diferencia del color, grande y evolutivo, que va por /api/ml/color-map). SOLO lo usa el
// PRE-CHEQUEO de guía para no marcar un falso "talle sin fila" cuando la notación difiere; el plan real de
// keep/create lo computa el backend con su propio scanon. Si crece, mover a un endpoint compartido como el color.
const SIZE_CANON = { XXS:'XXS', XS:'XS', S:'S', M:'M', L:'L', XL:'XL', XXL:'2XL', '2XL':'2XL', XXXL:'3XL', '3XL':'3XL', XXXXL:'4XL', '4XL':'4XL', XXXXXL:'5XL', '5XL':'5XL' };
const scanon = s => { const k=String(s||'').toUpperCase().replace(/\s+/g,''); return SIZE_CANON[k]||k; };
// Mapa de color EN↔ES: FUENTE ÚNICA en el backend (`COLOR_CANON`, expuesto por /api/ml/color-map). El front
// lo trae por `ensureColorMap()` y NO lo duplica → no pueden divergir (era deuda: dos copias que se
// desalineaban). Mientras no cargó, `normColor` cae en identidad (peor caso: un color sin canonizar en el
// display hasta que llega el fetch; el write real lo canoniza el backend con la MISMA fuente).
let _colorMap = null;
async function ensureColorMap(){ if(_colorMap) return _colorMap; try{ const r=await apiGet('/api/ml/color-map'); if(r&&r.ok&&r.map) _colorMap=r.map; }catch(e){} if(!_colorMap) _colorMap={}; return _colorMap; }
const normColor = s => { const k=norm(s); return (_colorMap&&_colorMap[k])||k; };
const $ = id => document.getElementById(id);

// ── Maestro extendido ────────────────────────────────────────────────────────────────────────────────
async function pubEnsureMaster(){
  if(_pm) return _pm;
  try{ const r=await apiGet('/api/pub-master'); const d=r&&r.data?JSON.parse(r.data):null; if(d&&d.models) _pm=d; }catch(e){}
  return _pm;
}
function pubMasterFile(file){
  if(!file) return;
  const fr=new FileReader();
  fr.onload=async (ev)=>{
    try{
      const wb=XLSX.read(new Uint8Array(ev.target.result),{type:'array'});
      const rows=XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]],{defval:''});
      if(!rows.length){ toast('El Excel está vacío','error'); return; }
      // Traer el Maestro ACTUAL antes de pisarlo, para preservar la clasificación (esAbrigo/impermeabilidad/
      // abrigo/tipología) que NO viene en el Excel de carga → sin esto un re-upload la borraría.
      try{ await pubEnsureMaster(); }catch(e){}
      const prevModels=(_pm&&_pm.models)?_pm.models:{};
      const cols=Object.keys(rows[0]);
      const kSku=cols.find(c=>/sku/i.test(c));
      const kMod=cols.find(c=>/modelo|model/i.test(c));
      const kLanded=cols.find(c=>/landed|costo/i.test(c));
      const kPrice=cols.find(c=>/precio|price/i.test(c));
      // Descuento por TIER (Premium/Clásica difieren SIEMPRE en Parka) — con fallback a una columna única
      const kDescP=cols.find(c=>/desc/i.test(c)&&/prem/i.test(c));
      const kDescC=cols.find(c=>/desc/i.test(c)&&/clas/i.test(c));
      const kDesc=cols.find(c=>/desc/i.test(c)&&!/prem|clas/i.test(c));
      // Precio final por tier (calculado en el maestro) + Marca — para el cruce ML-vs-maestro
      const kPrecP=cols.find(c=>/precio|price/i.test(c)&&/prem/i.test(c));
      const kPrecC=cols.find(c=>/precio|price/i.test(c)&&/clas/i.test(c));
      const kMarca=cols.find(c=>/marca|brand/i.test(c));
      const kArt=cols.find(c=>/^art\.?$|art[íi]culo/i.test(String(c).trim()));   // código de artículo (no se usa en ML; identifica el artículo)
      if(!kSku||!kMod){ toast('Necesito al menos columnas SKU y Nombre Modelo','error'); return; }
      const models={}; const skuMap={};
      // OJO: las celdas NUMÉRICAS de XLSX llegan como number de JS (42.5) — pasarlas por el strip de
      // formato AR les arrancaba el punto decimal (42.5 → "425", ×10 silencioso en el landed → margen).
      // El strip de $ . espacios es SOLO para strings con formato AR ("$1.234,50").
      const num=v=>{ if(typeof v==='number') return isFinite(v)&&v>0?v:null;
        const n=parseFloat(String(v).replace(/[$.\s]/g,'').replace(',','.')); return isFinite(n)&&n>0?n:null; };
      rows.forEach(r=>{
        const sku=String(r[kSku]||'').trim(), mod=String(r[kMod]||'').trim();
        if(!sku||!mod) return;
        const nm=norm(mod);
        const m=models[nm]||(models[nm]={model:mod, art:null, landed:null, price:null, desc:null, descPrem:null, descClas:null, precioPrem:null, precioClas:null, marca:null, skus:[]});
        m.skus.push(sku);
        // valores por modelo: tomo el primero no-vacío de sus filas (el Excel repite por SKU)
        if(kLanded&&m.landed==null) m.landed=num(r[kLanded]);
        if(kPrice&&m.price==null) m.price=num(r[kPrice]);
        const dnum=(k)=>{ const d=parseFloat(String(r[k]).replace(',','.')); return (isFinite(d)&&d>0&&d<=90)?d:null; };
        if(kDescP&&m.descPrem==null) m.descPrem=dnum(kDescP);
        if(kDescC&&m.descClas==null) m.descClas=dnum(kDescC);
        if(kDesc&&m.desc==null) m.desc=dnum(kDesc);
        if(kPrecP&&m.precioPrem==null) m.precioPrem=num(r[kPrecP]);
        if(kPrecC&&m.precioClas==null) m.precioClas=num(r[kPrecC]);
        if(kMarca&&!m.marca){ const mv=String(r[kMarca]||'').trim(); if(mv) m.marca=mv; }
        if(kArt&&!m.art){ const av=String(r[kArt]||'').trim(); if(av) m.art=av; }
        const ks=norm(sku).replace(/\s+/g,'-').replace(/-+/g,'-').replace(/-+$/,''); if(ks) skuMap[ks]=nm;
      });
      // Preservar la clasificación por modelo (esAbrigo/imper/abrigo/tipología) del Maestro previo.
      for(const nm in models){ const pv=prevModels[nm]; if(pv){ ['esAbrigo','imper','abrigo','tipologia'].forEach(f=>{ if(pv[f]!==undefined) models[nm][f]=pv[f]; }); } }
      _pm={ models, cols:{sku:kSku,model:kMod,landed:kLanded||null,price:kPrice||null,desc:kDesc||null}, ts:Date.now() };
      apiPut('/api/pub-master',{ data: JSON.stringify(_pm) });
      apiPut('/api/sku-master',{ data: JSON.stringify(skuMap) });   // mantener el maestro clásico en sync (una sola carga)
      const withL=Object.values(models).filter(m=>m.landed!=null).length, withP=Object.values(models).filter(m=>m.price!=null).length, withD=Object.values(models).filter(m=>m.descPrem!=null||m.descClas!=null||m.desc!=null).length, withM=Object.values(models).filter(m=>m.marca).length;
      toast('✓ Maestro: '+Object.keys(models).length+' modelos ('+withL+' con landed · '+withP+' con precio · '+withD+' con descuento · '+withM+' con marca)','success');
      pubRenderMaster();
      try{ maestroRender(); }catch(e){}   // refrescar la tabla de la sección Maestro si está abierta
    }catch(e){ toast('Error leyendo Excel: '+e.message,'error'); console.error('[Pub] master',e); }
  };
  fr.readAsArrayBuffer(file);
}
function pubRenderMaster(){
  const el=$('pub-master-st'); if(!el) return;
  if(!_pm||!_pm.models){ el.innerHTML='<span style="color:#d97706">Sin maestro cargado — subí el Excel (ART · SKU · Nombre Modelo · Landed cost · Precio · Descuento).</span>'; return; }
  const ms=Object.values(_pm.models);
  el.innerHTML='<b>'+ms.length+'</b> modelos · '+ms.filter(m=>m.landed!=null).length+' con landed · '+ms.filter(m=>m.price!=null).length+' con precio · '+ms.filter(m=>m.descPrem!=null||m.descClas!=null||m.desc!=null).length+' con descuento'+(_pm.ts?(' · cargado '+new Date(_pm.ts).toLocaleDateString('es-AR')):'');
  const dl=$('pub-dest-models'); if(dl) dl.innerHTML=ms.map(m=>'<option value="'+esc(m.model)+'">').join('');
}

// ── Buscar y elegir publicación ──────────────────────────────────────────────────────────────────────
async function pubEnsureCat(){
  if(_pcat && _pcat.length) return _pcat;   // reintenta si quedó vacío: la GET del almacén (1.2MB) puede cortarse
                                            // y antes `if(_pcat)` tomaba el [] como "cargado" → quedaba clavado.
  try{ const w=await getWarehouse(); _pcat=w&&w.catalog?JSON.parse(w.catalog):[];
    // El mismo blob trae las ventas 14d por item (warehouse.sales, lo mismo que consume Promos) + su
    // antigüedad (tsSales) → las capturamos acá para no pedir /api/warehouse dos veces. La conversión solo
    // se calcula si tsSales está fresco (ver radarModelSignals).
    if(_pcat.length && _psales2w==null){ try{ _psales2w=w&&w.sales?JSON.parse(w.sales):{}; }catch(e){ _psales2w={}; } _psalesTs = w&&w.tsSales ? (Date.parse(w.tsSales)||0) : 0; }
  }catch(e){ _pcat=[]; }
  return _pcat;
}
async function pubSearch(){
  const t=String(($('pub-term')||{}).value||'').trim(); const box=$('pub-results'); if(!box) return;
  if(!t){ box.innerHTML=''; return; }
  box.innerHTML='<span class="spin" style="display:inline-block"></span>';
  // El SERVIDOR busca en el catálogo (D1) y devuelve ~30 ya rankeadas — el browser no baja el catálogo entero.
  // El modelo MANDA en el match (regla dura, resuelto server-side igual que matchCatalog).
  let hits=[]; try{ const r=await apiGet('/api/ml/pub-search?q='+encodeURIComponent(t)); hits=((r&&r.hits)||[]).slice(0,12); }catch(e){}
  const withSel=!!_sel;   // ya hay candidata elegida → el clic elige la FUENTE (artículo destino)
  box.innerHTML = hits.length ? hits.map((it,i)=>{
    const isCand=_sel&&String(it.id)===String(_sel.id);   // la candidata elegida
    const isSrc=String(_srcSel||'')===String(it.id);      // la FUENTE elegida
    const borde=isSrc?'#16a34a':(isCand?'#0ea5e9':'var(--border)');
    const bg=isSrc?'rgba(22,163,74,.06)':(isCand?'rgba(14,165,233,.06)':'transparent');
    return '<div style="display:flex;gap:8px;align-items:center;font-size:12px;padding:5px 8px;border:1px solid '+borde+';border-radius:6px;margin-bottom:3px;background:'+bg+'">'
    +'<b>'+esc(it.id)+'</b>'+(i===0?' <span style="font-size:9px;font-weight:700;padding:1px 6px;border-radius:9px;background:#fef3c7;color:#92400e">★ Recomendada</span>':'')+' <span style="text-transform:capitalize">'+esc(it.model||'—')+'</span> · '+esc(String(it.title||'').slice(0,55))+' · <span style="color:var(--text-soft)">'+esc(it.status)+' · stock '+(it.stock!=null?it.stock:'—')+' · '+(it.vis||0)+' vis · '+(it.sales||0)+' vtas 14d</span>'
    +(isSrc?'<span style="margin-left:auto;flex-shrink:0;font-size:11px;font-weight:700;color:#16a34a">✓ Fuente</span>'
      :(isCand?'<span style="margin-left:auto;flex-shrink:0;font-size:11px;font-weight:700;color:#0ea5e9">✓ Candidata</span>'
      :(withSel
        ?'<button class="btn btn-sm" style="margin-left:auto;background:#16a34a;color:#fff;border-color:#16a34a" onclick="pubSrcPick(\''+esc(it.id)+'\')">Usar como FUENTE</button>'
        :'<button class="btn btn-sm" style="margin-left:auto;background:#0ea5e9;color:#fff;border-color:#0ea5e9" onclick="pubPick(\''+esc(it.id)+'\')">Elegir para swap</button>')))
    +'</div>';
  }).join('') : '<div style="font-size:12px;color:var(--text-soft)">Sin resultados en el catálogo.</div>';
}
async function pubPick(id){
  const box=$('pub-wizard'); if(!box) return;
  box.innerHTML='<div style="font-size:12px;color:var(--text-soft)"><span class="spin" style="display:inline-block;margin-right:6px"></span>Leyendo la publicación en vivo…</div>';
  try{
    const r1=await apiGet('/api/ml/raw?path='+encodeURIComponent('/items/'+id+'?include_attributes=all'));
    const it=r1&&r1.body; if(!it||!it.id) throw new Error('no pude leer '+id);
    const r2=await apiGet('/api/ml/raw?path='+encodeURIComponent('/seller-promotions/items/'+id+'?app_version=v2'));
    const promos=Array.isArray(r2&&r2.body)?r2.body:[];
    const act=promos.filter(p=>{ const s=String(p.status||'').toLowerCase(); return (s==='started'||s==='active'||s==='pending') && !/COUPON|CUPON/i.test(p.type||''); });
    _sel={ id, item:it, promosAct:act };
    pubRenderWizard();
  }catch(e){ box.innerHTML='<div style="color:#dc2626;font-size:12px">Error: '+esc(e.message)+'</div>'; }
}

// ── SUGERIDOR DE CANDIDATAS A SWAP (SWAP v2, HITO 1 — solo lectura) ─────────────────────────────────
// Ranking = alta visibilidad × mala conversión: score = visitas14 × (convMediana − conv), sobre las pubs
// activas con tráfico mínimo. El DIAGNÓSTICO (por qué convierte mal) se calcula EN VIVO solo para el top:
// talles sin stock (énfasis color NEGRO, el más vendido), precio vs hermanas del modelo (blob de precios),
// sin descuento activo, cobertura en días. NO prescribe (principio Radar): muestra señales y Martin elige.
const SWAP_SUGG_N = 12;
let _swapSugg = null;          // {active:[], paused:[], median, salesAgeH} — data computada, se re-renderiza con filtros
let _swapSuggGender = 'Todos'; // filtro Hombre/Mujer/Todos (pedido de Martin: separar géneros)
let _swapSelId = null;         // candidata ELEGIDA (queda marcada en la lista)
const sgGender = g => { const s=norm(g); if(/mujer|fem|woman/.test(s)) return 'Mujer'; if(/homb|male|man/.test(s)) return 'Hombre'; return 'Otro'; };
function swapSuggFilter(g){ _swapSuggGender=g; swapSuggRender(); }
function swapSuggPick(id){ _swapSelId=id; swapSuggRender(); pubPick(id); const w=document.getElementById('pub-wizard'); if(w) w.scrollIntoView({behavior:'smooth'}); }
function swapSuggRender(){
  const box=$('swap-sugg-results'); if(!box||!_swapSugg) return;
  const g=_swapSuggGender;
  const gOk=x=> g==='Todos' || sgGender(x.it.gender)===g;
  const tb=t=>t==='Premium'?'<span style="font-size:9px;font-weight:700;padding:1px 6px;border-radius:9px;background:#ede9fe;color:#6d28d9">Premium</span>':(t==='Clasica'?'<span style="font-size:9px;font-weight:700;padding:1px 6px;border-radius:9px;background:#e0f2fe;color:#0369a1">Clásica</span>':'');
  const gb=x=>{ const s=sgGender(x.it.gender); return s!=='Otro'?('<span style="font-size:9px;font-weight:700;padding:1px 6px;border-radius:9px;background:var(--surface3);color:var(--text-soft)">'+s+'</span>'):''; };
  const pills='<div style="display:flex;gap:6px;margin:2px 0 10px">'+['Todos','Hombre','Mujer'].map(x=>'<button class="btn btn-sm" onclick="swapSuggFilter(\''+x+'\')" style="padding:2px 12px'+(x===g?';background:#0ea5e9;color:#fff;border-color:#0ea5e9;font-weight:700':'')+'">'+x+'</button>').join('')+'</div>';
  const row=(x,extra)=>{ const sel=_swapSelId===x.id;
    return '<div style="display:flex;gap:10px;align-items:center;padding:6px 8px;border:1px solid '+(sel?'#16a34a':'var(--border)')+';border-radius:8px'+(sel?';background:rgba(22,163,74,.06)':(x.sig&&x.sig[0]&&x.sig[0].hot?';border-left:3px solid #dc2626':''))+'">'
    +(x.it.thumbnail?('<img src="'+esc(x.it.thumbnail)+'" loading="lazy" style="width:44px;height:44px;object-fit:cover;border-radius:6px;flex-shrink:0;background:var(--surface2)">'):'<div style="width:44px;height:44px;border-radius:6px;background:var(--surface2);flex-shrink:0"></div>')
    +'<div style="min-width:0;flex:1">'
    +  '<div style="font-size:12px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap"><b style="text-transform:capitalize">'+esc(x.it.model||'?')+'</b> · <a href="https://articulo.mercadolibre.com.ar/MLA-'+x.id.replace(/^MLA/,'')+'" target="_blank" rel="noopener" style="color:#0ea5e9;text-decoration:none">'+esc(x.id)+'</a> '+tb(x.tier)+' '+gb(x)+' <span style="color:var(--text-soft)">'+extra+'</span></div>'
    +  '<div style="font-size:11px;color:var(--text-muted);margin-top:2px">'+(x.sig||[]).map(s=>esc(s.t)).join(' · ')+'</div>'
    +'</div>'
    +(sel?'<span style="flex-shrink:0;font-size:11px;font-weight:700;color:#16a34a">✓ Elegida</span>':'<button class="btn btn-sm" style="flex-shrink:0;background:#16a34a;color:#fff;border-color:#16a34a;font-weight:600" onclick="swapSuggPick(\''+esc(x.id)+'\')">Elegir para swap</button>')
    +'</div>'; };
  const act=(_swapSugg.active||[]).filter(gOk).slice(0,10);
  const pau=(_swapSugg.paused||[]).filter(gOk).slice(0,60);   // más, por prioridad (sold desc); scrollable abajo
  let h=pills;
  // Buscador directo: elegir CUALQUIER pub como candidata (por si no está en las listas de abajo).
  h+='<div style="margin:2px 0 10px"><input id="swap-sugg-search" oninput="swapSuggSearch()" placeholder="🔎 Buscar MLA o modelo y elegir directo…" style="width:100%;font-size:12px;padding:6px 8px"><div id="swap-sugg-search-res" style="margin-top:4px"></div></div>';
  h+='<div style="font-size:12px;font-weight:700;margin:0 0 4px">Activas que desperdician tráfico <span style="font-weight:400;color:var(--text-soft)">(mediana conv '+((_swapSugg.median||0)*100).toFixed(1)+'%'+(_swapSugg.salesAgeH>48?(' · ⚠ ventas de hace ~'+Math.round(_swapSugg.salesAgeH/24)+' días'):'')+(_swapSugg.visStaleCount>0?(' · <span title="Publicaciones activas excluidas del ranking porque su conteo de visitas quedó viejo (>7d) — típicamente recién reactivadas tras estar pausadas. Reentran solas cuando el barrido las refresque (≤24h).">'+_swapSugg.visStaleCount+' con visitas viejas (excluidas)</span>'):'')+')</span></div>';
  h+=act.length?('<div style="display:flex;flex-direction:column;gap:4px">'+act.map(x=>row(x,'· '+x.vis+' vis · '+x.sales+' vtas · conv '+(x.conv*100).toFixed(1)+'%')).join('')+'</div>'):'<div style="font-size:12px;color:var(--text-soft)">Nada en este filtro.</div>';
  h+='<div style="font-size:12px;font-weight:700;margin:12px 0 4px">Pausadas con historial <span style="font-weight:400;color:var(--text-soft)">(por ventas acumuladas — scrolleá para ver más)</span></div>';
  h+=pau.length?('<div style="display:flex;flex-direction:column;gap:4px;max-height:320px;overflow:auto;padding-right:4px;border:1px solid var(--border);border-radius:8px;padding:6px">'+pau.map(x=>row(x,'· '+(x.sold!=null?x.sold+' ventas históricas':'')+(x.it.stock!=null?(' · stock '+x.it.stock):''))).join('')+'</div>'):'<div style="font-size:12px;color:var(--text-soft)">Nada en este filtro.</div>';
  box.innerHTML=h;
}
// Buscador del sugeridor: encuentra cualquier pub (MLA/modelo, el modelo MANDA) y la deja elegible como candidata.
async function swapSuggSearch(){
  const t=String(($('swap-sugg-search')||{}).value||'').trim(); const box=$('swap-sugg-search-res'); if(!box) return;
  if(!t||t.length<2){ box.innerHTML=''; return; }
  box.innerHTML='<span class="spin" style="display:inline-block"></span>';
  // El SERVIDOR busca en el catálogo D1 (el browser no baja el catálogo entero); el modelo MANDA.
  let hits=[]; try{ const r=await apiGet('/api/ml/pub-search?q='+encodeURIComponent(t)); hits=((r&&r.hits)||[]).slice(0,12); }catch(e){}
  box.innerHTML=hits.length?('<div style="display:flex;flex-direction:column;gap:3px">'+hits.map(it=>{ const sel=_swapSelId===String(it.id);
    return '<div style="display:flex;gap:8px;align-items:center;font-size:11px;padding:4px 6px;border:1px solid '+(sel?'#16a34a':'var(--border)')+';border-radius:6px'+(sel?';background:rgba(22,163,74,.06)':'')+'">'
    +(it.thumbnail?('<img src="'+esc(it.thumbnail)+'" loading="lazy" style="width:30px;height:30px;object-fit:cover;border-radius:5px;flex-shrink:0">'):'')
    +'<div style="flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap"><b style="text-transform:capitalize">'+esc(it.model||'?')+'</b> · '+esc(it.id)+' <span style="color:var(--text-soft)">'+esc(it.status)+'</span></div>'
    +(sel?'<span style="flex-shrink:0;color:#16a34a;font-weight:700;font-size:10px">✓ Elegida</span>':'<button class="btn btn-sm" style="flex-shrink:0;padding:2px 8px" onclick="swapSuggPick(\''+esc(it.id)+'\')">Elegir</button>')
    +'</div>'; }).join('')+'</div>'):'<div style="font-size:11px;color:var(--text-soft)">Sin resultados en el catálogo.</div>';
}
async function swapSuggest(){
  const box=$('swap-sugg-results'), st=$('swap-sugg-st'), btn=$('swap-sugg-btn');
  if(!box) return;
  if(btn) btn.disabled=true;
  const prog=t=>{ if(st) st.textContent=t; };
  try{
    // El SERVIDOR rankea (tiene el almacén en D1) y devuelve ~15 activas + ~40 pausadas ya diagnosticadas.
    // El browser NO baja el catálogo de 1.2 MB (era el cuello + la cache frágil). Payload chico.
    prog('rankeando en el servidor…');
    const r=await apiGet('/api/ml/swap-candidates');
    if(!r||!r.ok){ box.innerHTML='<div style="font-size:12px;color:#dc2626">No pude traer las candidatas: '+esc((r&&r.error)||'error del servidor')+' <button class="btn btn-sm" onclick="swapSuggest()" style="padding:2px 10px">Reintentar</button></div>'; return; }
    _swapSugg={ active:r.active||[], paused:r.paused||[], median:r.median||0, salesAgeH:r.salesAgeH, visStaleCount:r.visStaleCount }; _swapSelId=null;
    if(!(_swapSugg.active.length||_swapSugg.paused.length)){
      box.innerHTML='<div style="font-size:12px;color:var(--text-soft)">Todavía no hay candidatas activas — las <b>visitas</b> se están precomputando en el backend (podés usar el buscador de abajo). <button class="btn btn-sm" onclick="swapSuggest()" style="padding:2px 10px">Reintentar</button></div>';
      // igual mostramos el buscador + pausadas si hay
      if(_swapSugg.paused.length) swapSuggRender();
      return;
    }
    swapSuggRender();
    prog(_swapSugg.active.length+' activas · '+_swapSugg.paused.length+' pausadas'+((r.salesAgeH!=null&&r.salesAgeH>48)?(' · ⚠ ventas de hace ~'+Math.round(r.salesAgeH/24)+'d'):''));
  }catch(e){ box.innerHTML='<div style="color:#dc2626;font-size:12px">Error: '+esc(e.message)+' <button class="btn btn-sm" onclick="swapSuggest()" style="padding:2px 10px">Reintentar</button></div>'; }
  finally{ if(btn) btn.disabled=false; }
}

// ── Wizard ───────────────────────────────────────────────────────────────────────────────────────────
function varSize(v){
  const c=(v.attribute_combinations||[]).find(a=>/size|talle/i.test(String(a.id||''))||/talle/i.test(String(a.name||'')));
  return c?(c.value_name||''):'';
}
function varSku(v){
  const a=(v.attributes||[]).find(x=>x.id==='SELLER_SKU');
  return a?(a.value_name||''):(v.seller_sku||'');
}
function pubRenderWizard(){
  const box=$('pub-wizard'); if(!box||!_sel) return;
  const it=_sel.item; const vars=it.variations||[];
  const modelAttr=((it.attributes||[]).find(a=>a.id==='MODEL')||{}).value_name||'—';
  let h='<div style="display:grid;grid-template-columns:1fr 1fr;gap:14px;align-items:start">';
  // IZQUIERDA: estado actual
  h+='<div style="border:1px solid var(--border);border-radius:8px;padding:10px">';
  h+='<div style="font-weight:700;font-size:13px;margin-bottom:6px">Publicación actual — '+esc(_sel.id)+'</div>';
  h+='<div style="font-size:12px;color:var(--text-muted)">'+esc(it.title||'')+'</div>';
  h+='<div style="font-size:12px;margin-top:4px">MODEL: <b style="text-transform:capitalize">'+esc(modelAttr)+'</b> · precio '+money(it.price)+' · '+esc(it.status)+' · '+(it.sold_quantity||0)+' vendidas</div>';
  h+='<div style="font-size:12px;margin-top:4px;color:'+(_sel.promosAct.length?'#d97706':'#16a34a')+'">'+(_sel.promosAct.length?('⚠ '+_sel.promosAct.length+' promo'+(_sel.promosAct.length===1?'':'s')+' activa'+(_sel.promosAct.length===1?'':'s')+' ('+_sel.promosAct.map(p=>esc(p.name||p.type)).join(', ')+') — el paso 1 sale de todas'):'Sin promos activas')+'</div>';
  // Detección modelo NUEVO (User Products): el swap acá NO conserva lo que lo hace valioso — ML re-crea
  // los productos (UPs viejos huérfanos, item_id nuevos = historial aparte) y Product Ads pierde la
  // familia (los ítems nuevos no entran al índice de ads → el panel no deja publicitar). Caso real:
  // familia MOSS 7846418913031059, jul-2026. Aviso fuerte, no bloqueante — la decisión es de Martin.
  const isUP = !!(it.family_name || (it.tags||[]).includes('user_product_listing'));
  if(isUP){
    h+='<div style="font-size:12px;margin-top:6px;padding:7px 9px;border:1px solid #d97706;border-radius:6px;background:rgba(217,119,6,.08);color:#b45309">'
      +'⚠️ <b>Publicación del modelo NUEVO (User Products)</b> — familia '+esc(String(it.family_id||''))+'.'
      +' En estas, el swap <b>rompe la publicidad</b> (Product Ads pierde la familia y las pubs desaparecen del panel de ads)'
      +' y el historial queda en los item_id viejos. Después del swap hay que renombrar la familia (family_name)'
      +' para que Ads la re-indexe — y ML solo lo permite <b>sin ventas</b>. Pensalo antes de ejecutar.</div>';
  }
  if(vars.length){
    h+='<table style="font-size:12px;border-collapse:collapse;margin-top:6px">'+vars.map(v=>'<tr><td style="padding:2px 10px 2px 0"><b>'+esc(varSize(v)||('var '+v.id))+'</b></td><td style="padding:2px 10px 2px 0">'+esc(varSku(v)||'sin SKU')+'</td><td style="padding:2px 0;color:var(--text-soft)">stock '+(v.available_quantity!=null?v.available_quantity:'—')+'</td></tr>').join('')+'</table>';
  }
  h+='</div>';
  // DERECHA: destino — elegís MODELO → se listan sus pubs (Recomendada primero) → elegís la FUENTE que
  // dona todo (fotos/desc/características/guía/SKU/precio/descuento, verificado contra el maestro).
  h+='<div style="border:1px solid var(--border);border-radius:8px;padding:10px">';
  h+='<div style="font-weight:700;font-size:13px;margin-bottom:6px">Artículo destino</div>';
  h+='<input type="hidden" id="pub-dest-model">';
  h+='<div id="pub-src-list" style="font-size:12px;color:var(--text-soft)">Buscá el modelo destino arriba en <b>Elegir publicación</b> (ej. «harmony») y elegí la ★ Recomendada como fuente.</div>';
  h+='<div id="pub-src-inherit" style="margin-top:8px;font-size:12px"></div>';
  h+='</div>';
  h+='</div>';
  h+='<div id="pub-precheck" style="margin-top:10px"></div>';
  // RUNNER POR BLOQUES (pestañas ejecutables por separado, en orden — checklist de estado). Reemplaza el
  // botón monolítico. Cada bloque escribe lo suyo y muestra su resultado antes de seguir al próximo.
  h+='<div style="margin-top:12px;border-top:1px dashed var(--border);padding-top:10px">';
  h+='<div style="font-size:12px;color:var(--text-muted);margin-bottom:6px">Ejecutá los bloques <b>en orden</b> (de izquierda a derecha). Cada uno queda registrado; el estado se marca acá abajo.</div>';
  h+='<div id="pub-blk-tabs" style="display:flex;gap:4px;flex-wrap:wrap"></div>';
  h+='<div id="pub-blk-body" style="margin-top:10px;border:1px solid var(--border);border-radius:8px;padding:10px"></div>';
  h+='</div>';
  box.innerHTML=h;
  pubRenderMaster();   // llena el datalist
  pubSwapTabs();
}
// ── Destino: modelo → pub FUENTE (SWAP v2, HITO 2) ──────────────────────────────────────────────────
let _srcPubs=[]; let _srcSel=null; let _pprices=null;
// Runner por bloques del swap. _swapBlk = estado por bloque ('done'|'warn'|'err'); _swapModelWritten marca si
// ya se escribió el MODEL nuevo (para el guard de los bloques que corren después); _swapClonedChart = id de la
// guía clonada (lo produce el bloque Guía, lo consume Variantes).
let _swapTab=1, _swapBlk={}, _swapModelWritten=false, _swapClonedChart=null;
let _swapColorAliases={}, _swapSizeRename={};   // aliases de color (por checkbox) + sizeRename (auto del API)
function swapParseAliases(){ return _swapColorAliases; }
// Toggle de un alias por checkbox: "tratar el color X del destino como el color Y de la fuente". Recalcula el plan.
function swapAliasToggle(tgt, src){ const k=String(tgt); if(_swapColorAliases[k]===String(src)) delete _swapColorAliases[k]; else _swapColorAliases[k]=String(src); pubSwapTab(2); }
// Sugerencia de emparejamiento: el color source más "parecido" (comparte primera palabra o substring).
function swapAliasSuggest(tgtColor, srcOnly){ const t=norm(tgtColor); const tw=t.split(/\s+/)[0]; let best=''; (srcOnly||[]).forEach(sc=>{ const s=norm(sc); if(s===t) best=best||sc; else if(t.includes(s)||s.includes(t)) best=best||sc; else if(s.split(/\s+/)[0]===tw) best=best||sc; }); return best; }
let _swapSrcAttrs=[], _swapSrcTitle='';   // atributos + título de la fuente (para el sugeridor de palabras del título)
let _swapTrends=null;   // keywords de las Trends de ML (cache por sesión de swap, por categoría del destino)
const SWAP_BLOCKS=[{n:1,key:'precio',label:'Precio y promos'},{n:2,key:'variantes',label:'Variantes y fotos'},{n:3,key:'carac',label:'Características y desc.'},{n:4,key:'guia',label:'Guía de talles'},{n:5,key:'titulo',label:'Título'},{n:6,key:'estado',label:'Estado'}];
let _swapTitle='';   // título (editable en el bloque 5; prellenado con el actual)
let _swapGarment='', _swapGarmentVid='';   // TIPO DE PRENDA (editable en el bloque 5, prellenado con el de la fuente)
function swapReset(){ _swapTab=1; _swapBlk={}; _swapModelWritten=false; _swapClonedChart=null; _swapTrends=null; _swapTitle=''; _swapGarment=''; _swapGarmentVid=''; _swapColorAliases={}; }
function swapTitleInput(v){ _swapTitle=String(v||''); }   // no re-render (mantiene foco); el contador se actualiza aparte
function swapGarmentInput(v){ _swapGarment=String(v||''); _swapGarmentVid=''; }   // si lo edita a mano, se pierde el value_id (se manda por nombre)
// El guard de modelo espera el modelo VIVO que corresponde al momento: viejo hasta que el bloque Características
// escribe el MODEL nuevo, nuevo después (así los bloques posteriores no chocan con el guard).
function swapExpect(){ const cur=((_sel&&_sel.item&&(_sel.item.attributes||[]).find(a=>a.id==='MODEL'))||{}).value_name||''; const nw=String(($('pub-dest-model')||{}).value||'').trim(); const o={}; o[_sel.id]=_swapModelWritten&&nw?nw:cur; return o; }
async function ensurePubPrices(){ if(_pprices) return _pprices; _pprices={}; try{ const w=await apiGet('/api/warehouse?part=prices'); const p=w&&w.prices?JSON.parse(w.prices):[];
  // sv-gate (MISMO helper que promos.ts — acceptPriceBlob, ver memoria ml-price-blob-sv-row0-validation): un
  // blob de esquema VIEJO no se sirve como fresco. Si no pasa el gate, dejamos _pprices vacío → el preview de
  // swap cae al descuento del maestro con su aviso visible, en vez de mostrar un sellerCost de esquema viejo.
  if(acceptPriceBlob(p,SCAN_SV)){ p.forEach(r=>{ if(r) (r.ids&&r.ids.length?r.ids:[r.num]).forEach(id=>{ _pprices[String(id)]=r; }); }); } }catch(e){} return _pprices; }
async function pubDestModelChanged(){
  const nm=String(($('pub-dest-model')||{}).value||'').trim(); const box=$('pub-src-list'); if(!box) return;
  _srcSel=null; const inh=$('pub-src-inherit'); if(inh) inh.innerHTML=''; const pc=$('pub-precheck'); if(pc) pc.innerHTML='';
  if(!nm||nm.length<3){ box.innerHTML=''; return; }
  box.innerHTML='<span class="spin" style="display:inline-block"></span>';
  await pubEnsureMaster();
  // El SERVIDOR busca por MODELO en el catálogo D1 (el atributo manda) y devuelve hits con vis+ventas; el
  // browser no baja el catálogo entero. Elegís la pub fuente y el modelo destino se deriva de ella.
  let hits=[]; try{ const r=await apiGet('/api/ml/pub-search?model='+encodeURIComponent(nm)); hits=(r&&r.hits)||[]; }catch(e){}
  hits=hits.filter(it=>(it.status==='active'||it.status==='paused') && String(it.id)!==String(_sel&&_sel.id));
  if(!hits.length){ box.innerHTML='<div style="font-size:12px;color:var(--text-soft)">Ningún modelo matchea «'+esc(nm)+'».</div>'; _srcPubs=[]; return; }
  _srcPubs=hits.map(it=>{ const id=String(it.id); return { it, id, vis:it.vis||0, sales:it.sales||0, score:(it.sales||0)*50+(it.vis||0) }; }).sort((a,b)=>b.score-a.score);
  pubSrcRender();
}
function pubSrcRender(){
  const box=$('pub-src-list'); if(!box) return;
  box.innerHTML='<div style="font-size:11px;color:var(--text-muted);margin-bottom:4px">Elegí la publicación FUENTE (dona fotos, características, descripción, guía, SKUs, precio y descuento):</div>'
    +'<div style="display:flex;flex-direction:column;gap:3px;max-height:260px;overflow:auto">'
    +_srcPubs.map((x,i)=>{ const sel=_srcSel===x.id; const active=x.it.status==='active';
      return '<div style="display:flex;gap:8px;align-items:center;padding:4px 6px;border:1px solid '+(sel?'#16a34a':'var(--border)')+';border-radius:6px'+(sel?';background:rgba(22,163,74,.06)':'')+'">'
      +(x.it.thumbnail?('<img src="'+esc(x.it.thumbnail)+'" loading="lazy" style="width:34px;height:34px;object-fit:cover;border-radius:5px;flex-shrink:0;background:var(--surface2)">'):'')
      +'<div style="min-width:0;flex:1;font-size:11px"><b>'+esc(x.id)+'</b>'+(i===0?' <span style="font-size:9px;font-weight:700;padding:1px 6px;border-radius:9px;background:#fef3c7;color:#92400e">★ Recomendada</span>':'')+' <span style="color:'+(active?'#166534':'#991b1b')+'">'+(active?'activa':'pausada')+'</span><div style="color:var(--text-soft);overflow:hidden;text-overflow:ellipsis;white-space:nowrap">'+x.vis+' vis · '+x.sales+' vtas 14d · '+esc(String(x.it.title||'').slice(0,45))+'</div></div>'
      +(sel?'<span style="flex-shrink:0;font-size:11px;font-weight:700;color:#16a34a">✓ Fuente</span>':'<button class="btn btn-sm" style="flex-shrink:0;padding:2px 10px" onclick="pubSrcPick(\''+esc(x.id)+'\')">Elegir</button>')
      +'</div>'; }).join('')+'</div>';
}
async function pubSrcPick(id){
  _srcSel=String(id); swapReset();
  { const _mi=$('pub-dest-model'); if(_mi) _mi.value=''; }   // limpiar ANTES del fetch: si leer la fuente falla, el bloque 3 corta limpio en vez de reusar el modelo de una fuente elegida antes (reglas-reviewer)
  if(_srcPubs.length) pubSrcRender();
  else { const sl=$('pub-src-list'); if(sl) sl.innerHTML='<div style="font-size:12px;color:#16a34a;font-weight:700">✓ Fuente: '+esc(String(id))+'</div>'; }
  try{ pubSearch(); }catch(e){}   // refresca la lista de arriba (marca el estado)
  const inh=$('pub-src-inherit'); if(inh) inh.innerHTML='<span class="spin" style="display:inline-block"></span> leyendo la fuente en vivo…';
  try{
    await pubEnsureMaster(); await ensurePubPrices(); await ensureColorMap();   // mapa de color (fuente única del backend) antes de canonizar variantes
    // El modelo destino SE DERIVA de la pub fuente elegida (corrección de Martin: no se elige del maestro).
    const srcCat=((_srcPubs.find(x=>x.id===String(id))||{}).it)||{};
    const tgt=_sel.item; const tgtTier=tgt.listing_type_id==='gold_pro'?'Premium':(tgt.listing_type_id==='gold_special'?'Clasica':'Otro');
    const [mr, vr]=await Promise.all([ apiGet('/api/ml/items-meta?ids='+encodeURIComponent(id+','+_sel.id)), apiGet('/api/ml/item-variations?id='+encodeURIComponent(id)) ]);
    const sm=(mr&&mr.meta&&mr.meta[id])||{}; const tm=(mr&&mr.meta&&mr.meta[_sel.id])||{};
    const srcVars=(vr&&vr.ok&&vr.variations)||[]; const srcAttrs=(vr&&vr.ok&&vr.attributes)||[];
    // MODEL destino = atributo MODEL VIVO de la fuente (regla dura: la única verdad actual), con fallback al
    // catálogo cacheado. Antes salía SOLO de _srcPubs (que puebla el buscador de la DERECHA); al elegir la
    // fuente desde "Elegir publicación" (arriba) _srcPubs quedaba vacío → model='' → el input nunca se seteaba
    // y el bloque 3 (Características) fallaba con "No hay modelo destino" pese a tener la fuente elegida.
    const model=String(((srcAttrs.find(a=>a.id==='MODEL')||{}).value_name)||srcCat.model||'').trim();
    const mi=$('pub-dest-model'); if(mi&&model) mi.value=model;   // el runner lee el MODEL de este input
    const mm=_pm&&_pm.models[norm(model)];
    _swapSrcAttrs=srcAttrs; _swapSrcTitle=String(sm.title||'');   // para el sugeridor de palabras del bloque Título
    _swapTitle=String((_sel&&_sel.item&&_sel.item.title)||'');   // título prellenado con el ACTUAL (editable)
    const _gt=(srcAttrs||[]).find(a=>a.id==='GARMENT_TYPE')||{}; _swapGarment=String(_gt.value_name||''); _swapGarmentVid=String(_gt.value_id||'');   // TIPO DE PRENDA prellenado con el de la fuente
    // Precio de LISTA = Precio FULL ARS, ÚNICO para ambos tiers (corrección de Martin — los tiers solo
    // difieren en el DESCUENTO). Hereda el de la fuente, verificado contra el full del maestro.
    const mPrice = mm&&mm.price!=null?mm.price:null;
    const price = sm.price!=null?Math.round(sm.price):(mPrice!=null?Math.round(mPrice):'');
    const pWarn = mPrice==null?'(sin precio full en el maestro)':(Math.round(mPrice)===Math.round(sm.price||0)?'✓ coincide con el maestro (full)':('⚠ difiere del precio Full del maestro ('+money(mPrice)+')'));
    // Descuento: el que financia la fuente HOY (blob de precios), verificado contra el maestro del tier target.
    const srow=_pprices[id]; const srcDesc=srow&&srow.sellerCost!=null?Math.round(srow.sellerCost):null;
    const mDesc = tgtTier==='Premium'?(mm&&(mm.descPrem!=null?mm.descPrem:mm.desc)):(mm&&(mm.descClas!=null?mm.descClas:mm.desc));
    const desc = srcDesc!=null?srcDesc:(mDesc!=null?Math.round(mDesc):'');
    const dWarn = srcDesc==null ? (mDesc!=null?'⚠ la fuente no tiene descuento visible → uso maestro':'⚠ sin descuento (ni fuente ni maestro)') : (mDesc!=null&&Math.abs(srcDesc-mDesc)>1?('⚠ difiere del maestro ('+Math.round(mDesc)+'%)'):'✓ coincide con el maestro');
    const tgtVars=tgt.variations||[];
    let h='<div style="border-top:1px dashed var(--border);padding-top:8px;display:flex;flex-direction:column;gap:6px">';
    h+='<div>Precio de lista: <input id="pub-dest-price" type="number" min="1000" step="1" value="'+price+'" style="width:110px;font-size:12px;padding:4px 6px"> <span style="font-size:11px;color:'+(String(pWarn)[0]==='✓'?'#16a34a':'#b45309')+'">'+esc(pWarn)+'</span></div>';
    h+='<div>Descuento propio: <input id="pub-dest-desc" type="number" min="5" max="80" value="'+desc+'" style="width:60px;font-size:12px;padding:4px 6px">% <span style="font-size:11px;color:'+(String(dWarn)[0]==='✓'?'#16a34a':'#b45309')+'">'+esc(dWarn)+'</span></div>';
    h+='<div style="font-size:11px;color:var(--text-soft)">Título: se edita en el bloque <b>5 · Título</b> (con las recomendaciones de búsqueda).</div>';
    h+='<input type="hidden" id="pub-dest-picsfrom" value="'+esc(id)+'"><input type="hidden" id="pub-dest-descfrom" value="'+esc(id)+'">';
    h+='<div style="font-size:11px;color:var(--text-soft)">Fotos y descripción: se copian de <b>'+esc(id)+'</b>.</div>';
    // VARIANTES QUE VA A TENER = las de la FUENTE (el destino ADOPTA el set del artículo nuevo, no al revés).
    // Corrección de Martin: exponer color × talle × SKU × STOCK de la FUENTE = lo que va a quedar; los colores
    // del destino que no estén en la fuente se ELIMINAN, los de la fuente que falten se CREAN. Nada a mano.
    // Match por color canónico (EN↔ES, normColor) para no borrar+recrear un color que en realidad es el mismo.
    if(srcVars.length){
      const tgtColOf=v=>{ const a=(v.attribute_combinations||[]).find(x=>x.id==='COLOR'||/color/i.test(String(x.name||''))); return a?String(a.value_name||''):''; };
      const tgtCols=[...new Set(tgtVars.map(tgtColOf).filter(Boolean))];
      const tgtCanon=new Set(tgtCols.map(normColor));
      const srcCanon=new Set(srcVars.map(v=>normColor(v.color)).filter(Boolean));
      const byCol={}; srcVars.forEach(v=>{ const c=v.color||'(sin color)'; (byCol[c]||(byCol[c]=[])).push(v); });
      h+='<div style="font-weight:700;margin-top:2px">Variantes que va a tener (de la fuente '+esc(id)+'):</div>';
      for(const c of Object.keys(byCol)){
        const isNew=!tgtCanon.has(normColor(c));
        h+='<div style="font-weight:700;font-size:12px;margin-top:6px;text-transform:capitalize">'+esc(c)+(isNew?' <span style="font-size:10px;font-weight:600;color:#0369a1">＋ se crea (no está en la pub actual)</span>':' <span style="font-size:10px;font-weight:600;color:#166534">se mantiene</span>')+'</div>';
        h+='<table style="border-collapse:collapse">'+byCol[c].map(v=>'<tr><td style="padding:2px 12px 2px 0"><b>'+esc(v.size||'?')+'</b></td><td style="font-family:monospace;font-size:11px;padding-right:12px">'+esc(v.sku||'—')+'</td><td style="font-size:11px;color:var(--text-soft)">stock '+(v.qty!=null?v.qty:'—')+'</td></tr>').join('')+'</table>';
      }
      const toDel=tgtCols.filter(c=>!srcCanon.has(normColor(c)));
      if(toDel.length) h+='<div style="font-size:12px;color:#991b1b;margin-top:6px">Se eliminan del destino (no están en la fuente): <b style="text-transform:capitalize">'+toDel.map(esc).join(', ')+'</b></div>';
      h+='<div style="font-size:10px;color:var(--text-soft);margin-top:2px">El alta/baja de colores y los SKU se aplican en el swap (bloque Variantes). El stock de las nuevas lo cargás vos después.</div>';
    }
    h+='</div>';
    if(inh) inh.innerHTML=h;
    pubSwapTabs();   // activar los bloques ahora que hay fuente + valores heredados cargados
    await pubPrecheck(sm, tm, srcVars, srcAttrs);
  }catch(e){ if(inh) inh.innerHTML='<span style="color:#dc2626;font-size:12px">Error leyendo la fuente: '+esc(e.message)+'</span>'; }
}
// PRE-CHEQUEO (solo lectura): todo el diff antes de escribir nada.
async function pubPrecheck(sm, tm, srcVars, srcAttrs){
  const pc=$('pub-precheck'); if(!pc||!_sel) return;
  pc.innerHTML='<div style="font-size:12px;color:var(--text-soft)"><span class="spin" style="display:inline-block;margin-right:6px"></span>Pre-chequeo…</div>';
  const L=[]; const tgt=_sel.item;
  try{
    // Variantes: diff por color CANÓNICO (EN↔ES) — conservar / borrar sobrantes del destino / crear los de la fuente
    const colOf=v=>{ const a=(v.attribute_combinations||[]).find(x=>x.id==='COLOR'||/color/i.test(String(x.name||''))); return a?normColor(a.value_name):''; };
    const tgtColors=[...new Set((tgt.variations||[]).map(colOf).filter(Boolean))];
    const srcColors=[...new Set(srcVars.map(v=>normColor(v.color)).filter(Boolean))];
    const drop=tgtColors.filter(c=>!srcColors.includes(c)); const add=srcColors.filter(c=>!tgtColors.includes(c)); const keep=tgtColors.filter(c=>srcColors.includes(c));
    L.push({ok:!drop.length&&!add.length, t:('Variantes: '+(keep.length?('conserva '+keep.join(', ')):'')+(drop.length?(' · BORRA color '+drop.join(', ')):'')+(add.length?(' · CREA color '+add.join(', ')):''))||'sin cambios de color'});
    // Guía de talles. CLAVE (bug cazado por Martin): la pub va a ADOPTAR las variantes de la FUENTE, así que
    // la guía tiene que cubrir los talles de la FUENTE (no los del destino actual — por eso antes no veía el 3XL
    // de Thor). swapEnsureGuide usa la guía de la FUENTE directo; solo si la notación difiere (XXL vs 2XL) la
    // clona TRADUCIDA a la notación del destino («X CLON»). El chequeo real: ¿alguna variante de la fuente se
    // queda sin fila en la guía (comparando por canon)? (eso sí sería un problema).
    const sg=srcAttrs.find(a=>a.id==='SIZE_GRID_ID'); const gid=sg?String(sg.value_name||sg.value_id||''):'';   // misma convención que catRecordFromBody
    if(gid){
      const cr=await apiGet('/api/ml/chart?id='+encodeURIComponent(gid));
      const rows=(cr&&cr.ok&&cr.rows)||[]; const gsizes=rows.map(r=>String(r.size));
      const ssizes=[...new Set(srcVars.map(v=>String(v.size)).filter(Boolean))];   // talles de la FUENTE = los que va a tener la pub
      const gcanon=new Set(gsizes.map(scanon));                                     // canon (XXL≡2XL): evita el falso "sin fila" por notación distinta
      const scanonSet=new Set(ssizes.map(scanon));
      const uncovered=ssizes.filter(s=>!gcanon.has(scanon(s)));                     // variante de la fuente sin fila (por canon) = problema real
      const extra=gsizes.filter(s=>!scanonSet.has(scanon(s)));                     // filas de la guía sin variante (ej. 3XL) — inofensivas
      L.push({ok:true, t:'Guía «'+esc((cr&&cr.name)||gid)+'»: filas ['+gsizes.join(', ')+'] · talles de la fuente ['+ssizes.join(', ')+']'});
      if(uncovered.length) L.push({ok:false, t:'⚠ estos talles de la fuente NO tienen fila en la guía: '+uncovered.join(', ')+' — hay que agregarlos a la guía clonada antes de asignar'});
      L.push({ok:true, t:'Guía de talles: usa «'+esc((cr&&cr.name)||gid)+'» de la fuente directo; si la notación difiere del destino la clona traducida («'+esc((cr&&cr.name)||gid)+' CLON»)'+(extra.length?' · filas sin variante: '+extra.join(', ')+' (inofensivas)':'')});
    } else L.push({ok:false, t:'Guía de talles: la fuente no tiene guía asignada — queda manual'});
    // Características. HOY el runner solo escribe MODEL (honesto — no miento con las demás). TIPO DE PRENDA
    // y el resto se copian en el bloque Características del swap (HITO 3: copia todas con value_id, saltea
    // read-only, avisa las sensibles). Igual muestro qué trae la fuente como referencia.
    const attr=id=>{ const a=srcAttrs.find(x=>x.id===id); return a?(a.value_name||''):''; };
    const gt=attr('GARMENT_TYPE'), br=attr('BRAND'), gen=attr('GENDER');
    L.push({ok:true, t:'Características (bloque 3): copia TIPO DE PRENDA «'+(gt||'—')+'» · BRAND «'+(br||'—')+'» y las demás de la fuente. GÉNERO «'+(gen||'—')+'» NO se toca (regla dura). MODEL → «'+String(($('pub-dest-model')||{}).value||'')+'»'});
    // Tienda oficial
    if(sm.officialStore&&tm.officialStore&&sm.officialStore!==tm.officialStore) L.push({ok:false, t:'Tienda oficial: mueve de #'+tm.officialStore+' a #'+sm.officialStore+' (la de la fuente) — puede pausar si la marca no cierra, se verifica'});
    else L.push({ok:true, t:'Tienda oficial: sin cambio ('+(tm.officialStore||'s/tienda')+')'});
    // Precio automatizado + promos (preflight de elegibilidad con el descuento heredado)
    if(tm.priceAuto) L.push({ok:false, t:'⛔ Automatización de precios de ML activa en esta pub — el precio NO se va a tocar'});
    const dv=Math.round(parseFloat(($('pub-dest-desc')||{}).value));
    if(!(dv>0)) L.push({ok:false, t:'⚠ sin descuento definido — el reenter no se puede pre-validar (cargalo arriba)'});
    else{
      const pf=await apiPostEx('/api/ml/promo-bulk',{ itemIds:[_sel.id], leaveAll:true, reenter:{con:dv,sin:dv}, dryRun:true, preflight:true });
      const r0=(pf&&pf.body&&pf.body.results&&pf.body.results[0])||{};
      if(r0.preflightBlocked&&r0.inelegible) L.push({ok:false, t:'⛔ INELEGIBLE para promos: si sale de sus promos NO puede reentrar (queda sin descuento SIN RETORNO). Pensalo antes de ejecutar.'});
      else if(r0.preflightBlocked) L.push({ok:false, t:'⚠ el '+dv+'% no entra en la banda de ML de esta pub — el reenter va a saltearse'});
      else L.push({ok:true, t:'Promos: sale de '+_sel.promosAct.length+' y reentra al '+dv+'% (preflight OK)'});
    }
  }catch(e){ L.push({ok:false, t:'Pre-chequeo incompleto: '+e.message}); }
  pc.innerHTML='<div style="border:1px solid var(--border);border-radius:8px;padding:10px"><div style="font-weight:700;font-size:13px;margin-bottom:6px">Pre-chequeo</div>'
    +L.map(x=>'<div style="font-size:12px;padding:2px 0;color:'+(x.ok?'var(--text)':'#b45309')+'">'+(x.ok?'✓ ':'')+x.t+'</div>').join('')+'</div>';
}
// ── RUNNER POR BLOQUES ──────────────────────────────────────────────────────────────────────────────
let _blkArm={};
function swapRenderBar(){
  const bar=$('pub-blk-tabs'); if(!bar) return;
  bar.innerHTML=SWAP_BLOCKS.map(b=>{ const s=_swapBlk[b.key]; const on=_swapTab===b.n; const ic=s==='done'?'✓ ':(s==='warn'?'⚠ ':(s==='err'?'✗ ':''));
    const col=on?';background:#0ea5e9;color:#fff;border-color:#0ea5e9;font-weight:700':(s==='done'?';border-color:#16a34a;color:#16a34a':(s==='warn'||s==='err'?';border-color:#b45309;color:#b45309':''));
    return '<button class="btn btn-sm" onclick="pubSwapTab('+b.n+')" style="padding:3px 10px'+col+'">'+ic+b.n+' · '+esc(b.label)+'</button>'; }).join('');
}
// Estilos del botón por estado del bloque (verde=pendiente, atenuado✓=hecho, ámbar=rehacer, rojo=reintentar).
const BLK_BTN={ done:['✓ Hecho · volver a correr','var(--surface2)','#16a34a','#16a34a','600'], warn:['⚠ Rehacer','#fffbeb','#b45309','#b45309','600'], err:['Reintentar','#dc2626','#fff','#dc2626','700'] };
function blkBtnHtml(key,label,onclick){ const m=BLK_BTN[_swapBlk[key]]; const txt=m?m[0]:label; const bg=m?m[1]:'#16a34a', col=m?m[2]:'#fff', bd=m?m[3]:'#16a34a', fw=m?m[4]:'700';
  return '<button id="blk-btn-'+key+'" class="btn" data-label="'+esc(label)+'" onclick="'+onclick+'" style="background:'+bg+';color:'+col+';border-color:'+bd+';font-weight:'+fw+'">'+esc(txt)+'</button>'; }
function blkDone(key,status){ _swapBlk[key]=status; swapRenderBar();
  const b=$('blk-btn-'+key); if(!b) return; b.disabled=false; const m=BLK_BTN[status];
  if(m){ b.textContent=m[0]; b.style.background=m[1]; b.style.color=m[2]; b.style.borderColor=m[3]; b.style.fontWeight=m[4]; } }
function blkSt(key,c,t){ const st=$('blk-st-'+key); if(st){ st.style.color=c; st.textContent=t; } }
function blkProg(key,t){ const p=$('blk-prog-'+key); if(p) p.innerHTML+='<div>'+t+'</div>'; }
// Confirmación doble-clic EN PANTALLA (nada de dialogs del navegador): 1er clic arma en rojo + aviso, 2do ejecuta.
function blkConfirm(key,warn,run){
  const btn=$('blk-btn-'+key); const label=btn?(btn.getAttribute('data-label')||btn.textContent):'';
  const restore=()=>{ if(btn){ btn.textContent=label; btn.style.background='#16a34a'; btn.style.color='#fff'; btn.style.borderColor='#16a34a'; btn.style.fontWeight='700'; } };
  if(!_blkArm[key]){
    _blkArm[key]=setTimeout(()=>{ _blkArm[key]=null; restore(); },12000);
    if(btn){ btn.textContent='⚠️ Confirmar'; btn.style.background='#dc2626'; btn.style.color='#fff'; btn.style.borderColor='#dc2626'; }
    blkSt(key,'#dc2626',warn); return;
  }
  clearTimeout(_blkArm[key]); _blkArm[key]=null; restore();
  run();
}
function pubSwapTabs(){ pubSwapTab(_swapTab); }
function pubSwapTab(n){
  _swapTab=n; swapRenderBar();
  const body=$('pub-blk-body'); if(!body||!_sel) return;
  if(!_srcSel){ body.innerHTML='<div style="font-size:12px;color:var(--text-soft)">Elegí primero la publicación FUENTE (arriba) para habilitar los bloques.</div>'; return; }
  if(n===1) body.innerHTML=blkPrecioBody();
  else if(n===2) pubBlkVariantesPlan();
  else if(n===3) body.innerHTML=blkCaracBody();
  else if(n===4) body.innerHTML=blkGuiaBody();
  else if(n===5){ body.innerHTML=blkTituloBody(); swapEnsureTrends(); }
  else if(n===6){ body.innerHTML=blkEstadoBody(); swapRefreshStatus(); }
}
// Trae las Trends de ML para la categoría del destino (una vez) y re-renderiza el bloque Título con las keywords.
async function swapEnsureTrends(){
  if(_swapTrends!==null) return;
  _swapTrends=[];   // marca "pedido" para no duplicar
  try{ const cat=String((_sel&&_sel.item&&_sel.item.category_id)||''); const r=await apiGet('/api/ml/trends'+(cat?('?category='+encodeURIComponent(cat)):'')); if(r&&r.ok&&Array.isArray(r.keywords)) _swapTrends=r.keywords; }catch(e){}
  if(_swapTab===5){ const body=$('pub-blk-body'); if(body) body.innerHTML=blkTituloBody(); }
}
function blkPrecioBody(){
  const price=($('pub-dest-price')||{}).value||''; const pct=($('pub-dest-desc')||{}).value||'';
  return '<div style="font-weight:700;margin-bottom:4px">1 · Precio y promos</div>'
   +'<div style="font-size:12px;color:var(--text-soft);margin-bottom:8px">Sale de las <b>'+_sel.promosAct.length+'</b> promo(s) activas → fija precio de lista <b>'+(price?money(price):'(cargá arriba)')+'</b> → reentra al descuento <b>'+(pct||'—')+'%</b>.</div>'
   +blkBtnHtml('precio','Ejecutar precio y promos','pubBlkPrecio()')+' <span id="blk-st-precio" style="font-size:12px"></span>'
   +'<div id="blk-prog-precio" style="margin-top:8px;font-size:12px"></div>';
}
function blkCaracBody(){
  const model=String(($('pub-dest-model')||{}).value||'').trim();
  return '<div style="font-weight:700;margin-bottom:4px">3 · Características y descripción</div>'
   +'<div style="font-size:12px;color:var(--text-soft);margin-bottom:8px">Copia todas las características de la fuente (con value_id, saltea read-only y el GÉNERO — que no se toca nunca), escribe <b>MODEL «'+esc(model||'?')+'»</b> y la descripción de la fuente.</div>'
   +blkBtnHtml('carac','Ejecutar características','pubBlkCarac()')+' <span id="blk-st-carac" style="font-size:12px"></span>'
   +'<div id="blk-prog-carac" style="margin-top:8px;font-size:12px"></div>';
}
function blkGuiaBody(){
  return '<div style="font-weight:700;margin-bottom:4px">4 · Guía de talles</div>'
   +'<div style="font-size:12px;color:var(--text-soft);margin-bottom:8px">Usa la guía del <b>modelo FUENTE</b> directo (la pub adopta sus variantes → comparte sus medidas). Solo si la notación difiere (ej. XXL vs 2XL) clona la de la fuente <b>traducida</b> a la notación del destino. Se asigna junto con Variantes.</div>'
   +blkBtnHtml('guia','Preparar guía','pubBlkGuia()')+' <span id="blk-st-guia" style="font-size:12px"></span>'
   +'<div id="blk-prog-guia" style="margin-top:8px;font-size:12px"></div>';
}
// Palabras derivadas de los ATRIBUTOS de la fuente (hechos del producto) — se combinan con las Trends de ML.
function titleAttrWords(){
  const at=id=>{ const a=(_swapSrcAttrs||[]).find(x=>x.id===id); return a?String(a.value_name||''):''; };
  const yes=v=>/^s[ií]/i.test(String(v||''));
  const cand=[];
  if(at('GARMENT_TYPE')) cand.push(at('GARMENT_TYPE'));
  if(yes(at('WITH_HOOD'))) cand.push('Con Capucha');
  if(yes(at('IS_IMPERMEABLE'))) cand.push('Impermeable');
  if(yes(at('IS_THERMIC'))) cand.push('Térmica');
  if(at('MAIN_MATERIAL')) cand.push(at('MAIN_MATERIAL'));
  if(/invierno/i.test(at('RELEASE_SEASON'))) cand.push('Invierno');
  return cand;
}
function blkTituloBody(){
  const cur=String((_sel&&_sel.item&&_sel.item.title)||'');
  const inputVal=String(_swapTitle||'').trim();
  const gender=(((_swapSrcAttrs||[]).find(a=>a.id==='GENDER')||{}).value_name)||'';
  const sug=titleSuggest(_swapTrends||[], inputVal||cur, gender, titleAttrWords());
  const loading=_swapTrends===null;
  let h='<div style="font-weight:700;margin-bottom:4px">5 · Título</div>';
  // TIPO DE PRENDA primero (técnica: setearlo habilita meter esa palabra en el título). Prellenado con el de la fuente.
  h+='<div style="font-size:12px;font-weight:700;margin:2px 0 3px">TIPO DE PRENDA <span style="font-weight:400;color:var(--text-soft)">— seteálo primero (habilita esa palabra en el título)</span></div>';
  h+='<input id="swap-garment-in" value="'+esc(_swapGarment||'')+'" oninput="swapGarmentInput(this.value)" placeholder="ej. Campera Puffer" style="width:100%;font-size:13px;padding:6px 8px;border:1px solid var(--border2);border-radius:6px">';
  h+='<div style="margin-top:4px"><button id="blk-btn-garment" class="btn btn-sm" onclick="pubBlkGarment()" style="background:#0ea5e9;color:#fff;border-color:#0ea5e9">Aplicar TIPO DE PRENDA</button> <span id="blk-st-garment" style="font-size:11px"></span></div>';
  h+='<div id="blk-prog-garment" style="font-size:11px;margin:3px 0 12px"></div>';
  h+='<div style="font-size:12px;margin-bottom:6px">Título actual: «<b>'+esc(cur)+'</b>» <span style="color:var(--text-soft)">('+cur.length+'/60)</span></div>';
  // CAMPO EDITABLE del título — prellenado con el ACTUAL para editar desde ahí.
  h+='<div style="font-size:12px;margin-bottom:6px">Título nuevo <button class="btn btn-sm" onclick="titleUseCurrent()" style="padding:1px 8px">Restaurar el actual</button></div>';
  h+='<input id="swap-title-in" maxlength="60" value="'+esc(_swapTitle||'')+'" oninput="swapTitleInput(this.value);var c=document.getElementById(\'swap-title-cnt\');if(c)c.textContent=this.value.length+\'/60\'" placeholder="(vacío = no cambiar el título)" style="width:100%;font-size:13px;padding:6px 8px;border:1px solid var(--border2);border-radius:6px">';
  h+='<div id="swap-title-cnt" style="font-size:10px;color:var(--text-soft);text-align:right;margin-bottom:6px">'+String(_swapTitle||'').length+'/60</div>';
  if(loading) h+='<div style="font-size:12px;color:var(--text-soft)"><span class="spin" style="display:inline-block;margin-right:6px"></span>Trayendo tendencias de búsqueda de ML…</div>';
  else{
    if(sug.trendWords.length) h+='<div style="font-size:12px;margin-bottom:6px;color:#0369a1">🔎 <b>Más buscadas en ML</b> (categoría, refresco semanal) que faltan en el título: <b>'+sug.trendWords.map(esc).join(' · ')+'</b></div>';
    if(sug.phrases.length) h+='<div style="font-size:11px;margin-bottom:6px;color:var(--text-soft)">Frases trending relevantes: '+sug.phrases.map(p=>'«'+esc(p)+'»').join(' · ')+'</div>';
    if(sug.attrWords.length) h+='<div style="font-size:12px;margin-bottom:8px;color:#166534">🏷️ <b>De tu producto</b> (faltan en el título): <b>'+sug.attrWords.map(esc).join(' · ')+'</b></div>';
  }
  h+='<div style="font-size:11px;color:var(--text-soft);margin:6px 0 8px">Recordá: ML suele ignorar el cambio de título con ventas — conviene DESPUÉS de características (TIPO DE PRENDA habilita meter esa palabra). Se verifica al aplicar.</div>';
  h+=blkBtnHtml('titulo','Ejecutar título','pubBlkTitulo()')+' <span id="blk-st-titulo" style="font-size:12px"></span>';
  h+='<div id="blk-prog-titulo" style="margin-top:8px;font-size:12px"></div>';
  return h;
}
function titleUseCurrent(){ if(_sel&&_sel.item){ _swapTitle=String(_sel.item.title||''); pubSwapTab(5); } }
// BLOQUE 2 — Variantes: PLAN keep-matching + WRITE destructivo (swap-variations execute:true; guard de modelo obligatorio).
async function pubBlkVariantesPlan(){
  const body=$('pub-blk-body'); if(!body) return;
  body.innerHTML='<div style="font-weight:700;margin-bottom:4px">2 · Variantes y fotos</div><div style="font-size:12px;color:var(--text-soft)"><span class="spin" style="display:inline-block;margin-right:6px"></span>Calculando plan keep-matching…</div>';
  try{
    const aliases=swapParseAliases();
    const r=await apiPostEx('/api/ml/swap-variations',{ targetId:_sel.id, sourceId:_srcSel, clonedChartId:_swapClonedChart||undefined, colorAliases:aliases });
    const j=r.body||{}; const p=j.plan||{}; const c=p.counts||{keep:0,create:0,keepZero:0,del:0};
    _swapSizeRename=p.sizeRename||{};   // lo produce el API (auto); lo usa el bloque Guía al clonar
    let h='<div style="font-weight:700;margin-bottom:4px">2 · Variantes y fotos <span style="font-size:11px;font-weight:400;color:var(--text-soft)">(keep-matching)</span></div>';
    h+='<div style="font-size:12px;margin-bottom:6px">Mantiene <b>'+c.keep+'</b> · Crea <b style="color:#0369a1">'+c.create+'</b> · Mantiene-en-0 <b>'+(c.keepZero||0)+'</b> · Borra <b style="color:#991b1b">'+c.del+'</b></div>';
    if((p.keep||[]).length) h+='<div style="font-size:11px;margin-bottom:2px"><b>Mantiene</b> (mismo id, conserva historial): '+p.keep.map(x=>esc(x.color+'/'+x.size)).join(', ')+'</div>';
    if((p.create||[]).length) h+='<div style="font-size:11px;color:#0369a1;margin-bottom:2px"><b>Crea:</b> '+p.create.map(x=>esc(x.color+'/'+x.size+'→'+x.sku)).join(', ')+'</div>';
    if((p.keepZero||[]).length) h+='<div style="font-size:11px;color:var(--text-soft);margin-bottom:2px"><b>Mantiene a stock 0</b> (talle sin fuente en ese color): '+p.keepZero.map(x=>esc(x.color+'/'+x.size)).join(', ')+'</div>';
    if((p.del||[]).length) h+='<div style="font-size:11px;color:#991b1b;margin-bottom:2px"><b>Borra</b> (color que no está en la fuente): '+p.del.map(x=>esc(x.color+'/'+x.size)).join(', ')+'</div>';
    if(Object.keys(_swapSizeRename).length) h+='<div style="font-size:11px;color:var(--text-soft);margin-bottom:2px">Notación: '+Object.keys(_swapSizeRename).map(k=>k+'→'+_swapSizeRename[k]).join(', ')+' (la guía se clona con esta notación)</div>';
    (j.warnings||[]).forEach(w=>{ h+='<div style="font-size:11px;color:#b45309">⚠ '+esc(w)+'</div>'; });
    // Alias de color por CHECKBOX (sin escribir): el API dice qué colores quedaron sin match en cada lado; para
    // cada color del destino que se borraría, sugerimos el color de la fuente más parecido → marcás si es el mismo.
    const ac=p.aliasCandidates||{tgtOnly:[],srcOnly:[]};
    if((ac.tgtOnly||[]).length && (ac.srcOnly||[]).length){
      h+='<div style="margin-top:10px;font-size:12px;border-top:1px dashed var(--border);padding-top:8px"><b>¿Algún color es el mismo con otro nombre?</b> <span style="color:var(--text-soft)">Marcá para MANTENERLO (no borrar+crear):</span></div>';
      ac.tgtOnly.forEach(tc=>{ const sg=swapAliasSuggest(tc,ac.srcOnly); if(!sg) return; const on=_swapColorAliases[tc]===sg;
        h+='<label style="display:flex;gap:6px;align-items:center;font-size:12px;margin-top:3px;cursor:pointer"><input type="checkbox" '+(on?'checked':'')+' onchange="swapAliasToggle(\''+esc(tc)+'\',\''+esc(sg)+'\')"> Tratar <b style="text-transform:capitalize">'+esc(tc)+'</b> (destino) como <b style="text-transform:capitalize">'+esc(sg)+'</b> (fuente)</label>'; });
      const noSug=ac.tgtOnly.filter(tc=>!swapAliasSuggest(tc,ac.srcOnly));
      if(noSug.length) h+='<div style="font-size:11px;color:var(--text-soft);margin-top:2px">Sin sugerencia (se borran si no los marcás): '+noSug.map(esc).join(', ')+'</div>';
    }
    // Ejecución (destructiva). Prepara la guía sola si no corriste el bloque 4 (clona/traduce lo necesario).
    h+='<div style="margin-top:10px">'+blkBtnHtml('variantes','Ejecutar variantes','pubBlkVariantes()')+' <span id="blk-st-variantes" style="font-size:12px">'+(_swapClonedChart?'':'<span style="color:var(--text-soft)">(prepara la guía solo)</span>')+'</span><div id="blk-prog-variantes" style="margin-top:8px;font-size:12px"></div></div>';
    body.innerHTML=h; blkDone('variantes', (c.del||c.keepZero)?'warn':'done');
  }catch(e){ body.innerHTML='<div style="color:#dc2626;font-size:12px">Error calculando el plan: '+esc(e.message)+'</div>'; }
}
// BLOQUE 2 — ejecución del swap de variantes (DESTRUCTIVA). chartId de la guía clonada (bloque 4); sizeRename
// lo deriva el API solo; colorAliases del input. Doble-clic + read-back en pantalla.
async function pubBlkVariantes(){
  const id=_sel.id;
  const aliases=swapParseAliases();
  blkConfirm('variantes','⚠️ Va a REESCRIBIR las variantes de '+id+' (mantener/crear/borrar según el plan) + fotos + guía. Es destructivo. Apretá Confirmar.', async ()=>{
    const btn=$('blk-btn-variantes'); if(btn){ btn.disabled=true; btn.textContent='Ejecutando…'; }
    const p=$('blk-prog-variantes'); if(p) p.innerHTML='';
    try{
      // Si no corriste el bloque Guía, la preparo yo ahora (clona/traduce lo necesario).
      if(!_swapClonedChart){ blkProg('variantes','0️⃣ Preparando guía…'); const g=await swapEnsureGuide(t=>blkProg('variantes','&nbsp;&nbsp;'+t)); if(g.error) throw new Error(g.error); }
      const curModel=((_sel.item.attributes||[]).find(a=>a.id==='MODEL')||{}).value_name||'';
      const r=await apiPostEx('/api/ml/swap-variations',{ targetId:id, sourceId:_srcSel, chartId:_swapClonedChart, execute:true, colorAliases:aliases, expect:{[id]:curModel} });
      const j=r.body||{};
      if(j.guard){ throw new Error('guard de modelo: '+(j.guard.error||'no coincide')); }
      if(!r.ok||j.error) throw new Error(j.error||('http '+r.status));
      blkProg('variantes','✓ '+j.liveVarCount+' variantes vivas (esp '+j.expectedVarCount+') · '+j.withPhoto+' con foto · borradas '+j.deleted+' · en-0 '+j.keptZero+' · poda '+(j.pruned?'ok':'no'));
      if(j.moderated) blkProg('variantes','<span style="color:#b45309">⚠ la pub quedó en revisión ('+esc(j.statusAfter||'')+') — revisá</span>');
      (j.warnings||[]).forEach(w=>blkProg('variantes','<span style="color:#b45309">⚠ '+esc(w)+'</span>'));
      blkSt('variantes', j.applied?'#16a34a':'#b45309', j.applied?'✓ Variantes aplicadas.':'⚠ Revisá el detalle.'); blkDone('variantes', j.applied?'done':'warn');
    }catch(e){ blkSt('variantes','#dc2626','Error: '+e.message); blkDone('variantes','err'); toast('Variantes: '+e.message,'error'); }
    finally{ const b=$('blk-btn-variantes'); if(b) b.disabled=false; }   // el estado del boton lo pone blkDone
  });
}
// BLOQUE 1 — Precio y promos (self-contained): salir de promos → precio → reentrar descuento.
async function pubBlkPrecio(){
  const id=_sel.id;
  const price=Math.round(parseFloat(($('pub-dest-price')||{}).value));
  const pct=Math.round(parseFloat(($('pub-dest-desc')||{}).value));
  if(!(price>=1000)){ blkSt('precio','#dc2626','Precio de lista inválido (cargalo arriba).'); return; }
  if(!(pct>=5&&pct<=80)){ blkSt('precio','#dc2626','Descuento inválido (5–80).'); return; }
  blkConfirm('precio','⚠️ Va a salir de '+_sel.promosAct.length+' promo(s), fijar precio '+money(price)+' y aplicar '+pct+'%. Apretá Confirmar.', async ()=>{
    const btn=$('blk-btn-precio'); if(btn){ btn.disabled=true; btn.textContent='Ejecutando…'; }
    const p=$('blk-prog-precio'); if(p) p.innerHTML='';
    const outcome={ left:0, discount:null };
    try{
      // 1 — salir de todas las promos (resumible; saltea cupones server-side)
      if(_sel.promosAct.length){
        blkProg('precio','1️⃣ Saliendo de '+_sel.promosAct.length+' promo(s)…');
        let off=0, done=false, guard=0;
        while(!done && guard<40){ guard++;
          const r=await apiPostEx('/api/ml/promo-bulk',{ itemIds:[id], leaveAll:true, offset:off });
          if(!r.ok){ const tr=r.status>=500||r.status===0; if(tr&&guard<38){ await new Promise(res=>setTimeout(res,1500)); continue; } throw new Error('salida de promos: '+((r.body&&r.body.error)||('http '+r.status))); }
          const res=(r.body.results||[])[0]; if(res) outcome.left=(res.left||[]).length;
          off=r.body.nextOffset; done=!!r.body.done;
        }
        blkProg('precio','&nbsp;&nbsp;✓ salió de '+outcome.left+' promo(s)');
        await new Promise(res=>setTimeout(res,2500));   // consistencia eventual de ML post-leave
      } else blkProg('precio','1️⃣ Sin promos activas.');
      // 2 — precio (item-update solo precio; guard dynamic_standard_price server-side)
      blkProg('precio','2️⃣ Fijando precio '+money(price)+'…');
      const r2=await apiPostEx('/api/ml/item-update',{ itemId:id, price });
      if(!r2.ok) throw new Error('item-update: '+((r2.body&&r2.body.error)||('http '+r2.status)));
      let priceSkipped=false, priceFail=false;
      (r2.body.steps||[]).forEach(s=>{ if(s.step==='price'&&s.skipped) priceSkipped=true; if(s.step==='price-verify'&&s.applied===false) priceFail=true; const icon=s.skipped?'·':(s.ok!==false?'✓':'✗'); blkProg('precio','&nbsp;&nbsp;'+icon+' '+esc(s.step)+(s.note?(' — '+esc(s.note)):'')+(s.error?(' — <span style="color:#dc2626">'+esc(String(s.error))+'</span>'):'')); });
      // 3 — descuento: julio si aparece candidata (poll), si no PRICE_DISCOUNT
      blkProg('precio','3️⃣ Aplicando descuento '+pct+'%…');
      if(!_julio){ try{ const pr=await apiGet('/api/ml/promos'); _julio=((pr&&pr.promos)||[]).find(c=>String(c.type)==='SELLER_CAMPAIGN'&&String(c.status||'').toLowerCase()==='started')||null; }catch(e){} }
      let joined=false;
      if(_julio){
        for(let k=0;k<6 && !joined;k++){
          await new Promise(res=>setTimeout(res,2500));
          const rr=await apiGet('/api/ml/raw?path='+encodeURIComponent('/seller-promotions/items/'+id+'?app_version=v2'));
          const cand=(Array.isArray(rr&&rr.body)?rr.body:[]).find(pp=>String(pp.id||'')===String(_julio.id)&&String(pp.status||'').toLowerCase()==='candidate');
          if(!cand) continue;
          const jr=await apiPostEx('/api/ml/promo-join-deal',{ items:[{id, pct}], promotionId:_julio.id, promotionType:'SELLER_CAMPAIGN' });
          const res=(jr.ok&&jr.body&&jr.body.results&&jr.body.results[0])||{};
          if(jr.ok && res.ok!==false && !res.skipped){ joined=true; outcome.discount='julio @'+pct+'%'; blkProg('precio','&nbsp;&nbsp;✓ entró a «'+esc(_julio.name||'julio')+'» al '+pct+'% ('+money(res.dealPrice||price*(1-pct/100))+')'); }
          else blkProg('precio','&nbsp;&nbsp;· intento julio: '+esc(String(res.error||'aún no candidata')));
          break;
        }
      }
      if(!joined){
        const dIso=(ms)=>{ const d=new Date(ms); return d.getFullYear()+'-'+String(d.getMonth()+1).padStart(2,'0')+'-'+String(d.getDate()).padStart(2,'0'); };
        const finish=(_julio&&_julio.finish_date)?String(_julio.finish_date).slice(0,10):dIso(Date.now()+30*86400000);
        const ar=await apiPostEx('/api/ml/promo-apply',{ items:[{ itemId:id, dealPrice:Math.round(price*(1-pct/100)) }], startDate:dIso(Date.now())+'T00:00:00', finishDate:finish+'T23:59:59' });
        const res=(ar.ok&&ar.body&&ar.body.results&&ar.body.results[0])||{};
        if(ar.ok&&res.ok!==false){ outcome.discount='PRICE_DISCOUNT @'+pct+'%'; blkProg('precio','&nbsp;&nbsp;✓ Descuento '+pct+'% aplicado ('+money(price*(1-pct/100))+', hasta '+esc(finish)+')'); }
        else blkProg('precio','&nbsp;&nbsp;✗ <span style="color:#dc2626">descuento: '+esc(String(res.error||(ar.body&&ar.body.error)||'falló'))+'</span> — reintentá');
      }
      const priceOk=!priceSkipped&&!priceFail;
      blkSt('precio', priceOk&&outcome.discount?'#16a34a':'#b45309', priceOk?(outcome.discount?'✓ Precio y promos listo.':'⚠ Precio OK, descuento no entró — revisá.'):(priceSkipped?'⚠ Precio NO tocado (automatización de ML activa).':'⚠ Precio no aplicado — revisá.'));
      blkDone('precio', (priceOk&&outcome.discount)?'done':'warn');
      try{ apiPost('/api/decisions',{ area:'swap-precio', subject:id, suggested:{price, pct}, applied:outcome, outcome:{ok:true}, accepted:true }); }catch(e){}
    }catch(e){ blkSt('precio','#dc2626','Error: '+e.message); blkDone('precio','err'); toast('Precio/promos: '+e.message,'error'); }
    finally{ const b=$('blk-btn-precio'); if(b) b.disabled=false; }   // el estado del boton lo pone blkDone
  });
}
// BLOQUE 3 — Características y descripción: copia atributos (guard modelo VIEJO) → escribe MODEL nuevo + desc.
async function pubBlkCarac(){
  const id=_sel.id; const model=String(($('pub-dest-model')||{}).value||'').trim();
  if(!model){ blkSt('carac','#dc2626','No hay modelo destino (elegí la fuente arriba).'); return; }
  blkConfirm('carac','⚠️ Va a copiar las características de la fuente, escribir MODEL «'+model+'» y la descripción. Apretá Confirmar.', async ()=>{
    const btn=$('blk-btn-carac'); if(btn){ btn.disabled=true; btn.textContent='Ejecutando…'; }
    const p=$('blk-prog-carac'); if(p) p.innerHTML=''; let warn=false;
    try{
      // 1 — copiar atributos ANTES de tocar el MODEL (el guard espera el modelo VIEJO, todavía vivo)
      blkProg('carac','1️⃣ Copiando características de la fuente…');
      const cr=await apiPostEx('/api/ml/copy-attributes',{ targetId:id, sourceId:_srcSel, expect:swapExpect() });
      const cb=cr.body||{};
      if(cb.guard){ throw new Error('guard de modelo: '+(cb.guard.error||'la pub no coincide')); }
      // copy-attributes devuelve 200 con {ok:false,error} si el PUT falló → chequear cb.ok, no el status HTTP.
      if((!cr.ok || cb.ok===false) && cb.error) throw new Error('características: '+cb.error);
      blkProg('carac','&nbsp;&nbsp;✓ '+((cb.applied||[]).length)+' aplicadas · '+((cb.skipped||[]).length)+' salteadas (read-only/sistema)'+((cb.ignored||[]).length?(' · '+cb.ignored.length+' ignoradas por ML'):''));
      (cb.warnings||[]).forEach(w=>{ warn=true; blkProg('carac','&nbsp;&nbsp;<span style="color:#b45309">⚠ '+esc(w)+'</span>'); });
      if(cb.moderated){ warn=true; blkProg('carac','&nbsp;&nbsp;<span style="color:#b45309">⚠ la pub quedó en revisión ('+esc(cb.statusAfter||'under_review')+') tras copiar — revisá</span>'); }
      // 2 — MODEL nuevo + descripción de la fuente (item-update)
      blkProg('carac','2️⃣ Escribiendo MODEL «'+esc(model)+'» + descripción…');
      const r2=await apiPostEx('/api/ml/item-update',{ itemId:id, model, descriptionFrom:_srcSel });
      if(!r2.ok) throw new Error('MODEL/desc: '+((r2.body&&r2.body.error)||('http '+r2.status)));
      (r2.body.steps||[]).forEach(s=>{ const icon=s.skipped?'·':(s.ok!==false?'✓':'✗'); if(s.ok===false) warn=true; blkProg('carac','&nbsp;&nbsp;'+icon+' '+esc(s.step)+(s.error?(' — <span style="color:#dc2626">'+esc(String(s.error))+'</span>'):'')); });
      _swapModelWritten=true;
      blkSt('carac','#16a34a','✓ Características listas.'); blkDone('carac', warn?'warn':'done');
    }catch(e){ blkSt('carac','#dc2626','Error: '+e.message); blkDone('carac','err'); toast('Características: '+e.message,'error'); }
    finally{ const b=$('blk-btn-carac'); if(b) b.disabled=false; }   // el estado del boton lo pone blkDone
  });
}
// Prepara la guía a asignar (deja _swapClonedChart listo). Compartido por el bloque 4 y por Variantes (auto).
// Si la notación del destino ≠ la de la fuente (XXL vs 2XL) → clona la guía de la fuente TRADUCIDA a la notación
// del destino («{nombre} CLON»); si coincide → usa la de la fuente directo (sin clonar). Devuelve {chartId} o {error}.
// prog = fn opcional para loguear el progreso en el bloque que la llame.
async function swapEnsureGuide(prog){
  const log=prog||(()=>{});
  const aliases=swapParseAliases();
  const pr=await apiPostEx('/api/ml/swap-variations',{ targetId:_sel.id, sourceId:_srcSel, colorAliases:aliases });
  const sr=(pr.body&&pr.body.plan&&pr.body.plan.sizeRename)||{}; _swapSizeRename=sr;
  const sv=await apiGet('/api/ml/item-variations?id='+encodeURIComponent(_srcSel));
  const sgAttr=((sv&&sv.attributes)||[]).find(a=>a.id==='SIZE_GRID_ID'); const srcGid=sgAttr?String(sgAttr.value_name||sgAttr.value_id||''):'';
  if(!srcGid) return { error:'La fuente no tiene guía asignada — resolvela a mano.' };
  if(!Object.keys(sr).length){ _swapClonedChart=srcGid; log('✓ misma notación → uso la guía de la fuente ('+srcGid+') directo, sin clonar'); return { chartId:srcGid, cloned:false }; }
  const cr0=await apiGet('/api/ml/chart?id='+encodeURIComponent(srcGid));
  const baseName=String((cr0&&cr0.name)||('guía '+srcGid));
  log('notación distinta ('+Object.keys(sr).map(k=>k+'→'+sr[k]).join(', ')+') → clono «'+esc(baseName)+' CLON» traducida');
  const cl=await apiPostEx('/api/ml/clone-size-chart',{ sourceChartId:srcGid, name:(baseName+' CLON').slice(0,120), sizeRename:sr });
  const cb=cl.body||{};
  if(!cl.ok || !cb.chartId) return { error:'clonar guía: '+((cb.error||(cb.cause&&cb.cause.join('; ')))||('http '+cl.status)) };
  _swapClonedChart=String(cb.chartId);
  log('✓ clon '+esc(_swapClonedChart)+' ('+cb.rowCount+' filas, Talle en notación del destino)');
  return { chartId:_swapClonedChart, cloned:true, name:baseName+' CLON' };
}
// BLOQUE 4 — Guía de talles (opcional, se puede correr solo o dejar que Variantes lo haga auto).
async function pubBlkGuia(){
  blkConfirm('guia','⚠️ Prepara la guía (clona traducida solo si cambia la notación). Apretá Confirmar.', async ()=>{
    const btn=$('blk-btn-guia'); if(btn){ btn.disabled=true; btn.textContent='Ejecutando…'; }
    const p=$('blk-prog-guia'); if(p) p.innerHTML='';
    try{
      blkProg('guia','1️⃣ Analizando notación…');
      const r=await swapEnsureGuide(t=>blkProg('guia','&nbsp;&nbsp;'+t));
      if(r.error){ blkSt('guia','#b45309',r.error); blkDone('guia','warn'); return; }
      blkSt('guia','#16a34a', r.cloned?('✓ Guía clonada («'+esc(r.name)+'»).'):'✓ Guía de la fuente lista (sin clon).'); blkDone('guia','done');
      if(_swapTab===2) pubSwapTab(2);   // si Variantes está abierto, refrescar (habilita el botón)
    }catch(e){ blkSt('guia','#dc2626','Error: '+e.message); blkDone('guia','err'); toast('Guía: '+e.message,'error'); }
    finally{ const b=$('blk-btn-guia'); if(b) b.disabled=false; }   // el estado del boton lo pone blkDone
  });
}
// TIPO DE PRENDA (bloque 5): setea el atributo GARMENT_TYPE (técnica que habilita meter esa palabra en el título).
async function pubBlkGarment(){
  const id=_sel.id; const val=String(_swapGarment||'').trim();
  if(!val){ blkSt('garment','#b45309','Vacío — escribí un TIPO DE PRENDA.'); return; }
  const curModel=((_sel.item.attributes||[]).find(a=>a.id==='MODEL')||{}).value_name||'';
  const link='https://articulo.mercadolibre.com.ar/MLA-'+id.replace(/^MLA/,'');
  const btn=$('blk-btn-garment'); if(btn){ btn.disabled=true; btn.textContent='Aplicando…'; }
  const pr=$('blk-prog-garment'); if(pr) pr.innerHTML='';
  try{
    const r=await apiPostEx('/api/ml/set-attr',{ itemId:id, id:'GARMENT_TYPE', value_name:val, value_id:(_swapGarmentVid||undefined), expect:{[id]:curModel} });
    const j=r.body||{};
    if(j.guard) throw new Error('guard de modelo: '+(j.guard.error||'no coincide'));
    if(j.applied){ blkSt('garment','#16a34a','✓ TIPO DE PRENDA aplicado — ya podés meter esa palabra en el título.'); }
    else { if(pr) pr.innerHTML='<span style="color:#b45309">ML no lo aplicó (quedó «'+esc(j.live||'—')+'»). Editalo a mano: <a href="'+link+'" target="_blank" rel="noopener" style="color:#0ea5e9">abrir publicación</a></span>'; blkSt('garment','#b45309','⚠ ML no lo aplicó — link para hacerlo a mano.'); }
  }catch(e){ if(pr) pr.innerHTML='<span style="color:#dc2626">Error: '+esc(e.message)+' — <a href="'+link+'" target="_blank" rel="noopener" style="color:#0ea5e9">abrir publicación</a></span>'; blkSt('garment','#dc2626','Error.'); }
  finally{ const b=$('blk-btn-garment'); if(b){ b.disabled=false; b.textContent='Aplicar TIPO DE PRENDA'; } }
}
// BLOQUE 5 — Título: intento + verificación (ML puede ignorarlo con ventas).
async function pubBlkTitulo(){
  const id=_sel.id; const title=String(_swapTitle||'').trim(); const cur=String((_sel.item&&_sel.item.title)||'').trim();
  if(!title){ blkSt('titulo','#b45309','Título vacío — escribí uno.'); return; }
  if(title===cur){ blkSt('titulo','#b45309','El título es igual al actual — no hay cambio.'); return; }
  blkConfirm('titulo','⚠️ Va a escribir el título «'+title.slice(0,40)+'». Apretá Confirmar.', async ()=>{
    const btn=$('blk-btn-titulo'); if(btn){ btn.disabled=true; btn.textContent='Ejecutando…'; }
    const p=$('blk-prog-titulo'); if(p) p.innerHTML='';
    try{
      const r2=await apiPostEx('/api/ml/item-update',{ itemId:id, title });
      if(!r2.ok) throw new Error('título: '+((r2.body&&r2.body.error)||('http '+r2.status)));
      const tv=(r2.body.steps||[]).find(s=>s.step==='title-verify');
      const applied=tv?tv.applied:null;
      if(applied){ blkProg('titulo','✓ ML aplicó el título nuevo'); blkSt('titulo','#16a34a','✓ Título aplicado.'); blkDone('titulo','done'); }
      else { blkProg('titulo','· ML ignoró el título (con ventas suele pasar) — editalo por panel o con la técnica de TIPO DE PRENDA'); blkSt('titulo','#b45309','⚠ ML no aplicó el título (queda manual).'); blkDone('titulo','warn'); }
    }catch(e){ blkSt('titulo','#dc2626','Error: '+e.message); blkDone('titulo','err'); toast('Título: '+e.message,'error'); }
    finally{ const b=$('blk-btn-titulo'); if(b) b.disabled=false; }   // el estado del boton lo pone blkDone
  });
}
// BLOQUE 6 — Estado: activar/pausar la publicación (tras el swap suele quedar pausada).
function blkEstadoBody(){
  const st=String((_sel&&_sel.item&&_sel.item.status)||'?'); const active=st==='active';
  let h='<div style="font-weight:700;margin-bottom:4px">6 · Estado de la publicación</div>';
  h+='<div style="font-size:12px;margin-bottom:8px">Estado actual: <b id="swap-estado-live" style="color:'+(active?'#166534':'#991b1b')+'">'+esc(st)+'</b>. Tras el swap suele quedar PAUSADA — activala cuando tengas todo listo (guía, características, stock).</div>';
  h+='<button id="blk-btn-estadoOn" class="btn" onclick="pubBlkEstado(\'active\')" style="background:#16a34a;color:#fff;border-color:#16a34a;font-weight:700">Activar publicación</button> ';
  h+='<button id="blk-btn-estadoOff" class="btn btn-sm" onclick="pubBlkEstado(\'paused\')" style="padding:4px 10px">Pausar</button> <span id="blk-st-estado" style="font-size:12px"></span>';
  h+='<div id="blk-prog-estado" style="margin-top:8px;font-size:12px"></div>';
  return h;
}
async function swapRefreshStatus(){ try{ const r=await apiGet('/api/ml/raw?path='+encodeURIComponent('/items/'+_sel.id+'?attributes=id,status')); const st=r&&r.body&&r.body.status; if(st){ if(_sel&&_sel.item)_sel.item.status=st; const el=$('swap-estado-live'); if(el){ el.textContent=st; el.style.color=st==='active'?'#166534':'#991b1b'; } } }catch(e){} }
async function pubBlkEstado(status){
  const id=_sel.id; const curModel=((_sel.item.attributes||[]).find(a=>a.id==='MODEL')||{}).value_name||'';
  const key=status==='active'?'estadoOn':'estadoOff';
  blkConfirm(key,'⚠️ Va a poner la publicación en «'+status+'». Apretá Confirmar.', async ()=>{
    const btn=$('blk-btn-'+key); if(btn){ btn.disabled=true; btn.textContent='Aplicando…'; }
    const p=$('blk-prog-estado'); if(p) p.innerHTML='';
    try{
      const r=await apiPostEx('/api/ml/edit-bulk',{ field:'status', items:[{id,value:status}], expect:{[id]:curModel} });
      const res=((r.body&&r.body.results)||r.results||[])[0]||{};
      if(!r.ok || res.ok===false) throw new Error(res.error||(r.body&&r.body.error)||('http '+r.status));
      if(_sel&&_sel.item) _sel.item.status=status;
      blkProg('estado','✓ ahora está «'+status+'»'); blkSt('estado','#16a34a','✓ Estado → «'+status+'».'); blkDone('estado', status==='active'?'done':'warn');
      const el=$('swap-estado-live'); if(el){ el.textContent=status; el.style.color=status==='active'?'#166534':'#991b1b'; }
    }catch(e){ blkSt('estado','#dc2626','Error: '+e.message); toast('Estado: '+e.message,'error'); }
    finally{ const b=$('blk-btn-'+key); if(b){ b.disabled=false; b.textContent=(key==='estadoOn'?'Activar publicación':'Pausar'); } }
  });
}

// ── SECCIÓN MAESTRO: tabla editable con TODAS las columnas del Excel maestro ────────────────────────────
// Muestra el maestro extendido (_pm) con columnas configurables (toggles persistidos en localStorage —
// van a crecer, así que se elige qué ver), descuentos Premium/Clásica EDITABLES (recalculan el precio del
// tier = precio full × (1 − desc/100) y persisten en pub_master), y ACOS/ROAS EN VIVO de Mercado Ads
// (mismo blob que el margen real, cache 24h compartido por localStorage 'parka_adscosts_v1').
const MST_COLS = [
  { key:'model',      label:'Modelo' },
  { key:'art',        label:'Artículo' },
  { key:'marca',      label:'Marca' },
  { key:'skus',       label:'SKUs' },
  { key:'pubs',       label:'Publicaciones' },
  { key:'landed',     label:'Landed USD' },
  { key:'landedARS',  label:'Landed $' },
  { key:'price',      label:'Precio full ARS' },
  { key:'descPrem',   label:'Desc Premium %' },
  { key:'precioPrem', label:'Precio Premium' },
  { key:'descClas',   label:'Desc Clásica %' },
  { key:'precioClas', label:'Precio Clásica' },
  { key:'acos',       label:'ACOS %' },
  { key:'roas',       label:'ROAS' },
  { key:'costoReal',  label:'Costo real' },
  { key:'devolEsp',   label:'Devol. esp.' },
  { key:'margen',     label:'Margen $' },
  { key:'margenPct',  label:'Margen %' },
  { key:'esAbrigo',   label:'¿Abrigo?' },
  { key:'imper',      label:'Impermeabilidad' },
  { key:'abrigo',     label:'Abrigo (relleno)' },
  { key:'tipologia',  label:'Tipología' },
];
const MST_BYKEY={}; MST_COLS.forEach(c=>{ MST_BYKEY[c.key]=c; });
let _mstCols=null, _mstRows=[], _mstAds=null, _mstAdsLoading=false, _pmSaveT=null, _mstColOrder=null, _mstDrag=null, _mstPubCount={}, _mstMlc=null, _mstMlcLoading=false, _mstDolar=null, _mstSort={key:null,dir:null};
let _mstRetRate=null, _mstRetDev=null, _mstRetFlete=null, _mstRetCov=null;   // tasa de devolución + costo esperado/unidad (tasa × flete real) + flete de vuelta promedio + cobertura, por modelo
let _mstShipAgg=null;   // promedio real del flete de IDA por modelo (set completo, de /api/ml/ship-agg): {nm:{avg,n,pending}}
// Señales del Radar (Build 1): ventas 14d por item (del almacén) + visitas 14d por item (ML, cacheadas 6h).
// Alimentan cobertura (días) y conversión, con las MISMAS fórmulas que promos.ts groupItems (ver radarModelSignals).
let _psales2w=null;     // {itemId: unidades 14d} — mismo blob que usa Promos (warehouse.sales)
let _psalesTs=0;        // antigüedad del blob de ventas (tsSales); si está viejo NO calculamos conversión
// Orden de columnas (persistido). Filtra keys viejas y agrega columnas nuevas al final (para cuando sumemos).
function mstOrder(){
  if(!_mstColOrder){
    let s=null; try{ s=JSON.parse(localStorage.getItem('parka_maestro_colorder_v1')||'null'); }catch(e){}
    const def=MST_COLS.map(c=>c.key);
    _mstColOrder = Array.isArray(s) ? s.filter(k=>MST_BYKEY[k]).concat(def.filter(k=>!s.includes(k))) : def;
  }
  return _mstColOrder;
}
// Drag & drop de las pastillas → reordena columnas (además del clic que muestra/oculta)
function maestroDragStart(ev,key){ _mstDrag=key; try{ ev.dataTransfer.effectAllowed='move'; }catch(e){} }
function maestroDragOver(ev){ ev.preventDefault(); try{ ev.dataTransfer.dropEffect='move'; }catch(e){} }
function maestroDrop(ev,key){
  ev.preventDefault();
  if(!_mstDrag||_mstDrag===key){ _mstDrag=null; return; }
  const ord=mstOrder().slice(); const from=ord.indexOf(_mstDrag), to=ord.indexOf(key);
  if(from<0||to<0){ _mstDrag=null; return; }
  ord.splice(from,1); ord.splice(to,0,_mstDrag);
  _mstColOrder=ord; try{ localStorage.setItem('parka_maestro_colorder_v1', JSON.stringify(ord)); }catch(e){}
  _mstDrag=null; maestroRender();
}
// Exporta un .xlsx con las columnas VISIBLES en el orden actual (todas las filas del maestro).
function maestroExport(){
  if(!_pm||!_pm.models||!Object.keys(_pm.models).length){ toast('No hay maestro para exportar','error'); return; }
  const st=mstColState(); const adsM=(_mstAds&&_mstAds.models)||{};
  const cols=mstOrder().map(k=>MST_BYKEY[k]).filter(c=>c&&st[c.key]);
  const rows=(_mstRows&&_mstRows.length?_mstRows:Object.keys(_pm.models).sort((a,b)=>String(_pm.models[a].model).localeCompare(String(_pm.models[b].model))).map(k=>_pm.models[k]));
  const data=rows.map(m=>{ const ad=adsM[norm(m.model)]; const o={};
    cols.forEach(c=>{ let v='';
      if(c.key==='model') v=m.model;
      else if(c.key==='skus') v=(m.skus||[]).join(', ');
      else if(c.key==='pubs'){ const pc=_mstPubCount[norm(m.model)]; v=pc?pc.total:0; }
      else if(c.key==='acos') v=(ad&&ad.acos!=null)?ad.acos:'';
      else if(c.key==='roas') v=(ad&&ad.roas!=null)?ad.roas:'';
      else if(c.key==='costoReal'){ const mm=mstMargin(m); v=mm?Math.round(mm.costoReal):''; }
      else if(c.key==='margen'){ const mm=mstMargin(m); v=mm?Math.round(mm.margen):''; }
      else if(c.key==='margenPct'){ const mm=mstMargin(m); v=(mm&&mm.margenPct!=null)?Math.round(mm.margenPct):''; }
      else if(c.key==='devolEsp'){ const mm=mstMargin(m); v=(mm&&mm.devNet>0)?Math.round(mm.devNet):''; }
      else if(c.key==='landedARS'){ const P=mstParams(); v=m.landed!=null?Math.round(m.landed*P.dolar):''; }
      else if(c.key==='esAbrigo') v=(m.esAbrigo===true?'Sí':(m.esAbrigo===false?'No':''));
      else { const raw=m[c.key]; v=(raw!=null?raw:''); }
      o[c.label]=v;
    });
    return o;
  });
  try{
    const ws=XLSX.utils.json_to_sheet(data, { header: cols.map(c=>c.label) });
    const wb=XLSX.utils.book_new(); XLSX.utils.book_append_sheet(wb, ws, 'Maestro');
    XLSX.writeFile(wb, 'maestro-parka.xlsx');
    toast('✓ Excel exportado ('+data.length+' filas · '+cols.length+' columnas)','success');
  }catch(e){ toast('Error exportando: '+e.message,'error'); }
}
function mstColState(){
  if(_mstCols) return _mstCols;
  let s=null; try{ s=JSON.parse(localStorage.getItem('parka_maestro_cols_v1')||'null'); }catch(e){}
  _mstCols={}; MST_COLS.forEach(c=>{ _mstCols[c.key] = (s&&typeof s[c.key]==='boolean') ? s[c.key] : true; });
  _mstCols.model=true;   // el modelo siempre visible (ancla de la fila)
  return _mstCols;
}
function maestroToggleCol(key){
  if(key==='model') return;
  const st=mstColState(); st[key]=!st[key];
  try{ localStorage.setItem('parka_maestro_cols_v1', JSON.stringify(st)); }catch(e){}
  maestroRender();
}
// ACOS/ROAS: mismo endpoint y cache que el margen real (comparten el localStorage key)
async function maestroEnsureAds(force){
  if(_mstAds && !force) return _mstAds;
  if(!force){ try{ const c=JSON.parse(localStorage.getItem('parka_adscosts_v1')||'null'); if(c&&c.data&&(Date.now()-c.ts<24*60*60*1000)){ _mstAds=c.data; return _mstAds; } }catch(e){} }
  try{ const r=await apiGet('/api/ml/ads-costs'); if(r&&r.ok){ _mstAds=r; try{ localStorage.setItem('parka_adscosts_v1', JSON.stringify({ts:Date.now(),data:r})); }catch(e){} } }catch(e){}
  return _mstAds;
}
// Costo esperado de devolución por modelo: el flete de vuelta REAL (receiver.cost, de /api/returns) agregado
// por modelo con el MISMO resolver SKU→modelo que Devoluciones/rsmBuild, ventana 30d. _mstRetCost[nm] = Σ del
// flete real de las devoluciones YA sincronizadas del modelo; _mstRetCov[nm] = {cnt costeadas, all totales}
// para avisar cobertura. Las pendientes (ret_cost NULL) NO suman: el margen arranca conservador (subcuenta el
// costo) y baja a lo exacto cuando el backfill termina de sincronizar. Sin número inventado.
async function maestroEnsureReturns(force){
  if(_mstRetDev && !force) return _mstRetDev;
  try{
    const [rr, mm] = await Promise.all([ apiGet('/api/returns'), apiGet('/api/sku-master') ]);
    const rows = (rr && rr.rows) || [];
    let master = {}; try{ master = (mm && (typeof mm.data==='string'? JSON.parse(mm.data) : mm.data)) || {}; }catch(e){}
    const resolveModel = makeSkuModelResolver(master, (S&&S.PC_PRODUCTS)||[]);
    // Ventana ALINEADA con la sección Devoluciones (desde FROM): tasa = devoluciones ÷ ventas del MISMO
    // período. Dividir devoluciones-30d por ventas-30d daba >100% por el LAG (una devolución de hoy es de
    // una venta de semanas atrás). weekTs replica el parser de Devoluciones para filtrar VML_WEEKS.
    const FROM_TS = Date.parse('2026-03-01T00:00:00-03:00');
    const weekTs = (w)=>{ if(w&&typeof w._ts==='number'&&w._ts) return w._ts; const lab=String((w&&w.label)||''); let m=lab.match(/(\d{2})\/(\d{2})\/(\d{2})\s*$/); if(m) return Date.parse('20'+m[3]+'-'+m[2]+'-'+m[1]+'T00:00:00-03:00'); m=lab.match(/^(\d{2})\/(\d{2})/); return m?Date.parse('2026-'+m[2]+'-'+m[1]+'T00:00:00-03:00'):0; };
    // Ventas por modelo (VML_WEEKS desde FROM), mismo resolver → misma clave que devoluciones y margen.
    const salesVML={};
    (S&&S.VML_WEEKS||[]).forEach(w=>{ const ts=weekTs(w); if(ts && ts<FROM_TS) return; const sk=(w&&w.skus)||{};
      Object.keys(sk).forEach(sku=>{ const q=sk[sku]||0; const base=vmlBaseCode(String(sku).toLowerCase().replace(/\s+/g,'-')); const mdl=resolveModel(base); if(!mdl) return; const nm=norm(mdl); salesVML[nm]=(salesVML[nm]||0)+q; }); });
    // Devoluciones por modelo (todo /api/returns, que ya es desde FROM): junto el ret_cost de CADA una
    // (NULL=sin chequear · 0=cerrado sin flete · >0=flete real; la distinción la hace returnsModelStats).
    const retCosts={};   // nm -> [ret_cost,...]
    for(const r of rows){ const base=r.sku?vmlBaseCode(String(r.sku).toLowerCase().replace(/\s+/g,'-')):''; const mdl=base?resolveModel(base):''; if(!mdl) continue; const nm=norm(mdl);
      (retCosts[nm]||(retCosts[nm]=[])).push(r.ret_cost); }
    // Tasa (métrica 7) + costo esperado/unidad (métrica 8) por modelo — aritmética pura en returns-math.ts.
    // flete[nm]=fleteAvg se expone aparte para que mstMarginCalc (mst-math.ts) recomponga devUnit con los
    // MISMOS operandos → resultado float-idéntico. salesVML = ventas de la ventana ALINEADA (misma que las
    // devoluciones, ambas desde FROM) para no dar >100% por el lag venta→devolución.
    const rate={}, devU={}, flete={}, cov={};
    Object.keys(retCosts).forEach(nm=>{ const st=returnsModelStats(retCosts[nm], salesVML[nm]||0);
      rate[nm]=st.rate; devU[nm]=st.devUnit; flete[nm]=st.fleteAvg; cov[nm]=st.cov; });
    _mstRetRate=rate; _mstRetDev=devU; _mstRetFlete=flete; _mstRetCov=cov;
  }catch(e){}
  return _mstRetDev;
}
// Promedio real del flete de IDA por modelo, sobre el SET COMPLETO (D1, /api/ml/ship-agg). Reemplaza la
// muestra de 3 de mlcosts en el margen; mientras se llena (backfill del cron), los modelos sin promedio
// caen al fallback de la muestra. Cache de sesión (barato, 1 GET).
// ATRIBUCIÓN: ship-agg entrega sumas crudas por seller_sku (spaid/npaid); resolvemos SKU→modelo con el
// resolver ÚNICO y agregamos por modelo → avg=Σspaid/Σnpaid (promediar promedios sería mal ponderado).
// Nunca por el modelo vivo de la publicación (regla dura). Misma forma de salida {nm:{avg,n,pending}}.
async function maestroEnsureShipAgg(force){
  if(_mstShipAgg && !force) return _mstShipAgg;
  try{
    const [r, mm] = await Promise.all([ apiGet('/api/ml/ship-agg'), apiGet('/api/sku-master') ]);
    if(r&&r.ok&&r.bySku){
      let master={}; try{ master=(mm && (typeof mm.data==='string'? JSON.parse(mm.data) : mm.data)) || {}; }catch(e){}
      const resolveModel=makeSkuModelResolver(master, (S&&S.PC_PRODUCTS)||[]);
      const byModel={};
      for(const sku in r.bySku){ const base=vmlBaseCode(String(sku).toLowerCase().replace(/\s+/g,'-')); const mdl=resolveModel(base); if(!mdl) continue; const nm=norm(mdl);
        const g=byModel[nm]||(byModel[nm]={spaid:0,npaid:0,pending:0}); const s=r.bySku[sku];
        g.spaid+=(s.spaid||0); g.npaid+=(s.npaid||0); g.pending+=(s.pending||0); }
      const out={};
      for(const nm in byModel){ const g=byModel[nm]; out[nm]={ avg: shipAvg(g.spaid, g.npaid), n:g.npaid, pending:g.pending }; }
      _mstShipAgg=out;
    }
  }catch(e){}
  return _mstShipAgg;
}
function maestroSaveDebounced(){
  if(_pmSaveT) clearTimeout(_pmSaveT);
  // Guardado HONESTO: esperamos la respuesta y confirmamos "✓" SOLO si el PUT llegó (2xx). apiPut es
  // fire-and-forget → antes el toast de éxito salía aunque fallara la red/D1 y la edición se perdía en
  // silencio (Martin creía guardado lo que no estaba). Ahora: await + 1 reintento + toast que dice la verdad.
  _pmSaveT=setTimeout(async ()=>{ _pmSaveT=null;
    const payload={ data: JSON.stringify(_pm) };
    let r=await apiPutEx('/api/pub-master', payload);
    if(!r.ok){ await new Promise(res=>setTimeout(res,1200)); r=await apiPutEx('/api/pub-master', payload); }
    if(r.ok) toast('✓ Maestro guardado','success');
    else toast('⚠️ NO se guardó el maestro — tu edición quedó local, reintentá ('+(r.error||('HTTP '+r.status))+')','error');
  }, 1000);
}
// Editar descuento de un tier → recalcula el precio del tier (full × (1−desc/100)) y persiste. NO re-renderiza
// (para no perder el foco del input): actualiza en vivo la celda del precio derivado por id.
function maestroEditDesc(i, tier, valStr){
  const m=_mstRows[i]; if(!m){ return; }
  const v=parseFloat(String(valStr).replace(',','.'));
  const d=(isFinite(v)&&v>=0&&v<=90)?v:null;
  const precio=(d!=null && m.price!=null)?Math.round(m.price*(1-d/100)):null;
  if(tier==='prem'){ m.descPrem=d; m.precioPrem=precio; }
  else{ m.descClas=d; m.precioClas=precio; }
  const cell=$('mst-'+tier+'p-'+i); if(cell) cell.textContent = precio!=null?money(precio):'—';
  if(m.price==null) toast('Ese modelo no tiene Precio full — cargalo para que el descuento calcule un precio','error');
  maestroSaveDebounced();
}
async function maestroRefreshAds(){
  const btn=$('maestro-refresh-btn'); if(btn){ btn.disabled=true; btn.textContent='Actualizando…'; }
  await maestroEnsureAds(true);
  if(btn){ btn.disabled=false; btn.textContent='↻ Actualizar ACOS/ROAS'; }
  maestroRender();
}
// Dólar oficial del día (venta, referencia BNA/BCRA) para convertir el landed USD → pesos. Cache 6h
// (backend en KV + local). Reemplaza el dólar manual para el landed/margen del Maestro.
async function maestroEnsureDolar(){
  if(_mstDolar) return _mstDolar;
  try{ const c=JSON.parse(localStorage.getItem('parka_dolar_v1')||'null'); if(c&&c.venta&&(Date.now()-(c._ts||0)<6*60*60*1000)){ _mstDolar=c; return _mstDolar; } }catch(e){}
  try{ const r=await apiGet('/api/dolar'); if(r&&r.ok&&r.venta){ _mstDolar={venta:r.venta, fecha:r.fecha||null, _ts:Date.now()}; try{ localStorage.setItem('parka_dolar_v1', JSON.stringify(_mstDolar)); }catch(e){} } }catch(e){}
  return _mstDolar;
}
// Parámetros: dólar del día (o, si falla, el override manual mx-dolar de la Matriz) + impuestos (PC_PARAMS).
function mstParams(){ const P=(S&&S.PC_PARAMS)||{}; const dol=(_mstDolar&&+_mstDolar.venta)||+P['mx-dolar']||1510; return { dolar:dol, iibb:(+P['mx-iibb']||5)/100, impdc:(+P['mx-impdc']||1.2)/100 }; }
// Costo/margen REAL por modelo (NETO de IVA, RI): landed del maestro (USD×dólar) + comisión/envío/precio
// reales de ventas (mlcosts) + publicidad (ads-costs) + IIBB + Imp.déb/créd. null si falta venta o landed.
// La comisión real ya incluye las cuotas reales que ofreciste (no el 27,8% teórico de 6 cuotas).
function mstMargin(m){
  const nm=norm(m.model);
  const mlc=_mstMlc && _mstMlc[nm];
  const ad=(_mstAds&&_mstAds.models)?_mstAds.models[nm]:null;
  const P=mstParams();
  // RESOLUCIÓN impura de los insumos (globales precomputados); la ARITMÉTICA vive en mstMarginCalc
  // (mst-math.ts, pura + testeada). Envío: promedio REAL sobre el set completo (ship-agg, D1); si un
  // modelo todavía no tiene promedio (backfill en curso), cae a la muestra de mlcosts.
  const shipA=(_mstShipAgg && _mstShipAgg[nm] && _mstShipAgg[nm].avg!=null) ? _mstShipAgg[nm] : null;
  const envBruto = shipA ? shipA.avg : (mlc && mlc.envio!=null ? mlc.envio : null);
  // Devolución: tasa (métrica 7) × flete de vuelta promedio (ambos de maestroEnsureReturns). `!=null`
  // explícito para blindar el caso de globales todavía en null (returns no cargados) — devUnit 0.
  const tasaDev=(_mstRetRate!=null && _mstRetRate[nm]!=null) ? _mstRetRate[nm] : null;
  const fleteVueltaProm=(_mstRetFlete!=null && _mstRetFlete[nm]!=null) ? _mstRetFlete[nm] : 0;
  const core=mstMarginCalc({
    precioReal: mlc ? mlc.precioReal : null,
    landedUSD: m.landed,
    dolar: P.dolar,
    comisUnit: mlc ? mlc.comisUnit : null,
    envBruto,
    adsCost: ad ? ad.cost : null,
    adsQty: mlc ? mlc.qty : null,
    iibb: P.iibb, impdc: P.impdc,
    tasaDev, fleteVueltaProm,
  }, 1.21);
  if(!core) return null;
  const envN=shipA?shipA.n:((mlc&&mlc.envN)||0), envFull=!!shipA;
  const devCov=(_mstRetCov && _mstRetCov[nm]) ? _mstRetCov[nm] : null;
  return { costoReal:core.costoReal, margen:core.margen, margenPct:core.margenPct, landedARS:core.landedARS,
           comisNet:core.comisNet, envNet:core.envNet, envN, envFull, adsNet:core.adsNet, iibbC:core.iibbC,
           impdcC:core.impdcC, devNet:core.devNet, devUnit:core.devUnit, devCov, noEnvio:core.noEnvio };
}
// Trae comisión+envío reales de ventas (reusa ensureMlCosts de promos.ts — scan pesado, cache 24h).
async function maestroCalcMargen(){
  const btn=$('maestro-margen-btn'); if(btn){ btn.disabled=true; btn.textContent='Calculando margen…'; }
  _mstMlcLoading=true; maestroRender();
  try{ const r = (window.ensureMlCosts ? await window.ensureMlCosts(false) : null); if(r) _mstMlc=r; }
  catch(e){ toast('No pude calcular el margen: '+(e&&e.message||e),'error'); }
  _mstMlcLoading=false;
  if(btn){ btn.disabled=false; btn.textContent='↻ Recalcular margen'; }
  maestroRender();
}
// Valor comparable de una columna (para ordenar): número donde corresponde, string en modelo/art/marca.
function mstSortVal(m, key){
  const nm=norm(m.model);
  if(key==='model') return String(m.model||'').toLowerCase();
  if(key==='art') return String(m.art||'').toLowerCase();
  if(key==='marca') return String(m.marca||'').toLowerCase();
  if(key==='skus') return (m.skus||[]).length;
  if(key==='pubs'){ const pc=_mstPubCount[nm]; return pc?pc.total:0; }
  if(key==='landedARS'){ return m.landed!=null?m.landed*mstParams().dolar:null; }
  if(key==='acos'){ const ad=(_mstAds&&_mstAds.models)?_mstAds.models[nm]:null; return ad?ad.acos:null; }
  if(key==='roas'){ const ad=(_mstAds&&_mstAds.models)?_mstAds.models[nm]:null; return ad?ad.roas:null; }
  if(key==='costoReal'||key==='margen'||key==='margenPct'){ const mm=mstMargin(m); return mm?mm[key]:null; }
  const v=m[key]; return v!=null?v:null;   // landed, price, descPrem, precioPrem, descClas, precioClas
}
// Clic en el título: 1º asc, 2º desc, 3º sin orden (tri-state, como pidió Martin).
function maestroSort(key){
  if(_mstSort.key!==key) _mstSort={key, dir:'asc'};
  else if(_mstSort.dir==='asc') _mstSort={key, dir:'desc'};
  else _mstSort={key:null, dir:null};
  maestroRender();
}
function maestroRender(){
  const host=$('maestro-root'); if(!host) return;
  if(!_pm||!_pm.models||!Object.keys(_pm.models).length){
    host.innerHTML='<div style="font-size:13px;color:#d97706;padding:10px">Sin maestro cargado todavía — subí el Excel con el botón de arriba (ART · SKU · Nombre Modelo · Landed · Precio full · Desc Premium/Clásica · Precio Premium/Clásica · Marca).</div>';
    return;
  }
  const st=mstColState();
  const adsM=(_mstAds&&_mstAds.models)||{};
  const nmOf=m=>norm(m.model);
  // toggles de columnas (chips): clic = mostrar/ocultar · arrastrar = reordenar
  let h='<div style="display:flex;flex-wrap:wrap;gap:6px;margin-bottom:4px">';
  mstOrder().forEach(k=>{ const c=MST_BYKEY[k]; if(!c) return; const on=!!st[c.key];
    h+='<button draggable="true" ondragstart="maestroDragStart(event,\''+c.key+'\')" ondragover="maestroDragOver(event)" ondrop="maestroDrop(event,\''+c.key+'\')" onclick="maestroToggleCol(\''+c.key+'\')" title="Clic: mostrar/ocultar · arrastrá para reordenar" style="font-size:11px;padding:3px 10px;border-radius:12px;border:1px solid '+(on?'var(--accent)':'var(--border)')+';background:'+(on?'var(--accent)':'transparent')+';color:'+(on?'#fff':'var(--text-muted)')+';cursor:grab">'+esc(c.label)+'</button>';
  });
  h+='</div><div style="font-size:10px;color:var(--text-soft);margin-bottom:10px">Clic en una pastilla = mostrar/ocultar la columna · arrastrala para cambiar el orden</div>';
  _mstRows=Object.keys(_pm.models).sort((a,b)=>String(_pm.models[a].model).localeCompare(String(_pm.models[b].model))).map(k=>_pm.models[k]);
  if(_mstSort.key){ const dir=_mstSort.dir==='desc'?-1:1; _mstRows.sort((a,b)=>{ const va=mstSortVal(a,_mstSort.key), vb=mstSortVal(b,_mstSort.key); if(va==null&&vb==null)return 0; if(va==null)return 1; if(vb==null)return -1; return ((typeof va==='number'&&typeof vb==='number')?(va-vb):String(va).localeCompare(String(vb)))*dir; }); }
  const vis=mstOrder().map(k=>MST_BYKEY[k]).filter(c=>c&&st[c.key]);
  const withAds=_mstRows.filter(m=>adsM[nmOf(m)]).length;
  const adsTxt = _mstAds ? (' · ACOS/ROAS '+_mstAds.dateFrom+' → '+_mstAds.dateTo+' ('+withAds+' con ads)') : (_mstAdsLoading ? ' · <span style="color:var(--text-soft)">trayendo ACOS/ROAS…</span>' : ' · <span style="color:#d97706">sin datos de ads — apretá «Actualizar ACOS/ROAS»</span>');
  const withMargin=_mstMlc?_mstRows.filter(m=>mstMargin(m)).length:0;
  const margenTxt = _mstMlc ? (' · <b>margen real</b> en '+withMargin+' modelos con ventas') : (_mstMlcLoading ? ' · <span style="color:var(--text-soft)">calculando margen real…</span>' : ' · <span style="color:#d97706">margen sin calcular — apretá «Margen real»</span>');
  const dolTxt = _mstDolar ? (' · <b>dólar $'+_mstDolar.venta+'</b>'+(_mstDolar.fecha?(' ('+String(_mstDolar.fecha).slice(0,10)+')'):'')) : '';
  h+='<div style="font-size:11px;color:var(--text-muted);margin-bottom:8px">'+_mstRows.length+' modelos'+adsTxt+margenTxt+dolTxt+' · Landed $ = landed USD × dólar del día. Margen NETO de IVA = landed + comisión + envío + ads + IIBB + imp.déb/créd + devolución esperada (flete de vuelta real).</div>';
  h+='<div style="max-height:72vh;overflow:auto;border:1px solid var(--border);border-radius:8px"><table style="width:100%;font-size:12px;border-collapse:collapse"><thead><tr style="text-align:right;color:var(--text-muted);font-size:11px">';
  vis.forEach((c,ci)=>{ const ar=_mstSort.key===c.key?(_mstSort.dir==='asc'?' ↑':' ↓'):''; h+='<th onclick="maestroSort(\''+c.key+'\')" title="Ordenar: clic asc → desc → sin orden" style="padding:4px 6px;cursor:pointer;user-select:none;white-space:nowrap;position:sticky;top:0;z-index:5;'+(ci===0?'text-align:left':'')+'">'+esc(c.label)+ar+'</th>'; });
  h+='</tr></thead><tbody>';
  _mstRows.forEach((m,i)=>{
    const nm=nmOf(m); const ad=adsM[nm]; const mm=mstMargin(m);
    h+='<tr style="border-top:1px solid var(--border2);text-align:right">';
    vis.forEach((c,ci)=>{
      const left=ci===0?'text-align:left;':'';
      let cell='<span style="color:var(--text-soft)">—</span>';
      if(c.key==='model') cell='<span style="text-transform:capitalize;font-weight:600">'+esc(m.model)+'</span>';
      else if(c.key==='art') cell = m.art?('<span style="color:var(--text-soft);font-variant-numeric:tabular-nums">'+esc(m.art)+'</span>'):'<span style="color:var(--text-soft)">—</span>';
      else if(c.key==='marca') cell = m.marca?esc(m.marca):cell;
      else if(c.key==='skus') cell = '<span title="'+esc((m.skus||[]).join(', '))+'" style="color:var(--text-soft)">'+((m.skus||[]).length)+'</span>';
      else if(c.key==='pubs'){ const pc=_mstPubCount[nm]; cell = pc?('<span title="'+pc.active+' activas de '+pc.total+' en el catálogo">'+pc.total+(pc.active!==pc.total?(' <span style="color:var(--text-soft)">('+pc.active+' act)</span>'):'')+'</span>'):'<span style="color:var(--text-soft)">0</span>'; }
      else if(c.key==='landed') cell = m.landed!=null?('US$'+Math.round(m.landed).toLocaleString('es-AR')):cell;
      else if(c.key==='landedARS'){ const P=mstParams(); cell = m.landed!=null?('<span title="US$'+Math.round(m.landed)+' × '+P.dolar+'">'+money(m.landed*P.dolar)+'</span>'):cell; }
      else if(c.key==='price') cell = m.price!=null?money(m.price):cell;
      else if(c.key==='descPrem') cell = '<input type="number" min="0" max="90" step="0.5" value="'+(m.descPrem!=null?m.descPrem:'')+'" onchange="maestroEditDesc('+i+',\'prem\',this.value)" style="width:56px;font-size:12px;padding:3px 5px;text-align:right;border:1px solid var(--border);border-radius:5px;background:var(--card)">';
      else if(c.key==='precioPrem') cell = '<span id="mst-premp-'+i+'">'+(m.precioPrem!=null?money(m.precioPrem):'—')+'</span>';
      else if(c.key==='descClas') cell = '<input type="number" min="0" max="90" step="0.5" value="'+(m.descClas!=null?m.descClas:'')+'" onchange="maestroEditDesc('+i+',\'clas\',this.value)" style="width:56px;font-size:12px;padding:3px 5px;text-align:right;border:1px solid var(--border);border-radius:5px;background:var(--card)">';
      else if(c.key==='precioClas') cell = '<span id="mst-clasp-'+i+'">'+(m.precioClas!=null?money(m.precioClas):'—')+'</span>';
      else if(c.key==='acos'){ const v=ad?ad.acos:null; const lt=acosLight(v); const col=lt==null?'var(--text-soft)':(lt==='green'?'#16a34a':(lt==='amber'?'#d97706':'#dc2626')); cell='<span style="color:'+col+'">'+(v!=null?v+'%':'—')+'</span>'; }
      else if(c.key==='roas'){ const v=ad?ad.roas:null; const col=v==null?'var(--text-soft)':(v>=8?'#16a34a':(v>=5?'#d97706':'#dc2626')); cell='<span style="color:'+col+'" title="'+(ad?(ad.pubs+' pub · gasto 30d $'+Math.round(ad.cost).toLocaleString('es-AR')):'')+'">'+(v!=null?v:'—')+'</span>'; }
      else if(c.key==='costoReal') cell = mm?('<span title="landed '+money(mm.landedARS)+' · comisión '+money(mm.comisNet)+' · envío '+money(mm.envNet)+' ('+(mm.envFull?'set completo':'muestra')+' n'+mm.envN+') · ads '+money(mm.adsNet)+' · IIBB '+money(mm.iibbC)+' · imp.d/c '+money(mm.impdcC)+' · devol. '+money(mm.devNet)+' — neto de IVA">'+money(mm.costoReal)+'</span>'):cell;
      else if(c.key==='devolEsp'){ if(mm){ const cov=mm.devCov; const covTxt=cov?(cov.cnt+'/'+cov.all+' devoluciones (30d) con flete sincronizado'+(cov.cnt<cov.all?' — el resto se completa al sincronizar':'')):'sin devoluciones en 30d'; cell='<span title="'+esc(covTxt)+'"'+(cov&&cov.cnt<cov.all?' style="color:#d97706"':'')+'>'+(mm.devNet>0?money(mm.devNet):'—')+(cov&&cov.cnt<cov.all?' *':'')+'</span>'; } }
      else if(c.key==='margen'){ if(mm){ const col=mm.margen<0?'#dc2626':((mm.margenPct||0)<15?'#d97706':'#16a34a'); cell='<span style="color:'+col+';font-weight:700"'+(mm.noEnvio?' title="sin muestra de envío — margen optimista"':'')+'>'+money(mm.margen)+(mm.noEnvio?' *':'')+'</span>'; } }
      else if(c.key==='margenPct'){ if(mm&&mm.margenPct!=null){ const col=mm.margenPct<10?'#dc2626':(mm.margenPct<25?'#d97706':'#16a34a'); cell='<span style="color:'+col+';font-weight:700">'+Math.round(mm.margenPct)+'%</span>'; } }
      else if(c.key==='esAbrigo') cell = (m.esAbrigo===true)?'Sí':((m.esAbrigo===false)?'<span style="color:#d97706" title="clasificado como NO abrigo (no entra en la señal de clima)">No</span>':cell);
      else if(c.key==='imper') cell = m.imper?('<span style="color:var(--text-soft)">'+esc(m.imper)+'</span>'):cell;
      else if(c.key==='abrigo') cell = m.abrigo?('<span style="color:var(--text-soft)">'+esc(m.abrigo)+'</span>'):cell;
      else if(c.key==='tipologia') cell = m.tipologia?esc(m.tipologia):cell;
      h+='<td style="padding:5px 6px;'+left+'">'+cell+'</td>';
    });
    h+='</tr>';
  });
  h+='</tbody></table></div>';
  host.innerHTML=h;
}
// Cantidad de publicaciones por modelo, desde el catálogo del warehouse (total + activas). Dato VIVO
// (no vive en el maestro): un modelo puede tener varias MLA. norm(model) cruza con las keys del maestro.
function buildPubCount(){
  _mstPubCount={};
  (_pcat||[]).forEach(it=>{ const nm=norm(it.model); if(!nm) return; const c=_mstPubCount[nm]||(_mstPubCount[nm]={total:0,active:0}); c.total++; if(it.status==='active') c.active++; });
}
// Carga + render (entry de la sección MAESTRO). Pinta el maestro AL TOQUE (no espera a ads); ACOS/ROAS
// llegan después (cache local o red ~10s) y re-pinta. Así la tabla no queda vacía esperando la publicidad.
async function maestroLoad(){
  await pubEnsureMaster();
  try{ await pubEnsureCat(); buildPubCount(); }catch(e){}   // conteo de publicaciones (catálogo)
  try{ await maestroEnsureDolar(); }catch(e){}             // dólar del día (landed → pesos)
  // margen real: usar el cache de ventas si está fresco (<24h); el scan pesado queda para el botón «Margen real»
  if(!_mstMlc){ try{ const c=JSON.parse(localStorage.getItem('parka_mlcosts_v3')||'null'); if(c&&c.data&&(Date.now()-c.ts<24*60*60*1000)) _mstMlc=c.data; }catch(e){} }
  if(!_mstAds) _mstAdsLoading=true;
  maestroRender();
  await maestroEnsureAds(false);
  _mstAdsLoading=false;
  try{ await maestroEnsureReturns(false); }catch(e){}   // costo esperado de devolución (flete real por modelo)
  try{ await maestroEnsureShipAgg(false); }catch(e){}   // promedio de envío full-set (reemplaza la muestra)
  maestroRender();
}

// ── Entry de la sección ──────────────────────────────────────────────────────────────────────────────
async function pubRender(){
  await pubEnsureMaster();
  pubRenderMaster();
}
try{ Object.assign(window,{ pubRender, pubMasterFile, pubSearch, pubPick, pubDestModelChanged, pubSrcPick, pubSwapTab, pubBlkPrecio, pubBlkVariantes, swapAliasToggle, swapTitleInput, swapGarmentInput, pubBlkGarment, pubBlkEstado, pubBlkCarac, pubBlkGuia, pubBlkTitulo, titleUseCurrent, swapSuggest, swapSuggFilter, swapSuggPick, swapSuggSearch, maestroLoad, maestroRender, maestroToggleCol, maestroEditDesc, maestroRefreshAds, maestroExport, maestroDragStart, maestroDragOver, maestroDrop, maestroCalcMargen, maestroSort }); }catch(e){}
// ── Seam Fase 3 (migra con su estado a maestro.ts/swap.ts cuando se extraigan) ─────────────────────
// Reads = live-binding exports: radar.ts los usa verbatim y siempre con el valor actual. Los writes al
// estado que QUEDA acá van por setter (un binding importado es read-only). OJO: _mstMlc/_mstMlcLoading
// tienen DOS escritores mientras vivan acá — el maestro (directo, este archivo) y radar (vía setter);
// al extraer maestro.ts hereda ambos.
function setMstMlc(v){ _mstMlc=v; }
function setMstMlcLoading(v){ _mstMlcLoading=v; }
export {
  pubRender,
  norm, esc, $,
  mstMargin, pubEnsureMaster, pubEnsureCat,
  maestroEnsureDolar, maestroEnsureAds, maestroEnsureReturns, maestroEnsureShipAgg,
  _pm, _pcat, _psales2w, _psalesTs, _mstMlc, _mstMlcLoading, _mstRetRate, _mstAds,
  setMstMlc, setMstMlcLoading,
}

