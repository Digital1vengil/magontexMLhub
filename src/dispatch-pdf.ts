// @ts-nocheck
// ParkaHub — Despacho / Control.pdf / Despachos por día (paso modularizacion).
// Funciones cortadas TAL CUAL desde app.ts. Cero cambio de logica.
import { S } from './state'
import { toast, nbadge } from './core-ui'

// -- Classify carrier ----------------------------------------------------
// Transportista (col AU) = fuente definitiva siempre.
// Col D solo suma si dice explícitamente "conductor/repartidor" (Flex).
// "colecta" en col D NO indica Flex -- todos los envíos pasan por colecta.
export function classifyCarrier(descripcion, forma, transportista){
  const t = String(transportista||'').toLowerCase().trim();
  const d = String(descripcion||'').toLowerCase();

  // -- Col D -- texto de ML para Flex ---------------------------
  // "Tu comprador debe recibir el paquete hoy..." = etiqueta lista para Flex
  // "a tu conductor", "a tu repartidor" = también Flex
  if(d.includes('comprador debe recibir')) return 'flex';
  if(d.includes('conductor') || d.includes('repartidor')) return 'flex';

  // -- Transportista -- cuando col D no identifica ---------------
  // FLEX: carriers de reparto a domicilio
  if(t.includes('andreani'))  return 'flex';
  if(t === 'oca' || t.startsWith('oca ') || t.endsWith(' oca')) return 'flex';
  if(t.includes('ocasa'))     return 'flex';

  // CORREO ARGENTINO
  if(t.includes('correo argentino')) return 'correo';

  // PUNTOS DE RETIRO
  if(t.includes('pickit') || t.includes('punto hop') || t.includes('hop')) return 'punto';

  // COLECTA: Reprocesos Carrito = ML retira en depósito
  if(t.includes('reprocesos') || t === '') return 'colecta';

  // Cualquier otro -> colecta
  return 'colecta';
}

// --- REPORTS -----------------------------------------------------------
function onDrop(e){e.preventDefault();document.getElementById('dz').classList.remove('drag-over');const files=[...e.dataTransfer.files].filter(f=>f.name.toLowerCase().endsWith('.pdf'));if(files.length)processControlPdfFiles(files);}
function onFileInput(e){const files=[...e.target.files].filter(f=>f.name.toLowerCase().endsWith('.pdf'));if(files.length)processControlPdfFiles(files);e.target.value='';}

// --- CONTROL.PDF -------------------------------------------------------

async function processControlPdfFiles(files){
  const ld=document.getElementById('rep-load');
  ld.style.display='flex';
  try{
    let allEntries=[];
    for(const file of files){
      document.getElementById('rep-loadtxt').textContent=`Leyendo ${file.name}...`;
      const uint8=new Uint8Array(await file.arrayBuffer());
      const text=await extractPdfText(uint8);
      if(!text||text.length<50) continue;
      const entries=parseControlText(text);
      allEntries.push(...entries);
    }
    // Deduplicate by venta ID
    const seen=new Set();
    allEntries=allEntries.filter(e=>{if(!e.venta||seen.has(e.venta))return false;seen.add(e.venta);return true;});
    // Re-sort A->Z
    allEntries.sort((a,b)=>a.buyer.localeCompare(b.buyer,'es',{sensitivity:'base'}));
    if(!allEntries.length) throw new Error('No se encontraron ordenes en los PDFs');
    S.controlEntries=allEntries;
    S.controlFiltered=[...allEntries];
    renderControlTable();
    document.getElementById('rep-card').style.display='';
    document.getElementById('rep-card-title').textContent=`${allEntries.length} ordenes`;
    document.getElementById('rep-card-sub').textContent=files.length===1?files[0].name:`${files.length} archivos combinados`;
    nbadge('nb-rep',allEntries.length);
    toast(`${allEntries.length} ordenes de ${files.length} PDF${files.length>1?'s':''} ordenadas A->Z`,'success');
  }catch(e){ toast('Error: '+e.message,'error'); console.error(e); }
  ld.style.display='none';
}

// Alias single file
async function processControlPdfFile(file){ return processControlPdfFiles([file]); }

// -- Extract text using PDF.js ------------------------------------------------
async function extractPdfText(bytes){
  // PDF.js 3.x CDN expone window.pdfjsLib
  const lib = window.pdfjsLib;
  if(!lib) throw new Error('PDF.js no cargo. Recarga la pagina.');
  lib.GlobalWorkerOptions.workerSrc='https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';
  const doc = await lib.getDocument({data:bytes}).promise;
  let out='';
  for(let p=1;p<=doc.numPages;p++){
    const page=await doc.getPage(p);
    const ct=await page.getTextContent();
    // Agrupar items por fila Y (tol 4px), separar columna izq (x<230) y der (x>=230)
    // Umbral 230pt = mitad aprox de una A4 en el PDF de ML
    const rowMap=new Map();
    for(const it of ct.items){
      if(!it.str.trim()) continue;
      const x=it.transform[4], y=it.transform[5];
      let found=null;
      for(const [ry] of rowMap){ if(Math.abs(ry-y)<=4){found=ry;break;} }
      const key=found!==null?found:y;
      if(!rowMap.has(key)) rowMap.set(key,[]);
      rowMap.get(key).push({x,s:it.str});
    }
    const sortedYs=[...rowMap.keys()].sort((a,b)=>b-a);
    for(const y of sortedYs){
      const items=rowMap.get(y).sort((a,b)=>a.x-b.x);
      const L=items.filter(i=>i.x< 230).map(i=>i.s).join(' ').trim();
      const R=items.filter(i=>i.x>=230).map(i=>i.s).join(' ').trim();
      if(L) out+=L+'\n';
      if(R) out+=R+'\n';
    }
    out+='\f\n';
  }
  return out;
}

// -- Parse text into entries ---------------------------------------------------
function parseControlText(text){
  const NOISE=[
    /Despacha tus productos cuanto antes[^\n]*/gi,
    /¡?No te relajes[^\n]*/gi,
    /Tu comprador los est[aá] esperando\.?/gi,
    /Identifi+caci[óo]n(\s+Productos)?/gi,
    /^mercado\s*libre$/gim,
    /^Productos$/gim,
  ];
  for(const r of NOISE) text=text.replace(r,'');
  const lines=text.split('\n').map(l=>l.trim()).filter(Boolean);
  const entries=[];
  let cur=null;

  function isEnvioID(s){
    if(!s||s.length<5) return false;
    if(s.includes(':')) return false;
    if(/\s/.test(s)) return false;
    if(/^(Campera|Parka|Chaleco|Anorak|Mochila|Buzo|Piloto|Bomber|Puffer|Trench|Abrigo|Balance|Aioros|Discord|Ember|Prisma|Dynamo|Harmony|Anubis|Woven|Fleece|Hombre|Mujer|Gravity|Baker|Supply|Terra|Origin|Ubuntu|Fjord)/i.test(s)) return false;
    return /^[A-Z0-9]{5,}$/i.test(s);
  }
  function looksLikeName(s){
    if(!s||s.includes(':')) return false;
    if(isEnvioID(s)) return false;
    if(/^(Campera|Parka|Chaleco|Mochila|Anorak|Abrigo|Piloto|Bomber|Puffer|Trench|Balance|Aioros|Discord|Ember|Prisma|Dynamo|Harmony|Anubis|Woven|Fleece|Hombre|Mujer)/i.test(s)) return false;
    const words=s.split(/\s+/);
    if(words.length<2||words.length>7) return false;
    if(/\d{5,}/.test(s)) return false;
    return /^[A-ZÀ-ÿ]/i.test(s);
  }
  function closeCur(){
    if(!cur) return;
    if(cur._item&&cur._item.sku) cur.items.push({...cur._item});
    if(cur.items.length>0&&(cur.venta||cur.packId||cur.id)){
      cur.ref=cur.packId||cur.venta;
      cur.qty=cur.items.reduce((s,i)=>s+i.qty,0);
      const {_item,...clean}=cur;
      entries.push(clean);
    }
    cur=null;
  }

  for(const line of lines){
    if(isEnvioID(line)){closeCur();cur={id:line,packId:'',venta:'',buyer:'',items:[],_item:null};continue;}
    if(!cur) continue;
    const mPack =/Pack\s+ID:\s*(\d{8,})/i.exec(line);
    const mVenta=/Venta:\s*(\d{8,})/i.exec(line);
    const mSKU  =/SKU:?\s*([A-Z0-9][A-Z0-9\-\.]{2,})/i.exec(line);
    const mQty  =/Cantidad:\s*(\d+)/i.exec(line);
    const mTalle=/Talle:\s*([A-Za-z0-9]{1,6})/i.exec(line);
    const mColor=/Color:\s*(.+)/i.exec(line);
    if(mPack)  cur.packId=mPack[1];
    if(mVenta) cur.venta=mVenta[1];
    if(mSKU){
      if(cur._item&&cur._item.sku) cur.items.push({...cur._item});
      cur._item={sku:mSKU[1].trim(),qty:1,talle:'',color:''};
    }
    if(mQty   &&cur._item) cur._item.qty  =parseInt(mQty[1])||1;
    if(mTalle &&cur._item) cur._item.talle=mTalle[1].trim();
    if(mColor &&cur._item) cur._item.color=mColor[1].trim().replace(/^black$/i,'Negro');
    if(!cur.buyer&&(cur.venta||cur.packId)&&looksLikeName(line)) cur.buyer=line;
  }
  closeCur();
  entries.sort((a,b)=>(a.buyer||'').localeCompare(b.buyer||'','es',{sensitivity:'base'}));
  return entries;
}

// -- Render preview table -----------------------------------------------
function renderControlTable(){
  const q=(document.getElementById('rep-filter')||{}).value?.toLowerCase()||'';
  S.controlFiltered=q
    ?S.controlEntries.filter(e=>{
        const skus=(e.items||[]).map(i=>i.sku+' '+i.talle).join(' ').toLowerCase();
        return [e.buyer||'', e.ref||'', skus].some(f=>f.toLowerCase().includes(q));
      })
    :[...S.controlEntries];

  const multi=S.controlEntries.filter(e=>e.items.length>1).length;
  document.getElementById('ctrl-n').textContent=S.controlEntries.length;
  document.getElementById('ctrl-packs').textContent=multi;
  document.getElementById('ctrl-skus').textContent=new Set(S.controlEntries.flatMap(e=>e.items.map(i=>i.sku))).size;

  document.getElementById('rep-tbody').innerHTML=S.controlFiltered.map((e,i)=>{
    const skuHtml=(e.items||[]).map(it=>
      `<span style="font-family:monospace;font-size:11px;font-weight:600;background:var(--accent-light);color:var(--accent);border-radius:3px;padding:1px 5px">${it.sku}</span>${it.talle?` <span style="font-size:11px;color:var(--text-soft)">${it.talle}</span>`:''}`
    ).join(' &nbsp;');
    return `<tr>
      <td style="font-size:11px;color:var(--text-muted)">${i+1}</td>
      <td style="font-weight:600;font-size:13px">${e.buyer||'--'}</td>
      <td style="font-family:'Space Grotesk',sans-serif;font-size:11px;color:var(--text-soft)">${e.ref||'--'}</td>
      <td>${skuHtml||'--'}</td>
      <td style="text-align:center;font-family:'Space Grotesk',sans-serif;font-weight:700;font-size:14px;color:${(e.items||[]).length>1?'var(--orange)':'var(--text)'}">${e.qty}</td>
    </tr>`;
  }).join('');
}

function filterControlTable(){ renderControlTable(); }

function clearControl(){
  S.controlEntries=[];S.controlFiltered=[];
  document.getElementById('rep-card').style.display='none';
  const fi=document.getElementById('rep-filter');if(fi)fi.value='';
  nbadge('nb-rep',0);
  toast('Reporte limpiado','info');
}

// -- Generate Excel: Nombre | N. Venta/Pack ID | Artículos ---------------
export function generateControlReport(){
  if(!S.controlEntries.length){toast('Cargá el Control.pdf primero','error');return;}

  const today=new Date().toLocaleDateString('es-AR',{day:'numeric',month:'long',year:'numeric'});
  const filename=(document.getElementById('rep-card-sub')||{}).textContent||'';

  // Colors
  const BK='0D0D0D', WH='FFFFFF', SU='F8F9FA', GR='1A3D2B', GL='D4F0E0',
        G2='2D5A3D', AC='1A73E8', AM='B45309', AM2='FFFBEB', TE='374151',
        MT='9CA3AF', BL='1D4ED8', BL2='EFF6FF', BD='E0E0E0';

  function c(v,bg,fg,sz,bold,align){
    return{v:v===null||v===undefined?'':v, t:typeof v==='number'?'n':'s',
      s:{fill:{fgColor:{rgb:bg||WH},patternType:'solid'},
         font:{name:'Calibri',sz:sz||11,bold:!!bold,color:{rgb:fg||TE}},
         alignment:{horizontal:align||'left',vertical:'center',wrapText:true},
         border:{top:{style:'thin',color:{rgb:BD}},bottom:{style:'thin',color:{rgb:BD}},
                 left:{style:'thin',color:{rgb:BD}},right:{style:'thin',color:{rgb:BD}}}}};
  }

  const ws={}; let R=0;
  const SC=(col,row,cell)=>{ws[XLSX.utils.encode_cell({r:row,c:col})]=cell;};

  // -- Header ---------------------------------------------------
  SC(0,R,c('PARKA.',BK,'E8C547',16,true));
  SC(1,R,c('',BK));
  SC(2,R,c('CONTROL DE DESPACHO -- ORDENADO ALFABÉTICAMENTE',BK,WH,12,true,'center'));
  ws['!merges']=[{s:{r:0,c:2},e:{r:0,c:2}}]; R++;

  SC(0,R,c('',BK)); SC(1,R,c('',BK));
  SC(2,R,c('Fecha: '+today+'  -  '+filename,BK,MT,9,false,'right')); R++;
  for(let col=0;col<3;col++) SC(col,R,c('',SU)); R++;

  // -- Stats row ------------------------------------------------
  const total=S.controlEntries.length;
  const multi=S.controlEntries.filter(e=>e.items.length>1).length;
  SC(0,R,c('TOTAL ÓRDENES',SU,MT,9,true,'center'));
  SC(1,R,c('PAQUETES DOBLES',AM2,AM,9,true,'center'));
  SC(2,R,c('',SU)); R++;
  SC(0,R,c(total,SU,AC,18,true,'center'));
  SC(1,R,c(multi,AM2,AM,18,true,'center'));
  SC(2,R,c('',SU)); R++;
  for(let col=0;col<3;col++) SC(col,R,c('',SU)); R++;

  // -- Column headers -------------------------------------------
  SC(0,R,c('NOMBRE',GR,GL,10,true,'left'));
  SC(1,R,c('N. VENTA / PACK ID',GR,GL,10,true,'center'));
  SC(2,R,c('CANT.',GR,GL,10,true,'center')); R++;

  // -- Data rows ------------------------------------------------
  for(let i=0;i<S.controlEntries.length;i++){
    const e=S.controlEntries[i];
    const bg=i%2===0?WH:'F4FBF7';
    const isMulti=e.items&&e.items.length>1;
    const qty=e.qty||e.items?.reduce((s,it)=>s+it.qty,0)||1;

    SC(0,R,c(e.buyer||'--',    bg,        TE,  11, true,  'left'));
    SC(1,R,c(e.ref,            bg,        isMulti?AM:BL, 11, false, 'center'));
    SC(2,R,c(qty,              isMulti?AM2:bg, isMulti?AM:TE, 13, true,  'center'));
    R++;
  }

  // -- Footer ---------------------------------------------------
  for(let col=0;col<3;col++) SC(col,R,c('',SU)); R++;
  SC(0,R,c('PARKA. Sales Hub',SU,MT,9,false,'left'));
  SC(2,R,c('Generado el '+today,SU,MT,9,false,'right')); R++;

  // -- Sheet config ---------------------------------------------
  ws['!ref']=XLSX.utils.encode_range({s:{r:0,c:0},e:{r:R-1,c:2}});
  ws['!cols']=[{wch:36},{wch:22},{wch:8}];
  ws['!rows']=Array.from({length:R},(_,i)=>{
    if(i===0) return{hpt:22};
    if(i===4) return{hpt:28};
    // Data rows with multiple SKUs need more height
    const di=i-7;
    if(di>=0&&di<S.controlEntries.length&&S.controlEntries[di].items.length>1) return{hpt:32};
    return{hpt:18};
  });
  ws['!freeze']={xSplit:0,ySplit:7,topLeftCell:'A8',activeCell:'A8',sqref:'A8'};

  const wb=XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb,ws,'Control Despacho');
  const ctrlFname=`PARKA_Control_Despacho_${new Date().toISOString().slice(0,10)}.xlsx`;
  XLSX.writeFile(wb, ctrlFname);
  // Guardar en memoria para subir a Drive
  window._lastControlWb   = wb;
  window._lastControlName = ctrlFname;
  // Mostrar botón Drive si está conectado
  var driveBtn = document.getElementById('btn-save-drive-ctrl');
  if(driveBtn) driveBtn.style.display = S.GD.token ? 'inline-flex' : 'none';
  toast('✓ Reporte generado — '+S.controlEntries.length+' órdenes'+(S.GD.token?' — guardá en Drive con el botón':''), 'success');
}

// --- DESPACHOS POR DÍA -------------------------------------------------
export function renderDespachos(){
  const platF=document.getElementById('des-plat').value;
  const from=document.getElementById('des-from').value;
  const to=document.getElementById('des-to').value;
  const q=(document.getElementById('des-day-search').value||'').toLowerCase();
  const all=[...S.platOrders,...S.manualOrders];

  // Filter shipped orders
  let shipped=all.filter(o=>{
    if(o.status!=='shipped')return false;
    if(platF!=='all'&&o.platform!==platF)return false;
    if(from&&o.date.slice(0,10)<from)return false;
    if(to&&o.date.slice(0,10)>to)return false;
    return true;
  });

  // Group by date
  const dayMap={};
  for(const o of shipped){
    const day=o.date.slice(0,10);
    if(!dayMap[day])dayMap[day]={date:day,orders:new Set(),qty:0,plats:new Set(),skus:{}};
    dayMap[day].orders.add(o.orderId);
    dayMap[day].qty+=o.qty;
    dayMap[day].plats.add(o.platform);
    dayMap[day].skus[o.sku]=(dayMap[day].skus[o.sku]||0)+o.qty;
  }

  let days=Object.values(dayMap).sort((a,b)=>b.date.localeCompare(a.date));

  // Update summary
  const totalPedidos=days.reduce((s,d)=>s+d.orders.size,0);
  const totalUnits=days.reduce((s,d)=>s+d.qty,0);
  const avg=days.length?Math.round(totalPedidos/days.length*10)/10:0;
  document.getElementById('dsum-dias').textContent=days.length;
  document.getElementById('dsum-total').textContent=totalPedidos;
  document.getElementById('dsum-units').textContent=totalUnits;
  document.getElementById('dsum-avg').textContent=avg;

  // Render bar chart
  renderDespachosChart(days);

  // Apply day-level search
  if(q)days=days.filter(d=>d.date.includes(q)||Object.keys(d.skus).some(s=>s.toLowerCase().includes(q)));

  // Render table
  const empty=document.getElementById('des-empty'),wrap=document.getElementById('des-table-wrap');
  if(!days.length){empty.style.display='';wrap.style.display='none';return;}
  empty.style.display='none';wrap.style.display='block';

  document.getElementById('des-tbody').innerHTML=days.map(d=>{
    const dateObj=new Date(d.date+'T12:00:00');
    const dow=['Dom','Lun','Mar','Mié','Jue','Vie','Sáb'][dateObj.getDay()];
    const platBadges=[...d.plats].map(p=>`<span class="badge ${p}" style="font-size:10px">${{ml:'ML',tn:'TN',manual:'MAN'}[p]||p}</span>`).join(' ');
    const topSkus=Object.entries(d.skus).sort((a,b)=>b[1]-a[1]).slice(0,4).map(([sku,q])=>`<span style="font-family:'Space Grotesk',sans-serif;font-size:11px;font-weight:600;color:var(--accent)">${sku}</span><span style="font-size:11px;color:var(--text-muted)">×${q}</span>`).join(' ');
    const isToday=d.date===new Date().toISOString().slice(0,10);
    return`<tr style="${isToday?'background:var(--accent-dim)':''}">
      <td><span style="font-family:'Space Grotesk',sans-serif;font-size:13px;font-weight:600">${dateObj.toLocaleDateString('es-AR',{day:'2-digit',month:'2-digit',year:'2-digit'})}</span>${isToday?'<span style="font-size:10px;color:var(--accent);margin-left:6px;font-weight:600">HOY</span>':''}</td>
      <td><span style="font-family:'Space Grotesk',sans-serif;font-size:12px;color:var(--text-soft)">${dow}</span></td>
      <td style="text-align:center"><span style="font-family:'Space Grotesk',sans-serif;font-size:20px;font-weight:700;color:var(--text)">${d.orders.size}</span></td>
      <td style="text-align:center"><span style="font-family:'Space Grotesk',sans-serif;font-size:16px;font-weight:600;color:var(--text-soft)">${d.qty}</span></td>
      <td><div style="display:flex;gap:4px;flex-wrap:wrap">${platBadges}</div></td>
      <td><div style="display:flex;gap:6px;flex-wrap:wrap;align-items:center">${topSkus}</div></td>
    </tr>`;
  }).join('');
}

function renderDespachosChart(days){
  const chartEl=document.getElementById('des-chart');
  const emptyEl=document.getElementById('des-chart-empty');
  if(!days.length){chartEl.style.display='none';emptyEl.style.display='';return;}
  emptyEl.style.display='none';chartEl.style.display='block';
  const recent=days.slice().reverse().slice(-30); // last 30 days with shipments
  const maxQ=Math.max(...recent.map(d=>d.orders.size),1);
  const barW=Math.max(28,Math.min(56,Math.floor(700/recent.length)-4));
  document.getElementById('des-chart-info').textContent=`Últimos ${recent.length} días con despachos`;
  chartEl.innerHTML=`<div style="display:flex;align-items:flex-end;gap:4px;height:120px;padding-bottom:28px;position:relative;min-width:${recent.length*(barW+4)}px">
    ${recent.map(d=>{
      const h=Math.max(6,Math.round((d.orders.size/maxQ)*90));
      const dateObj=new Date(d.date+'T12:00:00');
      const isToday=d.date===new Date().toISOString().slice(0,10);
      const label=dateObj.toLocaleDateString('es-AR',{day:'2-digit',month:'2-digit'});
      return`<div style="display:flex;flex-direction:column;align-items:center;gap:3px;flex-shrink:0;width:${barW}px" title="${d.date}: ${d.orders.size} pedidos">
        <span style="font-family:'Space Grotesk',sans-serif;font-size:10px;font-weight:700;color:${isToday?'var(--accent)':'var(--text-soft)'}">${d.orders.size}</span>
        <div style="width:${barW-4}px;height:${h}px;background:${isToday?'var(--accent)':'var(--border)'};border-radius:3px 3px 0 0;transition:background .15s" onmouseover="this.style.background='var(--accent)'" onmouseout="this.style.background='${isToday?'var(--accent)':'var(--border)'}'"></div>
        <span style="font-size:9px;color:var(--text-muted);position:absolute;bottom:0;transform:translateX(0);white-space:nowrap">${label}</span>
      </div>`;
    }).join('')}
  </div>`;
}

function clearDesFilters(){
  document.getElementById('des-plat').value='all';
  document.getElementById('des-from').value='';
  document.getElementById('des-to').value='';
  document.getElementById('des-day-search').value='';
  renderDespachos();
}

function exportDespachosXL(){
  const platF=document.getElementById('des-plat').value;
  const all=[...S.platOrders,...S.manualOrders];
  const shipped=all.filter(o=>o.status==='shipped'&&(platF==='all'||o.platform===platF));
  if(!shipped.length){toast('No hay despachos registrados','error');return;}

  const today = new Date().toLocaleDateString('es-AR',{day:'numeric',month:'long',year:'numeric'});
  const C = {
    black:'0D0D0D', surface:'141414', surface2:'1C1C1C',
    gold:'E8C547', goldDim:'2A2510',
    white:'F0F0F0', soft:'A0A0A0', muted:'5A5A5A',
    accent:'1A73E8', accentBg:'E8F0FD', accentText:'1557B0',
    green:'166534', greenBg:'F0FDF4', greenText:'15803D',
  };

  function c(v, opts={}){
    const isDark = opts.dark;
    return {
      v, t: typeof v==='number'?'n':'s',
      s:{
        fill:{ fgColor:{ rgb: opts.bg||(isDark?C.surface:'FFFFFF') }, patternType:'solid' },
        font:{ name:'Calibri', sz:opts.sz||11, bold:!!opts.bold,
               color:{ rgb: opts.color||(isDark?C.white:'1F2937') }, italic:!!opts.italic },
        alignment:{ horizontal:opts.align||'left', vertical:'center', wrapText:!!opts.wrap },
        border:{
          top:   {style:'thin',color:{rgb:isDark?C.surface2:'E0E0E0'}},
          bottom:{style:'thin',color:{rgb:isDark?C.surface2:'E0E0E0'}},
          left:  {style:'thin',color:{rgb:isDark?C.surface2:'E0E0E0'}},
          right: {style:'thin',color:{rgb:isDark?C.surface2:'E0E0E0'}},
        }
      }
    };
  }

  // Build day map
  const dayMap={};
  for(const o of shipped){
    const day=o.date.slice(0,10);
    if(!dayMap[day])dayMap[day]={date:day,orders:new Set(),qty:0,skus:[],items:[]};
    dayMap[day].orders.add(o.orderId);
    dayMap[day].qty+=o.qty;
    dayMap[day].skus.push(o.sku);
    dayMap[day].items.push(o);
  }
  const days=Object.values(dayMap).sort((a,b)=>b.date.localeCompare(a.date));
  const dows=['Domingo','Lunes','Martes','Miércoles','Jueves','Viernes','Sábado'];

  // -- HOJA 1: Resumen por día ------------------------------------
  const ws1={}; let R=0;
  const s=(col,row,cell)=>{ ws1[XLSX.utils.encode_cell({r:row,c:col})]=cell; };

  // Título
  s(0,R,c('PARKA.',{bg:C.black,color:C.gold,sz:16,bold:true,dark:true}));
  s(1,R,c('',{bg:C.black,dark:true}));
  s(2,R,c('CONTROL DE DESPACHOS',{bg:C.black,color:C.white,sz:12,bold:true,dark:true}));
  s(3,R,c('',{bg:C.black,dark:true}));
  s(4,R,c('Fecha: '+today,{bg:C.black,color:C.muted,sz:10,align:'right',dark:true})); R++;
  for(let col=0;col<5;col++) s(col,R,c('',{bg:C.black,dark:true})); R++;

  // Stats globales
  const totalPedidos=days.reduce((s,d)=>s+d.orders.size,0);
  const totalUnits=days.reduce((s,d)=>s+d.qty,0);
  const avg=days.length?Math.round(totalPedidos/days.length*10)/10:0;
  const statBg='F8F9FA', statLabelColor='9CA3AF', statValColor='1F2937';
  const statLabels=['DÍAS CON DESPACHOS','TOTAL PEDIDOS','UNIDADES TOTALES','PROMEDIO / DÍA'];
  const statVals=[days.length, totalPedidos, totalUnits, avg];
  for(let col=0;col<4;col++) s(col,R,c(statLabels[col],{bg:statBg,color:statLabelColor,sz:9,bold:true,align:'center'})); s(4,R,c('',{bg:statBg})); R++;
  for(let col=0;col<4;col++) s(col,R,c(statVals[col],{bg:col===0?C.accentBg:statBg,color:col===0?C.accentText:C.accent,sz:18,bold:true,align:'center'})); s(4,R,c('',{bg:statBg})); R++;
  for(let col=0;col<5;col++) s(col,R,c('',{bg:statBg})); R++;

  // Headers tabla
  const hdrs=['FECHA','DÍA','PEDIDOS','UNIDADES','SKUs DESPACHADOS'];
  const hAligns=['center','center','center','center','left'];
  for(let col=0;col<5;col++) s(col,R,c(hdrs[col],{bg:C.surface2,color:C.muted,sz:9,bold:true,align:hAligns[col],dark:true})); R++;

  for(let i=0;i<days.length;i++){
    const d=days[i];
    const dt=new Date(d.date+'T12:00:00');
    const isToday=d.date===new Date().toISOString().slice(0,10);
    const bg=isToday?C.accentBg : i%2===0?'FFFFFF':'F8F9FA';
    const textCol=isToday?C.accentText:'1F2937';
    const dow=dows[dt.getDay()];
    const skuList=[...new Set(d.skus)].join(', ');
    const dateStr=dt.toLocaleDateString('es-AR',{day:'2-digit',month:'2-digit',year:'2-digit'});

    s(0,R,c(dateStr,         {bg, color:textCol, sz:11, bold:isToday, align:'center'}));
    s(1,R,c(dow,             {bg, color:isToday?C.accentText:'6B7280', sz:11, align:'center'}));
    s(2,R,c(d.orders.size,   {bg, color:textCol, sz:14, bold:true, align:'center'}));
    s(3,R,c(d.qty,           {bg, color:textCol, sz:12, bold:true, align:'center'}));
    s(4,R,c(skuList,         {bg, color:'6B7280', sz:10, wrap:true}));
    R++;
  }

  // Footer
  for(let col=0;col<5;col++) s(col,R,c('',{bg:'F8F9FA'})); R++;
  s(0,R,c('PARKA. Sales Hub',{bg:'F8F9FA',color:'9CA3AF',sz:9,italic:true}));
  for(let col=1;col<4;col++) s(col,R,c('',{bg:'F8F9FA'}));
  s(4,R,c('Generado el '+today,{bg:'F8F9FA',color:'9CA3AF',sz:9,align:'right',italic:true})); R++;

  ws1['!ref']=XLSX.utils.encode_range({s:{r:0,c:0},e:{r:R-1,c:4}});
  ws1['!cols']=[{wch:12},{wch:12},{wch:12},{wch:12},{wch:46}];
  ws1['!rows']=Array.from({length:R},(_,i)=>i===0?{hpt:26}:i===3?{hpt:28}:{hpt:20});

  // -- HOJA 2: Detalle completo ------------------------------------
  const ws2={}; let R2=0;
  const s2=(col,row,cell)=>{ ws2[XLSX.utils.encode_cell({r:row,c:col})]=cell; };
  const platNames={ml:'Mercado Libre',tn:'Tienda Nube',manual:'Manual'};

  // Título
  s2(0,R2,c('PARKA.',{bg:C.black,color:C.gold,sz:14,bold:true,dark:true}));
  s2(1,R2,c('DETALLE DE DESPACHOS',{bg:C.black,color:C.white,sz:12,bold:true,dark:true}));
  for(let col=2;col<6;col++) s2(col,R2,c('',{bg:C.black,dark:true})); R2++;
  for(let col=0;col<6;col++) s2(col,R2,c('',{bg:C.black,dark:true})); R2++;

  const h2=['FECHA','PLATAFORMA','N. ORDEN','SKU','PRODUCTO','CANT.'];
  const h2a=['center','center','center','left','left','center'];
  for(let col=0;col<6;col++) s2(col,R2,c(h2[col],{bg:C.surface2,color:C.muted,sz:9,bold:true,align:h2a[col],dark:true})); R2++;

  const sortedShipped=[...shipped].sort((a,b)=>b.date.localeCompare(a.date));
  for(let i=0;i<sortedShipped.length;i++){
    const o=sortedShipped[i];
    const bg=i%2===0?'FFFFFF':'F8F9FA';
    const dt=new Date(o.date);
    s2(0,R2,c(dt.toLocaleDateString('es-AR',{day:'2-digit',month:'2-digit',year:'2-digit'}),{bg,color:'6B7280',sz:11,align:'center'}));
    s2(1,R2,c(platNames[o.platform]||o.platform,{bg,color:'6B7280',sz:11,align:'center'}));
    s2(2,R2,c(o.orderId,{bg,color:'6B7280',sz:10,align:'center'}));
    s2(3,R2,c(o.sku,    {bg,color:'1F2937',sz:11,bold:true}));
    s2(4,R2,c(o.product,{bg,color:'6B7280',sz:10}));
    s2(5,R2,c(o.qty,    {bg,color:'1F2937',sz:13,bold:true,align:'center'}));
    R2++;
  }

  ws2['!ref']=XLSX.utils.encode_range({s:{r:0,c:0},e:{r:R2-1,c:5}});
  ws2['!cols']=[{wch:12},{wch:16},{wch:18},{wch:22},{wch:38},{wch:8}];
  ws2['!rows']=Array.from({length:R2},(_,i)=>i===0?{hpt:24}:{hpt:20});

  // -- Generar archivo ---------------------------------------------
  const wb=XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb,ws1,'Resumen por Día');
  XLSX.utils.book_append_sheet(wb,ws2,'Detalle Despachos');
  XLSX.writeFile(wb,`PARKA_Despachos_${new Date().toISOString().slice(0,10)}.xlsx`);
  toast('Excel exportado con formato PARKA','success');
}

// -- wired (HTML onclick/oninput) --------------------------------------
try{window.onDrop=onDrop;}catch(e){}
try{window.onFileInput=onFileInput;}catch(e){}
try{window.filterControlTable=filterControlTable;}catch(e){}
try{window.clearControl=clearControl;}catch(e){}
try{window.renderDespachos=renderDespachos;}catch(e){}
try{window.clearDesFilters=clearDesFilters;}catch(e){}
try{window.exportDespachosXL=exportDespachosXL;}catch(e){}
