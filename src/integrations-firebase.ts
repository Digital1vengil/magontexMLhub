// @ts-nocheck
// ParkaHub — integrations: Config (ML/TN tokens) + Tienda Nube CSV import.
// (Las capas Firebase RTDB / JSONBin / Share se retiraron — la persistencia
//  vive en Cloudflare D1 via el Worker; ver src/api.ts + bootstrapState.)
// Funciones movidas TAL CUAL desde app.ts.
import { S } from './state'
import { toast } from './core-ui'

// --- CFG: sección "Configuración" eliminada (2026-07). Guardaba tokens ML/TN en el navegador que
//     NO se usaban — la carga real va por el Worker (token server-side en KV) + Cloudflare Access. ---

function onTNDrop(e){
  e.preventDefault();
  document.getElementById('tn-dz').classList.remove('drag-over');
  var f = [...e.dataTransfer.files].find(function(f){ return /\.csv$/i.test(f.name); });
  if(f) parseTNFile(f); else toast('Solo archivos .csv de Tienda Nube','error');
}
function onTNInput(e){
  if(e.target.files[0]) parseTNFile(e.target.files[0]);
  e.target.value='';
}

function parseTNFile(file){
  var ld = document.getElementById('tn-load');
  ld.style.display = 'flex';
  var rd = new FileReader();
  rd.onload = function(e){
    try{
      var text = e.target.result;
      // TN usa ; como separador y encoding latin-1
      var lines = text.split('\n').filter(function(l){ return l.trim(); });
      if(!lines.length) throw new Error('CSV vacío');

      // Parsear CSV respetando comillas
      function parseCSVLine(line){
        var cols = [], cur = '', inQ = false;
        for(var i=0;i<line.length;i++){
          var c=line[i];
          if(c==='"'){ inQ=!inQ; }
          else if(c===';'&&!inQ){ cols.push(cur.trim()); cur=''; }
          else cur+=c;
        }
        cols.push(cur.trim());
        return cols;
      }

      var headers = parseCSVLine(lines[0]);
      function ci(name){
        var nl = name.toLowerCase();
        var exact = headers.findIndex(function(h){ return h.toLowerCase()===nl; });
        if(exact>=0) return exact;
        return headers.findIndex(function(h){ return h.toLowerCase().includes(nl); });
      }

      var cId    = ci('Número de orden');
      var cFecha = ci('Fecha');
      var cComp  = ci('Nombre del comprador');
      var cSKU   = ci('SKU');
      var cQty   = ci('Cantidad del producto');
      var cTotal = ci('Total');
      var cEnvio = ci('Medio de envío');
      var cEstado= ci('Estado de la orden');

      if(cSKU<0) throw new Error('No se encontró columna SKU en el CSV');

      S.TN_DATA = [];
      for(var r=1;r<lines.length;r++){
        var row = parseCSVLine(lines[r]);
        var sku = (row[cSKU]||'').replace(/^="/,'').replace(/"$/,'').trim();
        if(!sku||sku==='-') continue;
        var orderId = (row[cId]||'').trim();
        var fecha   = (row[cFecha]||'').trim();
        var buyer   = (row[cComp]||'').trim();
        var qty     = parseInt(row[cQty])||1;
        var total   = parseFloat((row[cTotal]||'0').replace(',','.').replace(/[^\d.]/g,''))||0;
        var envio   = (row[cEnvio]||'').trim();
        var estado  = (row[cEstado]||'').trim().toLowerCase();

        // Parsear fecha dd/mm/yyyy hh:mm:ss
        var dateISO = new Date().toISOString().slice(0,10);
        var dm = fecha.match(/(\d{2})\/(\d{2})\/(\d{4})/);
        if(dm) dateISO = dm[3]+'-'+dm[2]+'-'+dm[1];

        // Clasificar carrier
        var carrier = 'tn';
        var env = envio.toLowerCase();
        if(env.includes('flex')) carrier='flex';
        else if(env.includes('colect')) carrier='colecta';
        else if(env.includes('oca')||env.includes('andreani')||env.includes('correo')) carrier='correo';
        else if(env.includes('pickit')||env.includes('hop')||env.includes('punto')) carrier='punto';

        var status = estado.includes('cancel') ? 'cancelled' : 'paid';

        S.TN_DATA.push({
          platform:'tn', orderId:'TN-'+orderId,
          date: dateISO+'T12:00:00',
          sku: sku, qty: qty, product: sku,
          status: status, total: total, canal:'Tienda Nube',
          carrier: carrier, buyer: buyer, envio: envio
        });
      }

      if(!S.TN_DATA.length) throw new Error('No se encontraron órdenes válidas en el CSV');

      // Actualizar badge TN
      var totalUnits = S.TN_DATA.reduce(function(s,o){return s+o.qty;},0);
      var tnBadge = document.getElementById('tn-badge');
      var tnInfo  = document.getElementById('tn-loaded-info');
      if(tnBadge){ tnBadge.style.display=''; tnBadge.textContent=S.TN_DATA.length+' órdenes'; }
      if(tnInfo) { tnInfo.style.display=''; tnInfo.textContent='✓ '+S.TN_DATA.length+' órdenes · '+totalUnits+' uds cargadas — ahora podés verlas en la tabla unificada'; }
      // Fusionar automáticamente con ML
      window.tnMergeWithML?.();
      toast('✓ '+S.TN_DATA.length+' órdenes de Tienda Nube agregadas','success');
    }catch(err){ toast('Error: '+err.message,'error'); console.error(err); }
    ld.style.display='none';
  };
  rd.onerror = function(){ toast('No se pudo leer el archivo','error'); ld.style.display='none'; };
  // 'iso-8859-1' es la etiqueta de encoding reconocida por los navegadores (WHATWG Encoding
  // Standard); 'latin-1' NO está en la lista de labels válidos y hace que el navegador ignore
  // el encoding pedido y decodifique como UTF-8 -> tildes rotas en los headers (Número, envío, etc.)
  // y falla el matcheo de columnas.
  rd.readAsText(file, 'iso-8859-1');
}

export { onTNDrop, onTNInput, parseTNFile }

// --- window-expose: handlers cableados desde el HTML ---
try{window.onTNDrop=onTNDrop;}catch(e){}
try{window.onTNInput=onTNInput;}catch(e){}
