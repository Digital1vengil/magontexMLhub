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

async function gdSaveOrdersToDrive(){
  if(!S.xlImported.length){ toast('No hay órdenes para subir','error'); return; }
  if(!S.GD.token){ toast('Conectate a Google Drive primero','error'); return; }
  var btn = document.getElementById('btn-save-drive-orders');
  if(btn){ btn.textContent='⏳ Subiendo...'; btn.disabled=true; }
  try{
    var wb = XLSX.utils.book_new();
    var ws = XLSX.utils.aoa_to_sheet([
      ['N. Orden','Fecha','SKU','Producto','Cantidad','Canal','Estado','Carrier'],
      ...S.xlImported.map(function(o){
        return [o.orderId, new Date(o.date).toLocaleDateString('es-AR'), o.sku, o.product||'', o.qty, o.canal||'ML', o.status, o.carrier||''];
      })
    ]);
    ws['!cols'] = [14,12,20,36,8,14,12,12].map(function(w){return{wch:w};});
    XLSX.utils.book_append_sheet(wb, ws, 'Ordenes');
    var fname = 'PARKA_Ordenes_'+new Date().toISOString().slice(0,10)+'.xlsx';
    var wbout = XLSX.write(wb, {bookType:'xlsx', type:'array'});
    var blob  = new Blob([wbout], {type:'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'});
    await gdUploadFile(blob, fname, 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    if(btn){ btn.innerHTML='✓ Guardado en Drive'; btn.style.background='#D1FAE5'; btn.style.color='#065F46'; }
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
    if(fn) fn.value = S.GD.folderName;
    if(status && sname){
      sname.textContent = '📁 ' + S.GD.folderName;
      status.style.display = 'flex';
    }
    document.getElementById('gd-folder-id').value = S.GD.folderId;
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
  var q = document.getElementById('gd-folder-name').value.trim();
  if(!q){ toast('Escribí el nombre de la carpeta a buscar','error'); return; }

  fetch('https://www.googleapis.com/drive/v3/files?q='
    + encodeURIComponent("mimeType='application/vnd.google-apps.folder' and name contains '"+q.replace(/'/g,"\\'")+"' and trashed=false")
    + '&fields=files(id,name,parents)&pageSize=20',
    { headers:{ Authorization:'Bearer '+S.GD.token } })
    .then(function(r){ return r.json(); })
    .then(function(data){
      var list  = document.getElementById('gd-folder-list');
      var res   = document.getElementById('gd-folder-results');
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
  document.getElementById('gd-folder-id').value   = id;
  document.getElementById('gd-folder-name').value = name;
  // Mostrar estado visual
  var status = document.getElementById('gd-folder-status');
  document.getElementById('gd-folder-status-name').textContent = '📁 ' + name;
  status.style.display = 'flex';
  document.getElementById('gd-folder-list').style.display = 'none';
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
  document.getElementById('gd-folder-id').value   = '';
  document.getElementById('gd-folder-name').value = '';
  document.getElementById('gd-folder-status').style.display = 'none';
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

// Subir archivo Excel a Drive (llamado desde generateControlReport y exportHistXL)
async function gdUploadFile(blob, filename, mimeType){
  if(!S.GD.token || !S.GD.folderId) return false;
  try{
    var meta = JSON.stringify({ name:filename, parents:[S.GD.folderId] });
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
