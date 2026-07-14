// @ts-nocheck
// ParkaHub — modulo PRECIOS (lista de precios: modificadores de descuento / PVP).
// Funciones movidas TAL CUAL desde app.ts. Cero cambio de logica.
// Estado compartido via S (./state). Helpers puros via ./util. toast via ./core-ui.
// Costeo (calcCostoARS) via ./costs.
// Re-renders cross-dominio (matrizRender) y save (savePCProducts) se invocan por
// window.fn?.() para NO crear ciclos con app.ts.
import { S } from './state'
import { pn, fARS } from './util'
import { toast } from './core-ui'
import { calcCostoARS } from './costs'

// ── LISTA DE PRECIOS: solo modificadores ────────────
export function preciosRender(){
  var dolar    = pn('cv-dolar-bna')||pn('pc-dolar')||1200;
  var margen   = pn('pc-margen')/100;
  var comision = pn('pc-comision')/100;
  var q        = (document.getElementById('pc-search')||{}).value;
  q = q ? q.toLowerCase() : '';
  var data = q ? S.PC_PRODUCTS.filter(function(p){return (p.name+p.sku).toLowerCase().includes(q);}) : S.PC_PRODUCTS;
  var tbody = document.getElementById('pc-tbody');
  var empty = document.getElementById('pc-empty');
  if(!tbody) return;
  if(!data.length){tbody.innerHTML='';empty.style.display='';return;}
  empty.style.display='none';

  tbody.innerHTML = data.map(function(p,i){
    var costoARS = calcCostoARS(p);
    var pvpFull  = p.retailPriceFull || costoARS*2;
    var discML   = p.planMargins ? (p.planMargins.cuotas6||0) : 0;
    var discTN   = p.discTN || 0;
    var pvpML    = pvpFull*(1-discML/100);
    var pvpTN    = pvpFull*(1-discTN/100);
    var pDist    = costoARS*(1+margen);
    var pVend    = pDist*(1+comision);
    var isML = p.canal==='ML';
    var bg = isML?'':'rgba(14,116,144,.04)';
    return '<tr style="border-bottom:1px solid var(--border2);background:'+bg+'">'
      +'<td style="padding:10px 14px">'
        +'<div style="font-weight:700;font-size:12px">'+p.name+'</div>'
        +'<div style="font-size:10px;color:var(--text-muted);font-family:monospace">'+p.sku+'</div>'
      +'</td>'
      +'<td style="text-align:right;font-family:monospace;font-size:12px;padding:10px 14px;background:var(--surface2)">'+fARS(costoARS)+'</td>'
      // Descuento ML editable
      +'<td style="text-align:center;padding:8px 10px">'
        +'<input type="number" value="'+(discML)+'" min="0" max="50" step="1" '
          +'onchange="pcSetDiscount(\''+p.id+'\',\'ML\',this.value)" '
          +'style="width:60px;text-align:center;font-weight:700;border:1px solid var(--border);border-radius:6px;padding:4px 6px">'
      +'</td>'
      // Descuento TN editable
      +'<td style="text-align:center;padding:8px 10px">'
        +'<input type="number" value="'+discTN+'" min="0" max="50" step="1" '
          +'onchange="pcSetDiscount(\''+p.id+'\',\'TN\',this.value)" '
          +'style="width:60px;text-align:center;font-weight:700;border:1px solid var(--border);border-radius:6px;padding:4px 6px">'
      +'</td>'
      // PVP Full ML editable
      +'<td style="text-align:center;padding:8px 10px;background:rgba(13,122,82,.06)">'
        +'<input type="number" value="'+Math.round(pvpFull)+'" min="0" step="100" '
          +'onchange="pcSetPVP(\''+p.id+'\',this.value)" '
          +'style="width:90px;text-align:center;font-weight:800;color:var(--accent);border:1px solid var(--accent);border-radius:6px;padding:4px 6px">'
        +'<div style="font-size:9px;color:var(--text-muted);margin-top:2px">final: '+fARS(pvpML)+'</div>'
      +'</td>'
      // PVP TN calculado
      +'<td style="text-align:center;padding:10px 14px;background:rgba(14,116,144,.06)">'
        +'<div style="font-weight:800;color:var(--teal);font-size:13px">'+fARS(pvpTN)+'</div>'
        +'<div style="font-size:9px;color:var(--text-muted)">desc TN '+discTN+'%</div>'
      +'</td>'
      // Precio Dist
      +'<td style="text-align:center;padding:10px 14px"><span style="font-weight:700;font-size:12px">'+fARS(pDist)+'</span></td>'
      // PVP c/Vendedor
      +'<td style="text-align:center;padding:10px 14px"><span style="font-weight:700;font-size:12px;color:var(--teal)">'+fARS(pVend)+'</span></td>'
      +'</tr>';
  }).join('');
}

function pcSetDiscount(id, canal, val){
  var p = S.PC_PRODUCTS.find(function(x){return x.id===id;});
  if(!p) return;
  var v = parseFloat(val)||0;
  if(canal==='ML'){
    if(!p.planMargins) p.planMargins={cuotas6:0,cuotas3:0,ib:0,clasica:0};
    p.planMargins.cuotas6 = v;
    p.planMargins.cuotas3 = Math.max(0,v-5);
    p.planMargins.ib = Math.max(0,v-8);
  } else {
    p.discTN = v;
  }
  window.savePCProducts?.();
  window.matrizRender?.();
}

function pcSetPVP(id, val){
  var p = S.PC_PRODUCTS.find(function(x){return x.id===id;});
  if(!p) return;
  p.retailPriceFull = parseFloat(val)||0;
  window.savePCProducts?.();
  window.matrizRender?.();
}

function preciosExportXL(){
  if(!S.PC_PRODUCTS.length){toast('Sin productos','error');return;}
  var dolar=pn('pc-dolar')||1200, margen=pn('pc-margen')/100, com=pn('pc-comision')/100;
  var wb=XLSX.utils.book_new();
  var ws=XLSX.utils.aoa_to_sheet([
    ['SKU','Artículo','Canal','Costo ARS','Desc ML %','Desc TN %','PVP Full','PVP ML Final','PVP TN Final','Precio Dist.','PVP c/Vendedor'],
    ...S.PC_PRODUCTS.map(function(p){
      var c=calcCostoARS(p),pf=p.retailPriceFull||c*2;
      var dML=p.planMargins?(p.planMargins.cuotas6||0):0,dTN=p.discTN||0;
      var pd=c*(1+margen),pv=pd*(1+com);
      return [p.sku,p.name,p.canal||'ML',Math.round(c),dML,dTN,Math.round(pf),Math.round(pf*(1-dML/100)),Math.round(pf*(1-dTN/100)),Math.round(pd),Math.round(pv)];
    })
  ]);
  ws['!cols']=[10,28,6,12,8,8,12,14,14,12,14].map(function(w){return{wch:w};});
  XLSX.utils.book_append_sheet(wb,ws,'Precios');
  XLSX.writeFile(wb,'PARKA_Precios_'+new Date().toISOString().slice(0,10)+'.xlsx');
  toast('✓ Excel exportado','success');
}

// ── Re-exponer wired en window (las que el HTML llama por onclick/oninput) ──
try{window.preciosRender=preciosRender;}catch(e){}
try{window.pcSetDiscount=pcSetDiscount;}catch(e){}
try{window.pcSetPVP=pcSetPVP;}catch(e){}
try{window.preciosExportXL=preciosExportXL;}catch(e){}
