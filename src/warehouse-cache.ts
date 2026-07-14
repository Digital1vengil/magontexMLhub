// Cache en memoria COMPARTIDO del almacén (/api/warehouse). El blob es grande (~1.2 MB) y lo necesitan
// varios módulos (promos, report/Resumen, devoluciones, publicaciones); antes cada uno lo bajaba y
// parseaba por su cuenta (~7 GET + 7 JSON.parse de 1.2 MB por sesión). Ahora: UN GET por 5 min para todos.
//
// El almacén se parchea en vivo (webhook de ML + item-update) → 5 min de staleness es aceptable (misma
// política que ya tenía promos). invalidateWarehouse() lo llama quien SUBE un scan fresco (POST /api/warehouse):
// así el próximo getWarehouse de CUALQUIER módulo re-baja el dato nuevo (antes solo promos se enteraba).
import { apiGet } from './api'

let _wh: any = null
let _whTs = 0
let _inflight: Promise<any> | null = null   // single-flight: N llamadas concurrentes comparten 1 GET
const TTL = 5 * 60 * 1000

export async function getWarehouse(): Promise<any> {
  if (_wh && (Date.now() - _whTs < TTL)) return _wh
  if (_inflight) return _inflight            // ya hay un GET de 1.2MB en vuelo → esperalo, no dispares otro
  _inflight = (async () => {
    try { _wh = await apiGet('/api/warehouse'); if (_wh) _whTs = Date.now(); return _wh }
    catch (e) { _wh = null; return null }
    finally { _inflight = null }
  })()
  return _inflight
}

// Fuerza el re-fetch en la próxima llamada (tras subir un scan fresco al almacén compartido).
export function invalidateWarehouse(): void { _wh = null; _whTs = 0 }
