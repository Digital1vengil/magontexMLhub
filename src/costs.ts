// @ts-nocheck
// ParkaHub — modulo COSTOS / PRECIOS (articulos, costeo FOB, plantilla XL).
// Funciones movidas TAL CUAL desde app.ts. Cero cambio de logica.
// Estado compartido via S (./state). Helpers puros via ./util. toast via ./core-ui.
// Re-renders cross-dominio (preciosRender / matrizRender) y save (savePCProducts)
// se invocan por window.fn?.() para NO crear ciclos con app.ts.
import { S } from './state'
import { pn, fARS, fUSD } from './util'
import { toast, confirm2, uiPrompt } from './core-ui'

// Parámetros de costo guardados globalmente
export function getPCParam(key, def){
  var el = document.getElementById(key);
  if(el) { S.PC_PARAMS[key]=parseFloat(el.value)||def; }
  return S.PC_PARAMS[key]!==undefined ? S.PC_PARAMS[key] : def;
}

// Calcula el costo ARS de un producto usando los params de costos
export function calcCostoARS(p){
  var dolar       = getPCParam('cv-dolar-bna',1200);
  var arancel     = getPCParam('cv-arancel',20)/100;
  var estadistica = getPCParam('cv-estadistica',3)/100;
  var flete       = getPCParam('cv-flete',15)/100;
  var otros       = getPCParam('cv-otros',27)/100;
  var internos    = getPCParam('cv-internos',5)/100;
  var totalAduana = arancel+estadistica+flete+otros;
  var puestoUSD   = p.fob * (1 + totalAduana);
  var puestoARS   = puestoUSD * dolar;
  return puestoARS * (1 + internos);
}

// ── COSTOS: crear artículos ──────────────────────────
async function costosNuevoArticulo(){
  var v = await uiPrompt('Nuevo artículo', [
    {key:'nombre', label:'Nombre del artículo (ej: CAMPERA ODEN)', placeholder:'CAMPERA ODEN'},
    {key:'sku',    label:'SKU base (ej: ODEN)', value:'SKU-'+Date.now().toString().slice(-4)},
    {key:'fob',    label:'FOB USD (precio de fábrica)', type:'number', value:'100'},
    {key:'pubML',  label:'% Publicidad Mercado Libre', type:'number', value:'10'},
    {key:'pubTN',  label:'% Publicidad Tienda Nube', type:'number', value:'5'},
  ], 'Crear');
  if(!v) return;
  var nombre = (v.nombre||'').trim();
  if(!nombre){ toast('Falta el nombre','error'); return; }
  var sku = (v.sku||'').trim();
  if(!sku){ toast('Falta el SKU base','error'); return; }
  var fob = parseFloat(v.fob);
  if(isNaN(fob)){ toast('FOB inválido','error'); return; }
  var pubML = parseFloat(v.pubML); if(isNaN(pubML)) pubML = 10;
  var pubTN = parseFloat(v.pubTN); if(isNaN(pubTN)) pubTN = 5;

  costoCrearPar(nombre, sku, fob, pubML, pubTN);
}

function costoCrearPar(nombre, skuBase, fob, pubML, pubTN){
  var id = Date.now().toString();
  // Versión 1: con publicidad ML
  S.PC_PRODUCTS.push({
    id: id+'_ML', name: nombre.toUpperCase(), sku: skuBase.toUpperCase(),
    canal: 'ML', fob: fob, pubPercent: pubML,
    retailPriceFull: 0,
    planMargins:{cuotas6:10,cuotas3:5,ib:2,clasica:0}
  });
  // Versión 2: con publicidad TN (independiente)
  S.PC_PRODUCTS.push({
    id: id+'_TN', name: nombre.toUpperCase()+' (TN)', sku: skuBase.toUpperCase()+'-TN',
    canal: 'TN', fob: fob, pubPercent: pubTN,
    retailPriceFull: 0,
    planMargins:{cuotas6:0,cuotas3:0,ib:0,clasica:0}
  });
  window.savePCProducts?.();
  costosModeloRender();
  window.preciosRender?.();
  window.matrizRender?.();
  toast('✓ "'+nombre.toUpperCase()+'" creado — 2 versiones (ML + TN)','success');
}

function costosDescargarPlantilla(){
  var wb = XLSX.utils.book_new();
  var ws = XLSX.utils.aoa_to_sheet([
    ['Nombre','SKU','FOB_USD','PubML_%','PubTN_%'],
    ['CAMPERA ODEN','ODEN',85,10,5],
    ['PANTALON W7','W7',60,10,5],
    ['SWEATER M144','M144',45,10,5],
  ]);
  ws['!cols']=[{wch:28},{wch:12},{wch:12},{wch:12},{wch:12}];
  XLSX.utils.book_append_sheet(wb,ws,'Plantilla');
  XLSX.writeFile(wb,'PARKA_Plantilla_Articulos.xlsx');
  toast('✓ Plantilla descargada','success');
}

function costosImportXL(e){
  var file = e.target.files[0]; if(!file) return;
  var rd = new FileReader();
  rd.onload = function(ev){
    try{
      var wb = XLSX.read(new Uint8Array(ev.target.result),{type:'array'});
      var ws = wb.Sheets[wb.SheetNames[0]];
      var rows = XLSX.utils.sheet_to_json(ws,{defval:''});
      var added = 0;
      rows.forEach(function(row){
        var nombre = String(row['Nombre']||row['nombre']||'').trim();
        var sku    = String(row['SKU']||row['sku']||'').trim();
        var fob    = parseFloat(row['FOB_USD']||row['fob']||0);
        var pubML  = parseFloat(row['PubML_%']||row['pubML']||10);
        var pubTN  = parseFloat(row['PubTN_%']||row['pubTN']||5);
        if(!nombre||!fob) return;
        costoCrearPar(nombre, sku||nombre.slice(0,6), fob, pubML, pubTN);
        added++;
      });
      toast('✓ '+added+' artículos importados','success');
    }catch(err){ toast('Error al importar: '+err.message,'error'); }
    e.target.value='';
  };
  rd.readAsArrayBuffer(file);
}

function costosEliminarArticulo(id){
  var p = S.PC_PRODUCTS.find(function(x){return x.id===id;});
  if(!p) return;
  var baseName = p.name.replace(' (TN)','');
  if(!confirm2('delArt:'+id, '¿Eliminar "'+p.name+'"?')) return;
  S.PC_PRODUCTS = S.PC_PRODUCTS.filter(function(x){return x.id!==id;});
  window.savePCProducts?.();
  costosModeloRender(); window.preciosRender?.(); window.matrizRender?.();
  toast('Eliminado','info');
}

function costosModeloRender(){
  var tbody  = document.getElementById('cv-tbody-modelo');
  var empty  = document.getElementById('cv-empty-modelo');
  var footer = document.getElementById('cv-footer-modelo');
  if(!tbody) return;

  // Guardar params en localStorage al renderizar para que Matrices/Precios los lean
  ['cv-dolar-bna','cv-arancel','cv-estadistica','cv-flete','cv-otros','cv-internos','cv-publicidad'].forEach(function(k){
    var el=document.getElementById(k); if(el){ S.PC_PARAMS[k]=parseFloat(el.value)||0; }
  });
  window.savePCParams?.();

  var dolar       = getPCParam('cv-dolar-bna',1200);
  var arancel     = getPCParam('cv-arancel',20)/100;
  var estadistica = getPCParam('cv-estadistica',3)/100;
  var flete       = getPCParam('cv-flete',15)/100;
  var otros       = getPCParam('cv-otros',27)/100;
  var internos    = getPCParam('cv-internos',5)/100;
  var totalAduanaPerc = arancel + estadistica + flete + otros;

  if(!S.PC_PRODUCTS.length){
    tbody.innerHTML=''; empty.style.display=''; footer.style.display='none'; return;
  }
  empty.style.display='none'; footer.style.display='flex';

  var multSum=0, count=0;
  tbody.innerHTML = S.PC_PRODUCTS.map(function(p){
    var costoExtraUSD = p.fob * totalAduanaPerc;
    var puestoUSD     = p.fob + costoExtraUSD;
    var puestoARS     = puestoUSD * dolar;
    var costoInternos = puestoARS * internos;
    var costoBase     = puestoARS + costoInternos;
    var costoTotal    = costoBase * (1 + (p.pubPercent||0)/100);
    var multEfectivo  = p.fob>0 ? costoTotal/p.fob/dolar : 0;
    multSum += multEfectivo; count++;

    var isML = p.canal==='ML';
    var canalBadge = isML
      ? '<span style="font-size:9px;font-weight:800;background:#FEF3C7;color:#92400E;padding:1px 6px;border-radius:4px;margin-left:4px">ML</span>'
      : '<span style="font-size:9px;font-weight:800;background:var(--teal-bg,#CFFAFE);color:var(--teal);padding:1px 6px;border-radius:4px;margin-left:4px">TN</span>';

    return '<tr style="border-bottom:1px solid var(--border2);transition:.15s" onmouseover="this.style.background=\'var(--surface2)\'" onmouseout="this.style.background=\'#fff\'">'
      +'<td style="padding:12px 16px">'
        +'<div style="display:flex;align-items:center;gap:4px">'
          +'<span style="font-size:13px;font-weight:800;text-transform:uppercase;color:var(--text)">'+p.name+'</span>'
          +canalBadge
        +'</div>'
        +'<div style="font-size:10px;color:var(--text-muted);font-family:monospace;margin-top:2px">'+p.sku
          +'<span style="margin-left:8px">pub: '+(p.pubPercent||0)+'%</span>'
        +'</div>'
      +'</td>'
      +'<td style="padding:12px 14px;text-align:right;font-family:monospace;color:var(--text-soft);background:var(--surface2)">'+fUSD(p.fob)+'</td>'
      +'<td style="padding:12px 14px;text-align:right;font-family:monospace;color:#dc2626">'
        +'+'+fUSD(costoExtraUSD)
        +'<div style="font-size:9px;color:var(--text-muted);margin-top:1px">('+(totalAduanaPerc*100).toFixed(1)+'%)</div>'
      +'</td>'
      +'<td style="padding:12px 14px;text-align:right;font-family:monospace;color:#fff;background:var(--accent);font-size:14px;font-weight:800">'+fUSD(puestoUSD)+'</td>'
      +'<td style="padding:12px 14px;text-align:right;font-family:monospace;color:var(--text)">'+fARS(puestoARS)+'</td>'
      +'<td style="padding:12px 14px;text-align:right;font-family:monospace;font-weight:800;color:#fff;background:var(--teal)">'
        +fARS(costoTotal)
        +'<div style="font-size:9px;color:rgba(255,255,255,.7);margin-top:1px">×'+multEfectivo.toFixed(3)+'</div>'
      +'</td>'
      +'<td style="padding:8px 12px;text-align:center">'
        +'<button onclick="costosEliminarArticulo(\''+p.id+'\')" class="btn btn-ghost btn-sm" style="color:#dc2626;font-size:13px;padding:2px 7px">×</button>'
      +'</td>'
      +'</tr>';
  }).join('');

  var avgMult = count ? (multSum/count) : 0;
  document.getElementById('cv-mult-avg').textContent = '× '+avgMult.toFixed(3)+' promedio';
  // Actualizar precios y matrices
  window.preciosRender?.();
  window.matrizRender?.();
}

function costosExportXL(){
  if(!S.PC_PRODUCTS.length){toast('Sin artículos','error');return;}
  var dolar=pn('cv-dolar-bna')||pn('pc-dolar')||1200;
  var arancel=pn('cv-arancel')/100,estadistica=pn('cv-estadistica')/100,flete=pn('cv-flete')/100,otros=pn('cv-otros')/100,internos=pn('cv-internos')/100;
  var totalAduana=arancel+estadistica+flete+otros;
  var wb=XLSX.utils.book_new();
  var ws=XLSX.utils.aoa_to_sheet([
    ['SKU','Artículo','Canal','FOB USD','Pub %','Costos Aduana USD','FOB Puesto USD','Puesto ARS','Costo Total c/Pub ARS','Multiplicador'],
    ...S.PC_PRODUCTS.map(function(p){
      var extra=p.fob*totalAduana,puesto=p.fob+extra,puestoARS=puesto*dolar;
      var total=(puestoARS+puestoARS*internos)*(1+(p.pubPercent||0)/100);
      return [p.sku,p.name,p.canal||'ML',p.fob,p.pubPercent||0,+extra.toFixed(2),+puesto.toFixed(2),Math.round(puestoARS),Math.round(total),+(total/p.fob/dolar).toFixed(3)];
    })
  ]);
  ws['!cols']=[10,28,6,10,8,14,14,14,16,12].map(function(w){return{wch:w};});
  XLSX.utils.book_append_sheet(wb,ws,'Costos FOB');
  XLSX.writeFile(wb,'PARKA_Costos_'+new Date().toISOString().slice(0,10)+'.xlsx');
  toast('✓ Excel exportado','success');
}

// alias para compatibilidad
function preciosNuevoProducto(){ costosNuevoArticulo(); }
function costosRender(){ costosModeloRender(); }
function costosSimular(){ costosModeloRender(); }
function costosRenderTable(){ costosModeloRender(); }

// --- window-expose: handlers cableados desde el HTML ---
try{window.costosModeloRender=costosModeloRender;}catch(e){}
try{window.costosNuevoArticulo=costosNuevoArticulo;}catch(e){}
try{window.costosImportXL=costosImportXL;}catch(e){}
try{window.costosDescargarPlantilla=costosDescargarPlantilla;}catch(e){}
try{window.costosExportXL=costosExportXL;}catch(e){}
try{window.costosEliminarArticulo=costosEliminarArticulo;}catch(e){}
