// @ts-nocheck
// ParkaHub — modulo CORE STATE (persistencia PC products + reset de datos / nuevo reporte).
// Funciones movidas TAL CUAL desde app.ts. Cero cambio de logica.
import { S } from './state'
import { refreshHeaders, nbadge, toast, confirm2 } from './core-ui'
import { filterHist } from './history'
import { apiPut, apiPost } from './api'

function savePCProducts(){
  try{localStorage.setItem('parka_pc_products',JSON.stringify(S.PC_PRODUCTS));}catch(e){}
  // fire-and-forget al backend (cache local sigue siendo la fuente de arranque)
  apiPut('/api/state/pc_products',{data:S.PC_PRODUCTS});
}

// Guardar parametros de costeo: cache local + backend (debounce ~400ms).
let _pcParamsTimer = null;
function savePCParams(){
  try{localStorage.setItem('parka_pc_params',JSON.stringify(S.PC_PARAMS));}catch(e){}
  if(_pcParamsTimer) clearTimeout(_pcParamsTimer);
  _pcParamsTimer = setTimeout(function(){
    apiPut('/api/state/pc_params',{data:S.PC_PARAMS});
  }, 400);
}

// --- MISC --------------------------------------------------------------
function clearAll(){if(!confirm2('clearAll','¿Limpiar TODOS los datos y credenciales?'))return;S.platOrders=[];S.manualOrders=[];S.reportData=[];S.filteredMan=[];S.filteredPlat=[];S.filteredRep=[];S.xlImported=[];S.xlFiltered=[];localStorage.clear();apiPost('/api/state/reset',{confirm:true});try{localStorage.setItem('parka_d1_migrated','1');}catch(e){}refreshHeaders();window.filterManual?.('');window.renderPlatTable?.();filterHist();window.renderDespachos?.();nbadge('nb-orders',0);nbadge('nb-rep',0);var xr=document.getElementById('xl-result-state');if(xr)xr.style.display='none';document.getElementById('rep-card').style.display='none';toast('Datos eliminados','info');}

// --- NEW REPORT (clear imported data) ----------------------------------
function newReport(){
  if(S.xlImported.length && !confirm2('newReport','¿Limpiar las órdenes importadas y empezar un nuevo reporte?')) return;
  // Clear excel imports
  S.platOrders = S.platOrders.filter(o => !(o.platform==='ml' && o.source==='excel'));
  S.xlImported = []; S.xlFiltered = [];
  // Reset UI
  var xr2=document.getElementById('xl-result-state');if(xr2)xr2.style.display='none';
  // badges
  document.getElementById('xl-result-state').style.display  = 'none';
  document.getElementById('xl-files-list').innerHTML = '';
  document.getElementById('xl-tbody').innerHTML = '';
  document.getElementById('xl-search').value = '';
  // Reset stats
  ['xlsum-n','xlsum-u','xlsum-sku','xlsum-flex','xlsum-colecta','xlsum-correo'].forEach(id=>{
    const e=document.getElementById(id); if(e) e.textContent='0';
  });
  refreshHeaders(); filterHist(); window.renderDespachos?.();
  nbadge('nb-orders', S.manualOrders.length);
  toast('Listo para un nuevo reporte','info');
}

export { savePCProducts, savePCParams, clearAll, newReport }

// Funciones "wired" (llamadas desde el HTML): re-exponer en window.
try{window.clearAll=clearAll;}catch(e){}
try{window.savePCParams=savePCParams;}catch(e){}
