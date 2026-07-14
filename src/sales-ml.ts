// @ts-nocheck
// ParkaHub — modulo VENTAS ML + ORDENES MANUALES.
// Funciones movidas TAL CUAL desde app.ts. Cero cambio de logica.
import { S } from './state'
import { stLabel } from './util'
import { refreshHeaders, nbadge, toast, confirm2 } from './core-ui'
import { filterHist } from './history'

// --- MANUAL ORDERS -----------------------------------------------------
function openModal(idx=-1){
  S.editIdx=idx;
  document.getElementById('modal-title').textContent=idx>=0?'Editar orden':'Nueva orden manual';
  const o=idx>=0?S.manualOrders[idx]:{};
  document.getElementById('m-id').value=o.orderId||'';
  document.getElementById('m-date').value=o.date||new Date().toISOString().split('T')[0];
  document.getElementById('m-ch').value=o.channel||'';
  document.getElementById('m-st').value=o.status||'paid';
  document.getElementById('m-sku').value=o.sku||'';
  document.getElementById('m-qty').value=o.qty||1;
  document.getElementById('m-prod').value=o.product||'';
  document.getElementById('m-notes').value=o.notes||'';
  document.getElementById('modal').style.display='flex';
}
export function closeModal(){document.getElementById('modal').style.display='none';}
function saveOrder(){
  const id=document.getElementById('m-id').value.trim(),sku=document.getElementById('m-sku').value.trim();
  if(!id||!sku){toast('Completá N. de orden y SKU','error');return;}
  const o={platform:'manual',orderId:id,date:document.getElementById('m-date').value,channel:document.getElementById('m-ch').value.trim(),sku,product:document.getElementById('m-prod').value.trim()||sku,qty:parseInt(document.getElementById('m-qty').value)||1,status:document.getElementById('m-st').value,notes:document.getElementById('m-notes').value.trim()};
  if(S.editIdx>=0)S.manualOrders[S.editIdx]=o;else S.manualOrders.push(o);
  closeModal();filterManual('');refreshHeaders();filterHist();window.renderDespachos?.();
  nbadge('nb-orders',S.manualOrders.length);
  toast(S.editIdx>=0?'Orden actualizada':'Orden guardada','success');
}
function deleteOrder(i){if(!confirm2('delOrder:'+i,'¿Eliminás esta orden?'))return;S.manualOrders.splice(i,1);filterManual('');refreshHeaders();filterHist();window.renderDespachos?.();nbadge('nb-orders',S.manualOrders.length);toast('Orden eliminada','info');}
function filterManual(q){
  S.filteredMan=q?S.manualOrders.filter(o=>[o.orderId,o.sku,o.product,o.channel].some(f=>String(f).toLowerCase().includes(q.toLowerCase()))):S.manualOrders;
  const e=document.getElementById('manual-empty'),t=document.getElementById('manual-table'),osb=document.getElementById('osumbar');
  if(!S.filteredMan.length){if(e)e.style.display='';if(t)t.style.display='none';if(osb)osb.style.display='none';return;}
  if(e)e.style.display='none';if(t)t.style.display='table';
  if(osb)osb.style.display='flex';
  var osn=document.getElementById('osum-n'); if(osn)osn.textContent=S.filteredMan.length;
  var osu=document.getElementById('osum-u'); if(osu)osu.textContent=S.filteredMan.reduce((s,o)=>s+o.qty,0);
  document.getElementById('manual-tbody').innerHTML=S.filteredMan.map(o=>{const ri=S.manualOrders.indexOf(o);return`<tr><td><span class="oid-cell">#${o.orderId}</span></td><td><span class="date-cell">${new Date(o.date).toLocaleDateString('es-AR')}</span></td><td><span class="sku-cell">${o.sku}</span></td><td><span class="product-cell" title="${o.product}">${o.product}</span></td><td><span class="qty-cell">${o.qty}</span></td><td>${o.channel?`<span class="badge manual">${o.channel}</span>`:'--'}</td><td><span class="badge ${o.status}">${stLabel(o.status)}</span></td><td style="font-size:12px;color:var(--text-soft);max-width:130px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${o.notes||'--'}</td><td><div style="display:flex;gap:3px"><button class="btn-ghost btn-sm" onclick="openModal(${ri})">✏️</button><button class="btn-ghost btn-sm" onclick="deleteOrder(${ri})">🗑</button></div></td></tr>`;}).join('');
}
function exportManualXL(){if(!S.manualOrders.length){toast('No hay órdenes manuales','error');return;}const wb=XLSX.utils.book_new();const ws=XLSX.utils.aoa_to_sheet([['N. Orden','Fecha','SKU','Producto','Cant.','Canal','Estado','Notas'],...S.manualOrders.map(o=>[o.orderId,o.date,o.sku,o.product,o.qty,o.channel,stLabel(o.status),o.notes])]);ws['!cols']=[14,12,18,34,8,16,12,28].map(w=>({wch:w}));XLSX.utils.book_append_sheet(wb,ws,'Órdenes Manuales');XLSX.writeFile(wb,`PARKA_Manual_${new Date().toISOString().slice(0,10)}.xlsx`);toast('Excel exportado','success');}


/* (removido) Ventas ML legacy (vmlLoad/vmlFilter/vmlSetWeek/vmlExpandAll/vmlCollapseAll/vmlToggle/vmlBuild):
   escribían en #vml-tbl/#vml-count/#ventas-ml-data que no existen en el HTML actual. La tabla de Ventas
   ML viva la renderiza vmlRender2 en ./history (#vml-tbody2/#vml-thead2). Sin callers tras sacar el import en app.ts. */


// --- window-expose: handlers cableados desde el HTML ---
try{window.openModal=openModal;}catch(e){}
try{window.closeModal=closeModal;}catch(e){}
try{window.saveOrder=saveOrder;}catch(e){}
try{window.deleteOrder=deleteOrder;}catch(e){}
try{window.filterManual=filterManual;}catch(e){}
try{window.exportManualXL=exportManualXL;}catch(e){}
