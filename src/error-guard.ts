// @ts-nocheck
// Fail-loud: errores NO manejados (sync + promesas rechazadas) se muestran como toast rojo
// visible en vez de tragarse en silencio. Es la red de seguridad para regresiones de la clase
// que vivió oculta mucho tiempo: un onclick inline que tira ReferenceError, un getElementById
// sobre un id inexistente, etc. Esos errores propagan a window y antes pasaban desapercibidos.
import { toast } from './core-ui'

// Ruido benigno del browser que NO queremos mostrarle al usuario.
const IGNORE = [
  'ResizeObserver loop',            // warning benigno de Chrome, no es un bug
  'Script error.',                  // errores cross-origin sin detalle util
  'Non-Error promise rejection',
]

let lastMsg = '', lastAt = 0

function esc(s){ return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }

function surface(prefix, rawMsg){
  try{
    const msg = String(rawMsg == null ? 'error desconocido' : rawMsg)
    if(IGNORE.some(function(p){ return msg.indexOf(p) >= 0; })) return
    // siempre al console (no suprimimos nada)
    console.error('[ParkaHub] ' + prefix + ':', rawMsg)
    // dedupe: mismo mensaje dentro de 4s -> no repetir el toast (evita spam en loops)
    var now = Date.now()
    if(msg === lastMsg && now - lastAt < 4000) return
    lastMsg = msg; lastAt = now
    // toast guardado: en un error MUY temprano puede no existir el DOM/#toasts todavia
    try{ toast('Error inesperado: ' + esc(msg.slice(0, 160)), 'error'); }catch(e){}
  }catch(e){ /* el guard jamas debe romper */ }
}

// Errores sincronicos no manejados (incluye los de handlers inline onclick="fn()").
window.addEventListener('error', function(e){
  // Ignorar errores de CARGA de recursos (img/script 404): no traen .message JS.
  if(!e || !e.message) return
  var where = e.filename ? ' (' + String(e.filename).split('/').pop() + ':' + e.lineno + ')' : ''
  surface('error', e.message + where)
})

// Promesas rechazadas sin .catch (async functions que tiran sin manejarse).
window.addEventListener('unhandledrejection', function(e){
  var r = e ? e.reason : null
  var msg = (r && r.message) ? r.message : String(r)
  surface('promise', msg)
})
