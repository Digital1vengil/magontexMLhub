// ParkaHub — indicador "EN VIVO" (puntito) reutilizable + helpers de frescura de datos.
// Un puntito por sección (id="live-<sec>"). Estados:
//   ok    → verde: dato fresco (edad < TTL).
//   stale → gris:  dato del almacén viejo, o scan incompleto (un batch falló) → no confiar del todo.
//   busy  → ámbar titilando: refresco en vivo en curso.
//   off   → rojo:  sin conexión / nunca hubo dato.
// El clic del puntito dispara un re-scan EN VIVO (solo lectura de ML: no escribe nada) → clic simple, sin
// diálogos del navegador (que el Chrome de Martin suprime).

// Antigüedad legible. Se duplica el helper (idéntico al de promos.ts) para que live.ts quede autocontenido.
function agoTxt(ts: number): string {
  if (!ts) return ''
  const m = Math.round((Date.now() - ts) / 60000)
  return m < 1 ? 'recién' : m < 60 ? 'hace ' + m + ' min' : m < 1440 ? 'hace ' + Math.round(m / 60) + ' h' : 'hace ' + Math.round(m / 1440) + ' d'
}

// Estado según antigüedad del dato: sin ts → off; scan incompleto → stale; fresco (< ttl) → ok; si no → stale.
export function liveStateFor(ts: number, ttlFreshMs: number, complete: boolean): 'ok' | 'stale' | 'off' {
  if (!ts) return 'off'
  if (!complete) return 'stale'
  return Date.now() - ts < ttlFreshMs ? 'ok' : 'stale'
}

// Pinta el puntito id="live-<id>" con la clase + tooltip del estado. online=false → rojo (sin conexión).
export function setLive(id: string, opts: { state?: string; ts?: number; online?: boolean }): void {
  const { state, ts = 0, online = true } = opts || {}
  const el = document.getElementById('live-' + id)
  if (!el) return
  el.classList.remove('ok', 'stale', 'off', 'busy')
  let cls: string, tip: string
  if (!online) { cls = 'off'; tip = 'sin conexión — mostrando el último dato local' }
  // `off` = nunca hubo dato (ts=0). ANTES caía en el `else` y se pintaba VERDE "al día" sin datos: el
  // puntito mentía. `liveStateFor` devuelve 'off' cuando ts=0 → hay que manejarlo explícito.
  else if (state === 'off') { cls = 'off'; tip = 'sin datos todavía · clic para actualizar en vivo' }
  else if (state === 'busy') { cls = 'busy'; tip = 'actualizando en vivo…' }
  else if (state === 'stale') { cls = 'stale'; tip = 'dato del almacén' + (ts ? ' · ' + agoTxt(ts) : '') + ' · clic para actualizar en vivo' }
  else { cls = 'ok'; tip = 'al día' + (ts ? ' · ' + agoTxt(ts) : '') + ' · clic para actualizar en vivo' }
  el.classList.add(cls)
  el.setAttribute('title', tip)
}

try { (window as any).setLive = setLive; (window as any).liveStateFor = liveStateFor } catch (e) {}
