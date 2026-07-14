// @ts-nocheck
// ParkaHub - modulo HISTORIAL + HISTORIAL DE CARGAS + VENTAS ML (semanas).
// Extraido de app.ts sin cambios de logica.
import { S } from './state'
import { talleSort, vmlBaseCode, vmlWeekSortKey } from './util'
import { nbadge, toast, confirm2 } from './core-ui'
import { gdUploadFile } from './integrations-gdrive'
import { apiPut, apiPost } from './api'

// --- HISTORIAL (registro de reportes confirmados) ----------------------
function saveHist(){
  try{localStorage.setItem('parka_hist',JSON.stringify(S.historialReportes));}catch(e){}
  apiPut('/api/state/hist',{data:S.historialReportes});
}

/* ── Historial de Cargas (Excel ML importados) ── */
function saveHCargas(){
  try{ localStorage.setItem('parka_hcargas', JSON.stringify(S.hCargas)); }catch(e){}
  apiPut('/api/state/hcargas',{data:S.hCargas});
}

function addHCarga(filename, orders){
  var units   = orders.reduce(function(s,o){return s+o.qty;},0);
  var flex    = orders.filter(function(o){return o.carrier==='flex';}).length;
  var colecta = orders.filter(function(o){return !o.carrier||o.carrier==='colecta';}).length;
  var correo  = orders.filter(function(o){return o.carrier==='correo';}).length;
  var punto   = orders.filter(function(o){return o.carrier==='punto';}).length;
  S.hCargas.unshift({
    id:      Date.now(),
    fecha:   new Date().toLocaleString('es-AR',{day:'2-digit',month:'2-digit',year:'2-digit',hour:'2-digit',minute:'2-digit'}),
    archivo: filename,
    ordenes: new Set(orders.map(function(o){return o.orderId;})).size,
    unidades: units,
    flex: flex, colecta: colecta, correo: correo, punto: punto
  });
  saveHCargas();
  nbadge('nb-hcargas', S.hCargas.length);
  renderHCargas();
  // Registrar evento de carga en el backend (fire-and-forget)
  apiPost('/api/events',{fn:filename, ts:Date.now(), u:units});
}

function renderHCargas(){
  var q = (document.getElementById('hcargas-search')||{}).value;
  q = q ? q.toLowerCase() : '';
  var data = q ? S.hCargas.filter(function(e){ return [e.archivo,e.fecha].some(function(f){return f.toLowerCase().includes(q);}); }) : S.hCargas;
  var empty = document.getElementById('hcargas-empty');
  var table = document.getElementById('hcargas-table');
  if(!data.length){ empty.style.display=''; table.style.display='none'; return; }
  empty.style.display='none'; table.style.display='';
  document.getElementById('hcargas-tbody').innerHTML = data.map(function(e){
    return '<tr>'
      +'<td style="font-size:12px;white-space:nowrap">'+e.fecha+'</td>'
      +'<td style="font-size:12px;color:var(--text-soft);max-width:200px;overflow:hidden;text-overflow:ellipsis">'+e.archivo+'</td>'
      +'<td style="text-align:center;font-weight:700;color:#4F46E5">'+e.ordenes+'</td>'
      +'<td style="text-align:center;font-weight:700">'+e.unidades+'</td>'
      +'<td style="text-align:center;color:var(--teal)">'+e.flex+'</td>'
      +'<td style="text-align:center;color:var(--blue)">'+e.colecta+'</td>'
      +'<td style="text-align:center;color:var(--orange)">'+e.correo+'</td>'
      +'<td style="text-align:center;color:var(--text-soft)">'+e.punto+'</td>'
      +'<td style="display:flex;gap:4px;align-items:center">'
        +'<button class="btn btn-secondary btn-sm" onclick="exportHCargaEntry('+e.id+')" style="font-size:11px;padding:4px 8px" title="Exportar Excel">'
          +'<svg width="11" height="11" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4M7 10l5 5 5-5M12 15V3"/></svg> Excel'
        +'</button>'
        +(S.GD.token?'<button class="btn btn-secondary btn-sm" onclick="exportHCargaDrive('+e.id+')" style="font-size:11px;padding:4px 8px" title="Guardar en Drive">'
          +'<svg width="11" height="11" viewBox="0 0 87.3 78" xmlns="http://www.w3.org/2000/svg"><path d="m6.6 66.85 3.85 6.65c.8 1.4 1.95 2.5 3.3 3.3l13.75-23.8h-27.5c0 1.55.4 3.1 1.2 4.5z" fill="#0066da"/><path d="m43.65 25-13.75-23.8c-1.35.8-2.5 1.9-3.3 3.3l-25.4 44a9.06 9.06 0 0 0 -1.2 4.5h27.5z" fill="#00ac47"/><path d="m73.55 76.8c1.35-.8 2.5-1.9 3.3-3.3l1.6-2.75 7.65-13.25c.8-1.4 1.2-2.95 1.2-4.5h-27.502l5.852 11.5z" fill="#ea4335"/><path d="m43.65 25 13.75-23.8c-1.35-.8-2.9-1.2-4.5-1.2h-18.5c-1.6 0-3.15.45-4.5 1.2z" fill="#00832d"/><path d="m59.8 53h-32.3l-13.75 23.8c1.35.8 2.9 1.2 4.5 1.2h50.8c1.6 0 3.15-.45 4.5-1.2z" fill="#2684fc"/><path d="m73.4 26.5-12.7-22c-.8-1.4-1.95-2.5-3.3-3.3l-13.75 23.8 16.15 28h27.45c0-1.55-.4-3.1-1.2-4.5z" fill="#ffba00"/></svg> Drive'
        +'</button>':'')
        +'<button class="btn btn-ghost btn-sm" onclick="deleteHCarga('+e.id+')" style="color:#c0392b;padding:2px 6px">×</button>'
      +'</td>'
      +'</tr>';
  }).join('');
}

function exportHCargaEntry(id){
  var e = S.hCargas.find(function(x){return x.id===id;});
  if(!e){ toast('Entrada no encontrada','error'); return; }
  var wb = XLSX.utils.book_new();
  var ws = XLSX.utils.aoa_to_sheet([
    ['Fecha','Archivo','Órdenes','Unidades','Flex','Colecta','Correo','Punto'],
    [e.fecha, e.archivo, e.ordenes, e.unidades, e.flex, e.colecta, e.correo, e.punto]
  ]);
  ws['!cols']=[{wch:16},{wch:36},{wch:10},{wch:10},{wch:8},{wch:8},{wch:8},{wch:8}];
  XLSX.utils.book_append_sheet(wb, ws, 'Carga');
  var fname = 'PARKA_Carga_'+e.fecha.replace(/[\/: ]/g,'_')+'.xlsx';
  XLSX.writeFile(wb, fname);
  toast('✓ Excel exportado','success');
}

async function exportHCargaDrive(id){
  if(!S.GD.token){ toast('Conectate a Google Drive primero','error'); return; }
  var e = S.hCargas.find(function(x){return x.id===id;});
  if(!e){ toast('Entrada no encontrada','error'); return; }
  toast('Subiendo a Drive...','info');
  var wb = XLSX.utils.book_new();
  var ws = XLSX.utils.aoa_to_sheet([
    ['Fecha','Archivo','Órdenes','Unidades','Flex','Colecta','Correo','Punto'],
    [e.fecha, e.archivo, e.ordenes, e.unidades, e.flex, e.colecta, e.correo, e.punto]
  ]);
  ws['!cols']=[{wch:16},{wch:36},{wch:10},{wch:10},{wch:8},{wch:8},{wch:8},{wch:8}];
  XLSX.utils.book_append_sheet(wb, ws, 'Carga');
  var fname = 'PARKA_Carga_'+e.fecha.replace(/[\/: ]/g,'_')+'.xlsx';
  var wbout = XLSX.write(wb,{bookType:'xlsx',type:'array'});
  var blob  = new Blob([wbout],{type:'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'});
  await gdUploadFile(blob, fname, 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
}

function deleteHCarga(id){
  S.hCargas = S.hCargas.filter(function(x){return x.id!==id;});
  saveHCargas();
  nbadge('nb-hcargas', S.hCargas.length);
  renderHCargas();
}

function clearHCargas(){
  if(!confirm2('clearHCargas','¿Limpiar el historial de cargas?')) return;
  S.hCargas = [];
  saveHCargas();
  nbadge('nb-hcargas', 0);
  renderHCargas();
}

// Confirmar desde PDFs de control
function confirmControlToHistorial(){
  if(!S.controlEntries.length){toast('Cargá los PDFs primero','error');return;}
  const filename=(document.getElementById('rep-card-sub')||{}).textContent||new Date().toLocaleDateString('es-AR');
  const snap=S.controlEntries.map(e=>({buyer:e.buyer,ref:e.ref,items:(e.items||[]).map(i=>({sku:i.sku,talle:i.talle,qty:i.qty})),qty:e.qty}));
  const entry={id:Date.now(),fecha:new Date().toLocaleString('es-AR',{day:'2-digit',month:'2-digit',year:'2-digit',hour:'2-digit',minute:'2-digit'}),archivo:filename,ordenes:S.controlEntries.length,unidades:S.controlEntries.reduce((s,e)=>s+e.qty,0),multi:S.controlEntries.filter(e=>e.items.length>1).length,skus:new Set(S.controlEntries.flatMap(e=>e.items.map(i=>i.sku))).size,snap};
  S.historialReportes.unshift(entry);
  saveHist();renderHistorial();nbadge('nb-hist',S.historialReportes.length);
  // Mostrar botón Drive si está conectado
  var driveBtn = document.getElementById('btn-save-drive-rep');
  if(driveBtn) driveBtn.style.display = S.GD.token ? 'inline-flex' : 'none';
  toast('✓ '+entry.ordenes+' órdenes confirmadas al historial','success');
}

function confirmToHistorial(){
  if(!S.xlImported.length){ toast('No hay ordenes importadas para confirmar','error'); return; }
  const filename = (document.getElementById('xl-result-sub')||{}).textContent||'';
  const uniqueOrders = new Set(S.xlImported.map(o=>o.orderId)).size;
  const units  = S.xlImported.reduce((s,o)=>s+o.qty,0);
  const flex   = S.xlImported.filter(o=>o.carrier==='flex').length;
  const colecta= S.xlImported.filter(o=>!o.carrier||o.carrier==='colecta').length;
  const correo = S.xlImported.filter(o=>o.carrier==='correo').length;
  const punto  = S.xlImported.filter(o=>o.carrier==='punto').length;

  const entry = {
    id:      Date.now(),
    fecha:   new Date().toLocaleString('es-AR',{day:'2-digit',month:'2-digit',year:'2-digit',hour:'2-digit',minute:'2-digit'}),
    archivo: filename,
    ordenes: uniqueOrders,
    unidades:units,
    flex, colecta, correo, punto,
  };
  S.historialReportes.unshift(entry);
  saveHist();
  // También guardar en historial de cargas
  addHCarga(filename, S.xlImported);
  // Mostrar botón Drive si está conectado
  var driveBtn = document.getElementById('btn-save-drive-orders');
  if(driveBtn) driveBtn.style.display = S.GD.token ? 'inline-flex' : 'none';
  renderHistorial();
  nbadge('nb-hist', S.historialReportes.length);
  toast('Reporte confirmado al historial','success');
}

function renderHistorial(){
  const q = (document.getElementById('hist-search')||{}).value?.toLowerCase()||'';
  const data = q
    ? S.historialReportes.filter(e=>[e.archivo,e.fecha].some(f=>f.toLowerCase().includes(q)))
    : S.historialReportes;

  const empty = document.getElementById('hist-empty');
  const table = document.getElementById('hist-table');
  if(!data.length){ empty.style.display=''; table.style.display='none'; return; }
  empty.style.display='none'; table.style.display='table';

  document.getElementById('hist-tbody').innerHTML = data.map((e)=>{
    const hasSnap=e.snap&&e.snap.length;
    const detBtn=hasSnap?`<button class="btn btn-ghost btn-sm" onclick="toggleHistDet(${e.id})" style="font-size:10px">▼ Ver</button>`:'';
    const detRow=hasSnap?`<tr id="hdet-${e.id}" style="display:none"><td colspan="8" style="padding:0;background:var(--bg)"><div style="padding:8px 16px;overflow:auto;max-height:220px"><table style="width:100%;font-size:12px;border-collapse:collapse"><thead><tr style="background:var(--surface2)"><th style="padding:4px 8px;text-align:left">Comprador</th><th>Venta/Pack</th><th>SKU</th><th>Cant.</th></tr></thead><tbody>${e.snap.map(o=>`<tr style="border-bottom:1px solid var(--border)"><td style="padding:3px 8px;font-weight:600">${o.buyer||'--'}</td><td style="padding:3px 8px;font-size:11px;color:#666">${o.ref||'--'}</td><td style="padding:3px 8px">${(o.items||[]).map(i=>`<span style="background:#e8f0fe;color:#1a56db;border-radius:3px;padding:1px 5px;font-size:11px;font-weight:600">${i.sku}</span>${i.talle?' '+i.talle:''}`).join(' ')}</td><td style="padding:3px 8px;text-align:center;font-weight:700">${o.qty}</td></tr>`).join('')}</tbody></table></div></td></tr>`:'';
    return `<tr>
      <td style="font-size:12px;white-space:nowrap">${e.fecha}</td>
      <td style="font-size:12px;max-width:180px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${e.archivo||''}">${e.archivo||'--'}</td>
      <td style="text-align:center;font-family:'Space Grotesk',sans-serif;font-weight:700;font-size:15px">${e.ordenes}</td>
      <td style="text-align:center;font-family:'Space Grotesk',sans-serif;font-weight:600">${e.unidades}</td>
      <td style="text-align:center;font-size:12px;color:var(--orange)">${e.multi||'--'}</td>
      <td style="text-align:center">${detBtn}</td>
      <td style="display:flex;gap:4px;align-items:center">
        <button class="btn btn-secondary btn-sm" onclick="exportHistEntry(${e.id})" title="Exportar Excel" style="font-size:11px;padding:4px 8px">
          <svg width="11" height="11" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4M7 10l5 5 5-5M12 15V3"/></svg> Excel
        </button>
        ${S.GD.token?`<button class="btn btn-secondary btn-sm" onclick="exportHistEntryDrive(${e.id})" title="Guardar en Drive" style="font-size:11px;padding:4px 8px">
          <svg width="11" height="11" viewBox="0 0 87.3 78" xmlns="http://www.w3.org/2000/svg"><path d="m6.6 66.85 3.85 6.65c.8 1.4 1.95 2.5 3.3 3.3l13.75-23.8h-27.5c0 1.55.4 3.1 1.2 4.5z" fill="#0066da"/><path d="m43.65 25-13.75-23.8c-1.35.8-2.5 1.9-3.3 3.3l-25.4 44a9.06 9.06 0 0 0 -1.2 4.5h27.5z" fill="#00ac47"/><path d="m73.55 76.8c1.35-.8 2.5-1.9 3.3-3.3l1.6-2.75 7.65-13.25c.8-1.4 1.2-2.95 1.2-4.5h-27.502l5.852 11.5z" fill="#ea4335"/><path d="m43.65 25 13.75-23.8c-1.35-.8-2.9-1.2-4.5-1.2h-18.5c-1.6 0-3.15.45-4.5 1.2z" fill="#00832d"/><path d="m59.8 53h-32.3l-13.75 23.8c1.35.8 2.9 1.2 4.5 1.2h50.8c1.6 0 3.15-.45 4.5-1.2z" fill="#2684fc"/><path d="m73.4 26.5-12.7-22c-.8-1.4-1.95-2.5-3.3-3.3l-13.75 23.8 16.15 28h27.45c0-1.55-.4-3.1-1.2-4.5z" fill="#ffba00"/></svg> Drive
        </button>`:''}
        <button class="btn btn-ghost btn-sm" onclick="deleteHistEntry(${e.id})" style="color:#c0392b;font-size:13px;padding:2px 6px">×</button>
      </td>
    </tr>${detRow}`;
  }).join('');
}

function exportHistEntry(id){
  var e = S.historialReportes.find(function(x){return x.id===id;});
  if(!e||!e.snap||!e.snap.length){ toast('Esta entrada no tiene datos para exportar','error'); return; }
  var wb = XLSX.utils.book_new();
  var ws = XLSX.utils.aoa_to_sheet([
    ['Comprador','N° Venta / Pack ID','SKU','Talle','Cant.'],
    ...e.snap.map(function(o){
      return [o.buyer||'--', o.ref||'--',
        (o.items||[]).map(function(i){return i.sku;}).join(', '),
        (o.items||[]).map(function(i){return i.talle||'';}).join(', '),
        o.qty];
    })
  ]);
  ws['!cols']=[{wch:30},{wch:22},{wch:20},{wch:10},{wch:8}];
  XLSX.utils.book_append_sheet(wb, ws, 'Control');
  var fname = 'PARKA_Control_'+e.fecha.replace(/[\/: ]/g,'_')+'.xlsx';
  XLSX.writeFile(wb, fname);
  toast('✓ Excel exportado','success');
}

async function exportHistEntryDrive(id){
  if(!S.GD.token){ toast('Conectate a Google Drive primero','error'); return; }
  var e = S.historialReportes.find(function(x){return x.id===id;});
  if(!e||!e.snap||!e.snap.length){ toast('Sin datos para subir','error'); return; }
  toast('Subiendo a Drive...','info');
  var wb = XLSX.utils.book_new();
  var ws = XLSX.utils.aoa_to_sheet([
    ['Comprador','N° Venta / Pack ID','SKU','Talle','Cant.'],
    ...e.snap.map(function(o){
      return [o.buyer||'--', o.ref||'--',
        (o.items||[]).map(function(i){return i.sku;}).join(', '),
        (o.items||[]).map(function(i){return i.talle||'';}).join(', '),
        o.qty];
    })
  ]);
  ws['!cols']=[{wch:30},{wch:22},{wch:20},{wch:10},{wch:8}];
  XLSX.utils.book_append_sheet(wb, ws, 'Control');
  var fname = 'PARKA_Control_'+e.fecha.replace(/[\/: ]/g,'_')+'.xlsx';
  var wbout = XLSX.write(wb,{bookType:'xlsx',type:'array'});
  var blob  = new Blob([wbout],{type:'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'});
  await gdUploadFile(blob, fname, 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
}

function deleteHistEntry(id){
  S.historialReportes = S.historialReportes.filter(e=>e.id!==id);
  saveHist();
  renderHistorial();
  nbadge('nb-hist', S.historialReportes.length);
}

function clearHistorial(){
  if(!S.historialReportes.length) return;
  if(!confirm2('clearHist','¿Limpiar todo el historial?')) return;
  S.historialReportes = [];
  saveHist();
  renderHistorial();
  nbadge('nb-hist', 0);
  toast('Historial limpiado','info');
}

function exportHistXL(){
  if(!S.historialReportes.length){ toast('No hay historial para exportar','error'); return; }
  const wb = XLSX.utils.book_new();
  const ws = XLSX.utils.aoa_to_sheet([
    ['Fecha','Archivo','Ordenes','Unidades','Flex','Colecta','Correo','Punto'],
    ...S.historialReportes.map(e=>[e.fecha,e.archivo,e.ordenes,e.unidades,e.flex,e.colecta,e.correo,e.punto])
  ]);
  ws['!cols']=[14,36,10,10,8,10,10,8].map(w=>({wch:w}));
  XLSX.utils.book_append_sheet(wb,ws,'Historial Reportes');
  XLSX.writeFile(wb,'PARKA_Historial_'+new Date().toISOString().slice(0,10)+'.xlsx');
  toast('Excel exportado','success');
}

// stub for nav refresh
function filterHist(){ renderHistorial(); }

/* ═══════════════════════════════════════════════════════
   VENTAS ML — historial de semanas, columnas comparativas
═══════════════════════════════════════════════════════ */

// Historial de semanas: [{label, fname, date, skus:{sku->qty}, total, orders}]
// Orden de cada semana: {idx -> 'desc'|'asc'}

// Exportar el HTML actual con los datos de semanas embebidos
function exportHubWithData(){
  if(!S.VML_WEEKS.length){ toast('No hay semanas cargadas para exportar','error'); return; }
  var el = document.getElementById('vml-embedded-data');
  if(el) el.textContent = JSON.stringify(S.VML_WEEKS);
  var html = document.documentElement.outerHTML;
  var blob = new Blob([html], {type:'text/html'});
  var a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'PARKA-SalesHub-' + new Date().toISOString().slice(0,10) + '.html';
  a.click();
  URL.revokeObjectURL(a.href);
  toast('✓ HTML exportado con '+S.VML_WEEKS.length+' semanas embebidas', 'success');
}

// ── Drop / Load ─────────────────────────────────────────
function vmlDrop2(e){
  e.preventDefault();
  document.getElementById('vml-dz2').classList.remove('drag-over');
  var f = [...e.dataTransfer.files].find(function(f){ return /\.(xlsx|xls|csv)$/i.test(f.name); });
  if(f) vmlLoad2(f); else toast('Solo .xlsx, .xls o .csv','error');
}

function vmlLoad2(file){
  if(!file) return;
  // Ventas ahora se sincronizan SOLAS desde ML (por día, exacto, compartido). La carga de Excel quedó
  // obsoleta y reemplazaría/pisaría la data exacta de D1 → deshabilitada.
  toast('Las ventas ahora se sincronizan solas desde Mercado Libre. La carga de Excel quedó deshabilitada.','info');
  return;
  var ld = document.getElementById('vml-loading2');
  ld.style.display = 'flex';
  document.getElementById('vml-loadtxt2').textContent = 'Procesando ' + file.name + '...';
  var rd = new FileReader();
  rd.onload = function(e){
    try{
      var wb  = XLSX.read(new Uint8Array(e.target.result), {type:'array', cellDates:false});
      var ws  = wb.Sheets[wb.SheetNames[0]];
      var raw = XLSX.utils.sheet_to_json(ws, {header:1, defval:''});
      // Parsear dividiendo automáticamente por semanas según las fechas del archivo
      var newWeeks = vmlParseByWeek(raw, file.name);
      if(!newWeeks.length) throw new Error('No se encontraron ventas con SKU y fecha válidos.');

      var added = 0, replaced = 0;
      newWeeks.forEach(function(nw){
        var existing = S.VML_WEEKS.findIndex(function(w){ return w.label === nw.label; });
        if(existing >= 0){ S.VML_WEEKS[existing] = nw; replaced++; }
        else             { S.VML_WEEKS.push(nw);        added++;    }
      });
      // Ordenar cronológicamente (más antigua primero → más reciente a la derecha)
      S.VML_WEEKS.sort(function(a,b){ return vmlWeekSortKey(a.label) - vmlWeekSortKey(b.label); });
      saveVmlWeeks();
      vmlRender2();
      window.rsmBuild2?.();
      toast('✓ '+newWeeks.length+' semanas cargadas ('+added+' nuevas, '+replaced+' actualizadas)', 'success');
    }catch(err){ toast('Error: '+err.message, 'error'); console.error(err); }
    ld.style.display = 'none';
  };
  rd.readAsArrayBuffer(file);
}

function vmlParseByWeek(raw, fname){
  // ── Encontrar header ──────────────────────────────────────
  var headerRow = -1;
  for(var i=0; i<Math.min(raw.length,20); i++){
    var c0 = String(raw[i][0]||'').trim();
    if(c0 === '# de venta'){ headerRow=i; break; }
    var joined = raw[i].map(function(c){ return String(c||'').toLowerCase(); }).join('|');
    if(['venta','sku','unidades','fecha'].filter(function(w){ return joined.includes(w); }).length >= 3){ headerRow=i; break; }
  }
  if(headerRow < 0) throw new Error('No se encontró la fila de encabezados.');

  var headers = raw[headerRow].map(function(h){ return String(h||'').trim(); });
  function ci(name){
    var nl = name.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g,'').replace(/[^a-z0-9]/g,'');
    return headers.findIndex(function(h){
      var hl = h.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g,'').replace(/[^a-z0-9]/g,'');
      return hl===nl || hl.includes(nl);
    });
  }
  var cSKU  = ci('SKU');
  var cQty  = headers.indexOf('Unidades');  // columna exacta
  var cDate = ci('Fecha de venta');
  if(cSKU < 0) throw new Error('No se encontró columna SKU. Columnas: '+headers.filter(Boolean).slice(0,8).join(', '));

  var MONTHS = {enero:1,febrero:2,marzo:3,abril:4,mayo:5,junio:6,
                julio:7,agosto:8,septiembre:9,octubre:10,noviembre:11,diciembre:12};

  // ── Agrupar por semana lunes→domingo ─────────────────────
  var weekMap = {};  // label → week object

  for(var r=headerRow+1; r<raw.length; r++){
    var row = raw[r];
    if(!row || !row.some(function(c){ return String(c||'').trim(); })) continue;
    var sku = String(row[cSKU]||'').trim();
    if(!sku || sku==='-' || sku==='--') continue;
    var qty = parseInt(row[cQty]) || 1;

    // Parsear fecha "12 de junio de 2026 12:43 hs."
    var dateStr = String(cDate>=0 ? row[cDate]||'' : '');
    var dm = dateStr.match(/(\d+)\s+de\s+(\w+)\s+de\s+(\d{4})/i);
    if(!dm || !MONTHS[dm[2].toLowerCase()]) continue;

    var d   = new Date(parseInt(dm[3]), MONTHS[dm[2].toLowerCase()]-1, parseInt(dm[1]));
    var dow = d.getDay();                                   // 0=dom
    var monday = new Date(d); monday.setDate(d.getDate() + (dow===0 ? -6 : 1-dow));
    var sunday  = new Date(monday); sunday.setDate(monday.getDate()+6);

    // Label "01/06 – 07/06/26"
    var p = function(n){ return String(n).padStart(2,'0'); };
    var label = p(monday.getDate())+'/'+p(monday.getMonth()+1)
              + ' – '
              + p(sunday.getDate())+'/'+p(sunday.getMonth()+1)
              + '/'+String(sunday.getFullYear()).slice(2);

    if(!weekMap[label]) weekMap[label] = {
      label:  label,
      fname:  fname,
      date:   monday.getDate()+'/'+(monday.getMonth()+1)+'/'+monday.getFullYear(),
      skus:   {},
      total:  0,
      orders: 0,
      _ts:    monday.getTime()   // para ordenar
    };
    weekMap[label].skus[sku] = (weekMap[label].skus[sku]||0) + qty;
    weekMap[label].total  += qty;
    weekMap[label].orders += 1;
  }

  return Object.values(weekMap);
}

function saveVmlWeeks(){
  try{ localStorage.setItem('parka_vml_weeks', JSON.stringify(S.VML_WEEKS)); }catch(e){}
  // Backend D1 — fuente principal
  apiPut('/api/state/vml_weeks',{data:S.VML_WEEKS});
}

// ── Sync desde ML (API) — reemplaza la carga manual del Excel ──────────────
// El Worker (/api/ml/sync) trae las órdenes, agrega por semana (mismo shape) y guarda en D1.
// Acá solo disparamos, tomamos el resultado, re-renderizamos y mostramos la VALIDACIÓN.
async function vmlSyncML(fromOverride){
  var btn = document.getElementById('vml-sync-btn');
  var txt = document.getElementById('vml-sync-txt');
  var rep = document.getElementById('vml-sync-report');
  var ld  = document.getElementById('vml-loading2');
  var lt  = document.getElementById('vml-loadtxt2');
  if(btn) btn.disabled = true;
  if(ld) ld.style.display='flex';
  try{
    // Sync RESUMIBLE: el Worker procesa hasta agotar su presupuesto de subrequests y devuelve
    // un cursor (nextFrom). Volvemos a llamar hasta done=true. Acumulamos para la validación.
    var from = fromOverride || null;
    var done = false, guard = 0;
    var totalOrders = 0, allDiff = [], lastWeeks = null, statusHist = {}, integrityOk = true, win = null;
    while(!done && guard < 60){
      guard++;
      var path = '/api/ml/sync' + (from ? '?from='+encodeURIComponent(from) : '');
      var res = await apiPost(path, {});
      if(!res || !res.ok) throw new Error(res && res.error ? res.error : 'Sin respuesta del servidor (¿token de ML vencido? Reconectá en /oauth/login)');
      var rp = res.report || {};
      totalOrders += (rp.ordersFetched||0);
      allDiff = allDiff.concat(rp.diff||[]);
      Object.keys(rp.statusHistogram||{}).forEach(function(k){ statusHist[k]=(statusHist[k]||0)+rp.statusHistogram[k]; });
      if(!rp.integrityOk) integrityOk = false;
      if(!win) win = rp.window;
      lastWeeks = res.weeks;
      done = !!rp.done;
      from = rp.nextFrom;
      if(txt) txt.textContent = 'Sincronizando... '+totalOrders+' órdenes';
      if(lt) lt.textContent = 'Trayendo ventas de Mercado Libre... ('+totalOrders+' órdenes'+(done?'':', sigue')+')';
      if(!done && !from) break; // safety: sin cursor y sin done -> cortar
    }
    S.VML_WEEKS = Array.isArray(lastWeeks) ? lastWeeks : S.VML_WEEKS;
    try{ localStorage.setItem('parka_vml_weeks', JSON.stringify(S.VML_WEEKS)); }catch(e){}
    vmlRender2();
    window.rsmBuild2?.();
    var agg = { ordersFetched: totalOrders, weeksComputed: allDiff.length, statusHistogram: statusHist, integrityOk: integrityOk, diff: allDiff, window: win, done: done };
    var diffs = allDiff.filter(function(d){ return d.storedTotal!=null && d.delta!==0; });
    toast('✓ Sincronizado: '+totalOrders+' órdenes' + (diffs.length ? ' · ⚠️ '+diffs.length+' semana(s) difieren del Excel (ver validación)' : '') + (done?'':' · ⚠️ incompleto, volvé a sincronizar'), diffs.length||!done ? 'info' : 'success');
    if(rep){ rep.style.display='block'; rep.innerHTML = _vmlSyncReportHtml(agg); }
    console.table(allDiff);
    console.log('[Sync ML] estados:', statusHist, '| integridad:', integrityOk, '| done:', done, '| ventana:', win);
  }catch(err){
    toast('Error al sincronizar: '+err.message, 'error');
    console.error('[Sync ML]', err);
  }finally{
    if(btn) btn.disabled = false;
    if(txt) txt.textContent = 'Sincronizar desde Mercado Libre';
    if(ld) ld.style.display='none';
  }
}

function _vmlSyncReportHtml(rp){
  var st = rp.statusHistogram || {};
  var stStr = Object.keys(st).map(function(k){ return k+': '+st[k]; }).join(' · ') || '—';
  var rows = (rp.diff||[]).filter(function(d){ return d.storedTotal != null; });
  var html = '<div style="font-weight:600;margin-bottom:6px">Validación de la sincronización</div>';
  html += '<div style="color:var(--text-soft);margin-bottom:8px">Integridad (total = suma de SKUs): <strong style="color:'+(rp.integrityOk?'#16a34a':'#dc2626')+'">'+(rp.integrityOk?'OK':'FALLA')+'</strong> &nbsp;·&nbsp; Estados ML: '+stStr+'</div>';
  if(rows.length){
    html += '<div style="color:var(--text-soft);margin-bottom:4px">Comparación con el dato previo (Excel) en semanas solapadas:</div>';
    html += '<table style="width:100%;border-collapse:collapse;font-size:11px"><thead><tr style="text-align:left;color:var(--text-muted)"><th style="padding:3px 6px">Semana</th><th style="padding:3px 6px;text-align:right">Excel</th><th style="padding:3px 6px;text-align:right">API</th><th style="padding:3px 6px;text-align:right">Δ</th><th style="padding:3px 6px;text-align:right">Cancel.</th></tr></thead><tbody>';
    rows.forEach(function(d){
      var bad = d.delta !== 0;
      html += '<tr style="border-top:1px solid var(--border)"><td style="padding:3px 6px;font-family:monospace">'+d.label+'</td>'
        + '<td style="padding:3px 6px;text-align:right">'+d.storedTotal+'</td>'
        + '<td style="padding:3px 6px;text-align:right">'+d.apiTotal+'</td>'
        + '<td style="padding:3px 6px;text-align:right;font-weight:700;color:'+(bad?'#dc2626':'#16a34a')+'">'+(d.delta>0?'+':'')+d.delta+'</td>'
        + '<td style="padding:3px 6px;text-align:right;color:var(--text-muted)">'+d.apiCancelled+'</td></tr>';
    });
    html += '</tbody></table>';
    var bads = rows.filter(function(d){ return d.delta !== 0; }).length;
    html += '<div style="margin-top:6px;color:var(--text-soft)">'+(bads ? bads+' semana(s) con diferencia. Si la Δ ≈ las unidades canceladas, es esperable (el Excel y la API pueden contar distinto las canceladas).' : 'Todas las semanas coinciden exactamente con el Excel. ✓')+'</div>';
  } else {
    html += '<div style="color:var(--text-soft)">No había datos previos para comparar (primer sync).</div>';
  }
  return html;
}
function vmlSearch2(){ S._vmlSearch2 = document.getElementById('vml-search2').value.toLowerCase(); vmlRender2(); }
// alias para el oninput
function vmlRender2(){ _vmlRenderTable2(); }

// Extrae el código base sin el talle final: "M-114-BLACK-L" → "M-114-BLACK"

// Para el render: más reciente primero (izq→der: reciente→antigua)
function _vmlRenderTable2(){
  var weeks = S.VML_WEEKS.slice().reverse();
  var empty = document.getElementById('vml-empty2');
  var card  = document.getElementById('vml-table-card');
  if(!weeks.length){ empty.style.display=''; card.style.display='none'; return; }
  empty.style.display='none'; card.style.display='';
  document.getElementById('vml-weeks-count').textContent = weeks.length + ' semana' + (weeks.length!==1?'s':'');

  // ── Agrupar SKUs por código base ─────────────────────────
  // groups: { base -> { total_por_semana:[qty,...], talles:{ talle -> [qty,...] } } }
  var groups = {};
  var allTalles = {}; // base -> Set de talles

  weeks.forEach(function(w, wi){
    Object.keys(w.skus).forEach(function(sku){
      var base  = vmlBaseCode(sku);
      var talle = sku.slice(base.length + 1) || sku; // lo que queda después del base
      if(!groups[base]){ groups[base] = { totals: weeks.map(function(){return 0;}), talles: {} }; allTalles[base] = {}; }
      groups[base].totals[wi] += w.skus[sku];
      if(!groups[base].talles[talle]) groups[base].talles[talle] = weeks.map(function(){return 0;});
      groups[base].talles[talle][wi] += w.skus[sku];
      allTalles[base][talle] = true;
    });
  });

  // ── Filtro búsqueda ──────────────────────────────────────
  var q = S._vmlSearch2;
  var baseList = Object.keys(groups);
  if(q) baseList = baseList.filter(function(b){ return b.toLowerCase().includes(q); });

  // ── Ordenar por semana primaria o por total ──────────────
  var pi = typeof S.VML_SORT._primary !== 'undefined' ? S.VML_SORT._primary : 0;
  if(pi >= weeks.length) pi = 0;
  var ps = S.VML_SORT[pi] || 'desc';
  var byTotal = S.VML_SORT._byTotal;
  baseList.sort(function(a,b){
    if(byTotal){
      var at = groups[a].totals.reduce(function(s,v){return s+v;},0);
      var bt = groups[b].totals.reduce(function(s,v){return s+v;},0);
      return byTotal==='desc' ? bt-at : at-bt;
    }
    var av = groups[a].totals[pi]||0, bv = groups[b].totals[pi]||0;
    return ps==='desc' ? bv-av : av-bv;
  });

  // ── Máximos por semana (para barras) ─────────────────────
  var maxPerWeek = weeks.map(function(w,wi){
    return Math.max.apply(null, baseList.map(function(b){ return groups[b].totals[wi]||0; }).concat([1]));
  });

  // ── Header ───────────────────────────────────────────────
  var thW = Math.max(90, Math.min(140, Math.floor(800/(weeks.length+1))));
  var sortTotalArrow = S.VML_SORT._byTotal === 'asc' ? ' ↑' : S.VML_SORT._byTotal === 'desc' ? ' ↓' : '';
  var thead = '<tr>'
    + '<th style="position:sticky;left:0;background:#6366F1;color:#FFFFFF;z-index:2;min-width:190px;padding-left:14px;border-right:1px solid rgba(255,255,255,0.25)">CÓDIGO</th>'
    + '<th onclick="vmlSortByTotal()" style="text-align:center;min-width:90px;cursor:pointer;background:#6366F1;color:#FFFFFF;border-right:1px solid rgba(255,255,255,0.25)">'
    + '<div style="font-size:10px;font-weight:800;color:#FFFFFF;letter-spacing:.06em">TOTAL'+sortTotalArrow+'</div>'
    + '</th>';
  weeks.forEach(function(w, wi){
    var sort  = S.VML_SORT[wi] || 'desc';
    var arrow = (S.VML_SORT._primary===wi) ? (sort==='desc'?' ↓':' ↑') : '';
    var isActive = S.VML_SORT._primary===wi;
    var colBg = isActive ? '#4F46E5' : '#6366F1';
    thead += '<th onclick="vmlToggleSort('+wi+')" style="text-align:center;min-width:'+thW+'px;cursor:pointer;background:'+colBg+';color:#FFFFFF;border-left:1px solid rgba(255,255,255,0.2)">'
      + '<div style="font-size:11px;font-weight:700;color:#FFFFFF">'+w.label+arrow+'</div>'
      + '<div style="font-size:10px;color:rgba(255,255,255,0.75);font-weight:500;margin-top:1px">'+w.total+' uds</div>'
      + '<button onclick="event.stopPropagation();vmlRemoveWeek('+wi+')" title="Eliminar" style="font-size:9px;color:rgba(255,255,255,0.6);background:none;border:none;cursor:pointer;padding:0;margin-top:1px">✕</button>'
      + '</th>';
  });
  thead += '</tr>';
  document.getElementById('vml-thead2').innerHTML = thead;

  // ── Filas ────────────────────────────────────────────────
  var html = '';
  var grandTotal = 0;

  baseList.forEach(function(base, bi){
    var g = groups[base];
    var talleKeys = Object.keys(g.talles).sort(talleSort);
    var hasTalles = talleKeys.length > 1 || (talleKeys.length===1 && talleKeys[0]!==base);
    var rowId = 'vml-row-'+bi;
    var totalBase = g.totals.reduce(function(s,v){return s+v;}, 0);
    grandTotal += totalBase;
    var isOpen = false; // estado por defecto cerrado

    // ── Fila base ──
    html += '<tr style="border-bottom:1px solid var(--border2);'+(hasTalles?'cursor:pointer':'')+'background:var(--surface)" '
          + (hasTalles ? 'onclick="vmlToggleRow(\''+rowId+'\')"' : '')+'>';

    html += '<td style="position:sticky;left:0;background:var(--surface);z-index:1;padding:9px 8px 9px 14px;border-right:2px solid var(--border)">'
      + (hasTalles
          ? '<span id="arr-'+rowId+'" style="display:inline-block;width:16px;font-size:9px;color:var(--accent);transition:transform .15s;margin-right:2px">▶</span>'
          : '<span style="display:inline-block;width:18px"></span>')
      + '<span style="font-family:monospace;font-size:12px;font-weight:800;color:#0A0A0A">'+base+'</span>'
      + '</td>';

    // Total
    html += '<td style="text-align:center;padding:9px 8px;font-size:15px;font-weight:800;color:#2e7d4f;font-family:\'Space Grotesk\',sans-serif;background:#f7fcf9;border-right:1px solid var(--border)">'+totalBase+'</td>';

    // Por semana
    weeks.forEach(function(w, wi){
      var v = g.totals[wi] || 0;
      var isActive = S.VML_SORT._primary===wi;
      html += '<td style="text-align:center;padding:9px 8px;'
        + (v>0 ? 'font-weight:700;font-size:13px;color:var(--text)' : 'color:var(--text-muted);font-size:12px')
        + (isActive && v>0 ? ';background:#f7fcf9' : '')
        + '">'+( v>0 ? v : '—' )+'</td>';
    });
    html += '</tr>';

    // ── Filas de talles — misma estructura que la fila padre ──
    if(hasTalles){
      talleKeys.forEach(function(talle, ti){
        var talleVals = g.talles[talle];
        var talleTotal = talleVals.reduce(function(s,v){return s+v;},0);
        var isLast = ti===talleKeys.length-1;
        html += '<tr id="'+(ti===0?rowId+'-t':'')+'vml-talle-'+rowId+'-'+ti+'" class="talle-row-'+rowId+'" style="display:none;background:#E0E7FF;border-bottom:'+(isLast?'2px solid #6366F1':'1px solid #A5B4FC')+'">';
        html += '<td style="padding:6px 8px 6px 38px;position:sticky;left:0;background:#C7D2FE;z-index:1;border-right:1px solid #6366F1">'
              + '<span style="font-size:10px;color:#1A5C42;margin-right:4px">└</span>'
              + '<span style="font-family:monospace;font-size:11px;font-weight:700;color:#0A0A0A">'+talle+'</span>'
              + '</td>';
        html += '<td style="text-align:center;padding:6px 8px;font-size:12px;font-weight:700;color:#0A0A0A;background:#C7D2FE;border-right:1px solid #6366F1">'+talleTotal+'</td>';
        weeks.forEach(function(w, wi){
          var v = talleVals[wi] || 0;
          html += '<td style="text-align:center;padding:6px 8px;font-size:12px;border-left:1px solid rgba(0,0,0,0.12);'
            + (v>0 ? 'color:#0A0A0A;font-weight:700' : 'color:rgba(0,0,0,0.25)')
            + '">'+( v>0 ? v : '·' )+'</td>';
        });
        html += '</tr>';
      });
    }
  });

  // ── Fila TOTAL ──
  html += '<tr style="background:var(--surface2);border-top:2px solid var(--border)">';
  html += '<td style="position:sticky;left:0;background:var(--surface2);font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.08em;color:var(--text-muted);padding:10px 8px 10px 14px;border-right:2px solid var(--border)">TOTAL</td>';
  html += '<td style="text-align:center;padding:10px 8px;font-size:16px;font-weight:800;color:#1E1B4B;font-family:\'Space Grotesk\',sans-serif;background:#E0E7FF;border-right:1px solid #6366F1">'+grandTotal+'</td>';
  weeks.forEach(function(w){ html += '<td style="text-align:center;padding:10px 8px;font-size:14px;font-weight:700;color:#1E1B4B;background:#A8D5C8;font-family:\'Space Grotesk\',sans-serif">'+w.total+'</td>'; });
  html += '</tr>';

  document.getElementById('vml-tbody2').innerHTML = html;
  vmlUpdateDelSelector();
}

function vmlToggleRow(rowId){
  var arr  = document.getElementById('arr-'+rowId);
  var rows = document.querySelectorAll('.talle-row-'+rowId);
  if(!rows.length) return;
  // Verificar estado actual — si alguna está visible, contraer
  var anyVisible = Array.from(rows).some(function(r){ return r.style.display !== 'none'; });
  rows.forEach(function(r){ r.style.display = anyVisible ? 'none' : ''; });
  if(arr) arr.style.transform = anyVisible ? 'rotate(0deg)' : 'rotate(90deg)';
}

function vmlToggleSort(wi){
  S.VML_SORT._primary = wi;
  S.VML_SORT._byTotal = false;
  S.VML_SORT[wi] = (S.VML_SORT[wi]==='asc') ? 'desc' : 'asc';
  _vmlRenderTable2();
}

function vmlSortByTotal(){
  S.VML_SORT._byTotal = !S.VML_SORT._byTotal ? 'desc' : (S.VML_SORT._byTotal==='desc' ? 'asc' : 'desc');
  S.VML_SORT._primary = undefined;
  _vmlRenderTable2();
}

function vmlDeleteSelected(){
  var sel = document.getElementById('vml-del-sel');
  var wi  = parseInt(sel.value);
  if(isNaN(wi) || wi < 0 || wi >= S.VML_WEEKS.length){ toast('Seleccioná una semana para eliminar','error'); return; }
  var label = S.VML_WEEKS[wi].label;
  if(!confirm2('vmlDelSel:'+wi,'¿Eliminar la semana "'+label+'"?')) return;
  S.VML_WEEKS.splice(wi, 1);
  saveVmlWeeks();
  sel.value = '';
  vmlRender2();
  window.rsmBuild2?.();
  toast('Semana "'+label+'" eliminada','success');
}

function vmlUpdateDelSelector(){
  var sel = document.getElementById('vml-del-sel');
  if(!sel) return;
  var prev = sel.value;
  sel.innerHTML = '<option value="">Eliminar semana...</option>';
  S.VML_WEEKS.forEach(function(w, wi){
    var opt = document.createElement('option');
    opt.value = wi;
    opt.textContent = w.label + ' — ' + w.total + ' uds';
    sel.appendChild(opt);
  });
  if(prev !== '') sel.value = prev;
}

function vmlRemoveWeek(wi){
  if(!confirm2('vmlRmWeek:'+wi,'¿Eliminar la semana "'+S.VML_WEEKS[wi].label+'"?')) return;
  S.VML_WEEKS.splice(wi,1);
  saveVmlWeeks();
  vmlRender2();
  window.rsmBuild2?.();
}

function vmlClearAll2(){
  if(!S.VML_WEEKS.length) return;
  if(!confirm2('vmlClearAll','¿Borrar todo el historial de semanas?')) return;
  S.VML_WEEKS = [];
  S.VML_SORT  = {};
  saveVmlWeeks();
  vmlRender2();
  document.getElementById('rsmn-empty').style.display='';
  document.getElementById('rsmn-content').style.display='none';
}

// Retrocompatibilidad con vmlnewLoad / vmlnewBuildTable
function vmlnewBuildTable(){ vmlRender2(); }

function toggleHistDet(id){
  var r=document.getElementById('hdet-'+id);if(!r)return;
  var open=r.style.display==='none'||r.style.display==='';
  r.style.display=open?'':'none';
  var prev=r.previousElementSibling;
  if(prev){var b=prev.querySelector('button:last-child');if(b&&b.textContent.includes('▼'))b.textContent=(open?'▲':'▼')+' Ver';}
}

export { vmlRender2, filterHist, renderHCargas, renderHistorial, confirmToHistorial }

// --- window-expose: handlers cableados desde el HTML ---
try{window.confirmControlToHistorial=confirmControlToHistorial;}catch(e){}
try{window.renderHCargas=renderHCargas;}catch(e){}
try{window.clearHCargas=clearHCargas;}catch(e){}
try{window.renderHistorial=renderHistorial;}catch(e){}
try{window.filterHist=filterHist;}catch(e){}
try{window.clearHistorial=clearHistorial;}catch(e){}
try{window.exportHistXL=exportHistXL;}catch(e){}
try{window.vmlDrop2=vmlDrop2;}catch(e){}
try{window.vmlLoad2=vmlLoad2;}catch(e){}
try{window.vmlDeleteSelected=vmlDeleteSelected;}catch(e){}
try{window.vmlClearAll2=vmlClearAll2;}catch(e){}
try{window.exportHubWithData=exportHubWithData;}catch(e){}
try{window.vmlRender2=vmlRender2;}catch(e){}
try{window.vmlSyncML=vmlSyncML;}catch(e){}
try{window.exportHCargaEntry=exportHCargaEntry;}catch(e){}
try{window.exportHCargaDrive=exportHCargaDrive;}catch(e){}
try{window.deleteHCarga=deleteHCarga;}catch(e){}
try{window.toggleHistDet=toggleHistDet;}catch(e){}
try{window.exportHistEntry=exportHistEntry;}catch(e){}
try{window.exportHistEntryDrive=exportHistEntryDrive;}catch(e){}
try{window.deleteHistEntry=deleteHistEntry;}catch(e){}
try{window.vmlSortByTotal=vmlSortByTotal;}catch(e){}
try{window.vmlToggleSort=vmlToggleSort;}catch(e){}
try{window.vmlRemoveWeek=vmlRemoveWeek;}catch(e){}
try{window.vmlToggleRow=vmlToggleRow;}catch(e){}
