// @ts-nocheck
// ParkaHub — modulo PLATAFORMAS (ML / TN) + IMPORT EXCEL (reporte ventas ML).
// Funciones movidas TAL CUAL desde app.ts. Cero cambio de logica.
import { S } from './state'
import { getRange, normSt, stLabel, parseVariant, skuSortKey } from './util'
import { refreshHeaders, toast } from './core-ui'
import { classifyCarrier } from './dispatch-pdf'
import { filterHist } from './history'
import { API_BASE } from './api'

// --- PERIOD ------------------------------------------------------------
function periodToggle(p){
  const v=document.getElementById(p+'-period').value,c=v==='custom';
  document.getElementById(p+'-dfw').style.display=c?'':'none';
  document.getElementById(p+'-dtw').style.display=c?'':'none';
}
// --- STATUS ------------------------------------------------------------

// --- FETCH ML ----------------------------------------------------------
async function fetchML(){
  const{from,to}=getRange('ml');
  const f=from.toISOString().split('T')[0]+'T00:00:00.000-03:00';
  const t2=to.toISOString().split('T')[0]+'T23:59:59.999-03:00';
  const ld=document.getElementById('ml-load');ld.style.display='flex';
  document.getElementById('ml-loadtxt').textContent='Conectando con ML...';
  let offset=0,limit=50,total=Infinity,newO=[];
  try{
    while(offset<total){
      const url=`${API_BASE}/api/ml/orders?from=${encodeURIComponent(f)}&to=${encodeURIComponent(t2)}&offset=${offset}&limit=${limit}`;
      const res=await fetch(url);
      if(!res.ok){const e=await res.json().catch(()=>({}));throw new Error(`ML ${res.status}: ${e.message||res.statusText}`);}
      const data=await res.json();total=data.paging?.total||0;
      const results=data.results||[];if(!results.length)break;
      for(const o of results)for(const it of(o.order_items||[]))newO.push({platform:'ml',orderId:String(o.id),date:o.date_created,sku:it.item?.seller_sku||it.item?.id||'--',product:it.item?.title||'--',qty:it.quantity||1,status:normSt(o.status)});
      offset+=results.length;document.getElementById('ml-loadtxt').textContent=`${newO.length} de ${total}...`;
      if(results.length<limit)break;
    }
    S.platOrders=S.platOrders.filter(o=>o.platform!=='ml').concat(newO);
    // filterPlat('') en vez de renderPlatTable(): renderPlatTable usa filteredPlat||platOrders y filteredPlat
    // arranca [] (truthy) -> nunca mostraba lo recien traido (bug preexistente, antes oculto por el CORS).
    // refreshDB() removido: era una referencia colgante del baseline (nunca definida) que tiraba ReferenceError.
    filterPlat('');refreshHeaders();filterHist();window.renderDespachos?.();
    toast(`ML: ${newO.length} líneas cargadas`,'success');
  }catch(e){toast(e.message,'error');}
  ld.style.display='none';
}

// --- FETCH TN ----------------------------------------------------------
async function fetchTN(){
  const{from,to}=getRange('tn');
  const ld=document.getElementById('tn-load');ld.style.display='flex';
  document.getElementById('tn-loadtxt').textContent='Conectando con TN...';
  let page=1,newO=[],more=true;
  try{
    while(more){
      const url=`${API_BASE}/api/tn/orders?from=${Math.floor(from/1000)}&to=${Math.floor(to/1000)}&page=${page}`;
      const res=await fetch(url);
      if(!res.ok){const e=await res.json().catch(()=>({}));throw new Error(`TN ${res.status}: ${e.description||res.statusText}`);}
      const data=await res.json();
      if(!Array.isArray(data)||!data.length){more=false;break;}
      for(const o of data)for(const pr of(o.products||[]))newO.push({platform:'tn',orderId:String(o.number||o.id),date:o.created_at,sku:pr.sku||pr.product_id||'--',product:pr.name||'--',qty:pr.quantity||1,status:normSt(o.payment_status)});
      if(data.length<200)more=false;page++;
      document.getElementById('tn-loadtxt').textContent=`${newO.length} órdenes...`;
    }
    S.platOrders=S.platOrders.filter(o=>o.platform!=='tn').concat(newO);
    // filterPlat('') en vez de renderPlatTable(): renderPlatTable usa filteredPlat||platOrders y filteredPlat
    // arranca [] (truthy) -> nunca mostraba lo recien traido (bug preexistente, antes oculto por el CORS).
    // refreshDB() removido: era una referencia colgante del baseline (nunca definida) que tiraba ReferenceError.
    filterPlat('');refreshHeaders();filterHist();window.renderDespachos?.();
    toast(`TN: ${newO.length} líneas cargadas`,'success');
  }catch(e){toast(e.message,'error');}
  ld.style.display='none';
}

// --- PLAT TABLE --------------------------------------------------------
function filterPlat(q){S.filteredPlat=q?S.platOrders.filter(o=>[o.orderId,o.sku,o.product].some(f=>f.toLowerCase().includes(q.toLowerCase()))):S.platOrders;renderPlatTable();}
function renderPlatTable(){S.filteredPlat=S.filteredPlat||S.platOrders;const w=document.getElementById('plat-wrap'),e=document.getElementById('plat-empty');if(!S.filteredPlat.length){w.style.display='none';e.style.display='';return;}e.style.display='none';w.style.display='block';document.getElementById('plat-tbody').innerHTML=S.filteredPlat.map(o=>{const d=new Date(o.date);return`<tr><td><span class="badge ${o.platform}">${o.platform==='ml'?'ML':'TN'}</span></td><td><span class="oid-cell">#${o.orderId}</span></td><td><span class="date-cell">${d.toLocaleDateString('es-AR')} ${d.toLocaleTimeString('es-AR',{hour:'2-digit',minute:'2-digit'})}</span></td><td><span class="sku-cell">${o.sku}</span></td><td><span class="product-cell" title="${o.product}">${o.product}</span></td><td><span class="qty-cell">${o.qty}</span></td><td><span class="badge ${o.status}">${stLabel(o.status)}</span></td></tr>`;}).join('');}
function exportPlatXL(){if(!S.platOrders.length){toast('No hay órdenes de plataformas','error');return;}const wb=XLSX.utils.book_new();const ws=XLSX.utils.aoa_to_sheet([['Plataforma','N. Orden','Fecha','SKU','Producto','Cant.','Estado'],...S.platOrders.map(o=>[o.platform==='ml'?'Mercado Libre':'Tienda Nube',o.orderId,new Date(o.date).toLocaleDateString('es-AR'),o.sku,o.product,o.qty,stLabel(o.status)])]);ws['!cols']=[16,16,12,18,36,8,12].map(w=>({wch:w}));XLSX.utils.book_append_sheet(wb,ws,'Plataformas');XLSX.writeFile(wb,`PARKA_Plataformas_${new Date().toISOString().slice(0,10)}.xlsx`);toast('Excel exportado','success');}

// --- ORDER TABS --------------------------------------------------------
function switchOTab(tab){
  // Ya no hay tabs — función vacía para compatibilidad
}

// --- EXCEL IMPORT (ML REPORTE VENTAS) ----------------------------------

function onXLDrop(e){
  e.preventDefault();
  document.getElementById('xl-dz').classList.remove('drag-over');
  const files = [...e.dataTransfer.files].filter(f=>f.name.match(/\.xlsx?$/i));
  if(files.length) processXLFiles(files);
}
function onXLInput(e){
  const files = [...e.target.files].filter(f=>f.name.match(/\.xlsx?$/i));
  if(files.length) processXLFiles(files);
  e.target.value='';
}

async function processXLFiles(files){
  const ld = document.getElementById('xl-load');
  ld.style.display='flex';

  // Clear previous excel imports
  S.platOrders = S.platOrders.filter(o => !(o.platform==='ml' && o.source==='excel'));
  S.xlImported = [];

  // Show file list
  const listEl = document.getElementById('xl-files-list');
  listEl.style.display='flex';
  listEl.innerHTML = files.map(f=>`
    <div style="display:flex;align-items:center;gap:8px;padding:8px 12px;background:var(--surface2);border:1px solid var(--border);border-radius:6px;font-size:12px">
      <span style="font-size:16px">📊</span>
      <span style="flex:1;font-weight:500;color:var(--text)">${f.name}</span>
      <span id="file-status-${f.name.replace(/[^a-z0-9]/gi,'_')}" style="color:var(--text-muted)">Pendiente...</span>
    </div>`).join('');

  let allOrders = [];
  let totalDups = 0;

  for(const file of files){
    const statusId = 'file-status-'+file.name.replace(/[^a-z0-9]/gi,'_');
    const statusEl = document.getElementById(statusId);
    if(statusEl) statusEl.textContent = 'Leyendo...';
    document.getElementById('xl-loadtxt').textContent = `Procesando ${file.name}...`;

    try{
      const orders = await parseXLFile(file);
      // Dedup by orderId -- skip if already loaded from another file
      const existingIds = new Set(allOrders.map(o=>o.orderId));
      const newOrders = orders.filter(o=>!existingIds.has(o.orderId));
      const dups = orders.length - newOrders.length;
      totalDups += dups;
      allOrders.push(...newOrders);
      if(statusEl) statusEl.textContent = `OK ${newOrders.length} órdenes${dups?` (+${dups} dup.)`:''}`;
      if(statusEl) statusEl.style.color = 'var(--green)';
    }catch(e){
      if(statusEl){ statusEl.textContent = 'Error: '+e.message; statusEl.style.color='var(--red)'; }
      toast(`Error en ${file.name}: ${e.message}`, 'error');
    }
  }

  if(!allOrders.length){ ld.style.display='none'; return; }

  S.platOrders.push(...allOrders);
  S.xlImported = allOrders;
  S.xlFiltered = [...allOrders];
  renderXLTable();

  // Switch to result state
  document.getElementById('xl-upload-state') && (document.getElementById('xl-upload-state').style.display='none');
  document.getElementById('xl-result-state').style.display  = 'flex';
  document.getElementById('xl-result-title').textContent = `${allOrders.length} órdenes importadas`;
  document.getElementById('xl-result-sub').textContent   = files.length===1 ? files[0].name : `${files.length} archivos combinados`;
  // Badge en card ML
  var mlBadge = document.getElementById('ml-badge');
  var mlInfo  = document.getElementById('ml-loaded-info');
  if(mlBadge){ mlBadge.style.display=''; mlBadge.textContent=allOrders.length+' órdenes'; }
  if(mlInfo) { mlInfo.style.display=''; mlInfo.textContent='✓ '+allOrders.length+' órdenes de ML cargadas'; }

  refreshHeaders(); filterHist(); window.renderDespachos?.();
  const msg = totalDups ? `${allOrders.length} órdenes únicas (${totalDups} duplicados omitidos)` : `${allOrders.length} órdenes importadas correctamente`;
  toast(msg, 'success');
  ld.style.display='none';
}

async function parseXLFile(file){
  const buf = await file.arrayBuffer();
  const wb = XLSX.read(buf, {type:'array', cellDates:false});
  const ws = wb.Sheets[wb.SheetNames[0]];
  const raw = XLSX.utils.sheet_to_json(ws, {header:1, defval:''});

  // -- Encontrar fila de header ------------------------------------
  // El reporte ML AR tiene ~5 filas de metadata antes del header real.
  // Buscamos la fila donde col0 sea exactamente "# de venta" O donde
  // haya al menos 4 palabras clave de encabezado en la misma fila.
  let headerRow = -1;
  const KEY_WORDS = ['venta','sku','unidades','estado','fecha','transportista','entrega','comprador'];
  for(let i=0; i<Math.min(raw.length,20); i++){
    const row = raw[i];
    const col0 = String(row[0]||'').trim();
    // match exacto del reporte ML AR
    if(col0 === '# de venta'){ headerRow=i; break; }
    // fallback: fila con muchas palabras clave
    const joined = row.map(c=>String(c||'').toLowerCase()).join('|');
    const hits = KEY_WORDS.filter(w=>joined.includes(w)).length;
    if(hits >= 4){ headerRow=i; break; }
  }
  if(headerRow<0) throw new Error('No se encontró la fila de encabezados. ¿Es el reporte de ventas de ML?');

  const headers = raw[headerRow].map(h=>String(h||'').trim());
  console.log('[ML] Header en fila '+(headerRow+1)+'. Cols: '+headers.filter(Boolean).slice(0,12).join(' | '));

  // -- Mapear columnas (búsqueda flexible) -------------------------
  function ci(exactName){
    // 1. coincidencia exacta
    let idx = headers.indexOf(exactName);
    if(idx>=0) return idx;
    // 2. coincidencia parcial sin tildes ni especiales
    const nl = exactName.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g,'').replace(/[^a-z0-9]/g,'');
    idx = headers.findIndex(h=>{
      const hl = h.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g,'').replace(/[^a-z0-9]/g,'');
      return hl.includes(nl) || nl.includes(hl);
    });
    return idx;
  }
  function ciFirst(names){ for(const n of names){ const i=ci(n); if(i>=0) return i; } return -1; }

  // Columnas del reporte ML AR real (verificadas contra el archivo)
  const colId     = ciFirst(['# de venta','numero de venta']);
  const colDate   = ciFirst(['Fecha de venta','fecha de pago']);
  const colState  = ciFirst(['Estado','estado de la venta']);
  const colDesc   = ciFirst(['Descripción del estado','Descripcion del estado']);
  const colPaq    = ciFirst(['Paquete de varios productos']);
  // "Unidades" aparece en col6 (ventas) y col50 (devoluciones) — tomar la primera
  const colUnits  = headers.indexOf('Unidades');
  const colIngreso= ciFirst(['Ingresos por productos']);
  const colCostoEnvio = ciFirst(['Costos de envío','Costo de envío']);
  const colDescuento  = ciFirst(['Descuentos y bonificaciones','Descuentos']);
  const colTotal  = ciFirst(['Total (ARS)','Total ARS']);
  const colSKU    = ciFirst(['SKU']);
  const colTitle  = ciFirst(['Título de la publicación','Titulo de la publicacion']);
  const colVar    = ciFirst(['Variante']);
  const colCanal  = ciFirst(['Canal de venta']);
  const colForma  = ciFirst(['Forma de entrega']);
  const colTrans  = ciFirst(['Transportista']);
  const colSeg    = ciFirst(['Número de seguimiento','Numero de seguimiento']);

  console.log('[ML] colSKU='+colSKU+' colId='+colId+' colUnits='+colUnits+' colForma='+colForma+' colTrans='+colTrans+' colDesc='+colDesc);

  if(colSKU < 0) throw new Error('No se encontró columna SKU. Encabezados detectados: '+headers.filter(Boolean).slice(0,10).join(', '));

  const orders = [];
  const trackGroups = {};
  const months = {enero:1,febrero:2,marzo:3,abril:4,mayo:5,junio:6,julio:7,agosto:8,septiembre:9,octubre:10,noviembre:11,diciembre:12};

  for(let r=headerRow+1; r<raw.length; r++){
    const row = raw[r];
    if(!row || !row.some(c=>String(c||'').trim())) continue;

    const id  = colId>=0 ? String(row[colId]||'').trim() : String(r);
    if(colId>=0 && (!id || id.length<4)) continue;

    const sku = String(row[colSKU]||'').trim();
    if(!sku || sku==='-' || sku==='--') continue;

    // Fecha
    let dateISO = new Date().toISOString().slice(0,10);
    if(colDate>=0){
      const dr = String(row[colDate]||'');
      const dm = dr.match(/(\d+)\s+de\s+(\w+)\s+de\s+(\d{4})/i);
      if(dm){ const mon=months[dm[2].toLowerCase()]; if(mon) dateISO=`${dm[3]}-${String(mon).padStart(2,'0')}-${String(dm[1]).padStart(2,'0')}`; }
      else { const dm2=dr.match(/(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{2,4})/); if(dm2){ const yr=dm2[3].length===2?'20'+dm2[3]:dm2[3]; dateISO=`${yr}-${dm2[2].padStart(2,'0')}-${dm2[1].padStart(2,'0')}`; } }
    }

    // Estado → status interno
    const stRaw = colState>=0 ? String(row[colState]||'').toLowerCase() : '';
    let status = 'paid';
    if(stRaw.includes('etiqueta')||stRaw.includes('imprimir')||stRaw.includes('colecta')||stRaw.includes('camino')||stRaw.includes('demorado')) status='shipped';
    else if(stRaw.includes('entregado')) status='shipped';
    else if(stRaw.includes('cancel')) status='cancelled';
    else if(stRaw.includes('pendiente')||stRaw.includes('acreditado')||stRaw.includes('procesando')) status='pending';

    const desc       = colDesc>=0     ? String(row[colDesc]||'').trim()   : '';
    const esPaquete  = colPaq>=0      ? String(row[colPaq]||'').trim().toLowerCase()==='sí' : false;
    const tracking   = colSeg>=0      ? String(row[colSeg]||'').trim()    : '';
    const forma      = colForma>=0    ? String(row[colForma]||'').trim()  : '';
    const transp     = colTrans>=0    ? String(row[colTrans]||'').trim()  : '';
    const carrier    = classifyCarrier(desc, forma, transp);

    const qty        = parseInt(row[colUnits])||1;
    const costoEnvio = colCostoEnvio>=0 ? Math.abs(parseFloat(row[colCostoEnvio])||0) : 0;
    const descuento  = colDescuento>=0  ? Math.abs(parseFloat(row[colDescuento])||0)  : 0;
    const total      = colTotal>=0      ? parseFloat(row[colTotal])||0               : 0;
    const ingreso    = colIngreso>=0    ? parseFloat(row[colIngreso])||0              : 0;
    const title      = colTitle>=0      ? String(row[colTitle]||'').trim()||sku       : sku;
    const variant    = colVar>=0        ? String(row[colVar]||'').trim()              : '';
    const canal      = colCanal>=0      ? String(row[colCanal]||'Mercado Libre').trim(): 'Mercado Libre';

    if(esPaquete && tracking){
      if(!trackGroups[tracking]) trackGroups[tracking]=[];
      trackGroups[tracking].push(id);
    }

    orders.push({
      platform:'ml', orderId:id,
      date:dateISO+'T12:00:00',
      sku, qty, product:title, variant,
      status, total, ingreso, costoEnvio, descuento, canal,
      esPaquete, tracking,
      carrier, desc, transp,
      source:'excel', sourceFile:file.name
    });
  }

  // Attach packageKey
  for(const o of orders){
    if(o.esPaquete && o.tracking && trackGroups[o.tracking]?.length>=2){
      o.packageKey = o.tracking;
    }
  }
  return orders;
}

function filterXL(q){
  S.xlFiltered = q ? S.xlImported.filter(o=>[o.orderId,o.sku,o.product,o.variant].some(f=>String(f).toLowerCase().includes(q.toLowerCase()))) : [...S.xlImported];
  renderXLTable();
}

function renderXLTable(){
  // Group by SKU+talle, sum quantities
  const grouped = {};
  for(const o of S.xlFiltered){
    const {color, talle} = parseVariant(o.variant);
    const key = o.sku + '||' + talle;
    if(!grouped[key]){
      grouped[key] = { sku:o.sku, color, talle, qty:0 };
    }
    grouped[key].qty += o.qty;
  }
  const rows = Object.values(grouped).sort((a,b)=>skuSortKey(a.sku).localeCompare(skuSortKey(b.sku)));
  const totalUnits = rows.reduce((s,r)=>s+r.qty, 0);
  const totalSkus  = rows.length;

  const uniqueOrders = new Set(S.xlFiltered.map(o=>o.orderId)).size;
  const n = document.getElementById('xlsum-n'); if(n) n.textContent = uniqueOrders;
  const u = document.getElementById('xlsum-u'); if(u) u.textContent = totalUnits;
  const s = document.getElementById('xlsum-sku'); if(s) s.textContent = totalSkus;

  document.getElementById('xl-tbody').innerHTML = rows.map(r=>`<tr>
    <td><span class="sku-cell">${r.sku}</span></td>
    <td style="font-size:12px;color:var(--text-soft)">${r.color}</td>
    <td style="font-family:'Space Grotesk',sans-serif;font-size:12px;font-weight:600;color:var(--accent)">${r.talle}</td>
    <td><span class="qty-cell">${r.qty}</span></td>
  </tr>`).join('');
}

/* ═══════════════════════════════════════════════════════
   TIENDA NUBE — importar CSV y fusionar con ML
═══════════════════════════════════════════════════════ */

function tnMergeWithML(){
  if(!S.TN_DATA.length) return;
  var existing = new Set(S.xlImported.map(function(o){return o.orderId;}));
  var added = 0;
  S.TN_DATA.forEach(function(o){
    if(!existing.has(o.orderId)){ S.xlImported.push(o); added++; }
  });
  if(added > 0){
    refreshHeaders();
    document.getElementById('xl-upload-state') && (document.getElementById('xl-upload-state').style.display='none');
    var rs=document.getElementById('xl-result-state'); if(rs) rs.style.display='flex';
    renderPlatTable();
  }
}

function tnReset(){
  S.TN_DATA = [];
  document.getElementById('tn-result').style.display = 'none';
  document.getElementById('tn-fname').textContent = '';
  document.getElementById('tn-tbody').innerHTML = '';
}


// --- window-expose: handlers cableados desde el HTML ---
// renderPlatTable se expone para llamadas cross-modulo (clearAll en app.ts) via window.renderPlatTable?.()
try{window.renderPlatTable=renderPlatTable;}catch(e){}
try{window.periodToggle=periodToggle;}catch(e){}
try{window.fetchML=fetchML;}catch(e){}
try{window.fetchTN=fetchTN;}catch(e){}
try{window.tnMergeWithML=tnMergeWithML;}catch(e){}
try{window.filterPlat=filterPlat;}catch(e){}
try{window.exportPlatXL=exportPlatXL;}catch(e){}
try{window.onXLDrop=onXLDrop;}catch(e){}
try{window.onXLInput=onXLInput;}catch(e){}
try{window.filterXL=filterXL;}catch(e){}
