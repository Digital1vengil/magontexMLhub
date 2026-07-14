// Clasificación del CARÁCTER de una prenda para la señal de clima del Radar. Módulo HOJA puro (sin imports con
// efectos de lado → testeable en node sin DOM/localStorage). Decide cuál es el DRIVER de demanda de cada modelo:
//
//   rain  = prenda de LLUVIA: trench / piloto impermeable (o repelente). La lluvia es el driver primario —
//           se vende MUCHO más con lluvia y bastante menos sin, aunque haga frío (ej. Alchemy=trench;
//           Gemini=piloto: se vende como "raincoat" impermeable AUNQUE tenga relleno leve → la TIPOLOGÍA
//           manda sobre el nivel de relleno).
//   warm  = prenda de ABRIGO: tiene relleno/corderito y NO es de lluvia. El driver es el FRÍO (puffer, parka…).
//   light = liviana: "Sin relleno" y no es de lluvia. Responde a la temperatura (a favor templado, en contra frío).
//
// Excluyentes por diseño: rain XOR warm XOR light XOR ninguno (vacío/no clasificado = neutro, sin chip).
// TRAMPA (bug jul-2026): "Sin relleno" CONTIENE la subcadena "relleno" → chequear `light` ANTES y excluirlo de warm.
export function garmentClimate(abrigo: unknown, tipologia: unknown, imper: unknown): { rain: boolean; warm: boolean; light: boolean } {
  const impS = String(imper || '')
  const imperY = !/no\s*impermeable/i.test(impS) && /impermeable|repelente/i.test(impS)   // OJO: "No impermeable" CONTIENE "impermeable" → excluir primero (misma trampa que "Sin relleno")
  const rain = imperY && /trench|piloto/i.test(String(tipologia || ''))   // prenda de lluvia (driver = lluvia)
  const a = String(abrigo || '')
  const isSinRelleno = /sin\s*relleno/i.test(a)
  const warm = !rain && !isSinRelleno && /relleno|corderito/i.test(a)     // abriga (driver = frío)
  const light = !rain && isSinRelleno                                     // liviana (driver = temperatura)
  return { rain, warm, light }
}
