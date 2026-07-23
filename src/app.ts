// @ts-nocheck
// ParkaHub - JS de la app extraido del monolito (paso 3). Cero cambios de logica.
import { S } from './state'
import { getRange, normSt, stLabel, parseVariant, skuBase, skuSortKey, pn, fARS, fUSD, talleSort, vmlBaseCode, vmlWeekSortKey } from './util'
import { checkMobile, refreshHeaders, nbadge, toast, dzv, dzd } from './core-ui'
import { gdInit } from './integrations-gdrive'
import './integrations-firebase'
import './scan'
import './platforms'
import './costs'
import { calcCostoARS, getPCParam } from './costs'
import './matrices'
import { matrizRender } from './matrices'
import './pricing'
import { preciosRender } from './pricing'
import './dispatch-pdf'
import { classifyCarrier, renderDespachos, generateControlReport } from './dispatch-pdf'
import './report'
import { exportXLImportado, previewSalidas, buildAllCharts, renderStats, renderTop10, rsmBuild2 } from './report'
import './history'
import { vmlRender2, filterHist, renderHCargas, renderHistorial, confirmToHistorial } from './history'
import './reclamos'
import './devoluciones'
import { renderDevoluciones } from './devoluciones'
import './promos'
import './publicaciones'
import './radar'   // Fase 3: sección Radar (extraída de publicaciones.ts); su window-expose debe correr o nav('radar') muere en silencio
import './sales-ml'
import { closeModal } from './sales-ml'
import './mapeo'
import './conexiones'
import './nav'
import { nav } from './nav'
import './core-state'
import { savePCProducts, newReport } from './core-state'
import { apiGet, apiPost } from './api'

    (function(){
      var el = document.getElementById('sec-precios');
      if(!el) return;
      var obs = new MutationObserver(function(muts){
        muts.forEach(function(m){
          if(m.attributeName==='class' && el.classList.contains('active')){
            setTimeout(function(){ try{ preciosRender(); }catch(e){ console.error('preciosRender:',e); } }, 100);
          }
        });
      });
      obs.observe(el, {attributes:true});
    })();

    // Publicaciones (wizard de swap): cargar el maestro extendido al entrar
    (function(){
      var el = document.getElementById('sec-publicaciones');
      if(!el) return;
      var obs = new MutationObserver(function(muts){
        muts.forEach(function(m){
          if(m.attributeName==='class' && el.classList.contains('active')){
            try{ (window as any).pubRender?.(); }catch(e){ console.error('pubRender auto:',e); }
          }
        });
      });
      obs.observe(el, {attributes:true});
    })();

    // Auto-render al mostrar la sección
    (function(){
      var el = document.getElementById('sec-matrices');
      if(!el) return;
      var obs = new MutationObserver(function(muts){
        muts.forEach(function(m){
          if(m.attributeName==='class' && el.classList.contains('active')){
            setTimeout(function(){ try{ matrizRender(true); }catch(e){ console.error('matrizRender:',e); } }, 100);
          }
        });
      });
      obs.observe(el, {attributes:true});
    })();

    (function(){
      var el = document.getElementById('sec-costos');
      if(!el) return;
      var obs = new MutationObserver(function(muts){
        muts.forEach(function(m){
          if(m.attributeName==='class' && el.classList.contains('active')){
            setTimeout(function(){ try{ window.costosModeloRender?.(); }catch(e){ console.error('costosRender:',e); } }, 100);
          }
        });
      });
      obs.observe(el, {attributes:true});
    })();

    // Maestro: cargar + render (tabla editable con todas las columnas) al entrar
    (function(){
      var el = document.getElementById('sec-maestro');
      if(!el) return;
      var obs = new MutationObserver(function(muts){
        muts.forEach(function(m){
          if(m.attributeName==='class' && el.classList.contains('active')){
            setTimeout(function(){ try{ (window as any).maestroLoad?.(); }catch(e){ console.error('maestroLoad:',e); } }, 60);
          }
        });
      });
      obs.observe(el, {attributes:true});
    })();

    // Resumen (analisis): re-render al entrar a la sección (faltaba este observer -> quedaba en
    // blanco si rsmBuild2 no había corrido en la carga por timing de cache/bootstrap).
    (function(){
      var el = document.getElementById('sec-analisis');
      if(!el) return;
      var obs = new MutationObserver(function(muts){
        muts.forEach(function(m){
          if(m.attributeName==='class' && el.classList.contains('active')){
            setTimeout(function(){ try{ window.rsmBuild2?.(); }catch(e){ console.error('rsmBuild2:',e); } }, 100);
          }
        });
      });
      obs.observe(el, {attributes:true});
    })();

    (function(){
      var el = document.getElementById('sec-reclamos');
      if(!el) return;
      var obs = new MutationObserver(function(muts){
        muts.forEach(function(m){
          if(m.attributeName==='class' && el.classList.contains('active')){
            setTimeout(function(){ try{ window.renderReclamos?.(); }catch(e){ console.error('renderReclamos:',e); } }, 100);
          }
        });
      });
      obs.observe(el, {attributes:true});
    })();

    (function(){
      var el = document.getElementById('sec-devoluciones');
      if(!el) return;
      var obs = new MutationObserver(function(muts){
        muts.forEach(function(m){
          if(m.attributeName==='class' && el.classList.contains('active')){
            setTimeout(function(){ try{ window.renderDevoluciones?.(); }catch(e){ console.error('renderDevoluciones:',e); } }, 100);
          }
        });
      });
      obs.observe(el, {attributes:true});
    })();

    // Puntito "en vivo" (freshness del scan de precios; ahora vive dentro de Promos): clic = forzar recálculo
    // en vivo. Es solo lectura de ML (no escribe) → clic simple, sin diálogos del navegador.
    (function(){
      function wire(){
        var dot = document.getElementById('live-precio');
        if(dot && !dot._wired){ dot._wired=true; dot.addEventListener('click', function(){ window.promoPriceForce?.(); }); }
      }
      if(document.readyState==='loading') document.addEventListener('DOMContentLoaded', wire); else wire();
    })();

    // PROMOS (unificada): al entrar pinta la lista de promociones activas (tab 1) al toque, y carga las tabs de
    // precios/oportunidades (coherencia + campañas donde ML pone plata) desde el almacén + refresco en 2do plano.
    (function(){
      var el = document.getElementById('sec-promos');
      if(!el) return;
      var obs = new MutationObserver(function(muts){
        muts.forEach(function(m){
          if(m.attributeName==='class' && el.classList.contains('active')){
            setTimeout(function(){
              try{ window.renderPromosPanel?.(); }catch(e){ console.error('renderPromosPanel:',e); }
              // SIEMPRE llamamos promoPriceEnter (sin guard de "ya cargado"): re-pinta al instante desde el
              // cache y, si el dato está viejo (>30min) y no hay otro scan en curso (debounce interno 5min),
              // refresca en vivo en 2do plano. Así re-entrar a Promos trae las candidatas nuevas que ML invita
              // a diario, sin perderlas hasta recargar la página.
              try{ window.promoPriceEnter?.(); }catch(e){ console.error('promoPriceEnter auto:',e); }
            }, 100);
          }
        });
      });
      obs.observe(el, {attributes:true});
    })();


// Close sidebar when nav item clicked on mobile
document.addEventListener('DOMContentLoaded', ()=>{
  document.querySelectorAll('.nav-item').forEach(btn=>{
    btn.addEventListener('click', ()=>{
      if(window.innerWidth<=768){
        document.querySelector('.sidebar').classList.remove('open');
        document.getElementById('sidebar-overlay').classList.remove('open');
      }
    });
  });
});

// --- SCANNER -----------------------------------------------------------
// processScan, toggleCamera, stopCamera, clearScan, exportScanXL -> moved to ./scan



// --- STATE -------------------------------------------------------------

// --- NAV: movido a ./nav (nav) ---------------------------------------

// periodToggle, fetchML, fetchTN, filterPlat, renderPlatTable, exportPlatXL, switchOTab -> moved to ./platforms
// onXLDrop, onXLInput, processXLFiles, parseXLFile, filterXL, renderXLTable -> moved to ./platforms

// exportXLImportado -> moved to ./report

// --- MANUAL ORDERS -----------------------------------------------------
// openModal, closeModal, saveOrder, deleteOrder, filterManual, exportManualXL -> moved to ./sales-ml

// --- HISTORIAL (registro de reportes confirmados): movido a ./history ---

/* ═══════════════════════════════════════════════════════
   MÓDULO PRECIOS / MATRICES / COSTOS
   - Costos: crea artículos, genera 2 versiones (ML pub / TN pub)
   - Precios: modificadores de descuento y PVP full
   - Matrices: rentabilidad por plan de pago
═══════════════════════════════════════════════════════ */
// savePCProducts -> moved to ./core-state

// ── LISTA DE PRECIOS: movido a ./pricing (preciosRender, pcSetDiscount, pcSetPVP, preciosExportXL) ──

// ── MATRICES ─────────────────────────────────────────

// tnMergeWithML, tnReset -> moved to ./platforms


// ── Historial de Cargas + Historial de reportes: movido a ./history ──

// --- MISC --------------------------------------------------------------
// clearAll -> moved to ./core-state (wired en window dentro del modulo)

// --- NEW REPORT (clear imported data) ----------------------------------
// newReport -> moved to ./core-state

// --- BOOTSTRAP STATE (D1) ----------------------------------------------
// Migracion one-time + hidratacion async desde el Worker. localStorage queda
// como cache de arranque: si el backend no responde, no se toca nada.
async function bootstrapState(){
  // (a) Migracion one-time: subir lo que ya hay en localStorage a D1.
  try{
    if(localStorage.getItem('parka_d1_migrated') !== '1'){
      var payload = {
        hist:        JSON.parse(localStorage.getItem('parka_hist')        || '[]'),
        hcargas:     JSON.parse(localStorage.getItem('parka_hcargas')     || '[]'),
        pc_products: JSON.parse(localStorage.getItem('parka_pc_products') || '[]'),
        pc_params:   JSON.parse(localStorage.getItem('parka_pc_params')   || '{}'),
        vml_weeks:   JSON.parse(localStorage.getItem('parka_vml_weeks')   || '[]'),
      };
      var imp = await apiPost('/api/state/import', payload);
      if(imp){ try{ localStorage.setItem('parka_d1_migrated','1'); }catch(e){} }
    }
  }catch(e){ console.warn('bootstrap migrate:', e); }

  // (a.5) Sync compartido al abrir: un tick del pipeline (debounced server-side → si otro usuario ya
  // sincronizó hace <2min, vuelve al toque). Mantiene D1 fresco para TODOS sin que cada uno pegue a ML.
  // NO se espera (perf): antes el `await` metía 5-20s de sync de ML DELANTE de la hidratación en cada
  // apertura donde no aplicaba el debounce. Ahora corre en background; si el tick trajo ventas nuevas
  // (no fue debounced), re-baja vml_weeks (~41KB) y re-renderiza — mismo patrón que la hidratación de abajo.
  apiGet('/api/sync/tick').then(function(t){
    if(!t || t.skipped) return;                     // debounced → no cambió nada, no re-bajar
    return apiGet('/api/state/vml_weeks').then(function(r){
      if(!r || r.data==null) return;
      var w; try{ w = typeof r.data==='string' ? JSON.parse(r.data) : r.data; }catch(e){ return; }
      if(!Array.isArray(w) || !w.length) return;
      S.VML_WEEKS = w;
      try{ localStorage.setItem('parka_vml_weeks', JSON.stringify(w)); }catch(e){}
      window.vmlRender2?.(); window.rsmBuild2?.();
    });
  }).catch(function(e){ console.warn('sync tick:', e); });

  // (b) Hidratar desde D1. Si apiGet devuelve null -> queda el cache local.
  var state = await apiGet('/api/state');
  if(!state) return;
  // El Worker devuelve los dominios directo: {hist:{data,rev}, hcargas:{...}, ...} (sin wrapper .dom)
  var dom = state.dom || state;

  function pick(domain){
    var d = dom[domain];
    if(!d || d.data == null) return undefined;
    try{ return typeof d.data === 'string' ? JSON.parse(d.data) : d.data; }
    catch(e){ return undefined; }
  }

  var hist        = pick('hist');
  var hcargas     = pick('hcargas');
  var pc_products = pick('pc_products');
  var pc_params   = pick('pc_params');
  var vml_weeks   = pick('vml_weeks');

  if(hist !== undefined){
    S.historialReportes = hist;
    try{ localStorage.setItem('parka_hist', JSON.stringify(S.historialReportes)); }catch(e){}
    window.renderHistorial?.();
    nbadge('nb-hist', S.historialReportes.length);
  }
  if(hcargas !== undefined){
    S.hCargas = hcargas;
    try{ localStorage.setItem('parka_hcargas', JSON.stringify(S.hCargas)); }catch(e){}
    window.renderHCargas?.();
  }
  if(pc_products !== undefined){
    S.PC_PRODUCTS = pc_products;
    try{ localStorage.setItem('parka_pc_products', JSON.stringify(S.PC_PRODUCTS)); }catch(e){}
  }
  if(pc_params !== undefined){
    S.PC_PARAMS = pc_params;
    try{ localStorage.setItem('parka_pc_params', JSON.stringify(S.PC_PARAMS)); }catch(e){}
    // Sincronizar los inputs de parámetros (mx-*/cv-*) con lo hidratado de D1 ANTES de los renders de
    // abajo. Las keys de PC_PARAMS SON los ids de los inputs. Sin esto, matrizRender/costosModeloRender
    // leen el DEFAULT del HTML y PISAN lo guardado → era el bug de "al refrescar se borra lo editado".
    try{ Object.keys(S.PC_PARAMS).forEach(function(k){ var el=document.getElementById(k); if(el && el.tagName==='INPUT') el.value=S.PC_PARAMS[k]; }); }catch(e){}
  }
  if(vml_weeks !== undefined){
    S.VML_WEEKS = vml_weeks;
    try{ localStorage.setItem('parka_vml_weeks', JSON.stringify(S.VML_WEEKS)); }catch(e){}
    window.vmlRender2?.();
    window.rsmBuild2?.();
  }
  if(pc_products !== undefined || pc_params !== undefined){
    window.costosModeloRender?.();
    window.preciosRender?.();
    window.matrizRender?.();
  }

  // Reclamos (tabla propia en D1: /api/reclamos)
  try{
    var rec = await apiGet('/api/reclamos');
    if(rec && rec.data){
      var arr = typeof rec.data==='string' ? JSON.parse(rec.data) : rec.data;
      if(Array.isArray(arr)){
        S.reclamos = arr;
        try{ localStorage.setItem('parka_reclamos', JSON.stringify(arr)); }catch(e){}
        window.renderReclamos?.();
      }
    }
  }catch(e){ console.warn('bootstrap reclamos:', e); }
}

// --- INIT --------------------------------------------------------------
document.addEventListener('DOMContentLoaded',()=>{
  // Scanner confirm button
  const scBtn = document.getElementById('scan-confirm-btn');
  if(scBtn) scBtn.addEventListener('click', function(){
    const v = document.getElementById('scan-input');
    if(v){ window.processScan?.(v.value); v.value=''; v.focus(); }
  });
  // Scan input enter key
  const scInp = document.getElementById('scan-input');
  if(scInp) scInp.addEventListener('keydown', function(e){
    if(e.key==='Enter'){ window.processScan?.(this.value); this.value=''; }
  });
  gdInit();
  // Restaurar badge del historial desde localStorage (cache de arranque)
  nbadge('nb-hist', S.historialReportes.length);
  if(S.historialReportes.length) renderHistorial();
  // Render inmediato con el cache local; bootstrapState refresca async desde D1
  vmlRender2();
  if(S.VML_WEEKS.length) rsmBuild2();
  if(S.reclamos.length) window.renderReclamos?.();
  // Fallback: si el HTML no dejó ninguna sección activa al cargar, mostrar la default (Resumen).
  if(!document.querySelector('.sec.active')){ document.getElementById('sec-analisis')?.classList.add('active'); }
  bootstrapState();
  document.getElementById('m-date').value=new Date().toISOString().split('T')[0];
  document.getElementById('modal').addEventListener('click',function(e){if(e.target===this)closeModal();});
  // Wire import section buttons
  const btnExportXL = document.getElementById('btn-export-xl');
  if(btnExportXL) btnExportXL.addEventListener('click', previewSalidas);
  const btnNewRep = document.getElementById('btn-new-report');
  if(btnNewRep) btnNewRep.addEventListener('click', newReport);
  const btnConfHist = document.getElementById('btn-confirm-hist');
  if(btnConfHist) btnConfHist.addEventListener('click', confirmToHistorial);
  const btnGenCtrl = document.getElementById('btn-gen-control');
  if(btnGenCtrl) btnGenCtrl.addEventListener('click', generateControlReport);
});


/* == DASHBOARD JS == */


window.D=S.D; /* loaded from JSON tag */

// mkChart, buildAllCharts, srt, doFilter, thC, buildTable, handleFiles -> moved to ./report

document.addEventListener('DOMContentLoaded',function(){
  var el=document.getElementById('app-data');
  if(el){try{S.D=JSON.parse(el.textContent);window.D=S.D;}catch(e){console.warn(e);}}
  setTimeout(function(){try{buildAllCharts();}catch(e){console.warn(e);}},300);
  /* Smooth scroll nav */
  document.querySelectorAll('.nav-link').forEach(function(a){
    a.addEventListener('click',function(e){
      e.preventDefault();
      var target=document.getElementById(a.getAttribute('href').slice(1));
      if(target)target.scrollIntoView({behavior:'smooth',block:'start'});
      document.querySelectorAll('.nav-link').forEach(function(x){x.classList.remove('active');});
      a.classList.add('active');
    });
  });
  /* Active nav on scroll */
  var sections=document.querySelectorAll('.section');
  window.addEventListener('scroll',function(){
    var scrollY=window.scrollY+100;
    sections.forEach(function(s){
      if(s.offsetTop<=scrollY&&s.offsetTop+s.offsetHeight>scrollY){
        var id=s.id;
        document.querySelectorAll('.nav-link').forEach(function(a){
          a.classList.toggle('active',a.getAttribute('href')==='#'+id);
        });
      }
    });
  },{passive:true});
});



/* Stats renderers — run after app.js loaded */
document.addEventListener('DOMContentLoaded', function(){
  setTimeout(function(){
    renderStats();
  }, 400);
});

// renderStats, renderTop10 -> moved to ./report
document.addEventListener('DOMContentLoaded',function(){
  setTimeout(renderTop10, 350);
});


/* ════════════════════════════════════════
   VENTAS ML — lógica completa
   vmlLoad, vmlFilter, vmlSetWeek, vmlExpandAll, vmlCollapseAll, vmlToggle, vmlBuild -> moved to ./sales-ml
════════════════════════════════════════ */


/* VENTAS ML (semanas) + exportHubWithData + toggleHistDet: movido a ./history */

// (removido) hook legacy `goTo`/vmlLoad/vmlBuild: goTo nunca existió (la nav real es nav()),
// la tabla vieja vml-tbl no está en el HTML, y la tabla ML viva la renderiza vmlRender2 (./history).





// --- window-expose: handlers cableados desde el HTML ---
// nav: re-expuesto en ./nav
// onXLDrop, onXLInput, filterXL: re-expuestos en ./platforms
// filterManual, exportManualXL, openModal, closeModal, saveOrder: re-expuestos en ./sales-ml
try{window.savePCProducts=savePCProducts;}catch(e){}
// fetchML, periodToggle, fetchTN, filterPlat, exportPlatXL: re-expuestos en ./platforms
// onDrop, onFileInput, filterControlTable, clearControl, renderDespachos, clearDesFilters, exportDespachosXL:
// se exponen en ./dispatch-pdf (estas líneas eran refs a identificadores no importados acá -> ReferenceError tragado).
// confirmControlToHistorial, renderHCargas, clearHCargas, renderHistorial, clearHistorial, exportHistXL: re-expuestos en ./history
// clearAll: re-expuesto en ./core-state
// tnMergeWithML: re-expuesto en ./platforms
// vmlDrop2, vmlLoad2, vmlDeleteSelected, vmlClearAll2, exportHubWithData, vmlRender2: re-expuestos en ./history
try{window.rsmBuild2=rsmBuild2;}catch(e){}
