// @ts-nocheck
// ── RADAR DE DECISIONES (Fase 3: extraído byte-fiel de publicaciones.ts) ─────────────────────────────
// Board diagnóstico read-only por modelo (no prescribe ni escribe precio). Trae con él sus stacks propios
// de CLIMA (Open-Meteo, ponderado por demanda) y VISITAS 14d (conversión) — radar es su único consumidor.
// El estado del MAESTRO (margen real _mstMlc, ads, devoluciones) y del catálogo (_pcat, ventas 14d) vive
// todavía en publicaciones.ts: lo LEE por seam (live-binding exports, verbatim) y ESCRIBE _mstMlc/
// _mstMlcLoading por setter (un import ES es read-only). Cuando se extraiga maestro.ts, se repunta el import.
import { toast } from './core-ui'
import { apiGet } from './api'
import { garmentClimate } from './garment'
import { stockMode, daysOfStock, conversionRate } from './inventory-math'
import {
  norm, esc, $,
  mstMargin, pubEnsureMaster, pubEnsureCat,
  maestroEnsureDolar, maestroEnsureAds, maestroEnsureReturns, maestroEnsureShipAgg,
  _pm, _pcat, _psales2w, _psalesTs, _mstMlc, _mstMlcLoading, _mstRetRate, _mstAds,
  setMstMlc, setMstMlcLoading,
} from './publicaciones'

// estado de módulo RADAR-ONLY (mudado de publicaciones.ts:894-895)
let _pvisits=null;      // {itemId: visitas 14d | null} — cache de sesión + localStorage
let _pvisitsLoading=false;

// Visitas 14d por item_id (para conversión), con la MISMA fuente y ventana que Promos (/api/ml/visits,
// last=14). ML deja 1 item por llamada; el Worker loopea (tope 40 ids/request). Cache de sesión + localStorage
// 6h (las visitas 14d se mueven lento) para no re-pegarle a ML cada vez que se abre el Radar. Igual que
// maestroEnsureAds/Returns/ShipAgg: barato, incremental (solo pide los ids que faltan).
function pvisitsLoad(){
  if(_pvisits) return;
  _pvisits={};
  try{ const c=JSON.parse(localStorage.getItem('parka_visits_v1')||'null'); if(c&&c.byItem&&(Date.now()-(c.ts||0)<6*60*60*1000)) _pvisits=c.byItem; }catch(e){}
}
let _pvisitsWhTried=false;
// Persist con MERGE: otro módulo (Promos) comparte la misma clave — pisar con solo esta copia en memoria
// borraría sus entradas; y se conserva el ts más viejo aún válido (no alargar el TTL re-estampando).
function pvisitsPersist(){
  try{
    let prev={}, prevTs=Date.now();
    try{ const c=JSON.parse(localStorage.getItem('parka_visits_v1')||'null'); if(c&&c.byItem&&(Date.now()-(c.ts||0)<6*60*60*1000)){ prev=c.byItem; prevTs=c.ts||prevTs; } }catch(e){}
    const clean={...prev}; for(const k in _pvisits){ if(_pvisits[k]!=null) clean[k]=_pvisits[k]; }
    localStorage.setItem('parka_visits_v1', JSON.stringify({ts:Math.min(prevTs, Date.now()), byItem:clean}));
  }catch(e){}
}
// Sembrar del ALMACÉN compartido (blob `visits` precomputado por el cron, TTL 26h) antes de pegarle a ML:
// el sugeridor de swap / Radar levantan las ~480 visitas de D1 en 1 GET en vez de ~480 llamadas.
async function pvisitsSeedWarehouse(){
  if(_pvisitsWhTried) return; _pvisitsWhTried=true;
  try{ const r=await apiGet('/api/warehouse?part=visits'); const v=r&&r.visits?JSON.parse(r.visits):null; const ts=r&&r.tsVisits?Date.parse(r.tsVisits):0;
    if(v && (Date.now()-ts) < 26*60*60*1000){ for(const k in v){ if(v[k]!=null && !(k in _pvisits)) _pvisits[k]=v[k]; } pvisitsPersist(); } }catch(e){}
}
async function maestroEnsureVisits(ids, onProg){
  pvisitsLoad();
  if([...new Set(ids)].some(id=>id && !(id in _pvisits))) await pvisitsSeedWarehouse();
  const want=[...new Set(ids)].filter(id=>id && !(id in _pvisits));
  if(!want.length) return _pvisits;
  for(let i=0;i<want.length;i+=40){
    if(onProg) onProg(i, want.length);
    const batch=want.slice(i,i+40);
    try{ const r=await apiGet('/api/ml/visits?ids='+encodeURIComponent(batch.join(','))); if(r&&r.ok&&r.visits) Object.assign(_pvisits, r.visits); else batch.forEach(id=>{ if(!(id in _pvisits)) _pvisits[id]=null; }); }
    catch(e){ batch.forEach(id=>{ if(!(id in _pvisits)) _pvisits[id]=null; }); }
  }
  // Persistir SOLO las visitas reales (no los null de fallos): un null es "no pude traerlo ahora", NO
  // "sin tráfico". Con MERGE (pvisitsPersist) para no pisar entradas del cache compartido con Promos.
  pvisitsPersist();
  return _pvisits;
}

// ── CLIMA (BUILD 2b) — pronóstico por punto (Open-Meteo, /api/weather) PONDERADO por dónde está la demanda
// (/api/geo-mix byZone). Da el "viento a favor/en contra" por TIPO de producto esta semana. Cache 6h. Los
// umbrales son heurísticos (calibrables por Martin). Read-only.
let _weather=null, _weatherTs=0, _geoMix=null, _geoMixTs=0;
const WEATHER_TH={ cold:11, mild:16, dry:0.15, rainy:0.40 };   // tMÍNIMA ponderada °C (mañana/noche = cuando se compra abrigo) · fracción de días con lluvia
async function maestroEnsureWeather(){
  if(_weather && (Date.now()-_weatherTs<6*60*60*1000)) return _weather;
  try{ const c=JSON.parse(localStorage.getItem('parka_weather_v1')||'null'); if(c&&c.data&&(Date.now()-c.ts<6*60*60*1000)){ _weather=c.data; _weatherTs=c.ts; return _weather; } }catch(e){}
  try{ const r=await apiGet('/api/weather'); if(r&&r.ok&&r.points){ _weather=r; _weatherTs=Date.now(); try{ localStorage.setItem('parka_weather_v1', JSON.stringify({ts:_weatherTs,data:r})); }catch(e){} } }catch(e){}
  return _weather;
}
async function maestroEnsureGeoMix(){
  if(_geoMix && (Date.now()-_geoMixTs<6*60*60*1000)) return _geoMix;
  try{ const c=JSON.parse(localStorage.getItem('parka_geomix_v2')||'null'); if(c&&c.data&&(Date.now()-c.ts<6*60*60*1000)){ _geoMix=c.data; _geoMixTs=c.ts; return _geoMix; } }catch(e){}
  try{ const r=await apiGet('/api/geo-mix?weeks=4'); if(r&&r.ok&&r.byZone){ _geoMix=r; _geoMixTs=Date.now(); try{ localStorage.setItem('parka_geomix_v2', JSON.stringify({ts:_geoMixTs,data:r})); }catch(e){} } }catch(e){}
  return _geoMix;
}
// Exposición climática PONDERADA por demanda: junta la demanda por zona (byZone) con el pronóstico del punto
// de esa zona → tmax/tmin promedio ponderado + fracción de días con lluvia. Es "el clima donde vendés".
function computeWeatherExposure(){
  if(!_weather || !_weather.points || !_geoMix || !_geoMix.byZone) return null;
  let wSum=0, tmaxAcc=0, tminAcc=0, rainAcc=0, rainW=0, allU=0, covU=0;
  for(const z of _geoMix.byZone){
    const u=z.u||0; allU+=u;
    const p=(z.point && _weather.points[z.point]) || null;
    if(!p || u<=0 || p.tmax==null) continue;
    wSum+=u; covU+=u; tmaxAcc+=u*p.tmax; tminAcc+=u*(p.tmin!=null?p.tmin:p.tmax);
    if(p.nDays>0){ rainW+=u; rainAcc+=u*((p.rainyDays||0)/p.nDays); }   // lluvia SOLO sobre zonas con pronóstico de días (evita falso "seco" por nDays=0)
  }
  if(wSum<=0) return null;
  return { wTmax:tmaxAcc/wSum, wTmin:tminAcc/wSum, wRainShare: rainW>0?rainAcc/rainW:null, coverage:allU>0?covU/allU:0, resolvedPct:(_geoMix.resolvedPct!=null?_geoMix.resolvedPct:null), capturePct:(_geoMix.capturePct!=null?_geoMix.capturePct:null), mixUnits:(_geoMix.unitsAll||0), updated:_weather.updated };
}
// Detalle del clima DESPLEGABLE (para VERIFICAR el dato crudo y ENTENDER los chips): pronóstico por zona
// (cotejable contra cualquier servicio), cómo se pondera por demanda, y las reglas de los chips. <details>
// nativo (sin JS ni diálogo). Va bajo la línea de clima del Radar.
function radarWeatherDetail(wx){
  if(!wx || !_weather || !_weather.points || !_geoMix || !_geoMix.byZone) return '';
  const T=WEATHER_TH;
  const totalU=_geoMix.byZone.reduce((s,z)=>s+(z.u||0),0)||1;
  const zs=_geoMix.byZone.slice().sort((a,b)=>(b.u||0)-(a.u||0));
  const rowsH=zs.map(z=>{ const p=(z.point&&_weather.points[z.point])||null;
    const dem=Math.round((z.u||0)/totalU*100);
    const tmax=(p&&p.tmax!=null)?Math.round(p.tmax)+'°':'—';
    const tmin=(p&&p.tmin!=null)?Math.round(p.tmin)+'°':'—';
    const rain=(p&&p.nDays>0)?Math.round((p.rainyDays||0)/p.nDays*100)+'%':'—';
    const tCol=(p&&p.tmin!=null)?(p.tmin<T.cold?'#2563eb':(p.tmin>T.mild?'#dc2626':'var(--text)')):'var(--text-soft)';   // la MÍNIMA es la que manda para abrigo
    return '<tr><td style="text-align:left">'+esc(z.label)+' <span style="color:var(--text-soft)">· '+esc(z.point||'—')+'</span></td><td>'+dem+'%</td><td style="color:var(--text-soft)">'+tmax+'</td><td style="color:'+tCol+';font-weight:600">'+tmin+'</td><td>'+rain+'</td></tr>';
  }).join('');
  const tbl='<table style="width:100%;font-size:11px;border-collapse:collapse;margin:6px 0"><thead><tr style="color:var(--text-muted);text-align:right"><th style="text-align:left">Zona · punto de pronóstico</th><th>% demanda</th><th>tmáx</th><th style="color:var(--text-muted)">tmín ★</th><th>días lluvia</th></tr></thead><tbody style="text-align:right">'+rowsH+'</tbody></table>';
  const agg='<div style="font-size:11px;color:var(--text-muted);margin:6px 0"><b>Promedio ponderado por demanda</b> = Σ(valor_zona × %demanda_zona): mín <b>'+Math.round(wx.wTmin)+'°</b> / máx <b>'+Math.round(wx.wTmax)+'°</b> · lluvia <b>'+(wx.wRainShare!=null?Math.round(wx.wRainShare*100)+'%':'—')+'</b>. La ★ mín es la que decide (mañana/noche = cuando se compra abrigo; el máx del mediodía engaña). Las zonas con más demanda pesan más. Open-Meteo, próximos 5 días.</div>';
  const reglas='<div style="font-size:11px;color:var(--text-muted);line-height:1.7"><b>Umbrales:</b> frío &lt;'+T.cold+'° · fresco '+T.cold+'–'+T.mild+'° · templado &gt;'+T.mild+'° (sobre la MÍNIMA) · seco &lt;'+Math.round(T.dry*100)+'% / lluvioso ≥'+Math.round(T.rainy*100)+'% de días con lluvia.<br><b>El driver depende del TIPO de prenda</b> (<span style="color:#16a34a">verde = a favor</span> · <span style="color:#d97706">ámbar = en contra</span>): <b>Trench/Piloto impermeable</b> → la LLUVIA (a favor si lluvioso, en contra si seco, aunque haga frío — ej. Alchemy, Gemini). <b>Abriga</b> (con relleno/leve/corderito) → el FRÍO (a favor si frío, en contra si templado; la lluvia no hace falta). <b>Liviana</b> (sin relleno) → la temperatura (a favor templado, en contra frío). Solo en semanas claras.</div>';
  return '<details style="margin-bottom:8px"><summary style="cursor:pointer;font-size:11px;color:#2e7d4f;user-select:none">🌦️ Ver detalle del clima — pronóstico por zona + reglas (para cotejar)</summary><div style="padding:8px 10px;border:1px solid var(--border2);border-radius:6px;background:var(--surface2);margin-top:4px">'+tbl+agg+reglas+'</div></details>';
}
// Agrega el catálogo VIVO (_pcat) por modelo, con el MISMO criterio que Promos (banner ~promos.ts:411-428 +
// scan de incongruencias ~700-716):
//   · STOCK compartido = un modelo puede tener varias PUBLICACIONES (family_id o item suelto) y el stock es
//     COMPARTIDO entre ellas → stock del modelo = MODA de los stocks por publicación ACTIVA (no la suma).
//     Dentro de una publicación sí se suman las variantes activas.
//   · IDs para VENTAS/VISITAS = TODAS las variantes del modelo (active+paused), igual que groupItems suma
//     sales2w sobre todo el grupo (:390): una unidad vendida en 14d cuenta como demanda aunque esa variante
//     esté pausada hoy. Devuelve allIds (ventas/visitas) y activeIds (stock) por separado.
function radarCatAgg(){
  const arts={};   // nm -> { pubs:{pubKey:{stock}}, activeIds:[], allIds:[] }
  (_pcat||[]).forEach(it=>{
    const nm=norm(it.model); if(!nm) return;
    const a=arts[nm]||(arts[nm]={pubs:{}, activeIds:[], allIds:[]});
    a.allIds.push(it.id);                                          // ventas/visitas: todas las variantes
    if(it.status==='active'){
      const pk=it.familyId?('fam:'+it.familyId):('id:'+it.id);
      (a.pubs[pk]||(a.pubs[pk]={stock:0})).stock += (it.stock||0); // stock: suma de variantes activas de ESA publicación
      a.activeIds.push(it.id);
    }
  });
  const out={};
  for(const nm in arts){
    const pubs=Object.values(arts[nm].pubs);
    const positive=pubs.map(p=>p.stock).filter(s=>s>0);
    // 1 publicación activa → su stock; varias → MODA de los stocks positivos (stock compartido, banner de Promos)
    const stock = pubs.length>1 ? stockMode(positive) : (pubs[0]?pubs[0].stock:0);
    out[nm]={ ids:arts[nm].allIds, activeIds:arts[nm].activeIds, stock, nPubs:pubs.length };
  }
  return out;
}
// Señales por modelo (cobertura + conversión). OJO fuentes y FRESCURA (verificado en prod: la conversión
// daba >100% por dividir ventas viejas del almacén sobre visitas frescas — ventanas desalineadas):
//   · COBERTURA (días) = stock ÷ velocidad. Uso la velocidad de 30d de mlcosts (qty, cache <24h, fresca),
//     NO las ventas 14d de `warehouse.sales`: ese blob NO lo refresca el cron (solo un scan de Promos) →
//     puede estar días viejo. stock ÷ (qty/30).
//   · CONVERSIÓN = ventas14d ÷ visitas14d, MISMA ventana y MISMOS ids (los que tienen visita conocida, para
//     no inflar el ratio). Solo si `warehouse.sales` está FRESCO (<48h); si no, no se calcula (mejor mudo
//     que un número inventado). Cap de seguridad: >100% = imposible ⇒ dato inconsistente, no se muestra.
function radarModelSignals(nm, cat, qty){
  const c = cat || null;
  const stock = c ? c.stock : null;
  const ids = c ? c.ids : [];
  const diasCob = daysOfStock(stock, qty, 30);          // stock ÷ (qty 30d / 30) — métrica 4
  const visIds = ids.filter(id => _pvisits && _pvisits[id]!=null);   // ids con visita conocida (alinear num/den)
  const anyVis = visIds.length>0;
  const visits = anyVis ? visIds.reduce((a,id)=>a+(_pvisits[id]||0),0) : null;
  const salesFresh = !!(_psalesTs && (Date.now()-_psalesTs < 48*60*60*1000));
  const sales2w = anyVis ? visIds.reduce((a,id)=>a+((_psales2w&&_psales2w[id])||0),0) : 0;   // MISMO conjunto que visits
  const conv = conversionRate(sales2w, visits, salesFresh);   // gate de frescura + clamp [0,1] — métrica 5
  return { stock, nPubs:c?c.nPubs:0, diasCob, visits, anyVis, conv, salesFresh };
}

// ── RADAR DE DECISIONES ────────────────────────────────────────────────────────────────────────────
// Board DIAGNÓSTICO por modelo (no prescribe precio, dirección dura de Martin): cruza margen real (mstMargin,
// con costo de devolución) + velocidad (unidades 30d de mlcosts) + tasa de devolución (30d) + ACOS de ads +
// cobertura (días de stock) + conversión (ventas 14d/visitas 14d), y muestra las PALANCAS en juego (precio/
// costo · bajar-cortar ads · liquidar · talles · reponer/dejar por stock · escalar), SIN ordenar una sola.
// La decisión precio-vs-ads-vs-nada la toma Martin (y a futuro el sistema) viendo TODAS las palancas.
// Reusa TODO el estado del Maestro (mismo cálculo de plata, sin duplicar). Solo modelos con ventas en 30d.
// Umbrales v2 (heurística, TUNEABLES; Martin los calibra con su data): para ML de indumentaria un ~2% de
// conversión es sano y <~0.8% flojo; el disparador real de "cortar ads" es que la pauta cueste MÁS que el
// margen (ACOS > margen%), no un umbral suelto de ACOS.
const RADAR_TH = { sellsFast:15, marginThin:10, retHigh:0.15, acosHigh:15, convGood:0.02, convBad:0.008, coverHigh:60, coverFast:21, stockLow:10, visitsLow:50 };
function finishLevers(levers){ levers.sort((a,b)=>b.pri-a.pri); return { pri:levers[0]?levers[0].pri:0, levers, read:levers[0]?levers[0].why:'' }; }
// Devuelve { pri, levers:[{pri,tone,label,why}], read } — las palancas en juego, rankeadas por urgencia.
// pri sirve para ordenar filas y palancas; NUNCA colapsa a una sola orden (se muestran todas las que aplican).
function radarLevers(o){
  const TH=RADAR_TH, pct=x=>Math.round(x)+'%', c1=x=>(x*100).toFixed(1)+'%';
  const levers=[]; const add=(pri,tone,label,why)=>levers.push({pri,tone,label,why});
  if(!o.mm || o.mm.margen==null){ add(3,'muted','Falta costo','sin landed cargado no hay margen real que leer'); return finishLevers(levers); }
  const p=o.mm.margenPct!=null?o.mm.margenPct:0;
  const q=o.qty||0, sells=q>=TH.sellsFast;
  const sig=o.sig||{}, conv=sig.conv, convKnown=conv!=null;
  const convGood=convKnown && conv>=TH.convGood, convBad=convKnown && conv<TH.convBad;
  const acos=o.acos, acosHigh=acos!=null && acos>=TH.acosHigh;
  const adsUnderwater=acos!=null && o.mm.margenPct!=null && acos>o.mm.margenPct;   // la pauta cuesta más que el margen
  const noStock=(sig.stock!=null && sig.stock<=0);
  const lowStock=(sig.stock!=null && sig.stock>0 && sig.stock<TH.stockLow);
  // 1) MARGEN NEGATIVO — la palanca depende de POR QUÉ (conversión + ads), no es una sola cosa.
  if(p<0){
    if(convGood) add(100,'danger','Precio / costo','margen '+pct(p)+' pero convierte '+c1(conv)+' (bien) — la palanca es el precio o el costo, no la pauta');
    if(adsUnderwater && !convGood) add(98,'danger','Cortar ads','margen '+pct(p)+' y ACOS '+acos+'% > margen — la pauta te lo deja en rojo'+(convBad?(' y convierte '+c1(conv)+' (flojo)'):(convKnown?'':' (falta conversión)')));
    if(!convGood && !adsUnderwater) add(92,'danger','Precio / costo','margen '+pct(p)+' — perdés en cada venta; revisá precio o costo'+(convKnown?'':' (traé conversión para separar precio de ads)'));
  } else if(p<TH.marginThin){
    // 2) MARGEN FINO (0–10%)
    if(adsUnderwater && !convGood) add(66,'warn','Bajar ads','margen fino '+pct(p)+' y ACOS '+acos+'% > margen — la pauta lo empuja al rojo');
    else if(sells) add(60,'warn','Precio','margen fino '+pct(p)+' en un modelo que vende ('+q+'u/30d) — poco colchón');
    else add(30,'warn','Precio','margen fino '+pct(p)+' y poca venta ('+q+'u)');
  } else if(acosHigh || adsUnderwater){
    // 3) ACOS alto (absoluto) O la pauta cuesta MÁS que el margen (adsUnderwater, relativo). ANTES esta rama
    // solo miraba acosHigh (umbral absoluto ~18%): un modelo con margen 10-15% y ACOS entre el margen y 18%
    // (ACOS>margen pero <acosHigh) no entraba a ninguna rama y caía en "OK sin alertas" — contradecía la
    // doctrina (si la pauta se come el margen, hay que avisar). Ahora adsUnderwater dispara siempre.
    const uw = adsUnderwater ? (' > margen '+pct(p)) : '';
    if(convGood) add(adsUnderwater?58:48, adsUnderwater?'warn':'info','Precio, no ads','ACOS '+acos+'%'+uw+' pero convierte '+c1(conv)+' (bien) — la pauta trae ventas'+(adsUnderwater?' pero se come el margen; mirá precio':'; el margen aguanta, mirá precio antes que cortar'));
    else add(adsUnderwater?62:56,'warn','Bajar ads','ACOS '+acos+'%'+uw+(adsUnderwater?' (la pauta se come el margen)':'')+(convBad?(' y convierte '+c1(conv)+' (flojo)'):(convKnown?'':' (falta conversión)'))+' — la pauta pesa; probá bajarla');
  }
  // 4) DEVOLUCIONES altas
  if(o.retRate!=null && o.retRate>=TH.retHigh) add(78,'warn','Talles',pct(o.retRate*100)+' de devolución — revisá guía/tabla de talles');
  // 5) SOBRESTOCK → candidata a liquidar (cobertura larga)
  if(sig.diasCob!=null && sig.diasCob>=TH.coverHigh && !lowStock && !noStock) add(52,'warn','Liquidar',sig.diasCob+' días de cobertura ('+sig.stock+'u) — sobrestock; candidata a descuento');
  // 6) POCO / SIN STOCK → no empujar
  if(noStock) add(46,'muted','Sin stock','no hay stock activo — nada para empujar');
  else if(lowStock) add(45,'muted','Poco stock','quedan ~'+sig.stock+'u — no rinde publicitar ni bajar precio; reponé o dejá correr');
  // 7) VISIBILIDAD: poco tráfico = problema de visibilidad, no de precio
  if(sig.anyVis && sig.visits<TH.visitsLow) add(40,'muted','Visibilidad',sig.visits+' visitas 14d — casi sin tráfico; es visibilidad, no precio');
  // 8) SANO / ESCALAR (solo si nada más aplicó de plata)
  if(!levers.length){
    if(p>=25 && sells && !adsUnderwater) add(20,'ok','Escalar','margen '+pct(p)+', vende '+q+'u'+(acos!=null?(' · ACOS '+acos+'%'):'')+(convGood?(' · convierte '+c1(conv)):'')+' — hay lugar para crecer');
    else add(10,'ok','OK','margen '+pct(p)+', sin alertas'+(convGood?(' · convierte '+c1(conv)):''));
  }
  // 9) CLIMA (viento a favor/en contra por TIPO, ponderado por dónde está tu demanda). Solo dispara en
  // semanas CLARAS (frío/cálido/seco/lluvioso marcados) → no ensucia en semanas neutras. El contexto general
  // va en el header del Radar. Diagnóstico: la decisión (pautar o no) la toma Martin.
  const wx=o.wx, ty=o.type;
  if(wx && ty && ty.esAbrigo){
    // Temperatura por la MÍNIMA (mañana/noche = cuando se compra abrigo; el máx del mediodía engaña: días de
    // 16° máx pero 4° mín son fríos y venden abrigo — validado con ventas por hora, pico 9-13h y 18-23h).
    const T=WEATHER_TH, cold=(wx.wTmin!=null&&wx.wTmin<T.cold), mild=(wx.wTmin!=null&&wx.wTmin>T.mild);
    const dry=(wx.wRainShare!=null&&wx.wRainShare<T.dry), rainy=(wx.wRainShare!=null&&wx.wRainShare>=T.rainy);
    const tTxt='mín ~'+Math.round(wx.wTmin)+'°/máx ~'+Math.round(wx.wTmax)+'° donde vendés';
    const rTxt=(wx.wRainShare!=null?Math.round(wx.wRainShare*100)+'% de días con lluvia donde vendés':'lluvia sin dato');
    // El DRIVER depende del CARÁCTER de la prenda (garment.ts, pura+testeada):
    const { rain, warm, light } = garmentClimate(ty.abrigo, ty.tipologia, ty.imper);
    if(rain){
      // PRENDA DE LLUVIA (trench/piloto impermeable, ej. Alchemy/Gemini): la LLUVIA es el driver primario.
      if(rainy) add(45,'info','Clima: lluvia',rTxt+' — es lo que dispara un trench/piloto impermeable como éste');
      else if(dry) add(45,'warn','Clima: seco',rTxt+' — sin lluvia un trench/piloto tracciona mucho menos, aunque haga frío');
    } else if(warm){
      // PRENDA DE ABRIGO (puffer/relleno/corderito): el FRÍO es el driver (la lluvia no hace falta).
      if(cold) add(43,'info','Clima: frío',tTxt+' — frío en las horas de compra; viento a favor del abrigo');
      else if(mild) add(46,'warn','Clima: templado',tTxt+' — noches templadas; el abrigo pierde tracción');
    } else if(light){
      // LIVIANA (sin relleno, no de lluvia): responde a la temperatura.
      if(cold) add(45,'warn','Clima: frío',tTxt+' — con este frío la gente busca abrigo, no prenda liviana');
      else if(mild) add(42,'info','Clima: templado',tTxt+' — viento a favor para prendas livianas');
    }
  }
  return finishLevers(levers);
}
function radarRender(){
  const host=$('radar-root'); if(!host) return;
  if(!_pm||!_pm.models||!Object.keys(_pm.models).length){ host.innerHTML='<div style="font-size:13px;color:#d97706;padding:10px">Sin maestro cargado — cargalo en Precios → Maestro.</div>'; return; }
  if(!_mstMlc){ host.innerHTML='<div style="padding:10px;font-size:13px;color:var(--text-muted)">El radar necesita el margen real (comisión + envío de tus ventas). <button class="btn btn-sm" onclick="radarCalc()"'+(_mstMlcLoading?' disabled':'')+'>'+(_mstMlcLoading?'Calculando… (~1-2 min)':'Calcular margen real')+'</button></div>'; return; }
  const TONE={danger:'#dc2626',warn:'#d97706',ok:'#16a34a',muted:'#6b7280',info:'#0ea5e9'};
  const cat=radarCatAgg();
  const wx=computeWeatherExposure();   // clima ponderado por demanda (null si aún no cargó weather/geo-mix)
  const rows=[];
  Object.keys(_pm.models).forEach(k=>{ const m=_pm.models[k]; const nm=norm(m.model); const mlc=_mstMlc[nm];
    if(!mlc || !mlc.qty) return;                         // solo modelos con ventas en 30d
    const mm=mstMargin(m);
    const retRate=(_mstRetRate && _mstRetRate[nm]!=null)? _mstRetRate[nm] : null;
    const ad=(_mstAds&&_mstAds.models)?_mstAds.models[nm]:null;
    const acos=(ad&&ad.acos!=null)?ad.acos:null;
    const sig=radarModelSignals(nm, cat[nm], mlc.qty);
    const ty={ esAbrigo:m.esAbrigo, imper:m.imper, abrigo:m.abrigo, tipologia:m.tipologia };   // clasificación del Maestro
    const lv=radarLevers({ mm, qty:mlc.qty, retRate, acos, adCost:ad?ad.cost:0, sig, type:ty, wx });
    rows.push({ model:m.model, mm, qty:mlc.qty, retRate, acos, sig, lv, esAbrigo:m.esAbrigo });
  });
  rows.sort((a,b)=> (b.lv.pri-a.lv.pri) || (b.qty-a.qty));
  const nCrit=rows.filter(r=>r.lv.pri>=90).length, nAct=rows.filter(r=>r.lv.pri>=50).length;
  const salesFresh = !!(_psalesTs && (Date.now()-_psalesTs < 48*60*60*1000));
  const salesAgeH = _psalesTs ? Math.round((Date.now()-_psalesTs)/3600000) : null;
  const visSt = _pvisitsLoading ? ' · <span id="radar-visits-st" style="color:var(--text-soft)">trayendo conversión…</span>'
    : (!salesFresh ? ' · <span style="color:#d97706" title="La conversión necesita las ventas 14d del almacén frescas; hoy están a '+(salesAgeH!=null?salesAgeH+'h':'—')+'. Se refrescan al escanear Promos (o cuando el cron las incluya).">conversión en pausa (ventas 14d desactualizadas)</span>'
      : (_pvisits ? '' : ' · <span style="color:var(--text-soft)">conversión pendiente</span>'));
  let h='<div style="font-size:11px;color:var(--text-muted);margin-bottom:6px">'+rows.length+' modelos con ventas (30d) · <b style="color:#dc2626">'+nCrit+' en rojo</b> · '+nAct+' piden mirada. Diagnóstico multi-palanca: margen real + cobertura + conversión + ACOS + devoluciones — muestra las palancas en juego, no ordena una sola. <button class="btn btn-sm" onclick="radarCalc()" title="Recalcular con ventas frescas">↻</button>'+visSt+'</div>';
  h+='<div style="font-size:10px;color:var(--text-soft);margin-bottom:8px">Cobertura = stock ÷ velocidad 30d. Conversión = ventas 14d ÷ visitas 14d (solo si las ventas del almacén están frescas). Umbrales heurísticos (calibrables). Read-only: no escribe precios ni promos.</div>';
  if(wx){ const T=WEATHER_TH, tSt=(wx.wTmin==null?'—':(wx.wTmin<T.cold?'frío':(wx.wTmin>T.mild?'templado':'fresco')));
    const rTxt = wx.wRainShare!=null ? ('<b>'+Math.round(wx.wRainShare*100)+'% de días con lluvia</b> ('+(wx.wRainShare<T.dry?'seco':(wx.wRainShare>=T.rainy?'lluvioso':'lluvia media'))+')') : 'lluvia sin dato';
    // Cobertura HONESTA: qué % de la demanda del mes representa el mix (capturado÷demanda-real), NO resuelto÷capturado
    // (que da 100% aunque el mix cubra pocos días). Se completa solo con el cron → el flag "parcial" se limpia.
    const cap = wx.capturePct!=null ? (' · mix sobre <b>'+(wx.mixUnits||0).toLocaleString('es-AR')+' u.</b> (<b>'+wx.capturePct+'%</b> de la demanda de las últimas 4 semanas'+(wx.capturePct<60?' <span style="color:#d97706" title="El mix geográfico todavía cubre pocos días de ventas; se completa solo a medida que corre el cron. Hasta que suba, tomá el peso del clima con reservas.">— parcial</span>':'')+')') : '';
    h+='<div style="font-size:11px;color:var(--text-muted);margin-bottom:8px;padding:5px 8px;border:1px solid var(--border2);border-radius:6px;background:var(--surface2)">Clima ponderado por tu demanda (5 días): <b>mín ~'+Math.round(wx.wTmin)+'° / máx ~'+Math.round(wx.wTmax)+'°</b> (<b>'+tSt+'</b>, por la mínima — es cuando se compra abrigo) · '+rTxt+cap+'. El viento a favor/en contra por tipo sale como chip «Clima» en cada modelo.</div>';
    h+=radarWeatherDetail(wx);   // desplegable: pronóstico por zona (cotejable) + ponderación + reglas de los chips
    if(!rows.some(r=>r.esAbrigo!==undefined)) h+='<div style="font-size:10px;color:#d97706;margin-bottom:8px">Clima por tipo EN PAUSA: ningún modelo tiene el tipo clasificado en el Maestro — cargá impermeabilidad/abrigo para activar los chips «Clima».</div>'; }
  const th=(lab,extra,tip)=>'<th style="padding:6px 8px;position:sticky;top:0;z-index:5;'+(extra||'')+'"'+(tip?(' title="'+esc(tip)+'"'):'')+'>'+lab+'</th>';
  h+='<div style="max-height:74vh;overflow:auto;border:1px solid var(--border);border-radius:8px"><table style="width:100%;font-size:12px;border-collapse:collapse"><thead><tr style="text-align:right;color:var(--text-muted);font-size:11px">'
    +th('Modelo','text-align:left')+th('Palancas','text-align:left','Todas las palancas en juego, rankeadas — pasá el mouse por cada chip para el porqué')
    +th('Margen')+th('V.30d','','Unidades vendidas 30d (velocidad)')+th('Cobertura','','Días de stock al ritmo de venta de 14d')
    +th('Conv.','','Ventas 14d ÷ visitas 14d')+th('ACOS')+th('Devol.')+th('Stock','','Stock compartido: moda entre las publicaciones del modelo')+th('Lectura','text-align:left')
    +'</tr></thead><tbody>';
  rows.forEach(r=>{ const p=r.mm&&r.mm.margenPct!=null?Math.round(r.mm.margenPct):null; const s=r.sig;
    const chips=r.lv.levers.map(l=>'<span title="'+esc(l.why)+'" style="display:inline-block;padding:1px 7px;margin:1px 3px 1px 0;border-radius:9px;font-size:10px;font-weight:700;color:#fff;background:'+(TONE[l.tone]||'#6b7280')+'">'+esc(l.label)+'</span>').join('');
    const convTxt = s.conv!=null ? (s.conv*100).toFixed(1)+'%' : (_pvisitsLoading?'…':'—');
    const convCol = s.conv==null?'var(--text-soft)':(s.conv>=RADAR_TH.convGood?'#16a34a':(s.conv<RADAR_TH.convBad?'#dc2626':'#d97706'));
    const convTip = s.conv!=null ? (s.visits+' visitas 14d') : (s.anyVis && !s.salesFresh ? 'ventas 14d del almacén desactualizadas — se refrescan al escanear Promos' : (s.anyVis ? 'datos insuficientes' : 'visitas no cargadas'));
    const cob=s.diasCob, cobCol = cob==null?'var(--text-soft)':(cob>=RADAR_TH.coverHigh?'#d97706':(cob<RADAR_TH.coverFast?'#16a34a':'var(--text)'));
    const cobTip = cob!=null?((s.stock!=null?s.stock+'u':'')+(s.nPubs>1?(' · '+s.nPubs+' publicaciones (stock compartido)'):'')+' · vel. '+r.qty+'u/30d'):'';
    const stCol = (s.stock!=null && s.stock>0 && s.stock<RADAR_TH.stockLow)?'#d97706':'var(--text-soft)';
    h+='<tr style="border-top:1px solid var(--border)">'
      +'<td style="padding:5px 8px;font-weight:600;text-transform:capitalize">'+esc(r.model)+'</td>'
      +'<td style="padding:5px 8px">'+(chips||'—')+'</td>'
      +'<td style="padding:5px 8px;text-align:right;font-weight:700;color:'+(p==null?'var(--text-soft)':(p<0?'#dc2626':(p<RADAR_TH.marginThin?'#d97706':'#16a34a')))+'">'+(p==null?'—':p+'%')+'</td>'
      +'<td style="padding:5px 8px;text-align:right">'+r.qty+'</td>'
      +'<td style="padding:5px 8px;text-align:right;color:'+cobCol+'"'+(cobTip?(' title="'+esc(cobTip)+'"'):'')+'>'+(cob!=null?cob+'d':(s.stock!=null&&s.stock<=0?'sin stock':'—'))+'</td>'
      +'<td style="padding:5px 8px;text-align:right;color:'+convCol+'" title="'+esc(convTip)+'">'+convTxt+'</td>'
      +'<td style="padding:5px 8px;text-align:right;color:'+(r.acos==null?'var(--text-soft)':(r.acos>=RADAR_TH.acosHigh?'#d97706':'var(--text)'))+'">'+(r.acos!=null?r.acos+'%':'—')+'</td>'
      +'<td style="padding:5px 8px;text-align:right;color:'+((r.retRate!=null&&r.retRate>=RADAR_TH.retHigh)?'#d97706':'var(--text-soft)')+'">'+(r.retRate!=null?Math.round(r.retRate*100)+'%':'—')+'</td>'
      +'<td style="padding:5px 8px;text-align:right;color:'+stCol+'">'+(s.stock!=null?s.stock:'—')+'</td>'
      +'<td style="padding:5px 8px;color:var(--text-muted);font-size:11px">'+esc(r.lv.read)+'</td>'
      +'</tr>';
  });
  h+='</tbody></table></div>';
  host.innerHTML=h;
}
async function radarCalc(){
  setMstMlcLoading(true); radarRender();
  try{ const r=(window.ensureMlCosts? await window.ensureMlCosts(false):null); if(r)setMstMlc(r); }catch(e){ toast('No pude calcular el margen: '+(e&&e.message||e),'error'); }
  setMstMlcLoading(false);
  try{ await pubEnsureCat(); }catch(e){}                  // catálogo (stock) + ventas 14d (cobertura)
  try{ await maestroEnsureAds(false); }catch(e){}
  try{ await maestroEnsureReturns(false); }catch(e){}
  try{ await maestroEnsureShipAgg(false); }catch(e){}
  try{ await maestroEnsureGeoMix(); }catch(e){}      // demanda por zona (para ponderar el clima)
  try{ await maestroEnsureWeather(); }catch(e){}     // pronóstico por punto (Open-Meteo)
  radarRender();
  radarLoadVisits();
}
async function radarLoad(){
  await pubEnsureMaster();
  try{ await pubEnsureCat(); }catch(e){}                  // catálogo (stock) + ventas 14d (cobertura), 1 GET
  try{ await maestroEnsureDolar(); }catch(e){}
  if(!_mstMlc){ try{ const c=JSON.parse(localStorage.getItem('parka_mlcosts_v3')||'null'); if(c&&c.data&&(Date.now()-c.ts<24*60*60*1000)) setMstMlc(c.data); }catch(e){} }
  radarRender();
  if(_mstMlc){
    try{ await maestroEnsureAds(false); }catch(e){}
    try{ await maestroEnsureReturns(false); }catch(e){}
    try{ await maestroEnsureShipAgg(false); }catch(e){}
    try{ await maestroEnsureGeoMix(); }catch(e){}      // demanda por zona (para ponderar el clima)
    try{ await maestroEnsureWeather(); }catch(e){}     // pronóstico por punto (Open-Meteo)
    radarRender();
    radarLoadVisits();   // conversión: fetch de visitas lazy (no bloquea el pintado) → re-render al terminar
  }
}
// Trae visitas 14d SOLO de los item_ids activos de los modelos que salen en el Radar (con ventas 30d), en
// background. Cache 6h; si ya están todas, re-render y listo. No bloquea el render inicial ni las columnas
// de plata — la conversión se llena cuando llega.
async function radarLoadVisits(){
  if(!_mstMlc || _pvisitsLoading || !_pm || !_pm.models) return;
  const cat=radarCatAgg();
  const ids=[];
  Object.keys(_pm.models).forEach(k=>{ const nm=norm(_pm.models[k].model); const mlc=_mstMlc[nm]; if(mlc&&mlc.qty&&cat[nm]) ids.push(...cat[nm].ids); });
  if(!ids.length) return;
  pvisitsLoad();
  const missing=[...new Set(ids)].filter(id=>id && !(id in _pvisits));
  if(!missing.length){ radarRender(); return; }           // ya cacheadas
  _pvisitsLoading=true; radarRender();
  try{ await maestroEnsureVisits(ids, (i,n)=>{ const el=$('radar-visits-st'); if(el) el.textContent='trayendo conversión… '+i+'/'+n; }); }catch(e){}
  _pvisitsLoading=false;
  radarRender();
}

// ── window-expose: viaja CON el módulo (nav.ts llama radarLoad por onclick; sin esto = ReferenceError tragado) ──
try{ Object.assign(window,{ radarLoad, radarRender, radarCalc }); }catch(e){}

