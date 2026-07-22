// @ts-nocheck
// ParkaHub — módulo MAPEO (mapeo de depósito por sector).
// Sembrado desde "Mapeo_Deposito.xlsx". Editable (localStorage). Expone:
//  - window.mapeoRender / mapeoToggle / mapeoAddArt / mapeoDelArt / mapeoEditArt
//    / mapeoAddSector / mapeoRenameSector / mapeoDelSector / mapeoReset
//  - sectorForArticle(sku, base, color)  → nombre de sector (para el reporte)
//  - mapeoSectorOrder()                  → orden de sectores para el reporte
import { S } from './state'
import { toast, confirm2, uiPrompt } from './core-ui'
import { canonColor } from './colors'

const LS_KEY = 'parka_mapeo'

// --- SEED (del Excel Mapeo_Deposito.xlsx) ------------------------------
const SEED = JSON.parse('[{"sector":"Sector 1","articulos":[{"modelo":"W8","colores":["Black","Beige"]},{"modelo":"M78","colores":["Green"]},{"modelo":"M113","colores":["Black"]},{"modelo":"M138","colores":["Beige"]},{"modelo":"Malla Style #3","colores":["Green","Black"]}]},{"sector":"Sector 2","articulos":[{"modelo":"109","colores":["Black","Navy","Green"]},{"modelo":"W15","colores":["Black","Orange"]},{"modelo":"W71","colores":[]},{"modelo":"Pullover Hoodie","colores":[]},{"modelo":"Original Hood","colores":["Grey","Black"],"notas":"?"},{"modelo":"MSW Original Crew","colores":[],"notas":"(Parka?)"},{"modelo":"Malla Style #1","colores":[],"notas":"(Todo)"}]},{"sector":"Sector 3","articulos":[{"modelo":"132","colores":["Green","Navy"]},{"modelo":"M6","colores":["Blue"]},{"modelo":"M86","colores":["Black"]},{"modelo":"1161","colores":["Black"]},{"modelo":"M131","colores":["Navy","Green","Petroleo"]},{"modelo":"M134","colores":["Navy","Black","Green"]},{"modelo":"134","colores":["Navy","Green"]},{"modelo":"W2003","colores":["Black"]},{"modelo":"W7","colores":["Almond"]},{"modelo":"W8","colores":["Chocolate"]},{"modelo":"W41","colores":["Pink"]},{"modelo":"W12","colores":["Celeste"]},{"modelo":"W14","colores":["Brown"]},{"modelo":"2052","colores":["Green","Black"]},{"modelo":"W19","colores":["Black"]},{"modelo":"W12","colores":["Orange"]},{"modelo":"W2033","colores":["Green"]},{"modelo":"2045","colores":["Black"]},{"modelo":"W73","colores":["Pink"]},{"modelo":"(Fallas)","colores":[],"notas":"Nota: \'Fallas\' al pie del sector"}]},{"sector":"Sector 4","articulos":[{"modelo":"W24","colores":["Brown"]},{"modelo":"W29","colores":["Green","Beige"]},{"modelo":"M1184","colores":["Black"]},{"modelo":"M71","colores":["Navy"]},{"modelo":"M1183","colores":["Off White"]},{"modelo":"W7","colores":["Black","Green"]},{"modelo":"W2078","colores":["Black"]},{"modelo":"M150","colores":["Green"]}]},{"sector":"Sector 5","articulos":[{"modelo":"W2010","colores":["Green","Black"]},{"modelo":"W112","colores":["Black","Green","Grey","Olive"]},{"modelo":"W2032","colores":["Black"]},{"modelo":"M1159","colores":["Black"]},{"modelo":"W13","colores":["Black"]},{"modelo":"M1180","colores":["Black"]},{"modelo":"M131","colores":["Brown"]},{"modelo":"Mochi 3002 / 3003","colores":[],"notas":"(Parka)"},{"modelo":"2083","colores":["Black"]}]},{"sector":"Sector 6","articulos":[{"modelo":"W18","colores":["Black"]},{"modelo":"2055","colores":["Beige","Blue"]},{"modelo":"2077","colores":["Green","Black"]},{"modelo":"M1195","colores":[]},{"modelo":"MT-1026","colores":[],"notas":"(Todo)"}]},{"sector":"Sector 7","articulos":[{"modelo":"M74","colores":["Green","Grey","Navy","Black"]},{"modelo":"Camisa Lima","colores":[]},{"modelo":"Chomba Anonymus - Axe","colores":[]},{"modelo":"MJ Crich","colores":["Beige","Black"]},{"modelo":"M140","colores":["Black","Green","Brown","Navy"]},{"modelo":"Horquillas","colores":[]},{"modelo":"Pu\\u00f1os","colores":[]},{"modelo":"Direcciones","colores":[]},{"modelo":"Pantalones MP AP 24010","colores":["Green","Black"]},{"modelo":"1197","colores":["Black"]},{"modelo":"1191","colores":["Green","Black"]},{"modelo":"MJ Bonton","colores":[]}]},{"sector":"Sector 8","articulos":[{"modelo":"Popper Shirt","colores":["Beige","Black"]},{"modelo":"W41","colores":["Black","Bone"]},{"modelo":"2047","colores":["Grey","Black"]},{"modelo":"2043","colores":["Black"]},{"modelo":"W2059","colores":["White"]},{"modelo":"MT-1018","colores":["Charcoal","Black","Beige","White"]},{"modelo":"3001","colores":[]},{"modelo":"W2063","colores":[]},{"modelo":"Oden","colores":["Navy","Black","Beige"]}]},{"sector":"Sector 9","articulos":[{"modelo":"142","colores":["Green","Beige"]},{"modelo":"114","colores":["Grey","Black"]},{"modelo":"1188","colores":["Black","Grey"]},{"modelo":"1137","colores":["Off White","Black"]},{"modelo":"148","colores":["3 colores"]},{"modelo":"1155","colores":["Black"]},{"modelo":"151","colores":["Navy","Black"]},{"modelo":"133","colores":["Black","Green","Blue"]},{"modelo":"2067","colores":["Red","Black"]},{"modelo":"3014","colores":[],"notas":"Mochila"}]},{"sector":"Sector 10","articulos":[{"modelo":"1182","colores":["Black"]},{"modelo":"2079","colores":["Off White"]},{"modelo":"141","colores":["Navy"]},{"modelo":"114","colores":["Grey","Olive"]},{"modelo":"Regular Fit Split","colores":[]},{"modelo":"Oversize Fit North","colores":[]},{"modelo":"B3005","colores":[]},{"modelo":"W2118","colores":["Green","Black"]},{"modelo":"131","colores":["Black","Green"]}]},{"sector":"Sector 11","articulos":[{"modelo":"144","colores":["Black","Green","Navy"]},{"modelo":"1188","colores":["Grey"]},{"modelo":"3014","colores":[]},{"modelo":"W3","colores":["Brown","Black"]},{"modelo":"M141","colores":["Black"]},{"modelo":"M114","colores":["Black"]}]},{"sector":"Sector 12","articulos":[{"modelo":"1145","colores":["Blue","Green"]},{"modelo":"2076","colores":["Black","Green"]},{"modelo":"2070","colores":["Black","Mostaza"]},{"modelo":"2079","colores":["Black"]},{"modelo":"1165","colores":["Black","Beige"]},{"modelo":"1154","colores":["Black","Green"]},{"modelo":"2060","colores":["Black","Off White"]},{"modelo":"Flannel Jacket","colores":["Green","Black","Brown"]},{"modelo":"M1145","colores":["Grey"]},{"modelo":"Puffer Combinada","colores":["todos los colores"],"notas":"(Todo)"}]},{"sector":"Sector 13","articulos":[{"modelo":"M1175","colores":["Black","Green"]},{"modelo":"M131","colores":["Green"]},{"modelo":"M1166","colores":["Black"]}]},{"sector":"Bicis","articulos":[{"modelo":"Puffer Combinada","colores":[]},{"modelo":"Sherpa Jacket","colores":[]},{"modelo":"2094","colores":[]},{"modelo":"2057","colores":[]},{"modelo":"MT 1002","colores":[]},{"modelo":"MT 1016","colores":[],"notas":"(Todo)"},{"modelo":"MT 1017","colores":[],"notas":"(Todo)"},{"modelo":"MT 1021","colores":[],"notas":"(Todo)"},{"modelo":"MT 1027","colores":[],"notas":"(Todo)"},{"modelo":"MT 2025","colores":[],"notas":"(Todo)"},{"modelo":"Glanton","colores":[]},{"modelo":"1195","colores":[]}]}]')

// --- ESTADO ------------------------------------------------------------
function load(){
  try{
    const raw = localStorage.getItem(LS_KEY)
    if(raw){ const p = JSON.parse(raw); if(Array.isArray(p)) return p }
  }catch(e){}
  return JSON.parse(JSON.stringify(SEED))
}
let MAPEO = load()
S.MAPEO = MAPEO
const expanded = {}   // sector -> bool

function save(){
  try{ localStorage.setItem(LS_KEY, JSON.stringify(MAPEO)) }catch(e){}
  S.MAPEO = MAPEO
}

// --- MATCHER (para el reporte) -----------------------------------------
// Token de código: primeras letras + primer número (ignora guiones/espacios).
//  "W-8-BLK" → "W8" · "M-114-BLACK" → "M114" · "109-BLK" → "109" · "MT 1002" → "MT1002"
function codeToken(s){
  const u = String(s||'').toUpperCase().replace(/[\s.]/g,'')
  const m = u.match(/^([A-Z]{0,3})-?(\d{1,4})/)
  return m ? (m[1]||'') + m[2] : ''
}

// sku/base + color de la venta → nombre de sector ('' si no matchea).
// Prioriza modelo+color; si el color no coincide en ningún sector, cae al modelo.
export function sectorForArticle(sku, base, color){
  const om = codeToken(base || sku)
  if(!om) return ''
  const oc = canonColor(color || '')
  let byColor = '', byWild = '', byModel = ''
  for(const sec of MAPEO){
    for(const a of (sec.articulos||[])){
      if(codeToken(a.modelo) !== om) continue
      if(!byModel) byModel = sec.sector
      const cols = a.colores || []
      if(!cols.length){ if(!byWild) byWild = sec.sector; continue }
      if(oc && cols.some(c=>canonColor(c) === oc)){ if(!byColor) byColor = sec.sector }
    }
  }
  return byColor || byWild || byModel || ''
}

// Orden de sectores para el reporte (según el orden actual del mapeo).
export function mapeoSectorOrder(){ return MAPEO.map(s=>s.sector) }

// --- UI ----------------------------------------------------------------
const es = s => String(s==null?'':s).replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]))

export function mapeoRender(){
  const grid = document.getElementById('mapeo-grid')
  if(!grid) return
  const totalArt = MAPEO.reduce((n,s)=>n+(s.articulos?s.articulos.length:0),0)
  const cnt = document.getElementById('mapeo-count')
  if(cnt) cnt.textContent = MAPEO.length + ' sectores · ' + totalArt + ' artículos'

  grid.innerHTML = MAPEO.map((sec, si)=>{
    const open = !!expanded[sec.sector]
    const arts = sec.articulos || []
    let body = ''
    if(open){
      body = '<div class="mapeo-body">' +
        (arts.length ? arts.map((a, ai)=>{
          const cols = (a.colores||[]).map(c=>'<span class="mapeo-chip">'+es(c)+'</span>').join('')
          const nota = a.notas ? '<span class="mapeo-nota">'+es(a.notas)+'</span>' : ''
          return '<div class="mapeo-art">' +
            '<div class="mapeo-art-main"><span class="mapeo-modelo">'+es(a.modelo)+'</span>'+cols+nota+'</div>' +
            '<div class="mapeo-art-btns">' +
              '<button class="btn btn-ghost btn-sm" title="Editar" onclick="mapeoEditArt('+si+','+ai+')">✎</button>' +
              '<button class="btn btn-danger btn-sm" title="Quitar" onclick="mapeoDelArt('+si+','+ai+')">−</button>' +
            '</div></div>'
        }).join('') : '<div class="mapeo-empty-art">Sin artículos. Agregá con “+ Artículo”.</div>') +
        '<div class="mapeo-body-foot">' +
          '<button class="btn btn-primary btn-sm" onclick="mapeoAddArt('+si+')">+ Artículo</button>' +
          '<button class="btn btn-ghost btn-sm" onclick="mapeoRenameSector('+si+')">✎ Renombrar</button>' +
          '<button class="btn btn-danger btn-sm" onclick="mapeoDelSector('+si+')">🗑 Eliminar sector</button>' +
        '</div></div>'
    }
    return '<div class="mapeo-card'+(open?' open':'')+'">' +
      '<button class="mapeo-card-head" onclick="mapeoToggle('+si+')">' +
        '<span class="mapeo-card-title">'+es(sec.sector)+'</span>' +
        '<span class="mapeo-card-meta">'+arts.length+' art. <span class="mapeo-caret">'+(open?'▲':'▼')+'</span></span>' +
      '</button>' + body +
    '</div>'
  }).join('')
}

export function mapeoToggle(si){
  const sec = MAPEO[si]; if(!sec) return
  expanded[sec.sector] = !expanded[sec.sector]
  mapeoRender()
}

export async function mapeoAddArt(si){
  const sec = MAPEO[si]; if(!sec) return
  const r = await uiPrompt('Agregar artículo a '+sec.sector, [
    {key:'modelo', label:'Artículo / Modelo (ej: W8, M114, 109)', placeholder:'W8'},
    {key:'colores', label:'Colores (separados por coma, opcional)', placeholder:'Black, Green'},
    {key:'notas', label:'Notas (opcional)'}
  ], 'Agregar')
  if(!r) return
  if(!r.modelo){ toast('Falta el modelo','error'); return }
  const cols = r.colores ? r.colores.split(',').map(c=>c.trim()).filter(Boolean) : []
  const art = { modelo: r.modelo, colores: cols }
  if(r.notas) art.notas = r.notas
  sec.articulos = sec.articulos || []
  sec.articulos.push(art)
  save(); mapeoRender()
  toast('Artículo agregado a '+sec.sector, 'success')
}

export async function mapeoEditArt(si, ai){
  const sec = MAPEO[si]; if(!sec) return
  const a = (sec.articulos||[])[ai]; if(!a) return
  const r = await uiPrompt('Editar artículo', [
    {key:'modelo', label:'Artículo / Modelo', value:a.modelo},
    {key:'colores', label:'Colores (separados por coma)', value:(a.colores||[]).join(', ')},
    {key:'notas', label:'Notas', value:a.notas||''}
  ], 'Guardar')
  if(!r) return
  if(!r.modelo){ toast('Falta el modelo','error'); return }
  a.modelo = r.modelo
  a.colores = r.colores ? r.colores.split(',').map(c=>c.trim()).filter(Boolean) : []
  if(r.notas) a.notas = r.notas; else delete a.notas
  save(); mapeoRender()
  toast('Artículo actualizado', 'success')
}

export function mapeoDelArt(si, ai){
  const sec = MAPEO[si]; if(!sec) return
  const a = (sec.articulos||[])[ai]; if(!a) return
  if(!confirm2('mapeo-delart-'+si+'-'+ai, 'Quitar “'+a.modelo+'” de '+sec.sector+'.')) return
  sec.articulos.splice(ai, 1)
  save(); mapeoRender()
  toast('Artículo quitado', 'success')
}

export async function mapeoAddSector(){
  const r = await uiPrompt('Nuevo sector', [
    {key:'nombre', label:'Nombre del sector', placeholder:'Sector 14'}
  ], 'Crear')
  if(!r) return
  const nombre = (r.nombre||'').trim()
  if(!nombre){ toast('Falta el nombre','error'); return }
  if(MAPEO.some(s=>s.sector.toLowerCase()===nombre.toLowerCase())){ toast('Ya existe un sector con ese nombre','error'); return }
  MAPEO.push({ sector: nombre, articulos: [] })
  expanded[nombre] = true
  save(); mapeoRender()
  toast('Sector “'+nombre+'” creado', 'success')
}

export async function mapeoRenameSector(si){
  const sec = MAPEO[si]; if(!sec) return
  const r = await uiPrompt('Renombrar sector', [
    {key:'nombre', label:'Nuevo nombre', value:sec.sector}
  ], 'Guardar')
  if(!r) return
  const nombre = (r.nombre||'').trim()
  if(!nombre){ toast('Falta el nombre','error'); return }
  if(MAPEO.some((s,i)=>i!==si && s.sector.toLowerCase()===nombre.toLowerCase())){ toast('Ya existe un sector con ese nombre','error'); return }
  const wasOpen = expanded[sec.sector]; delete expanded[sec.sector]
  sec.sector = nombre; expanded[nombre] = wasOpen
  save(); mapeoRender()
  toast('Sector renombrado', 'success')
}

export function mapeoDelSector(si){
  const sec = MAPEO[si]; if(!sec) return
  if(!confirm2('mapeo-delsec-'+si, 'Eliminar el sector “'+sec.sector+'” y sus '+(sec.articulos?sec.articulos.length:0)+' artículos.')) return
  delete expanded[sec.sector]
  MAPEO.splice(si, 1)
  save(); mapeoRender()
  toast('Sector eliminado', 'success')
}

export function mapeoReset(){
  if(!confirm2('mapeo-reset', 'Restaurar el mapeo al original del Excel. Se pierden los cambios guardados.')) return
  MAPEO = JSON.parse(JSON.stringify(SEED))
  for(const k in expanded) delete expanded[k]
  save(); mapeoRender()
  toast('Mapeo restaurado desde el Excel', 'success')
}

// --- window-expose -----------------------------------------------------
try{
  window.mapeoRender = mapeoRender
  window.mapeoToggle = mapeoToggle
  window.mapeoAddArt = mapeoAddArt
  window.mapeoEditArt = mapeoEditArt
  window.mapeoDelArt = mapeoDelArt
  window.mapeoAddSector = mapeoAddSector
  window.mapeoRenameSector = mapeoRenameSector
  window.mapeoDelSector = mapeoDelSector
  window.mapeoReset = mapeoReset
}catch(e){}
