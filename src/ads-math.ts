// ParkaHub — semáforo de ACOS (métrica 3 del ledger, mitad front). El ACOS/ROAS lo calcula el Worker
// (parkahub-api, calc.ts acosPct/roas); el front solo lo clasifica para el color de la celda del Maestro.
// Extraído TAL CUAL de publicaciones.ts (maestroRender), sin cambio de lógica.
// Umbrales del ledger: <12 verde · <18 ámbar · resto rojo. null (sin dato) → null (color atenuado).

export type AcosLight = 'green' | 'amber' | 'red' | null

export function acosLight(acos: number | null | undefined): AcosLight {
  if (acos == null) return null
  return acos < 12 ? 'green' : (acos < 18 ? 'amber' : 'red')
}
