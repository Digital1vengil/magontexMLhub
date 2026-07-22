// @ts-nocheck
// ParkaHub — módulo report (charts, tabla ventas, stats, top10, resumen v3, export XL importado).
// Funciones movidas TAL CUAL desde app.ts. Cero cambio de logica.
import { S } from './state'
import { parseVariant, skuBase, skuSortKey, vmlBaseCode } from './util'
import { colorOfSku } from './colors'
import { sectorForArticle, mapeoSectorOrder } from './mapeo'
import { makeSkuModelResolver, nrm, dash } from './sku-resolver'
import { apiGet } from './api'
import { getWarehouse } from './warehouse-cache'
import { toast } from './core-ui'
import { share, othersShare } from './geo-math'   // share 100%-stacked de la tendencia geográfica (métrica 12)

// -- EXPORT: REPORTE SALIDAS VENTAS ML -- PARKA (XLSX) -----------------
export function exportXLImportado(){
  if(!S.xlFiltered.length){ toast('No hay órdenes importadas','error'); return; }

  const today = new Date().toLocaleDateString('es-AR',{day:'numeric',month:'long',year:'numeric'});
  const filename = (document.getElementById('xl-result-sub')||{}).textContent||'';

  // -- Group by SKU+talle, sum qty + carriers -------------------
  const grouped = {};
  for(const o of S.xlFiltered){
    if(!o.sku||o.sku==='-'||o.sku==='--') continue;
    const {color,talle} = parseVariant(o.variant);
    const key = o.sku+'||'+talle;
    if(!grouped[key]) grouped[key]={sku:o.sku,base:skuBase(o.sku),color,talle,qty:0,flex:0,colecta:0,correo:0,punto:0,ids:[]};
    grouped[key].qty      += o.qty;
    grouped[key].ids.push(o.orderId);
    const c = o.carrier||'colecta';
    if(c==='flex')    grouped[key].flex    += o.qty;
    else if(c==='correo') grouped[key].correo += o.qty;
    else if(c==='punto')  grouped[key].punto  += o.qty;
    else                  grouped[key].colecta += o.qty;
  }

  const rows = Object.values(grouped).sort((a,b)=>skuSortKey(a.sku).localeCompare(skuSortKey(b.sku)));
  // Sector de depósito por artículo (mapeo por modelo + color). '' si no matchea.
  for(const r of rows){ r.sector = sectorForArticle(r.sku, r.base, r.color) || ''; }
  const baseGroups = {};
  for(const r of rows){ if(!baseGroups[r.base]) baseGroups[r.base]=[]; baseGroups[r.base].push(r); }
  const bases = Object.keys(baseGroups).sort((a,b)=>skuSortKey(a).localeCompare(skuSortKey(b)));

  // Multi-package
  const packageMap = {};
  for(const o of S.xlFiltered){ if(!o.packageKey) continue; if(!packageMap[o.packageKey]) packageMap[o.packageKey]=[]; packageMap[o.packageKey].push(o); }
  const multiKeys = Object.keys(packageMap).filter(k=>packageMap[k].length>=2);

  const totalUnits  = rows.reduce((s,r)=>s+r.qty,0);
  const totalFlex   = rows.reduce((s,r)=>s+r.flex,0);
  const totalColec  = rows.reduce((s,r)=>s+r.colecta,0);
  const totalCorreo = rows.reduce((s,r)=>s+r.correo,0);

  // -- Paleta sobria: slate + acento indigo ---------------------
  const WH  = 'FFFFFF';
  const INK = '0F172A'; // slate-900 - banda de sector (la mas destacada)
  const HDR = '1E293B'; // slate-800 - encabezado de columnas
  const ACC = '4F46E5'; // indigo-600 - titulo / acento
  const ACC2= 'EEF2FF'; // indigo-50 - tinte suave
  const SUB = 'E2E8F0'; // slate-200 - sub-encabezado por modelo
  const ALT = 'F8FAFC'; // slate-50 - fila alternada
  const TXT = '0F172A'; // texto principal
  const MUT = '64748B'; // slate-500 - texto atenuado
  const LINE= 'E2E8F0'; // borde
  const OKB = '4F46E5'; // flex (indigo)
  const OKBL= 'EEF2FF';
  const AMB = 'B45309'; // colecta (ambar)
  const AMBL= 'FFF7ED';
  const OFF = 'CBD5E1'; // "--" atenuado

  function c(v, bg, fg, sz, bold, align, wrap, italic){
    return {
      v: v===undefined||v===null?'':v,
      t: typeof v==='number'?'n':'s',
      s:{
        fill:{fgColor:{rgb:bg||WH}, patternType:'solid'},
        font:{name:'Calibri',sz:sz||11,bold:!!bold,italic:!!italic,color:{rgb:fg||TXT}},
        alignment:{horizontal:align||'left',vertical:'center',wrapText:!!wrap},
        border:{
          top:{style:'thin',color:{rgb:LINE}},bottom:{style:'thin',color:{rgb:LINE}},
          left:{style:'thin',color:{rgb:LINE}},right:{style:'thin',color:{rgb:LINE}},
        }
      }
    };
  }

  const ws={};
  let R=0;
  const SC=(col,row,cell)=>{ ws[XLSX.utils.encode_cell({r:row,c:col})]=cell; };
  const COLS=7; // A=SKU B=Talle C=Unidades D=IDs E=Flex F=Colecta G=Sector

  // -- Titulo (banda indigo) ------------------------------------
  for(let col=0;col<COLS;col++) SC(col,R,c('',ACC,WH,11));
  SC(0,R,c('PARKA · REPORTE DE SALIDAS',ACC,WH,16,true,'left'));
  ws['!merges']=[{s:{r:R,c:0},e:{r:R,c:COLS-1}}]; R++;
  // subtitulo
  for(let col=0;col<COLS;col++) SC(col,R,c('',ACC,WH,10));
  SC(0,R,c('Ventas Mercado Libre   ·   '+today+(filename?('   ·   '+filename):''),ACC,'C7D2FE',10,false,'left',false,true));
  ws['!merges'].push({s:{r:R,c:0},e:{r:R,c:COLS-1}}); R++;
  // spacer
  for(let col=0;col<COLS;col++) SC(col,R,c('',WH)); R++;

  // -- Stats (label atenuado + valor grande) --------------------
  const sLabels=['SKUs UNICOS','UNIDADES','FLEX','COLECTA'];
  const sVals  =[rows.length, totalUnits, totalFlex, totalColec];
  const sFg    =[TXT, TXT, OKB, AMB];
  for(let col=0;col<4;col++) SC(col,R,c(sLabels[col],WH,MUT,9,true,'center'));
  SC(4,R,c('',WH)); SC(5,R,c('',WH)); SC(6,R,c('',WH)); R++;
  for(let col=0;col<4;col++) SC(col,R,c(sVals[col],WH,sFg[col],20,true,'center'));
  SC(4,R,c('',WH)); SC(5,R,c('',WH)); SC(6,R,c('',WH)); R++;
  // spacer
  for(let col=0;col<COLS;col++) SC(col,R,c('',WH)); R++;

  // -- Encabezado de columnas -----------------------------------
  const hLabels=['ARTICULO / SKU','TALLE','UNID.','N° DE VENTA / IDs','FLEX','COLECTA','SECTOR'];
  const hAligns=['left','center','center','left','center','center','center'];
  for(let col=0;col<COLS;col++) SC(col,R,c(hLabels[col],HDR,WH,10,true,hAligns[col]));
  const headerRow=R; R++;

  // -- Multi-articulo (acento indigo suave) ---------------------
  if(multiKeys.length){
    for(let col=0;col<COLS;col++) SC(col,R,c('',ACC2,ACC,10));
    SC(0,R,c('ETIQUETAS MULTI-ARTICULO ('+multiKeys.length+') — contienen 2+ articulos. Prepararlas juntas.',ACC2,ACC,10,true,'left'));
    ws['!merges'].push({s:{r:R,c:0},e:{r:R,c:COLS-1}}); R++;
    for(const pk of multiKeys){
      const items=packageMap[pk]; const ids=[...new Set(items.map(o=>o.orderId))];
      for(let col=0;col<COLS;col++) SC(col,R,c('',ALT,MUT,10));
      SC(0,R,c('📦 '+pk.slice(-16),ALT,TXT,10,true));
      SC(2,R,c(items.length+' art.',ALT,MUT,10,false,'center'));
      SC(3,R,c(ids.join('  '),ALT,MUT,9,false,'left',true)); R++;
      for(const it of items){
        const {talle,color}=parseVariant(it.variant); const cr=it.carrier||'colecta';
        for(let col=0;col<COLS;col++) SC(col,R,c('',WH,TXT,11));
        SC(0,R,c('   → '+it.sku,WH,TXT,11,true));
        SC(1,R,c(talle,WH,TXT,11,false,'center'));
        SC(2,R,c(it.qty,WH,TXT,12,true,'center'));
        SC(3,R,c(it.orderId,WH,MUT,9));
        SC(4,R,c(cr==='flex'?it.qty:'--',cr==='flex'?OKBL:WH,cr==='flex'?OKB:OFF,11,cr==='flex','center'));
        SC(5,R,c(cr==='colecta'?it.qty:'--',cr==='colecta'?AMBL:WH,cr==='colecta'?AMB:OFF,11,cr==='colecta','center'));
        SC(6,R,c(sectorForArticle(it.sku,skuBase(it.sku),color)||'--',WH,MUT,10,false,'center')); R++;
      }
    }
    for(let col=0;col<COLS;col++) SC(col,R,c('',WH)); R++;
  }

  // -- Agrupar por SECTOR ---------------------------------------
  const bySector={};
  for(const r of rows){ const sec=r.sector||'Sin sector'; (bySector[sec]=bySector[sec]||[]).push(r); }
  const order=mapeoSectorOrder();
  const firstTok=s=> s==='Sin sector' ? '' : String(s).split(' / ')[0];
  const secList=Object.keys(bySector).sort((a,b)=>{
    if(a==='Sin sector') return 1; if(b==='Sin sector') return -1;
    const ia=order.indexOf(firstTok(a)), ib=order.indexOf(firstTok(b));
    if(ia<0&&ib<0) return a.localeCompare(b); if(ia<0) return 1; if(ib<0) return -1;
    if(ia!==ib) return ia-ib; return a.localeCompare(b);
  });

  const sectorRows=[];
  for(const sec of secList){
    const secRows=bySector[sec]; const secTotal=secRows.reduce((s,i)=>s+i.qty,0);
    // Banda de sector DESTACADA (slate-900, alta, grande)
    for(let col=0;col<COLS;col++) SC(col,R,c('',INK,WH,14));
    SC(0,R,c('▍ '+sec.toUpperCase(),INK,WH,14,true,'left'));
    SC(2,R,c(secTotal,INK,WH,14,true,'center'));
    SC(3,R,c(secRows.length+' SKUs   ·   '+secTotal+' unid.',INK,'CBD5E1',10,false,'right',false,true));
    SC(COLS-1,R,c(sec,INK,'CBD5E1',10,true,'center'));
    sectorRows.push(R); R++;

    const bg2={};
    for(const r of secRows){ (bg2[r.base]=bg2[r.base]||[]).push(r); }
    const basesIn=Object.keys(bg2).sort((a,b)=>skuSortKey(a).localeCompare(skuSortKey(b)));
    for(const base of basesIn){
      const items=bg2[base]; const bTotal=items.reduce((s,i)=>s+i.qty,0);
      const bFlex=items.reduce((s,i)=>s+i.flex,0); const bColecta=items.reduce((s,i)=>s+i.colecta,0);
      // Sub-encabezado por modelo (slate-200)
      for(let col=0;col<COLS;col++) SC(col,R,c('',SUB,TXT,11));
      SC(0,R,c(base,SUB,TXT,11,true));
      SC(2,R,c(bTotal,SUB,TXT,12,true,'center'));
      SC(3,R,c('subtotal '+bTotal+' u.',SUB,MUT,9,false,'right',false,true));
      SC(4,R,c(bFlex||'',SUB,MUT,10,false,'center'));
      SC(5,R,c(bColecta||'',SUB,MUT,10,false,'center'));
      SC(6,R,c('',SUB,TXT,11)); R++;
      for(let i=0;i<items.length;i++){
        const item=items[i]; const bg=i%2===0?WH:ALT; const idsStr=item.ids.join('  ');
        SC(0,R,c('   '+item.sku,bg,TXT,11,true));
        SC(1,R,c(item.talle,bg,TXT,11,false,'center'));
        SC(2,R,c(item.qty,bg,TXT,12,true,'center'));
        SC(3,R,c(idsStr,bg,MUT,9,false,'left',true));
        SC(4,R,c(item.flex?item.flex:'--',item.flex?OKBL:bg,item.flex?OKB:OFF,11,!!item.flex,'center'));
        SC(5,R,c(item.colecta?item.colecta:'--',item.colecta?AMBL:bg,item.colecta?AMB:OFF,11,!!item.colecta,'center'));
        SC(6,R,c(item.sector||'--',bg,item.sector?TXT:OFF,10,!!item.sector,'center')); R++;
      }
    }
  }

  // Footer
  for(let col=0;col<COLS;col++) SC(col,R,c('',WH)); R++;
  SC(0,R,c('PARKA Sales Hub',WH,MUT,9,false,'left',false,true));
  SC(COLS-1,R,c('Generado el '+today,WH,MUT,9,false,'right',false,true)); R++;

  // -- Sheet setup ----------------------------------------------
  ws['!ref']  = XLSX.utils.encode_range({s:{r:0,c:0},e:{r:R-1,c:COLS-1}});
  ws['!cols'] = [{wch:30},{wch:8},{wch:9},{wch:40},{wch:9},{wch:10},{wch:18}];
  ws['!rows'] = Array.from({length:R},(_,i)=>{
    if(i===0) return {hpt:30};
    if(i===1) return {hpt:16};
    if(i===4) return {hpt:30};
    if(i===headerRow) return {hpt:20};
    if(sectorRows.includes(i)) return {hpt:26};
    return {hpt:17};
  });
  ws['!freeze'] = {xSplit:0, ySplit:headerRow+1, topLeftCell:XLSX.utils.encode_cell({r:headerRow+1,c:0})};

  const wbOut = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wbOut, ws, 'Salidas ML');
  XLSX.writeFile(wbOut, `PARKA_Salidas_ML_${new Date().toISOString().slice(0,10)}.xlsx`);
  toast('Excel exportado — formato PARKA','success');
}

/* Charts */
export function mkChart(id,type,labels,datasets,opts){
  var el=document.getElementById(id);if(!el)return;
  return new Chart(el,{type:type,data:{labels:labels,datasets:datasets},options:Object.assign({responsive:true,maintainAspectRatio:false,plugins:{legend:{display:false},tooltip:{backgroundColor:'#052e16',padding:10,cornerRadius:10}}},opts||{})});
}

export function buildAllCharts(){
  try{Chart.defaults.font.family="'Inter',sans-serif";Chart.defaults.color='#64748b';}catch(e){return;}
  var W=S.D.week_labels||[];
  var T=S.D.week_totals||[];
  var maxU=Math.max.apply(null,T)||1;

  /* Ventas semanales */
  mkChart('cVentas','bar',W,[{data:T,backgroundColor:T.map(function(v){return 'rgba(79,70,229,'+(0.25+0.75*(v/maxU)).toFixed(2)+')';}),borderRadius:5,borderSkipped:false}],{scales:{x:{grid:{display:false},border:{display:false},ticks:{font:{size:9},maxRotation:50,autoSkip:false}},y:{grid:{color:'rgba(79,70,229,.08)'},border:{display:false},ticks:{font:{size:10}}}}});

  /* Top publicaciones */
  var pubs=S.D.top_publicaciones||[];
  var pubLabels=pubs.map(function(p){var t=p.titulo||'';return t.length>22?t.substring(0,22)+'...':t;});
  var pubData=pubs.map(function(p){return p.unidades||0;});
  var pubColors=pubData.map(function(_,i){return S.CHART_COLORS[i%S.CHART_COLORS.length];});
  mkChart('cPubs','bar',pubLabels,[{data:pubData,backgroundColor:pubColors,borderRadius:5}],{indexAxis:'y',scales:{x:{grid:{color:'rgba(79,70,229,.08)'},border:{display:false},ticks:{font:{size:9}}},y:{grid:{display:false},border:{display:false},ticks:{font:{size:9}}}}});

  /* Envio donut */
  var env=S.D.by_envio||{};
  mkChart('cEnvio','doughnut',env.labels||[],[{data:env.totals||[],backgroundColor:['#15803d','#4ade80','#0284c7','#d97706'],borderWidth:2,borderColor:'#fff'}],{cutout:'60%',plugins:{legend:{display:true,position:'bottom',labels:{font:{size:10},padding:10}}}});

  /* Provincias */
  var prov=S.D.by_provincia||{};
  var provColors=(prov.labels||[]).map(function(_,i){return S.CHART_COLORS[i%S.CHART_COLORS.length];});
  mkChart('cProv','bar',prov.labels||[],[{data:prov.totals||[],backgroundColor:provColors,borderRadius:5}],{indexAxis:'y',scales:{x:{grid:{color:'rgba(79,70,229,.08)'},border:{display:false},ticks:{font:{size:9}}},y:{grid:{display:false},border:{display:false},ticks:{font:{size:9}}}}});

  /* Cantidad */
  var cant=S.D.by_cantidad||{};
  mkChart('cCant','bar',cant.labels||[],[{data:cant.totals||[],backgroundColor:S.CHART_COLORS,borderRadius:6}],{scales:{x:{grid:{display:false},border:{display:false},ticks:{font:{size:10}}},y:{grid:{color:'rgba(79,70,229,.08)'},border:{display:false},ticks:{font:{size:10}}}}});

  /* Envio por semana */
  var envW=env.by_week||{};
  var envDs=Object.keys(envW).map(function(k,i){return{label:k,data:envW[k],backgroundColor:S.CHART_COLORS[i%S.CHART_COLORS.length]+'bb',borderRadius:3,stack:'s'};});
  if(envDs.length)mkChart('cEnvioSem','bar',W,envDs,{scales:{x:{stacked:true,grid:{display:false},border:{display:false},ticks:{font:{size:9},maxRotation:50,autoSkip:false}},y:{stacked:true,grid:{color:'rgba(79,70,229,.08)'},border:{display:false},ticks:{font:{size:10}}}}});
}

/* (removido) Tabla ventas legacy: srt/doFilter/thC/buildTable escribían en #tbl/#tc que no existen
   en el HTML actual (dashboard viejo). La vista viva es Resumen v3 (rsmBuild2) + Ventas ML (./history). */

/* (removido) window.handleFiles legacy: escribía en #fl inexistente y su único invocador (dzd en
   ./core-ui) está guardado con `if(window.handleFiles)` y es inalcanzable. El import de Excel vivo
   es onXLDrop/onXLInput (./platforms). */

export function renderStats(){
  var D2 = window.D || {};

  /* Pago */
  var pago = D2.by_pago || {};
  var pagoEl = document.getElementById('stat-pago');
  if(pagoEl && pago.labels){
    var total = pago.totals.reduce(function(a,b){return a+b;},0)||1;
    pagoEl.innerHTML = pago.labels.map(function(l,i){
      var v = pago.totals[i]||0;
      var pct = Math.round(100*v/total);
      return '<div class="stat-row"><div class="stat-label">'+l+'</div><div class="stat-bar-wrap"><div class="stat-bar" style="width:'+pct+'%;background:'+(i===0?'var(--g600)':'var(--sk)')+'"></div></div><div class="stat-val">'+v.toLocaleString('es-AR')+'</div><div class="stat-pct">'+pct+'%</div></div>';
    }).join('');
  }

  /* Publicidad */
  var pub = D2.by_publicidad || {};
  var pubEl = document.getElementById('stat-pub');
  if(pubEl && pub.labels){
    var totalP = pub.totals.reduce(function(a,b){return a+b;},0)||1;
    pubEl.innerHTML = pub.labels.map(function(l,i){
      var v = pub.totals[i]||0;
      var pct = Math.round(100*v/totalP);
      return '<div class="stat-row"><div class="stat-label">'+l+'</div><div class="stat-bar-wrap"><div class="stat-bar" style="width:'+pct+'%;background:'+(i===0?'var(--am)':'var(--g600)')+'"></div></div><div class="stat-val">'+v.toLocaleString('es-AR')+'</div><div class="stat-pct">'+pct+'%</div></div>';
    }).join('');
  }

  /* Provincias */
  var prov = D2.by_provincia || {};
  var provEl = document.getElementById('stat-prov');
  if(provEl && prov.labels){
    var totalPr = prov.totals.reduce(function(a,b){return a+b;},0)||1;
    provEl.innerHTML = prov.labels.slice(0,8).map(function(l,i){
      var v = prov.totals[i]||0;
      var pct = Math.round(100*v/totalPr);
      var colors = ['var(--g700)','var(--g600)','#22c55e','#4ade80','var(--sk)','var(--am)','#7c3aed','#0891b2'];
      return '<div class="stat-row"><div class="stat-label">'+l+'</div><div class="stat-bar-wrap"><div class="stat-bar" style="width:'+pct+'%;background:'+colors[i]+'"></div></div><div class="stat-val">'+v.toLocaleString('es-AR')+'</div><div class="stat-pct">'+pct+'%</div></div>';
    }).join('');
  }
}


export function renderTop10(){
  var el=document.getElementById('top10-talles');
  if(!el)return;
  var colors=['var(--g900)','var(--g800)','var(--g700)','var(--g600)','#22c55e','#4ade80','var(--am)','var(--sk)','#7c3aed','#0891b2'];
  el.innerHTML=S.TOP10_TALLES.map(function(item,i){
    var max=item.talles[0]?item.talles[0].v:1;
    var bars=item.talles.map(function(t){
      var pct=Math.round(100*t.v/max);
      return '<div class="talle-row"><div class="talle-name">'+t.t+'</div><div class="talle-bar-bg"><div class="talle-bar-fill" style="width:'+pct+'%;background:'+colors[i]+'"></div></div><div class="talle-val">'+t.v+'</div></div>';
    }).join('');
    return '<div class="top10-card"><div class="top10-rank">#'+(i+1)+'</div><div class="top10-art" title="'+item.art+'">'+item.art+'</div><div class="top10-total">'+item.total.toLocaleString('es-AR')+'</div><div class="talle-bars">'+bars+'</div></div>';
  }).join('');
}

// ── Resumen v3 — tortas SVG + recomendaciones ────────────
export function rsmBuild2(){
  if(!S.VML_WEEKS.length){
    document.getElementById('rsmn-empty').style.display='';
    document.getElementById('rsmn-content').style.display='none';
    return;
  }
  document.getElementById('rsmn-empty').style.display='none';
  document.getElementById('rsmn-content').style.display='';

  // ── Acumular por SKU completo y por código base ─────────
  var totalSkus = {}, totalBase = {}, totalSkuColors = {};   // totalSkuColors[sku] = {colorReal: uds} (de la venta)
  S.VML_WEEKS.forEach(function(w){
    Object.keys(w.skus).forEach(function(s){
      totalSkus[s] = (totalSkus[s]||0) + w.skus[s];
      var b = vmlBaseCode(s);
      totalBase[b] = (totalBase[b]||0) + w.skus[s];
    });
    var sc = w.skuColors || {};   // color elegido en la venta (variation_attributes); puede faltar en días no resincronizados
    Object.keys(sc).forEach(function(s){
      var dst = totalSkuColors[s] || (totalSkuColors[s] = {});
      Object.keys(sc[s]).forEach(function(c){ dst[c] = (dst[c]||0) + sc[s][c]; });
    });
  });
  var grandTotal = Object.values(totalSkus).reduce(function(s,v){return s+v;},0);
  var sortedSkus  = Object.keys(totalSkus).sort(function(a,b){return totalSkus[b]-totalSkus[a];});
  var sortedBase  = Object.keys(totalBase).sort(function(a,b){return totalBase[b]-totalBase[a];});

  // (La distribución por talle —Hombre/Mujer, solo abrigos— se calcula más abajo cruzando con el catálogo.)

  // Colores
  var COLORS = ['#4F46E5','#6366F1','#818CF8','#A5B4FC','#312E81','#4338CA','#3730A3','#7C3AED','#8B5CF6','#C7D2FE','#DDD6FE'];

  // ── Función generadora de torta SVG ─────────────────────
  function makePie(data, size){
    // data = [{label, value, pct, color}]
    var s = size || 130, cx = s/2, cy = s/2, r = s/2 - 4, ri = r*0.52;
    var total = data.reduce(function(s,d){return s+d.value;},0);
    if(!total) return '<svg width="'+s+'" height="'+s+'"></svg>';
    var angle = -Math.PI/2, html = '<svg width="'+s+'" height="'+s+'" viewBox="0 0 '+s+' '+s+'">';
    data.forEach(function(d,i){
      var sweep = (d.value/total)*2*Math.PI;
      var x1=cx+r*Math.cos(angle), y1=cy+r*Math.sin(angle);
      var x2=cx+r*Math.cos(angle+sweep), y2=cy+r*Math.sin(angle+sweep);
      var xi1=cx+ri*Math.cos(angle), yi1=cy+ri*Math.sin(angle);
      var xi2=cx+ri*Math.cos(angle+sweep), yi2=cy+ri*Math.sin(angle+sweep);
      var large = sweep > Math.PI ? 1 : 0;
      html += '<path d="M'+xi1+','+yi1+' L'+x1+','+y1+' A'+r+','+r+' 0 '+large+',1 '+x2+','+y2+' L'+xi2+','+yi2+' A'+ri+','+ri+' 0 '+large+',0 '+xi1+','+yi1+' Z" fill="'+d.color+'" stroke="#fff" stroke-width="1.5"/>';
      angle += sweep;
    });
    html += '</svg>';
    return html;
  }

  function makeLegend(data, total){
    return data.map(function(d){
      return '<div style="display:flex;align-items:center;gap:6px;margin-bottom:5px">'
        +'<span style="width:10px;height:10px;border-radius:2px;background:'+d.color+';flex-shrink:0"></span>'
        +'<span style="font-size:11px;color:var(--text);font-weight:600;flex:1;white-space:nowrap;overflow:hidden;text-overflow:ellipsis" title="'+d.label+'">'+d.label+'</span>'
        +'<span style="font-size:11px;color:var(--text-muted);font-family:\'Space Grotesk\',sans-serif;flex-shrink:0">'+d.pct+'%</span>'
        +'</div>';
    }).join('');
  }

  // (Canonicalización de colores + resolución venta/SKU → ./colors.ts, funciones puras testeadas.)

  // ── Top 10 ───────────────────────────────────────────────
  var top10 = sortedBase.slice(0,10);
  var maxT  = top10.length ? totalBase[top10[0]] : 1;
  var medals = ['🥇','🥈','🥉'];
  var top10html = '<table style="width:100%"><thead><tr><th style="width:36px"></th><th>Código</th><th style="text-align:center;width:80px">Uds.</th><th style="width:40%;padding-right:12px">% del total</th></tr></thead><tbody>';
  top10.forEach(function(sku,i){
    var v = totalBase[sku];
    var pct = grandTotal ? Math.round(v/grandTotal*100) : 0;
    var barPct = Math.round(v/maxT*100);
    top10html += '<tr><td style="text-align:center;font-size:15px">'+(i<3?medals[i]:(i+1)+'°')+'</td>'
      +'<td><span style="font-family:monospace;font-size:12px;font-weight:700">'+sku+'</span></td>'
      +'<td style="text-align:center;font-size:13px;font-weight:700;color:#2e7d4f">'+v.toLocaleString('es-AR')+'</td>'
      +'<td style="padding-right:12px">'
      +'<div style="display:flex;align-items:center;gap:6px">'
      +'<div style="flex:1;height:6px;background:var(--border);border-radius:3px"><div style="height:100%;width:'+barPct+'%;background:#6366F1;border-radius:3px"></div></div>'
      +'<span style="font-size:10px;color:var(--text-muted);width:28px">'+pct+'%</span>'
      +'</div></td></tr>';
  });
  top10html += '</tbody></table>';
  document.getElementById('rsmn-top10').innerHTML = top10html;
  document.getElementById('rsmn-total-badge').textContent = grandTotal.toLocaleString('es-AR')+' uds totales';

  // ── Distribución por talle — Hombre/Mujer, SOLO ABRIGOS ─────────────────
  // El Excel de ventas solo trae SKU+cantidad; el género y la categoría salen del CATÁLOGO de ML
  // (atributo GENDER + category_id), que cruzamos por SKU (y por código base como fallback).
  // ABRIGOS = lo que pidió Martin: camperas/tapados/trench (MLA109096) + chalecos (MLA109104).
  // Excluye mochilas, bicis, remeras, trajes de baño, etc. (El nodo "Abrigos" de ML además tiene
  // sweaters/buzos/cardigans/ponchos — si se quieren sumar, agregar sus category_id acá.)
  var ABRIGO_CATS = { 'MLA109096':1, 'MLA109104':1 };
  ['h','m'].forEach(function(s){ var el=document.getElementById('rsmn-pie-talles-'+s); if(el) el.innerHTML='<div style="font-size:12px;color:var(--text-soft);padding:20px">Clasificando…</div>'; });
  // El catálogo de ML NO trae seller_sku (los SKU tipo M-114-BLACK-L viven en el Excel del vendedor),
  // así que el cruce es por MODELO: SKU vendido → código base → modelo (maestro SKU↔modelo + alias + Costos)
  //  → catálogo (modelo → GENDER + category_id). Normalizamos espacios→guión, y como el maestro es a nivel
  // color, también indexamos a nivel modelo (sin color) para tolerar typos de color del Excel (~86% cobertura).
  Promise.all([getWarehouse(), apiGet('/api/sku-master')]).then(function(res){
    var w = res[0], sm = res[1];
    var cat = []; try{ cat = w && w.catalog ? JSON.parse(w.catalog) : []; }catch(e){}
    var master = {}; try{ master = sm && sm.data ? (typeof sm.data==='string'?JSON.parse(sm.data):sm.data) : {}; }catch(e){}
    // modelo → {gender, cat} (catálogo)
    var byModel = {}, hasGender = false;
    cat.forEach(function(it){ var m=nrm(it.model); if(it.gender) hasGender=true; if(m && !byModel[m]) byModel[m]={gender:it.gender||'', cat:it.categoryId||''}; });
    // SKU-base → modelo: resolutor COMPARTIDO (sku-resolver.ts) — mismo criterio que Devoluciones,
    // antes duplicado acá a mano (maestro color+modelo, alias m-114=thor, PC_PRODUCTS de fallback).
    var resolveModel = makeSkuModelResolver(master, S.PC_PRODUCTS);
    var byGender = { Hombre:{}, Mujer:{} }, byGenderColor = { Hombre:{}, Mujer:{} }, classified = 0, unclass = 0, unmatched = {};
    var colSaleU = 0, colSkuU = 0;   // cobertura: uds con color de la VENTA vs derivado del SKU (fallback)
    Object.keys(totalSkus).forEach(function(sku){
      var u = totalSkus[sku];
      var ds = dash(sku), b = vmlBaseCode(ds);
      var mod = resolveModel(b);
      var info = mod ? byModel[mod] : null;
      if(!info){ unclass += u; var k = mod || b; unmatched[k] = (unmatched[k]||0) + u; return; }  // discontinuado o nombre desalineado vs la publicación
      if(!ABRIGO_CATS[info.cat]) return;   // resuelto pero NO es abrigo (mochila/remera/etc.) → excluido a propósito
      var g = info.gender==='Mujer' ? 'Mujer' : (info.gender==='Hombre' ? 'Hombre' : null);
      if(!g) return;
      var t = (ds.slice(b.length+1) || 'sin talle').toUpperCase();   // talle = sufijo del SKU (normalizado)
      byGender[g][t] = (byGender[g][t]||0) + u;
      var col = colorOfSku(sku, b, totalSkuColors[sku]);   // color elegido en la venta (o derivado del SKU como fallback)
      if(col.color){ byGenderColor[g][col.color] = (byGenderColor[g][col.color]||0) + u; if(col.src==='sale') colSaleU += u; else colSkuU += u; }
      classified += u;
    });
    ['Hombre','Mujer'].forEach(function(g){
      var suf = g==='Hombre'?'h':'m', data = byGender[g];
      var tot = Object.values(data).reduce(function(s,v){return s+v;},0);
      var sorted = Object.keys(data).sort(function(a,b){return data[b]-data[a];});
      var pieData = sorted.slice(0,9).map(function(t,i){ var v=data[t]; return {label:t, value:v, pct:tot?Math.round(v/tot*100):0, color:COLORS[i%COLORS.length]}; });
      var pe=document.getElementById('rsmn-pie-talles-'+suf), le=document.getElementById('rsmn-pie-talles-'+suf+'-legend'), te=document.getElementById('rsmn-talle-'+suf+'-tot');
      if(pe) pe.innerHTML = tot ? makePie(pieData,130) : '<div style="font-size:12px;color:var(--text-soft);padding:20px">Sin ventas de abrigos clasificadas</div>';
      if(le) le.innerHTML = tot ? makeLegend(pieData,tot) : '';
      if(te) te.textContent = tot ? ('· '+tot.toLocaleString('es-AR')+' uds') : '';
      // Colores más vendidos del género (mismo universo: abrigos clasificados)
      var cdata = byGenderColor[g];
      var ctot = Object.values(cdata).reduce(function(s,v){return s+v;},0);
      var csorted = Object.keys(cdata).sort(function(a,b){return cdata[b]-cdata[a];});
      var cPieData = csorted.slice(0,9).map(function(c,i){ var v=cdata[c]; return {label:c, value:v, pct:ctot?Math.round(v/ctot*100):0, color:COLORS[i%COLORS.length]}; });
      var ce=document.getElementById('rsmn-pie-colors-'+suf), cle=document.getElementById('rsmn-pie-colors-'+suf+'-legend'), cte=document.getElementById('rsmn-color-'+suf+'-tot');
      if(ce) ce.innerHTML = ctot ? makePie(cPieData,130) : '<div style="font-size:12px;color:var(--text-soft);padding:20px">Sin colores clasificados</div>';
      if(cle) cle.innerHTML = ctot ? makeLegend(cPieData,ctot) : '';
      if(cte) cte.textContent = ctot ? ('· '+ctot.toLocaleString('es-AR')+' uds') : '';
    });
    var csub=document.getElementById('rsmn-color-sub');
    if(csub){
      var colTot = colSaleU + colSkuU;
      if(!colTot){ csub.textContent = 'Color elegido en la venta · abrigos clasificados'; }
      else{
        var pSale = Math.round(colSaleU/colTot*100);
        csub.textContent = 'Abrigos clasificados · '+pSale+'% color real de la venta'
          + (colSkuU>0 ? (' · '+(100-pSale)+'% estimado del SKU ('+colSkuU.toLocaleString('es-AR')+' uds, se afina al resincronizar)') : '');
      }
    }
    var sub=document.getElementById('rsmn-talle-sub');
    if(sub){
      if(!hasGender){
        sub.textContent='El catálogo aún no tiene género — se completa con el próximo refresco del cron, o tocá ↻ Recalcular en Incongruencias';
      } else {
        var topUn = Object.keys(unmatched).sort(function(a,b){return unmatched[b]-unmatched[a];}).slice(0,6).map(function(k){return k+' ('+unmatched[k].toLocaleString('es-AR')+')';});
        sub.textContent = 'Abrigos (camperas/tapados/trench/chalecos) · '+classified.toLocaleString('es-AR')+' uds clasificadas'
          + (unclass>0 ? (' · '+unclass.toLocaleString('es-AR')+' sin clasificar'+(topUn.length?(': '+topUn.join(', ')):'')+' — modelo discontinuado o con nombre desalineado en la publicación') : '');
      }
    }
  }).catch(function(){ var sub=document.getElementById('rsmn-talle-sub'); if(sub) sub.textContent='No pude cargar el catálogo para clasificar por género'; });

  // ── Tendencia semanal (barras) — compacta (menos altura, deja lugar para más tarjetas) ────
  var weeks = S.VML_WEEKS.slice().reverse(); // reciente → antigua
  var wTots = weeks.map(function(w){return w.total;});
  var wMax  = Math.max.apply(null,wTots)||1;
  var bw = Math.max(26,Math.min(52,Math.floor(460/weeks.length)));
  document.getElementById('rsmn-chart').innerHTML = '<div style="display:flex;align-items:flex-end;gap:3px;height:64px;padding-bottom:20px">'
    + weeks.map(function(w,i){
        var h = Math.max(3,Math.round(wTots[i]/wMax*44));
        var isLast = i===0;
        return '<div style="display:flex;flex-direction:column;align-items:center;gap:2px;flex-shrink:0;width:'+bw+'px">'
          +'<div style="font-size:8px;color:var(--text-soft);font-weight:600;line-height:1">'+wTots[i]+'</div>'
          +'<div style="width:100%;height:'+h+'px;background:'+(isLast?'#16a34a':'#6366F1')+';border-radius:3px 3px 0 0;opacity:'+(isLast?'1':'.7')+'"></div>'
          +'<div style="font-size:8px;color:var(--text-muted);text-align:center;line-height:1.1;max-width:'+bw+'px;overflow:hidden">'+w.label.split(' – ')[0]+'</div>'
          +'</div>';
      }).join('')
    +'</div>';

  // ── Crecimiento sem a sem (top 5 bases) ─────────────────
  var top5b = sortedBase.slice(0,5);
  var wks   = S.VML_WEEKS; // cronológico
  var growHdr = '<table style="width:100%;font-size:12px"><thead><tr>'
    +'<th style="text-align:left;padding:6px 8px;min-width:130px">Código</th>';
  wks.forEach(function(w){ growHdr += '<th style="text-align:center;padding:6px 4px;font-size:10px;white-space:nowrap">'+w.label.split(' – ')[0]+'</th>'; });
  growHdr += '</tr></thead><tbody>';
  var growRows = top5b.map(function(base,bi){
    var row = '<tr style="background:'+(bi%2===0?'var(--bg)':'var(--surface)')+'"><td style="padding:5px 8px;font-family:monospace;font-size:11px;font-weight:700">'+base+'</td>';
    var prev = 0;
    wks.forEach(function(w){
      var v = Object.keys(w.skus).filter(function(s){return vmlBaseCode(s)===base;}).reduce(function(s,s2){return s+w.skus[s2];},0);
      var delta = prev>0 ? v-prev : null;
      var color = delta===null?'var(--text-muted)':delta>0?'#16a34a':delta<0?'#dc2626':'var(--text-muted)';
      var arrow = delta===null?'':delta>0?' ↑':delta<0?' ↓':'';
      row += '<td style="text-align:center;padding:5px 4px;font-weight:'+(v>0?'700':'400')+';color:'+(v>0?color:'var(--border)')+'">'+(v>0?v:'·')+(v>0&&delta!==null?'<span style="font-size:9px">'+arrow+'</span>':'')+'</td>';
      prev = v;
    });
    return row+'</tr>';
  }).join('');
  document.getElementById('rsmn-growth').innerHTML = growHdr+growRows+'</tbody></table>';
  document.getElementById('rsmn-growth-sub').textContent = 'Top 5 códigos — ↑ sube ↓ baja vs semana anterior';

  try{ rsmGeoBuild(); }catch(e){}   // geografía de la demanda (provincia + tendencias forma/zona) — best-effort, async
}

// Geografía de la demanda en el Resumen: (1) ventas por provincia (snapshot de /api/geo-mix) + (2)(3) cómo va
// variando la demanda por forma de envío y por zona climática (semanal, /api/geo-trend, share 100%-stacked).
// Best-effort: si la geo aún está backfilleándose muestra lo que hay; NO rompe el Resumen. Recrea el <canvas> en
// cada render (destruye el chart previo) para que re-navegar a Resumen no choque con "canvas already in use".
export function rsmGeoBuild(){
  var C={ prov:'#6366F1', Flex:'#0284c7', Correo:'#15803d', Full:'#d97706', Otro:'#9ca3af' };
  var ZC=['#166534','#22C55E','#4ADE80','#0284c7','#38bdf8','#d97706','#f59e0b','#a78bfa'];
  var fmtD=function(iso){ if(!iso)return ''; var p=String(iso).split('-'); return p.length>=3?(parseInt(p[2],10)+'/'+parseInt(p[1],10)):String(iso); };
  var fresh=function(cid,cvid){ var el=document.getElementById(cid); if(!el)return null; try{ if(window.Chart&&Chart.getChart){ var pv=Chart.getChart(cvid); if(pv)pv.destroy(); } }catch(e){} el.innerHTML='<canvas id="'+cvid+'"></canvas>'; return cvid; };
  var msg=function(cid,t){ var el=document.getElementById(cid); if(el)el.innerHTML='<div style="padding:24px;color:var(--text-soft);font-size:12px">'+t+'</div>'; };
  var pctScale={ stacked:true, max:100, grid:{color:'rgba(79,70,229,.08)'}, border:{display:false}, ticks:{font:{size:10},callback:function(v){return v+'%';}} };
  var wkX={ stacked:true, grid:{display:false}, border:{display:false}, ticks:{font:{size:9},maxRotation:50,autoSkip:true} };

  Promise.all([apiGet('/api/geo-mix?weeks=8'), apiGet('/api/geo-trend?weeks=20')]).then(function(res){
    var mix=res[0]||{}, tr=res[1]||{};
    // ── 1) Ventas por provincia (snapshot) ──
    var allProv=mix.byState||[]; var provTot=allProv.reduce(function(s,r){return s+(r.u||0);},0);
    var prov=allProv.slice(0,12);
    if(prov.length){ fresh('rsmn-geo-prov','rsmn-geo-prov-cv');
      mkChart('rsmn-geo-prov-cv','bar', prov.map(function(r){return r.k;}), [{data:prov.map(function(r){return r.u;}),backgroundColor:C.prov,borderRadius:4}],
        {indexAxis:'y',plugins:{tooltip:{callbacks:{label:function(c){return c.parsed.x.toLocaleString('es-AR')+' u ('+(provTot?Math.round(c.parsed.x/provTot*100):0)+'%)';}}}},scales:{x:{grid:{color:'rgba(79,70,229,.08)'},border:{display:false},ticks:{font:{size:9}}},y:{grid:{display:false},border:{display:false},ticks:{font:{size:10}}}}});
    } else msg('rsmn-geo-prov','Sin datos de geografía todavía.');
    var ps=document.getElementById('rsmn-geo-prov-sub'); if(ps) ps.textContent = provTot ? (provTot.toLocaleString('es-AR')+' u'+(mix.capturePct!=null?' · '+mix.capturePct+'% de la demanda':'')) : '';

    // ── series semanal (para 2 y 3) ──
    var series=tr.series||[]; var labels=series.map(function(w){return fmtD(w.wk);});
    var hasTrend=series.length>=2;   // 1 sola semana no es "tendencia"
    // Tooltip: título con el tamaño de muestra (n) + flag "muestra chica" → una semana poco resuelta (backfill en
    // curso) o de bajo volumen NO se lee como tendencia sólida (el share es representativo pero ruidoso con n chico).
    var shareTip={ callbacks:{ title:function(items){var w=series[items[0].dataIndex]||{}; return fmtD(w.wk)+' · '+(w.total||0).toLocaleString('es-AR')+' u'+((w.total||0)<40?' · muestra chica':'');}, label:function(c){return c.dataset.label+': '+Math.round(c.parsed.y)+'%';} } };

    // ── 2) Demanda por forma (share 100%-stacked) ──
    if(hasTrend){ fresh('rsmn-geo-forma','rsmn-geo-forma-cv');
      var fKeys=['Flex','Correo','Full','Otro'];
      var fds=fKeys.map(function(k){ return { label:k, data:series.map(function(w){ return share(w.forma&&w.forma[k]||0, w.total); }), backgroundColor:C[k] }; })
                   .filter(function(d){ return d.data.some(function(v){return v>0.5;}); });
      mkChart('rsmn-geo-forma-cv','bar',labels,fds,{plugins:{legend:{display:true,position:'bottom',labels:{font:{size:10},padding:8,boxWidth:12}},tooltip:shareTip},scales:{x:wkX,y:pctScale}});
    } else msg('rsmn-geo-forma','Tendencia en construcción (backfill de geografía en curso).');

    // ── 3) Demanda por zona (top 7 + Otras, share 100%-stacked) ──
    if(hasTrend){ fresh('rsmn-geo-zona','rsmn-geo-zona-cv');
      var zTot={}; series.forEach(function(w){ var z=w.zone||{}; Object.keys(z).forEach(function(k){ zTot[k]=(zTot[k]||0)+z[k]; }); });
      var topZ=Object.keys(zTot).sort(function(a,b){return zTot[b]-zTot[a];}).slice(0,7);
      var zlab=tr.zoneLabels||{};
      var zds=topZ.map(function(z,i){ return { label:(zlab[z]||z), data:series.map(function(w){ return share(w.zone&&w.zone[z]||0, w.total); }), backgroundColor:ZC[i%ZC.length] }; });
      zds.push({ label:'Otras', data:series.map(function(w){ var top=topZ.reduce(function(s,z){return s+(w.zone&&w.zone[z]||0);},0); return othersShare(w.total, top); }), backgroundColor:C.Otro });
      mkChart('rsmn-geo-zona-cv','bar',labels,zds,{plugins:{legend:{display:true,position:'bottom',labels:{font:{size:9},padding:5,boxWidth:10}},tooltip:shareTip},scales:{x:wkX,y:pctScale}});
    } else msg('rsmn-geo-zona','Tendencia en construcción (backfill de geografía en curso).');
  }).catch(function(e){ /* geo best-effort: no romper el Resumen */ });
}

