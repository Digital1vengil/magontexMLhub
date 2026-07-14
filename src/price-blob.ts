// ParkaHub — validación del blob compartido de precios (/api/warehouse?part=prices) por versión de
// esquema (sv). Módulo LEAF puro: sin estado, sin DOM, sin imports → testeable en Node (price-blob.test.ts).
// Espeja blobHasStaleRow de parkahub-api/src/warehouse.ts (mismo criterio, del otro lado del cable).
//
// El front valida el blob mirando SOLO la fila [0] (row[0]-only). Eso es válido PORQUE el backend garantiza
// un blob HOMOGÉNEO en sv (gate del POST /api/warehouse + refreshPriceRows + el rebuild del cron): si todas
// las filas comparten sv, chequear la primera alcanza y es O(1). Antes este criterio estaba TRIPLICADO a mano
// (promos.ts cache local + blob, publicaciones.ts ensurePubPrices) y un cambio había que replicarlo en los 3
// → esa divergencia es la clase de bug que el gate de sv vino a matar (retro 2026-07-13). Un solo helper, un
// solo lugar. Recibe `sv` por parámetro (igual que blobHasStaleRow) → SCAN_SV sigue siendo su fuente única en
// promos.ts, sin acoplar este leaf a ella. Mover/dedup ≠ cambiar cálculo → NO corresponde bump de SCAN_SV.

// ¿Aceptamos este blob de precios como FRESCO? Solo si es un array no vacío cuya fila [0] existe y su sv
// matchea el esquema vigente. Un blob de esquema viejo, vacío, con row[0] nulo, o que no es array → false;
// el consumidor cae a su fallback (re-escanear en vivo / descuento del maestro con aviso).
export function acceptPriceBlob(rows: any, sv: number): boolean {
  return Array.isArray(rows) && rows.length > 0 && !!rows[0] && rows[0].sv === sv
}
