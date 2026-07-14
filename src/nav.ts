// @ts-nocheck
// ParkaHub - nav: navegación entre secciones. Cero cambios de logica.
import { S } from './state'

// --- NAV ---------------------------------------------------------------
export function nav(id,btn){
  document.querySelectorAll('.sec').forEach(s=>s.classList.remove('active'));
  document.querySelectorAll('.nav-item').forEach(n=>n.classList.remove('active'));
  document.getElementById('sec-'+id).classList.add('active');
  btn.classList.add('active');
  if(id==='analisis'){ setTimeout(function(){try{ if(S.VML_WEEKS.length) window.rsmBuild2?.(); else document.getElementById('rsmn-empty').style.display=''; }catch(e){}},100); }
  if(id==='ventas')  { setTimeout(function(){try{ window.vmlRender2?.(); }catch(e){}},50); }
  if(id==='precios') { setTimeout(function(){ try{ window.preciosRender?.(); }catch(e){ console.error('preciosRender error:',e); } },50); }
  if(id==='matrices'){ setTimeout(function(){ try{ window.matrizRender?.(true); }catch(e){ console.error('matrizRender error:',e); } },50); }
  if(id==='costos')  { setTimeout(function(){ try{ window.costosModeloRender?.(); }catch(e){ console.error('costosRender error:',e); } },50); }
  if(id==='maestro') { setTimeout(function(){ try{ window.maestroLoad?.(); }catch(e){ console.error('maestroLoad error:',e); } },50); }
  if(id==='radar')   { setTimeout(function(){ try{ window.radarLoad?.(); }catch(e){ console.error('radarLoad error:',e); } },50); }
  if(id==='historial')window.filterHist?.();
  if(id==='hist-cargas') window.renderHCargas?.();
  if(id==='despachos')window.renderDespachos?.();
  // Ensure active section is visible on mobile
  if(window.innerWidth<=768){
    document.getElementById('sec-'+id).scrollTop=0;
    window.scrollTo(0,0);
  }
}

// --- window-expose: handlers cableados desde el HTML ---
try{window.nav=nav;}catch(e){}
