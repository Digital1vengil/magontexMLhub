// @ts-nocheck
// ParkaHub — helpers puros / utilidades compartidas (paso "util" de la modularizacion).
// Funciones movidas TAL CUAL desde app.ts. Cero cambio de logica.
import { S } from './state'

export function getRange(p){
  const v=document.getElementById(p+'-period').value,now=new Date();
  let from,to=new Date(now);to.setHours(23,59,59,999);
  if(v==='today'){from=new Date(now);from.setHours(0,0,0,0);}
  else if(v==='7d'){from=new Date(now);from.setDate(from.getDate()-7);from.setHours(0,0,0,0);}
  else if(v==='30d'){from=new Date(now);from.setDate(from.getDate()-30);from.setHours(0,0,0,0);}
  else{from=new Date(document.getElementById(p+'-df').value);to=new Date(document.getElementById(p+'-dt').value);to.setHours(23,59,59,999);}
  return{from,to};
}

// --- STATUS ------------------------------------------------------------
export function normSt(raw){if(!raw)return'pending';const s=raw.toLowerCase();if(['paid','payment_done','approved'].some(x=>s.includes(x)))return'paid';if(['ship','deliver','envi','entreg'].some(x=>s.includes(x)))return'shipped';if(['cancel'].some(x=>s.includes(x)))return'cancelled';return'pending';}
export function stLabel(s){return{paid:'Pagada',pending:'Pendiente',shipped:'Enviada',cancelled:'Cancelada'}[s]||s;}

// Parses "Color : Negro | Talle : XL" -> {color:'Negro', talle:'XL'}
export function parseVariant(v){
  const s = String(v||'');
  const cm = s.match(/Color\s*:\s*([^|]+)/i);
  const tm = s.match(/Talle\s*:\s*([^|]+)/i);
  return {
    color: cm ? cm[1].trim() : '--',
    talle: tm ? tm[1].trim() : '--'
  };
}

// Extract SKU base: M-144-BLACK-XL -> M-144-BLACK  (strip last segment if it's a talle)
export function skuBase(sku){
  const talles = /^(XXS|XS|S|M|L|XL|2XL|XXL|3XL|XXXL|4XL|XXXXL|0|2|4|6|8|10|12|14|U|UNICO)$/i;
  const parts = String(sku).split('-');
  if(parts.length > 1 && talles.test(parts[parts.length-1])) return parts.slice(0,-1).join('-');
  return sku;
}

// Sort priority: M (hombre) -> W (mujer) -> otros
// Within same prefix: sort by model number then talle order

export function skuSortKey(sku){
  const s = String(sku).toUpperCase();
  // Prefix group: M=0, W=1, others=2
  let group = 2;
  if(s.startsWith('M-') || s.startsWith('M1') || s.startsWith('MT')) group = 0;
  else if(s.startsWith('W-') || s.startsWith('W1') || s.startsWith('W2') || s.startsWith('W4') || s.startsWith('W8')) group = 1;

  // Extract talle from end
  const parts = s.split('-');
  const lastPart = parts[parts.length-1];
  const talleIdx = S.TALLE_ORDER.indexOf(lastPart.replace('XXL','XXL').toUpperCase());
  const tallePad = talleIdx >= 0 ? String(talleIdx).padStart(2,'0') : '99';

  // Base without talle for sorting
  const base = talleIdx >= 0 ? parts.slice(0,-1).join('-') : s;

  return `${group}|${base}|${tallePad}`;
}

export function pn(id){ var el=document.getElementById(id); return el?parseFloat(el.value)||0:0; }
export function fARS(v){ return '$'+Math.round(v).toLocaleString('es-AR'); }
export function fUSD(v){ return 'USD '+(+v).toLocaleString('es-AR',{minimumFractionDigits:2,maximumFractionDigits:2}); }

// Clave de ordenamiento numérico para un label "dd/mm – dd/mm/yy"
export function vmlWeekSortKey(label){
  var m = label.match(/(\d{2})\/(\d{2})\/(\d{2})/); // extrae dd/mm/yy del segundo extremo
  if(!m) return 0;
  return parseInt(m[3])*10000 + parseInt(m[2])*100 + parseInt(m[1]);
}

// Extrae el código base sin el talle final: "M-114-BLACK-L" → "M-114-BLACK"
export function talleSort(a,b){
  var ai = S.VML_TALLE_ORDER.indexOf(a.toUpperCase());
  var bi = S.VML_TALLE_ORDER.indexOf(b.toUpperCase());
  if(ai<0 && bi<0) return a.localeCompare(b);
  if(ai<0) return 1;
  if(bi<0) return -1;
  return ai-bi;
}

export function vmlBaseCode(sku){
  // Talles válidos al final del SKU: S, M, L, XL, XXL, XXXL, 2XL, 3XL, 4XL, XS, XXS, números
  var m = sku.match(/^(.+)-(\d{0,1}X{0,4}[SL]|XXS|XS|[SMLX]{1,2}|[0-9]{1,3})$/i);
  return m ? m[1] : sku;
}

// Destilado de keywords de título a partir de las Trends de ML (keywords reales de búsqueda, refresco semanal)
// + términos derivados de los atributos del producto. PURA y COMPARTIDA (swap + editor masivo) — un solo
// lugar para esta lógica (no re-copiar). Devuelve frases relevantes + palabras faltantes rankeadas.
//   trendKw: string[] (de /api/ml/trends)  ·  currentTitle: string  ·  gender: 'mujer'|'hombre'|''
//   attrWords: string[] extra (ej. "Con Capucha","Impermeable") derivadas de atributos por el caller.
export function titleSuggest(trendKw, currentTitle, gender, attrWords){
  var STOP = {de:1,la:1,el:1,los:1,las:1,y:1,con:1,para:1,en:1,a:1,del:1,por:1,o:1,un:1,una:1,'':1};
  // Marcas de la competencia + geos: NUNCA sugerir (ruido, y poner marca ajena en tu título es moderable por ML).
  var BRAND = {moncler:1,champion:1,patagonia:1,columbia:1,nike:1,adidas:1,puma:1,quiksilver:1,rip:1,curl:1,billabong:1,muluc:1,montagne:1,northland:1,'the':1,north:1,face:1,jack:1,wolfskin:1,bolivia:1,paris:1};
  // Materiales/estilos ESPECÍFICOS: solo se sugieren si el producto realmente los tiene (confirmado por sus
  // atributos o su propio título). Si no, se descartan (mejor no sugerir "cuero" a una campera que no es de cuero).
  var NEEDS_OK = {cuero:1,corderoy:1,corduroy:1,varsity:1,universitaria:1,jean:1,jeans:1,gabardina:1,polar:1,gamuza:1,lana:1,eco:1,ecocuero:1,inflable:1};
  var cur = String(currentTitle||'').toLowerCase();
  var stem = function(w){ return w.replace(/s$/,''); };
  var titleStems = {}; cur.split(/\s+/).forEach(function(w){ w=w.replace(/[^a-záéíóúñü0-9]/gi,''); if(w) titleStems[stem(w)]=1; });
  var covered = function(w){ return !!titleStems[stem(w)]; };   // NO sugerir algo que YA está tipeado en el título (cubre plural)
  // Género: SIEMPRE del atributo GENDER (lo pasa el caller). NUNCA se infiere del título — el título puede estar
  // heredado de otro modelo (reúso de publicaciones) y mentir. Si no viene el atributo, no se filtra por género.
  var g = String(gender||'').toLowerCase();
  var oppOK = function(s){
    if(/hombre/.test(g)) return !(/muje|femenin|dama/.test(s));
    if(/mujer/.test(g))  return !(/hombre|masculin|varon/.test(s));
    return true; };
  // "confirmado" del producto = SOLO los atributos reales (NO el título — puede tener "cuero" de otro modelo).
  var okSet = {}; (Array.isArray(attrWords)?attrWords:[]).forEach(function(a){ String(a).toLowerCase().split(/\s+/).forEach(function(w){ w=w.replace(/[^a-záéíóúñü0-9]/gi,''); if(w) okSet[stem(w)]=1; }); });
  var kw = Array.isArray(trendKw) ? trendKw : [];
  var rel = kw.filter(function(k){ return oppOK(String(k).toLowerCase()); });
  var keepWord = function(w){
    if(w.length<3 || STOP[w]) return false;
    if(BRAND[w]) return false;
    if(!oppOK(w)) return false;
    if(NEEDS_OK[stem(w)] && !okSet[stem(w)]) return false;   // material/estilo específico solo si el producto lo tiene
    return true; };
  // Frases trending: relevantes, sin marca ni estilo no confirmado, no contenidas ya en el título.
  var phrases = rel.filter(function(k){ var s=String(k).toLowerCase(); if(cur.includes(s)) return false;
    var toks=s.split(/\s+/).map(function(w){return w.replace(/[^a-záéíóúñü0-9]/gi,'');});
    if(toks.some(function(w){ return BRAND[w] || (NEEDS_OK[stem(w)] && !okSet[stem(w)]); })) return false;
    return true; }).slice(0,6);
  // Palabras sueltas rankeadas por aparición (más arriba en el ranking = más peso), faltantes en el título.
  var freq = {};
  rel.forEach(function(k,idx){ String(k).toLowerCase().split(/\s+/).forEach(function(w){ w=w.replace(/[^a-záéíóúñü0-9]/gi,''); if(!keepWord(w)) return; freq[w]=(freq[w]||0)+(rel.length-idx); }); });
  var trendWords = Object.keys(freq).filter(function(w){ return !covered(w); }).sort(function(a,b){ return freq[b]-freq[a]; }).slice(0,10);
  // Palabras de atributos del producto que faltan en el título (Con Capucha, Impermeable, material real, etc.).
  var aw = (Array.isArray(attrWords)?attrWords:[]).filter(function(w){ return w && !cur.includes(String(w).toLowerCase()); });
  return { phrases: phrases, trendWords: trendWords, attrWords: aw, gender: g, freeChars: Math.max(0, 60 - String(currentTitle||'').length) };
}
