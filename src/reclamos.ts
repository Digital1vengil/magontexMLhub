// @ts-nocheck
// ParkaHub — módulo RECLAMOS (ventas con problemas de Mercado Libre).
// Carga el Excel "Ventas con problemas", lo persiste en D1 (/api/reclamos) y muestra métricas
// accionables + tabla filtrable. El sync por API (claims) se suma después; el Excel = backup.
import { S } from './state'
import { toast, confirm2 } from './core-ui'
import { apiPut, apiGet } from './api'

const MESES = { ene:0, feb:1, mar:2, abr:3, may:4, jun:5, jul:6, ago:7, sep:8, set:8, oct:9, nov:10, dic:11 };

function norm(s){ return String(s||'').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g,'').trim(); }

// "Lunes 8 jun 2026 - 16:20 hs" -> {ts, iso, txt}
function parseFechaRec(s){
  s = String(s||'').trim();
  const m = norm(s).match(/(\d{1,2})\s+([a-z]+)\.?\s+(\d{4})/);
  if(!m) return { ts:0, iso:'', txt:s };
  const mon = MESES[m[2].slice(0,3)];
  if(mon===undefined) return { ts:0, iso:'', txt:s };
  const y=parseInt(m[3]), d=parseInt(m[1]), ts=Date.UTC(y,mon,d), p=n=>String(n).padStart(2,'0');
  return { ts, iso: y+'-'+p(mon+1)+'-'+p(d), txt:s };
}

// Semana lunes->domingo (mismo label que Ventas ML)
function weekLabelOf(ts){
  if(!ts) return '—';
  const dt=new Date(ts), dow=dt.getUTCDay();
  const mon=new Date(dt); mon.setUTCDate(dt.getUTCDate()+(dow===0?-6:1-dow));
  const sun=new Date(mon); sun.setUTCDate(mon.getUTCDate()+6);
  const p=n=>String(n).padStart(2,'0');
  return p(mon.getUTCDate())+'/'+p(mon.getUTCMonth()+1)+' – '+p(sun.getUTCDate())+'/'+p(sun.getUTCMonth()+1)+'/'+String(sun.getUTCFullYear()).slice(2);
}

function esc(s){ return String(s==null?'':s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }

// --- Parse del Excel "Ventas con problemas" -----------------------------------
function parseReclamosExcel(raw, fname){
  let headerRow = -1;
  for(let i=0;i<Math.min(raw.length,15);i++){
    const j = norm((raw[i]||[]).join('|'));
    if(j.includes('de la venta') && (j.includes('reclamo')||j.includes('problema'))){ headerRow=i; break; }
  }
  if(headerRow<0) throw new Error('No se encontró el encabezado (¿es el Excel de "Ventas con problemas" de ML?).');
  const H = raw[headerRow].map(norm);
  const find = re => H.findIndex(h=>re.test(h));
  const idx = {
    fv:   find(/fecha de la venta/),
    id:   H.findIndex(h=>/de la venta/.test(h) && !/fecha/.test(h)),
    tit:  find(/titulo/),
    vari: find(/^variable/),
    tipo: find(/tipo de problema/),
    det:  find(/detalle/),
    nro:  find(/numero de reclamo/),
    fr:   find(/fecha del reclamo/),
    rep:  find(/reputacion/),
    exc:  find(/exclusion/),
  };
  if(idx.id<0 || idx.tipo<0) throw new Error('Faltan columnas clave (# de la venta / Tipo de problema).');

  const out = [];
  for(let r=headerRow+1; r<raw.length; r++){
    const row = raw[r];
    if(!row || !row.some(c=>String(c||'').trim())) continue;
    const orderId = String(row[idx.id]||'').trim();
    if(!orderId) continue;
    const fv = parseFechaRec(idx.fv>=0?row[idx.fv]:'');
    const fr = parseFechaRec(idx.fr>=0?row[idx.fr]:'');
    out.push({
      orderId,
      titulo:       idx.tit>=0  ? String(row[idx.tit]||'').trim()  : '',
      categoria:    idx.vari>=0 ? String(row[idx.vari]||'').trim() : '',
      tipo:         idx.tipo>=0 ? String(row[idx.tipo]||'').trim() : '',
      detalle:      idx.det>=0  ? String(row[idx.det]||'').trim()  : '',
      nroReclamo:   idx.nro>=0  ? String(row[idx.nro]||'').trim()  : '',
      reputacion:   idx.rep>=0  ? String(row[idx.rep]||'').trim()  : '',
      exclusion:    idx.exc>=0  ? String(row[idx.exc]||'').trim()  : '',
      fechaVentaTxt: fv.txt,   fechaVentaTs: fv.ts,   fechaVentaISO: fv.iso,
      fechaReclamoTxt: fr.txt, fechaReclamoTs: fr.ts,
      _source: 'excel', fname: fname,
    });
  }
  return out;
}

// --- Drop / Load --------------------------------------------------------------
function onRecDrop(e){
  e.preventDefault();
  document.getElementById('rec-dz')?.classList.remove('drag-over');
  const f = [...e.dataTransfer.files].find(f=>/\.(xlsx|xls|csv)$/i.test(f.name));
  if(f) recLoad(f); else toast('Solo .xlsx, .xls o .csv','error');
}
function onRecInput(e){
  const f = e.target.files && e.target.files[0];
  if(f) recLoad(f);
  e.target.value='';
}
function recLoad(file){
  const ld = document.getElementById('rec-loading');
  if(ld) ld.style.display='flex';
  const rd = new FileReader();
  rd.onload = function(e){
    try{
      const wb = XLSX.read(new Uint8Array(e.target.result), {type:'array', cellDates:false});
      const ws = wb.Sheets[wb.SheetNames[0]];
      const raw = XLSX.utils.sheet_to_json(ws, {header:1, defval:''});
      const nuevos = parseReclamosExcel(raw, file.name);
      if(!nuevos.length) throw new Error('No se encontraron reclamos con # de venta válido.');
      // REEMPLAZA la lista: el reporte "Ventas con problemas" es la foto completa de 60 días.
      // Así los reclamos excluidos/caídos desaparecen y no se mezcla con cargas anteriores.
      S.reclamos = nuevos.sort((a,b)=> (b.fechaVentaTs||0)-(a.fechaVentaTs||0));
      saveReclamos();
      renderReclamos();
      toast('✓ '+nuevos.length+' reclamos cargados (reemplaza la lista)','success');
    }catch(err){ toast('Error: '+err.message,'error'); console.error('[Reclamos]', err); }
    if(ld) ld.style.display='none';
  };
  rd.readAsArrayBuffer(file);
}

function saveReclamos(){
  try{ localStorage.setItem('parka_reclamos', JSON.stringify(S.reclamos)); }catch(e){}
  apiPut('/api/reclamos', { data: S.reclamos });
}

function clearReclamos(){
  if(!confirm2('clearRec','¿Borrar todos los reclamos cargados?')) return;
  S.reclamos = [];
  saveReclamos();
  renderReclamos();
  toast('Reclamos borrados','info');
}

// --- Filtros ------------------------------------------------------------------
function recSearch(){ S._recFilter = (document.getElementById('rec-search')?.value||'').toLowerCase(); renderReclamos(); }
function recSetTipo(t){ S._recTipo = (S._recTipo===t ? '' : t); renderReclamos(); }

// --- Reputación oficial (panel headline, 1 llamada a /users/{id}) --------------
let _repCache = null;
async function recLoadReputation(force){
  const el = document.getElementById('rec-reputation');
  if(!el) return;
  if(_repCache && !force){ el.innerHTML = _repHtml(_repCache); return; }
  try{
    const r = await apiGet('/api/ml/reputation');
    if(!r || !r.ok){ return; }
    _repCache = r;
    el.innerHTML = _repHtml(r);
  }catch(e){ console.error('[Reputación]', e); }
}
function _repMetric(m, k){
  const x = (m && m[k]) || {};
  return { real: (x.excluded && x.excluded.real_value) || 0, counting: x.value || 0, rate: ((x.excluded && x.excluded.real_rate) || 0) * 100 };
}
function _repHtml(r){
  const m = r.metrics || {};
  const sales = (m.sales && m.sales.completed) || 0;
  const cell = (label, d) => {
    const ok = d.counting === 0;
    return '<div style="flex:1;min-width:130px">'
      + '<div style="font-size:11px;color:var(--text-muted)">'+label+'</div>'
      + '<div style="font-size:24px;font-weight:800;color:var(--text);line-height:1.1">'+d.real+'<span style="font-size:12px;color:var(--text-muted);font-weight:600"> · '+d.rate.toFixed(2)+'%</span></div>'
      + '<div style="font-size:11px;font-weight:700;color:'+(ok?'#16a34a':'#dc2626')+'">'+(ok? '0 afectan reputación ✓' : d.counting+' afectan reputación')+'</div></div>';
  };
  return '<div class="card" style="margin-bottom:14px">'
    + '<div class="card-title" style="margin-bottom:10px">Reputación oficial de Mercado Libre '
    + '<span style="font-size:11px;color:var(--text-muted);font-weight:500">· últimos 60 días · '+Number(sales).toLocaleString('es-AR')+' ventas</span></div>'
    + '<div style="display:flex;flex-wrap:wrap;gap:20px">'
    + cell('Ventas con reclamos', _repMetric(m,'claims'))
    + cell('Cancelaciones', _repMetric(m,'cancellations'))
    + cell('Demoras de manejo', _repMetric(m,'delayed_handling_time'))
    + '</div>'
    + '<div style="font-size:11px;color:var(--text-muted);margin-top:8px">Dato oficial de ML (no la lista de abajo). El % es sobre las ventas; "afectan reputación" = las que cuentan tras exclusiones.</div>'
    + '</div>';
}

// --- Render -------------------------------------------------------------------
function renderReclamos(){
  recLoadReputation();
  const empty = document.getElementById('rec-empty');
  const content = document.getElementById('rec-content');
  if(!S.reclamos.length){
    if(empty) empty.style.display='';
    if(content) content.style.display='none';
    return;
  }
  if(empty) empty.style.display='none';
  if(content) content.style.display='';

  const q = S._recFilter||'';
  const ft = S._recTipo||'';
  const rows = S.reclamos.filter(r=>{
    if(ft && r.tipo!==ft) return false;
    if(q && ![r.orderId,r.titulo,r.detalle,r.nroReclamo,r.tipo,r.exclusion].some(f=>String(f).toLowerCase().includes(q))) return false;
    return true;
  });

  // ── Stats (sobre el total, no el filtrado) ──
  const total = S.reclamos.length;
  const byTipo = {}, byDet = {}, byProd = {}, byWeek = {};
  let accionables = 0, rechazadas = 0, mediacion = 0, afectanRep = 0;
  S.reclamos.forEach(r=>{
    byTipo[r.tipo] = (byTipo[r.tipo]||0)+1;
    byDet[r.detalle] = (byDet[r.detalle]||0)+1;
    const base = (r.titulo||'(sin título)').slice(0,42);
    byProd[base] = (byProd[base]||0)+1;
    const wl = weekLabelOf(r.fechaVentaTs);
    byWeek[wl] = (byWeek[wl]||0)+1;
    if(norm(r.reputacion)==='afectada') afectanRep++;
    const ex = norm(r.estado || r.exclusion);
    if(ex.startsWith('no solicitada')) accionables++;
    else if(ex.startsWith('rechazada')) rechazadas++;
    else if(ex.includes('mediacion')) mediacion++;
  });
  const tipoOrder = Object.keys(byTipo).sort((a,b)=>byTipo[b]-byTipo[a]);
  const maxTipo = Math.max(1, ...Object.values(byTipo));
  const detOrder = Object.keys(byDet).sort((a,b)=>byDet[b]-byDet[a]);
  const prodOrder = Object.keys(byProd).sort((a,b)=>byProd[b]-byProd[a]).slice(0,6);
  const weekOrder = Object.keys(byWeek).filter(w=>w!=='—').sort();
  const maxWeek = Math.max(1, ...weekOrder.map(w=>byWeek[w]));

  const card = (title, body) => '<div class="card" style="flex:1;min-width:220px"><div class="card-title" style="margin-bottom:8px">'+title+'</div>'+body+'</div>';

  // Tipos (barras clickeables -> filtran)
  const tiposHtml = tipoOrder.map(t=>{
    const n=byTipo[t], pct=Math.round(n/maxTipo*100), active=(ft===t);
    return '<div onclick="recSetTipo('+JSON.stringify(t).replace(/"/g,'&quot;')+')" style="cursor:pointer;margin-bottom:7px;opacity:'+(ft&&!active?0.5:1)+'">'
      +'<div style="display:flex;justify-content:space-between;font-size:12px;margin-bottom:2px"><span style="color:var(--text)'+(active?';font-weight:700':'')+'">'+esc(t)+'</span><span style="font-weight:700;color:var(--accent)">'+n+'</span></div>'
      +'<div style="height:6px;background:var(--border);border-radius:3px"><div style="height:100%;width:'+pct+'%;background:#dc2626;border-radius:3px"></div></div></div>';
  }).join('') + (ft?'<div style="font-size:11px;color:var(--text-muted);margin-top:4px;cursor:pointer" onclick="recSetTipo(\'\')">✕ quitar filtro</div>':'');

  // Detalle (ranking)
  const detHtml = '<div style="display:flex;flex-direction:column;gap:5px">'+detOrder.slice(0,7).map(d=>{
    return '<div style="display:flex;justify-content:space-between;font-size:12px"><span style="color:var(--text-soft);flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="'+esc(d)+'">'+esc(d)+'</span><span style="font-weight:700;margin-left:8px">'+byDet[d]+'</span></div>';
  }).join('')+'</div>';

  // Reputación y estado
  const excHtml = '<div style="display:flex;flex-direction:column;gap:8px">'
    +'<div style="display:flex;justify-content:space-between;align-items:center"><span style="font-size:12px;color:var(--text)">Afectan reputación</span><span style="font-size:20px;font-weight:800;color:'+(afectanRep?'#dc2626':'#16a34a')+'">'+afectanRep+(afectanRep?'':' ✓')+'</span></div>'
    +'<div style="display:flex;justify-content:space-between;font-size:12px;color:var(--text-soft)"><span>En mediación con ML</span><span style="font-weight:700">'+mediacion+'</span></div>'
    +(accionables?'<div style="display:flex;justify-content:space-between;font-size:12px;color:var(--text-soft)"><span>🟢 Podés pedir exclusión</span><span style="font-weight:700;color:#16a34a">'+accionables+'</span></div>':'')
    +(rechazadas?'<div style="display:flex;justify-content:space-between;font-size:12px;color:var(--text-soft)"><span>Exclusión rechazada</span><span style="font-weight:700">'+rechazadas+'</span></div>':'')
    +'<div style="font-size:11px;color:var(--text-muted);margin-top:2px">El número oficial de reputación está en el panel de arriba. Acá: estado de los reclamos abiertos.</div></div>';

  // Productos top
  const prodHtml = '<div style="display:flex;flex-direction:column;gap:5px">'+prodOrder.map(p=>{
    return '<div style="display:flex;justify-content:space-between;font-size:12px"><span style="color:var(--text-soft);flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="'+esc(p)+'">'+esc(p)+'</span><span style="font-weight:700;margin-left:8px;color:#dc2626">'+byProd[p]+'</span></div>';
  }).join('')+'</div>';

  // Tendencia semanal
  const trendHtml = '<div style="display:flex;align-items:flex-end;gap:3px;height:80px">'+weekOrder.map(w=>{
    const n=byWeek[w], h=Math.max(4,Math.round(n/maxWeek*64));
    return '<div title="'+esc(w)+': '+n+'" style="flex:1;min-width:14px;display:flex;flex-direction:column;align-items:center;gap:2px">'
      +'<div style="font-size:9px;color:var(--text-soft)">'+n+'</div>'
      +'<div style="width:100%;height:'+h+'px;background:#dc2626;border-radius:3px 3px 0 0;opacity:.8"></div>'
      +'<div style="font-size:8px;color:var(--text-muted)">'+esc(w.split(' – ')[0])+'</div></div>';
  }).join('')+'</div>';

  document.getElementById('rec-stats').innerHTML =
    '<div style="display:flex;flex-wrap:wrap;gap:12px;margin-bottom:12px">'
    + card('Total reclamos', '<div style="font-size:32px;font-weight:800;color:#dc2626">'+total+'</div><div style="font-size:11px;color:var(--text-muted)">'+ (S.reclamos.filter(r=>norm(r.reputacion)==='afectada').length) +' afectan reputación</div>')
    + card('Por tipo de problema', tiposHtml)
    + card('Reputación y estado', excHtml)
    + '</div>'
    + '<div style="display:flex;flex-wrap:wrap;gap:12px;margin-bottom:12px">'
    + card('Motivos (detalle)', detHtml)
    + card('Productos con más reclamos', prodHtml)
    + card('Reclamos por semana (fecha de venta)', trendHtml)
    + '</div>';

  // ── Tabla ──
  const cnt = document.getElementById('rec-count');
  if(cnt) cnt.textContent = rows.length + (rows.length===total?'' : ' de '+total) + ' reclamos';
  document.getElementById('rec-tbody').innerHTML = rows.map(r=>{
    const estTxt = r.estado || r.exclusion || '';
    const ex = norm(estTxt);
    const exBadge = ex.includes('mediacion') ? '<span class="badge" style="background:#fef9c3;color:#854d0e">Mediación</span>'
      : ex.startsWith('no solicitada') ? '<span class="badge" style="background:#dcfce7;color:#166534">Podés excluir</span>'
      : ex.startsWith('rechazada') ? '<span class="badge" style="background:#fee2e2;color:#991b1b">Rechazada</span>'
      : '<span class="badge" style="background:var(--surface2);color:var(--text-soft)" title="'+esc(estTxt)+'">'+esc(estTxt.slice(0,24))+'</span>';
    return '<tr>'
      +'<td><span class="date-cell">'+esc((r.fechaVentaTxt||'').replace(/ - .*/,''))+'</span></td>'
      +'<td><span class="oid-cell">#'+esc(r.orderId)+'</span></td>'
      +'<td><span class="product-cell" title="'+esc(r.titulo)+'">'+esc(r.titulo)+'</span></td>'
      +'<td style="font-size:12px;color:var(--text-soft)">'+esc(r.tipo)+'</td>'
      +'<td style="font-size:12px;color:var(--text)">'+esc(r.detalle)+'</td>'
      +'<td><span class="sku-cell">'+esc(r.nroReclamo)+'</span></td>'
      +'<td><span class="date-cell">'+esc((r.fechaReclamoTxt||'').replace(/ - .*/,''))+'</span></td>'
      +'<td>'+exBadge+'</td></tr>';
  }).join('');
}

// --- window-expose ------------------------------------------------------------
try{window.onRecDrop=onRecDrop;}catch(e){}
try{window.onRecInput=onRecInput;}catch(e){}
try{window.recSearch=recSearch;}catch(e){}
try{window.recSetTipo=recSetTipo;}catch(e){}
try{window.renderReclamos=renderReclamos;}catch(e){}
try{window.clearReclamos=clearReclamos;}catch(e){}
try{window.recLoadReputation=recLoadReputation;}catch(e){}

export { renderReclamos }
