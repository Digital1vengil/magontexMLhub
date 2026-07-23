// @ts-nocheck
// ParkaHub — integrations: Google Drive connector (exports de xlsx que descarga
// el empleado). La capa de Google-Sheets-sync se retiró (redundante con D1).
// Funciones movidas TAL CUAL desde app.ts.
import { S } from './state'
import { toast, uiPrompt } from './core-ui'
import { stLabel } from './util'

async function gdSaveManualToDrive(){
  if(!S.manualOrders.length){ toast('No hay órdenes manuales para subir','error'); return; }
  if(!S.GD.token){ toast('Conectate a Google Drive primero en Configuración','error'); return; }
  toast('Subiendo órdenes manuales a Drive...','info');
  const wb=XLSX.utils.book_new();
  const ws=XLSX.utils.aoa_to_sheet([['N. Orden','Fecha','SKU','Producto','Cant.','Canal','Estado','Notas'],...S.manualOrders.map(o=>[o.orderId,o.date,o.sku,o.product,o.qty,o.channel,stLabel(o.status),o.notes])]);
  ws['!cols']=[14,12,18,34,8,16,12,28].map(w=>({wch:w}));
  XLSX.utils.book_append_sheet(wb,ws,'Órdenes Manuales');
  const fname=`PARKA_Manual_${new Date().toISOString().slice(0,10)}.xlsx`;
  const wbout=XLSX.write(wb,{bookType:'xlsx',type:'array'});
  const blob=new Blob([wbout],{type:'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'});
  await gdUploadFile(blob, fname, 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
}

// Fin de día: sube el reporte de "Cargar órdenes" a Drive SEPARADO por transportista —
// las órdenes Flex a la carpeta Flex y el resto (Colecta/Correo/Punto) a la carpeta Colecta,
// cada una en la subcarpeta del día de hoy. Antes esto subía TODO a una única carpeta genérica
// (S.GD.folderId), que quedó apuntando a la carpeta de Flex — por eso los despachos de Colecta
// también terminaban ahí.
function _ordersSheet(orders){
  var wb = XLSX.utils.book_new();
  var ws = XLSX.utils.aoa_to_sheet([
    ['N. Orden','Fecha','SKU','Producto','Cantidad','Canal','Estado','Carrier'],
    ...orders.map(function(o){
      return [o.orderId, new Date(o.date).toLocaleDateString('es-AR'), o.sku, o.product||'', o.qty, o.canal||'ML', o.status, o.carrier||''];
    })
  ]);
  ws['!cols'] = [14,12,20,36,8,14,12,12].map(function(w){return{wch:w};});
  XLSX.utils.book_append_sheet(wb, ws, 'Ordenes');
  return wb;
}

async function gdSaveOrdersToDrive(){
  if(!S.xlImported.length){ toast('No hay órdenes para subir','error'); return; }
  if(!S.GD.token){ toast('Conectate a Google Drive primero','error'); return; }
  var btn = document.getElementById('btn-save-drive-orders');
  if(btn){ btn.textContent='⏳ Subiendo...'; btn.disabled=true; }
  try{
    var today = new Date().toISOString().slice(0,10);
    var flexOrders    = S.xlImported.filter(function(o){ return o.carrier==='flex'; });
    var colectaOrders = S.xlImported.filter(function(o){ return o.carrier!=='flex'; }); // colecta/correo/punto/sin clasificar

    var subidas = [];
    if(flexOrders.length){
      var wbF = _ordersSheet(flexOrders);
      var wboutF = XLSX.write(wbF, {bookType:'xlsx', type:'array'});
      var blobF = new Blob([wboutF], {type:'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'});
      var folderF = await gdGetOrCreateDayFolder('flex');
      var okF = await gdUploadFile(blobF, 'PARKA_Ordenes_Flex_'+today+'.xlsx', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', folderF);
      if(okF) subidas.push('Flex ('+flexOrders.length+')');
    }
    if(colectaOrders.length){
      var wbC = _ordersSheet(colectaOrders);
      var wboutC = XLSX.write(wbC, {bookType:'xlsx', type:'array'});
      var blobC = new Blob([wboutC], {type:'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'});
      var folderC = await gdGetOrCreateDayFolder('colecta');
      var okC = await gdUploadFile(blobC, 'PARKA_Ordenes_Colecta_'+today+'.xlsx', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', folderC);
      if(okC) subidas.push('Colecta ('+colectaOrders.length+')');
    }

    // gdUploadFile ya tira un toast de éxito por cada archivo subido (con la carpeta/nombre real).
    if(subidas.length && btn){ btn.innerHTML='✓ Guardado en Drive'; btn.style.background='#D1FAE5'; btn.style.color='#065F46'; }
  }catch(e){ toast('Error: '+e.message,'error'); }
  if(btn) btn.disabled=false;
}

async function gdSaveControlToDrive(){
  if(!window._lastControlWb){ toast('Generá el reporte primero','error'); return; }
  if(!S.GD.token){ toast('Conectate a Google Drive primero en Configuración','error'); return; }
  var btns = ['btn-save-drive-ctrl','btn-save-drive-rep'].map(function(id){ return document.getElementById(id); }).filter(Boolean);
  btns.forEach(function(b){ b.textContent='⏳ Subiendo...'; b.disabled=true; });
  try{
    var wbout = XLSX.write(window._lastControlWb, {bookType:'xlsx', type:'array'});
    var blob  = new Blob([wbout], {type:'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'});
    var link  = await gdUploadFile(blob, window._lastControlName, 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    if(link){
      btns.forEach(function(b){ b.innerHTML='✓ Guardado en Drive'; b.style.background='#D1FAE5'; b.style.color='#065F46'; });
    }
  }catch(e){
    toast('Error al subir: '+e.message,'error');
  }
  btns.forEach(function(b){ b.disabled=false; });
}

/* ═══════════════════════════════════════════════════════
   GOOGLE DRIVE CONNECTOR
   Usa OAuth2 implicit flow — no backend necesario
═══════════════════════════════════════════════════════ */

// Inicializar estado al cargar
function gdInit(){
  var tok = localStorage.getItem('parka_gd_token');
  var exp = parseInt(localStorage.getItem('parka_gd_token_exp')||'0');
  if(tok && Date.now() < exp){
    S.GD.token = tok;
    gdSetConnected(true);
  }
  if(S.GD.folderId){
    var fn = document.getElementById('gd-folder-name');
    var status = document.getElementById('gd-folder-status');
    var sname  = document.getElementById('gd-folder-status-name');
    var fid = document.getElementById('gd-folder-id');
    if(fn) fn.value = S.GD.folderName;
    if(status && sname){
      sname.textContent = '📁 ' + S.GD.folderName;
      status.style.display = 'flex';
    }
    if(fid) fid.value = S.GD.folderId;
  }
}

function gdSetConnected(ok){
  var dot  = document.getElementById('gd-dot');
  var stat = document.getElementById('gd-status');
  var con  = document.getElementById('gd-connect-btn');
  var dis  = document.getElementById('gd-disconnect-btn');
  if(!dot) return;
  if(ok){
    dot.style.background  = 'var(--green)';
    stat.textContent      = 'Conectado';
    stat.style.color      = 'var(--green)';
    con.style.display     = 'none';
    dis.style.display     = '';
  } else {
    dot.style.background  = 'var(--text-muted)';
    stat.textContent      = 'Sin conectar';
    stat.style.color      = '';
    con.style.display     = '';
    dis.style.display     = 'none';
  }
}

async function gdConnect(){
  // Usar el cliente OAuth de Google con implicit flow
  // El usuario debe tener un Client ID configurado, o usamos el flujo de popup
  var CLIENT_ID = localStorage.getItem('parka_gd_client_id') || '';
  if(!CLIENT_ID){
    // Modal in-page para el Client ID (prompt() del navegador queda suprimido en el Chrome de Martin)
    var v = await uiPrompt('Conectar Google Drive', [
      {key:'cid', label:'Google OAuth Client ID (console.cloud.google.com → APIs → Credenciales)', placeholder:'xxxx.apps.googleusercontent.com'}
    ], 'Conectar');
    if(!v || !v.cid || !v.cid.trim()){ toast('Cancelado','info'); return; }
    CLIENT_ID = v.cid.trim();
    localStorage.setItem('parka_gd_client_id', CLIENT_ID);
  }

  var REDIRECT = window.location.origin + window.location.pathname;
  var url = 'https://accounts.google.com/o/oauth2/v2/auth'
    + '?client_id=' + encodeURIComponent(CLIENT_ID)
    + '&redirect_uri=' + encodeURIComponent(REDIRECT)
    + '&response_type=token'
    + '&scope=' + encodeURIComponent(S.GD.SCOPES)
    + '&prompt=consent';

  // Abrir en popup
  var w = 520, h = 620;
  var left = window.screenX + (window.outerWidth - w) / 2;
  var top  = window.screenY + (window.outerHeight - h) / 2;
  var popup = window.open(url, 'gdauth', 'width='+w+',height='+h+',left='+left+',top='+top);

  // Escuchar el token del redirect
  var timer = setInterval(function(){
    try {
      var hash = popup.location.hash;
      if(hash && hash.includes('access_token')){
        clearInterval(timer);
        popup.close();
        var params = new URLSearchParams(hash.slice(1));
        var tok    = params.get('access_token');
        var expIn  = parseInt(params.get('expires_in')||'3600') * 1000;
        S.GD.token   = tok;
        localStorage.setItem('parka_gd_token', tok);
        localStorage.setItem('parka_gd_token_exp', String(Date.now() + expIn));
        gdSetConnected(true);
        toast('✓ Google Drive conectado','success');
      }
    } catch(e){ /* cross-origin, ignorar */ }
    if(popup.closed){ clearInterval(timer); }
  }, 500);
}

function gdDisconnect(){
  S.GD.token = null;
  localStorage.removeItem('parka_gd_token');
  localStorage.removeItem('parka_gd_token_exp');
  gdSetConnected(false);
  toast('Google Drive desconectado','info');
}

// Buscar carpetas en Drive
function gdPickFolder(){
  if(!S.GD.token){ toast('Conectá Google Drive primero','error'); return; }
  var qEl = document.getElementById('gd-folder-name');
  if(!qEl) return;
  var q = qEl.value.trim();
  if(!q){ toast('Escribí el nombre de la carpeta a buscar','error'); return; }

  fetch('https://www.googleapis.com/drive/v3/files?q='
    + encodeURIComponent("mimeType='application/vnd.google-apps.folder' and name contains '"+q.replace(/'/g,"\\'")+"' and trashed=false")
    + '&fields=files(id,name,parents)&pageSize=20',
    { headers:{ Authorization:'Bearer '+S.GD.token } })
    .then(function(r){ return r.json(); })
    .then(function(data){
      var list  = document.getElementById('gd-folder-list');
      var res   = document.getElementById('gd-folder-results');
      if(!list || !res) return;
      if(!data.files || !data.files.length){
        res.innerHTML = '<div style="font-size:12px;color:var(--text-muted);padding:8px">No se encontraron carpetas con ese nombre. ¿Querés crearla?</div>'
          + '<button class="btn btn-primary btn-sm" onclick="gdCreateFolder(\''+q+'\')" style="margin-top:6px">+ Crear "'+q+'"</button>';
        list.style.display = '';
        return;
      }
      res.innerHTML = data.files.map(function(f){
        return '<div onclick="gdSelectFolder(\''+f.id+'\',\''+f.name.replace(/'/g,"\\'")+'\')" style="padding:8px 12px;border-radius:6px;cursor:pointer;font-size:12px;display:flex;align-items:center;gap:8px;background:var(--surface2);border:1px solid var(--border);transition:.12s" onmouseover="this.style.borderColor=\'var(--accent)\'" onmouseout="this.style.borderColor=\'var(--border)\'">'
          +'<svg width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path d="M22 19a2 2 0 01-2 2H4a2 2 0 01-2-2V5a2 2 0 012-2h5l2 3h9a2 2 0 012 2z"/></svg>'
          +'<span style="font-weight:600">'+f.name+'</span>'
          +'<span style="color:var(--text-muted);margin-left:auto;font-size:10px">'+f.id.slice(0,10)+'...</span>'
          +'</div>';
      }).join('');
      list.style.display = '';
    })
    .catch(function(e){ toast('Error buscando carpetas: '+e.message,'error'); });
}

function gdSelectFolder(id, name){
  S.GD.folderId   = id;
  S.GD.folderName = name;
  localStorage.setItem('parka_gd_folder_id',   id);
  localStorage.setItem('parka_gd_folder_name', name);
  var fid = document.getElementById('gd-folder-id');
  var fname = document.getElementById('gd-folder-name');
  if(fid) fid.value   = id;
  if(fname) fname.value = name;
  // Mostrar estado visual
  var status = document.getElementById('gd-folder-status');
  var sname  = document.getElementById('gd-folder-status-name');
  if(sname) sname.textContent = '📁 ' + name;
  if(status) status.style.display = 'flex';
  var list = document.getElementById('gd-folder-list');
  if(list) list.style.display = 'none';
  toast('✓ Carpeta "'+name+'" seleccionada — los reportes se guardarán ahí','success');
}

function gdOpenFolder(){
  if(!S.GD.folderId){
    // Si no hay carpeta configurada, abrir Drive raíz
    window.open('https://drive.google.com/drive/my-drive', '_blank');
    return;
  }
  window.open('https://drive.google.com/drive/folders/'+S.GD.folderId, '_blank');
}

function gdClearFolder(){
  S.GD.folderId = ''; S.GD.folderName = '';
  localStorage.removeItem('parka_gd_folder_id');
  localStorage.removeItem('parka_gd_folder_name');
  var fid = document.getElementById('gd-folder-id');
  var fname = document.getElementById('gd-folder-name');
  var status = document.getElementById('gd-folder-status');
  if(fid) fid.value   = '';
  if(fname) fname.value = '';
  if(status) status.style.display = 'none';
  toast('Carpeta removida','info');
}

function gdCreateFolder(name){
  if(!S.GD.token){ toast('Conectá Google Drive primero','error'); return; }
  fetch('https://www.googleapis.com/drive/v3/files', {
    method:'POST',
    headers:{ Authorization:'Bearer '+S.GD.token, 'Content-Type':'application/json' },
    body: JSON.stringify({ name:name, mimeType:'application/vnd.google-apps.folder' })
  })
  .then(function(r){ return r.json(); })
  .then(function(f){
    gdSelectFolder(f.id, f.name);
    toast('✓ Carpeta "'+f.name+'" creada en Drive','success');
  })
  .catch(function(e){ toast('Error creando carpeta: '+e.message,'error'); });
}

// Carpetas fijas de Drive para el despacho diario (mismas que usa "Flex de hoy" / "Colecta de
// hoy" en Historial, ver index.html/driveHoy). Acá las usamos para SUBIR el reporte del día a
// la subcarpeta correcta según el transportista, en vez de todo a la carpeta genérica S.GD.folderId.
// IDs por defecto; se pueden sobreescribir desde Sistema → Conexiones (localStorage).
var GD_PARENTS = {
  flex:    localStorage.getItem('parka_gd_flex_id')    || '1dhCrQ7mYCv5HqweRDaF_y4TPPGAPegOl',
  colecta: localStorage.getItem('parka_gd_colecta_id') || '1injla5TUawsfmCYcJsPA83xkoqF3r-Ng'
};

function gdHoy(){
  var d = new Date();
  return d.getFullYear()+'-'+('0'+(d.getMonth()+1)).slice(-2)+'-'+('0'+d.getDate()).slice(-2);
}

// Busca (o crea) la subcarpeta con la fecha de hoy dentro de la carpeta Flex/Colecta.
async function gdGetOrCreateDayFolder(kind){
  var parent = GD_PARENTS[kind];
  if(!parent || !S.GD.token) return null;
  var today = gdHoy();
  try{
    var q = "'"+parent+"' in parents and name='"+today+"' and mimeType='application/vnd.google-apps.folder' and trashed=false";
    var r = await fetch('https://www.googleapis.com/drive/v3/files?fields=files(id,name)&q='+encodeURIComponent(q), { headers:{ Authorization:'Bearer '+S.GD.token } });
    var j = await r.json();
    if(j.files && j.files.length) return j.files[0].id;
    var r2 = await fetch('https://www.googleapis.com/drive/v3/files', {
      method:'POST',
      headers:{ Authorization:'Bearer '+S.GD.token, 'Content-Type':'application/json' },
      body: JSON.stringify({ name:today, mimeType:'application/vnd.google-apps.folder', parents:[parent] })
    });
    var f2 = await r2.json();
    return f2.id || null;
  }catch(e){
    console.warn('gdGetOrCreateDayFolder:', e);
    return null;
  }
}

// Subir archivo Excel a Drive (llamado desde generateControlReport, exportHistXL, gdSaveOrdersToDrive, etc.)
// folderId es opcional: si no se pasa, usa la carpeta genérica configurada (S.GD.folderId).
async function gdUploadFile(blob, filename, mimeType, folderId){
  var targetFolder = folderId || S.GD.folderId;
  if(!S.GD.token || !targetFolder) return false;
  try{
    var meta = JSON.stringify({ name:filename, parents:[targetFolder] });
    var form = new FormData();
    form.append('metadata', new Blob([meta],{type:'application/json'}));
    form.append('file', blob, filename);
    var r = await fetch('https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id,name,webViewLink', {
      method:'POST',
      headers:{ Authorization:'Bearer '+S.GD.token },
      body: form
    });
    if(!r.ok) throw new Error('HTTP '+r.status);
    var f = await r.json();
    toast('✓ Guardado en Drive: '+f.name,'success');
    return f.webViewLink;
  } catch(e){
    toast('Error subiendo a Drive: '+e.message,'error');
    return false;
  }
}

export { gdInit, gdSetConnected, gdConnect, gdDisconnect, gdPickFolder, gdSelectFolder, gdOpenFolder, gdClearFolder, gdCreateFolder, gdUploadFile, gdSaveControlToDrive, gdSaveManualToDrive, gdSaveOrdersToDrive }

// --- window-expose: handlers cableados desde el HTML ---
try{window.gdInit=gdInit;}catch(e){}
try{window.gdConnect=gdConnect;}catch(e){}
try{window.gdDisconnect=gdDisconnect;}catch(e){}
try{window.gdPickFolder=gdPickFolder;}catch(e){}
try{window.gdSelectFolder=gdSelectFolder;}catch(e){}
try{window.gdCreateFolder=gdCreateFolder;}catch(e){}
try{window.gdClearFolder=gdClearFolder;}catch(e){}
try{window.gdOpenFolder=gdOpenFolder;}catch(e){}
try{window.gdSaveControlToDrive=gdSaveControlToDrive;}catch(e){}
try{window.gdSaveOrdersToDrive=gdSaveOrdersToDrive;}catch(e){}
try{window.gdSaveManualToDrive=gdSaveManualToDrive;}catch(e){}
