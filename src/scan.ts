// @ts-nocheck
// ParkaHub — Scanner module (paso "scan" de la modularizacion).
// Funciones movidas TAL CUAL desde app.ts. Cero cambio de logica.
import { S } from './state'
import { skuBase } from './util'
import { toast, confirm2 } from './core-ui'

// --- SCANNER -----------------------------------------------------------

function processScan(raw){
  const sku = String(raw||'').trim();
  if(!sku) return;

  // Debounce: ignore duplicate scans within 2s (camera fires multiple times)
  const now = Date.now();
  if(S.scanLog.length && S.scanLog[0].sku===sku && now-S.lastScanTime<2000) return;
  S.lastScanTime = now;

  const timeStr = new Date().toLocaleTimeString('es-AR',{hour:'2-digit',minute:'2-digit',second:'2-digit'});
  const allOrders = [...(S.xlImported||[]), ...(S.platOrders||[]), ...(S.manualOrders||[])];
  const matches = allOrders.filter(o => o.sku && o.sku.toUpperCase()===sku.toUpperCase());

  let type, icon, detail;
  if(matches.length > 0){
    const totalQty = matches.reduce((s,o)=>s+o.qty,0);
    const orderIds = [...new Set(matches.map(o=>o.orderId))];
    type='ok'; icon='✓';
    detail = totalQty+' unid. · '+orderIds.length+' orden'+(orderIds.length>1?'es':'')+' · '+orderIds.slice(0,2).join(', ')+(orderIds.length>2?'…':'');
  } else {
    const base = skuBase(sku);
    const partials = allOrders.filter(o => o.sku && skuBase(o.sku).toUpperCase()===base.toUpperCase());
    if(partials.length){
      type='warn'; icon='⚠';
      detail='SKU base encontrado -- talles: '+[...new Set(partials.map(o=>o.sku))].join(', ');
    } else {
      type='err'; icon='✕';
      detail='No encontrado en las órdenes cargadas';
    }
  }

  const entry={sku,type,icon,detail,time:timeStr};
  S.scanLog.unshift(entry);

  document.getElementById('sc-total').textContent = S.scanLog.length;
  document.getElementById('sc-ok').textContent    = S.scanLog.filter(e=>e.type==='ok').length;
  document.getElementById('sc-warn').textContent  = S.scanLog.filter(e=>e.type!=='ok').length;

  document.getElementById('scan-log').innerHTML = S.scanLog.map(e=>`
    <div class="scan-item ${e.type}">
      <span class="scan-icon">${e.icon}</span>
      <div style="flex:1;min-width:0">
        <div class="scan-sku">${e.sku}</div>
        <div class="scan-detail">${e.detail}</div>
      </div>
      <span class="scan-time">${e.time}</span>
    </div>`).join('');

  // Flash feedback on camera overlay
  const overlay=document.getElementById('scan-status-overlay');
  if(overlay){
    overlay.textContent = type==='ok'?'✓ '+sku : type==='warn'?'⚠ '+sku : '✕ No encontrado';
    overlay.style.color = type==='ok'?'#34D399':type==='warn'?'#FB923C':'#F87171';
    setTimeout(()=>{ if(overlay){overlay.textContent='Apuntá al código de barras';overlay.style.color='rgba(255,255,255,0.7)';} },1800);
  }

  // Vibrate on mobile
  if(navigator.vibrate) navigator.vibrate(type==='ok'?[80]:type==='warn'?[80,60,80]:[200]);

  // Flash input border
  const inp=document.getElementById('scan-input');
  if(inp){ inp.style.borderColor=type==='ok'?'var(--green)':type==='warn'?'var(--orange)':'var(--red)'; setTimeout(()=>{inp.style.borderColor='';},800); }
}

async function toggleCamera(){
  if(S.cameraActive){ stopCamera(); return; }

  const btn=document.getElementById('btn-camera');
  const wrap=document.getElementById('camera-wrap');

  // Check browser support
  if(!navigator.mediaDevices||!navigator.mediaDevices.getUserMedia){
    toast('Tu navegador no soporta acceso a la cámara. Usá Chrome o Safari.','error'); return;
  }

  btn.textContent='Iniciando cámara...';
  btn.disabled=true;

  try{
    // Load ZXing lazily
    if(!window.ZXing){
      toast('Cargando librería de escaneo...','info');
      await new Promise((res,rej)=>{
        const s=document.createElement('script');
        s.src='https://unpkg.com/@zxing/library@0.18.6/umd/index.min.js';
        s.onload=res; s.onerror=rej;
        document.head.appendChild(s);
      });
    }

    S.codeReader = new window.ZXing.BrowserMultiFormatReader();

    // Get back camera (environment)
    const devices = await S.codeReader.listVideoInputDevices();
    const backCam = devices.find(d=>d.label.toLowerCase().includes('back')||d.label.toLowerCase().includes('rear')||d.label.toLowerCase().includes('environment')) || devices[devices.length-1];
    const deviceId = backCam ? backCam.deviceId : undefined;

    wrap.style.display='block';
    S.cameraActive=true;

    btn.innerHTML='<svg width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg> Detener cámara';
    btn.disabled=false;
    btn.style.background='var(--red)';

    await S.codeReader.decodeFromVideoDevice(deviceId, 'scan-video', (result,err)=>{
      if(result){
        const text=result.getText();
        processScan(text);
      }
    });

  }catch(e){
    S.cameraActive=false;
    wrap.style.display='none';
    btn.disabled=false;
    btn.innerHTML='<svg width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path d="M23 19a2 2 0 01-2 2H3a2 2 0 01-2-2V8a2 2 0 012-2h4l2-3h6l2 3h4a2 2 0 012 2z"/><circle cx="12" cy="13" r="4"/></svg> Activar cámara';
    btn.style.background='';

    if(e.name==='NotAllowedError'||e.name==='PermissionDeniedError'){
      toast('Permiso de cámara denegado. Habilitalo en la configuración del navegador.','error');
    } else if(e.name==='NotFoundError'||e.name==='DevicesNotFoundError'){
      toast('No se encontró cámara en este dispositivo.','error');
    } else {
      toast('Error al iniciar la cámara: '+e.message,'error');
    }
  }
}

function stopCamera(){
  if(S.codeReader){ try{ S.codeReader.reset(); }catch(e){} S.codeReader=null; }
  S.cameraActive=false;
  const wrap=document.getElementById('camera-wrap');
  if(wrap) wrap.style.display='none';
  const btn=document.getElementById('btn-camera');
  if(btn){
    btn.innerHTML='<svg width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path d="M23 19a2 2 0 01-2 2H3a2 2 0 01-2-2V8a2 2 0 012-2h4l2-3h6l2 3h4a2 2 0 012 2z"/><circle cx="12" cy="13" r="4"/></svg> Activar cámara';
    btn.disabled=false; btn.style.background='';
  }
  // Stop video tracks
  const video=document.getElementById('scan-video');
  if(video&&video.srcObject){ video.srcObject.getTracks().forEach(t=>t.stop()); video.srcObject=null; }
}

function clearScan(){
  if(!S.scanLog.length) return;
  if(!confirm2('clearScan','¿Limpiar el registro del escáner?')) return;
  stopCamera();
  S.scanLog=[];
  document.getElementById('sc-total').textContent=0;
  document.getElementById('sc-ok').textContent=0;
  document.getElementById('sc-warn').textContent=0;
  document.getElementById('scan-log').innerHTML='<div style="text-align:center;padding:20px;color:var(--text-muted);font-size:12px">Activá la cámara o escribí el SKU para empezar</div>';
}

function exportScanXL(){
  if(!S.scanLog.length){ toast('No hay registros de escaneo','error'); return; }

  const today = new Date().toLocaleDateString('es-AR',{day:'numeric',month:'long',year:'numeric'});
  const C = {
    black:'0D0D0D', surface:'141414', surface2:'1C1C1C', surface3:'222222',
    gold:'E8C547', goldDim:'2A2510',
    white:'F0F0F0', soft:'A0A0A0', muted:'5A5A5A',
    green:'166534', greenBg:'F0FDF4', greenBorder:'BBF7D0', greenText:'15803D',
    orange:'9A3412', orangeBg:'FFFBEB', orangeBorder:'FDE68A', orangeText:'B45309',
    red:'991B1B',   redBg:'FEF2F2',   redBorder:'FECACA',   redText:'DC2626',
  };

  function c(v, opts={}){
    const isDark = opts.dark;
    return {
      v, t: typeof v==='number'?'n':'s',
      s:{
        fill:{ fgColor:{ rgb: opts.bg || (isDark?C.surface:C.white) }, patternType:'solid' },
        font:{ name:'Calibri', sz:opts.sz||11, bold:!!opts.bold,
               color:{ rgb: opts.color || (isDark?C.white:'1F2937') }, italic:!!opts.italic },
        alignment:{ horizontal:opts.align||'left', vertical:'center', wrapText:!!opts.wrap },
        border:{
          top:   { style:'thin', color:{ rgb: isDark?C.surface2:'E0E0E0' }},
          bottom:{ style:'thin', color:{ rgb: isDark?C.surface2:'E0E0E0' }},
          left:  { style:'thin', color:{ rgb: isDark?C.surface2:'E0E0E0' }},
          right: { style:'thin', color:{ rgb: isDark?C.surface2:'E0E0E0' }},
        }
      }
    };
  }

  // -- HOJA 1: Registro del escáner -----------------------------
  const ws1 = {}; let R = 0;
  const s = (col,row,cell) => { ws1[XLSX.utils.encode_cell({r:row,c:col})] = cell; };

  // Título
  s(0,R, c('PARKA.',      {bg:C.black, color:C.gold,  sz:16, bold:true,  dark:true}));
  s(1,R, c('',            {bg:C.black, dark:true}));
  s(2,R, c('REGISTRO DE ESCANEO -- CONTROL DE DESPACHO', {bg:C.black, color:C.white, sz:12, bold:true, dark:true}));
  s(3,R, c('Fecha: '+today, {bg:C.black, color:C.muted, sz:10, align:'right', dark:true})); R++;

  // Vacía
  for(let col=0;col<4;col++) s(col,R, c('',{bg:C.black,dark:true})); R++;

  // Stats resumen
  const nOk   = S.scanLog.filter(e=>e.type==='ok').length;
  const nWarn = S.scanLog.filter(e=>e.type==='warn').length;
  const nErr  = S.scanLog.filter(e=>e.type==='err').length;
  const statBgs   = [C.greenBg,  C.orangeBg, C.redBg,   'F8F9FA'];
  const statColors= [C.greenText, C.orangeText,C.redText, '374151'];
  const statLabels= ['✓ ENCONTRADOS','⚠ PARCIALES','✕ NO ENCONTRADOS','TOTAL'];
  const statVals  = [nOk, nWarn, nErr, S.scanLog.length];
  for(let col=0;col<4;col++) s(col,R, c(statLabels[col], {bg:statBgs[col], color:statColors[col], sz:9, bold:true, align:'center'})); R++;
  for(let col=0;col<4;col++) s(col,R, c(statVals[col],   {bg:statBgs[col], color:statColors[col], sz:20, bold:true, align:'center'})); R++;

  // Vacía
  for(let col=0;col<4;col++) s(col,R, c('',{bg:'F8F9FA'})); R++;

  // Headers tabla
  const hdrs = ['SKU','ESTADO','DETALLE','HORA'];
  const hAligns = ['left','center','left','center'];
  for(let col=0;col<4;col++){
    s(col,R, c(hdrs[col], {bg:C.surface2, color:C.muted, sz:9, bold:true, align:hAligns[col], dark:true}));
  } R++;

  // Filas de datos
  for(let i=0;i<S.scanLog.length;i++){
    const e  = S.scanLog[i];
    const ev = i%2===0;
    const typeBg    = e.type==='ok'?C.greenBg  : e.type==='warn'?C.orangeBg  : C.redBg;
    const typeColor = e.type==='ok'?C.greenText : e.type==='warn'?C.orangeText: C.redText;
    const rowBg     = ev ? 'FFFFFF' : 'F8F9FA';
    const label     = e.type==='ok'?'Encontrado' : e.type==='warn'?'Parcial' : 'No encontrado';

    s(0,R, c(e.sku,  {bg:rowBg, color:'1F2937', sz:11, bold:true}));
    s(1,R, c(label,  {bg:typeBg, color:typeColor, sz:11, bold:true, align:'center'}));
    s(2,R, c(e.detail,{bg:rowBg, color:'6B7280', sz:10, wrap:true}));
    s(3,R, c(e.time, {bg:rowBg, color:'9CA3AF', sz:10, align:'center'}));
    R++;
  }

  // Footer
  for(let col=0;col<4;col++) s(col,R, c('',{bg:'F8F9FA'})); R++;
  s(0,R, c('PARKA. Sales Hub',{bg:'F8F9FA', color:'9CA3AF', sz:9, italic:true}));
  s(1,R, c('',{bg:'F8F9FA'})); s(2,R, c('',{bg:'F8F9FA'}));
  s(3,R, c('Generado el '+today,{bg:'F8F9FA', color:'9CA3AF', sz:9, align:'right', italic:true})); R++;

  ws1['!ref']  = XLSX.utils.encode_range({s:{r:0,c:0},e:{r:R-1,c:3}});
  ws1['!cols'] = [{wch:22},{wch:14},{wch:48},{wch:10}];
  ws1['!rows'] = Array.from({length:R},(_,i)=>{
    if(i===0) return {hpt:26};
    if(i===3) return {hpt:28};
    return {hpt:20};
  });

  // -- HOJA 2: Resumen por SKU -----------------------------------
  const skuMap = {};
  for(const e of S.scanLog){
    if(!skuMap[e.sku]) skuMap[e.sku]={sku:e.sku, count:0, ok:0, warn:0, err:0, lastTime:e.time};
    skuMap[e.sku].count++;
    skuMap[e.sku][e.type]++;
    skuMap[e.sku].lastTime = e.time;
  }
  const skuRows = Object.values(skuMap).sort((a,b)=>b.count-a.count);

  const ws2 = {}; let R2 = 0;
  const s2 = (col,row,cell) => { ws2[XLSX.utils.encode_cell({r:row,c:col})] = cell; };

  // Título
  s2(0,R2, c('PARKA.',{bg:C.black,color:C.gold,sz:14,bold:true,dark:true}));
  s2(1,R2, c('',{bg:C.black,dark:true}));
  s2(2,R2, c('RESUMEN POR SKU -- ESCANEO',{bg:C.black,color:C.white,sz:12,bold:true,dark:true}));
  s2(3,R2, c('',{bg:C.black,dark:true}));
  s2(4,R2, c('Fecha: '+today,{bg:C.black,color:C.muted,sz:10,align:'right',dark:true})); R2++;
  for(let col=0;col<5;col++) s2(col,R2,c('',{bg:C.black,dark:true})); R2++;

  // Headers
  const h2 = ['SKU','TOTAL ESCANEOS','✓ ENCONTRADO','⚠ PARCIAL','ÚLTIMA VEZ'];
  for(let col=0;col<5;col++) s2(col,R2, c(h2[col],{bg:C.surface2,color:C.muted,sz:9,bold:true,align:'center',dark:true})); R2++;

  for(let i=0;i<skuRows.length;i++){
    const r  = skuRows[i];
    const bg = i%2===0?'FFFFFF':'F8F9FA';
    s2(0,R2, c(r.sku,   {bg, color:'1F2937', sz:11, bold:true}));
    s2(1,R2, c(r.count, {bg, color:'1F2937', sz:13, bold:true, align:'center'}));
    s2(2,R2, c(r.ok,    {bg: r.ok>0?C.greenBg:bg,  color:r.ok>0?C.greenText:'9CA3AF', sz:12, bold:true, align:'center'}));
    s2(3,R2, c(r.warn+r.err, {bg: (r.warn+r.err)>0?C.orangeBg:bg, color:(r.warn+r.err)>0?C.orangeText:'9CA3AF', sz:12, bold:true, align:'center'}));
    s2(4,R2, c(r.lastTime, {bg, color:'9CA3AF', sz:10, align:'center'}));
    R2++;
  }

  ws2['!ref']  = XLSX.utils.encode_range({s:{r:0,c:0},e:{r:R2-1,c:4}});
  ws2['!cols'] = [{wch:22},{wch:16},{wch:14},{wch:12},{wch:12}];
  ws2['!rows'] = Array.from({length:R2},(_,i)=> i===0?{hpt:24}:{hpt:20});

  // -- Generar archivo --------------------------------------------
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws1, 'Registro Escaneo');
  XLSX.utils.book_append_sheet(wb, ws2, 'Resumen por SKU');
  const fname2 = `PARKA_Escaneo_${new Date().toISOString().slice(0,10)}.xlsx`;
  XLSX.writeFile(wb, fname2);
  toast('Registro exportado con formato PARKA','success');
}

try{window.processScan=processScan;}catch(e){}
try{window.clearScan=clearScan;}catch(e){}
try{window.exportScanXL=exportScanXL;}catch(e){}
