# ParkaHub — Plan de modularización (Fase 1)

> **ESTADO: Fase 1 COMPLETA** — 16 módulos extraídos de `app.ts` (4001 → 240 líneas residuales), verificados (12 secciones sin errores, 0 consola). Ver `git log`. Fix final: 13 spreads bare `...X` → `...S.X` que el refactor de estado había omitido (causaban ReferenceError en renderDespachos/exports). Pendiente conocido: `refreshDB` es bug PREEXISTENTE del baseline (8 llamadas, 0 definiciones) — fuera del scope cero-cambio.

Objetivo: pasar el monolito `parkahub/index.html` (5723 líneas) a un proyecto Vite (vanilla + TS)
con módulos en `src/`, **sin cambiar de framework y con CERO cambio de comportamiento**.
Plan derivado de un análisis multi-agente del monolito.

## Reglas que no se rompen

- **Libs como CDN durante toda la partición** (Chart.js, xlsx-js-style, jszip, pdf.js, firebase).
  Quedan en `<script src>` del `<head>`. Migrar a npm es un paso POSTERIOR, una lib por commit.
  Nunca migrar pdf.js (worker) y firebase (compat) en el mismo paso.
- **56 funciones cableadas desde `onclick`/`oninput`/etc. del HTML deben seguir en `window`.**
  Al final de cada módulo: `Object.assign(window, {...})`. Ver lista `windowExposed` abajo.
- **Ciclos se rompen vía `window.fn?.()`**: `nav` llama a los render por window (no import);
  el triángulo costs↔pricing↔matrices comparte solo los puros (getPCParam, calcCostoARS) por import,
  los re-render cruzados van por window.
- **Encoding**: SIEMPRE leer/escribir estos archivos en UTF-8 (PS: `Get-Content -Encoding utf8` +
  `[IO.File]::WriteAllText(..., UTF8Encoding($false))`). Sin esto, los emojis (🛍️🥇) se corrompen y
  parse5 de Vite rechaza el HTML.
- **Verificar cada paso** contra el baseline (`parkahub/` servido aparte) y **commit** por paso.
  Fingerprint rápido: `nav('analisis')` → `mainLen === 1791`, `--accent === #0D7A52`, 12 secciones, 0 errores.

## Módulos objetivo (src/)

`state` (estado+config), `util` (puros), `core-ui` (toast/sidebar/badges), `core-state` (clearAll/newReport),
`nav` (router), `scan`, `platforms` (ML/TN/Excel), `sales-ml` (manual+VML), `dispatch-pdf` (control PDF),
`costs`, `pricing`, `matrices`, `history`, `report` (charts/dashboard),
`integrations-firebase`, `integrations-gdrive`, `main` (entry/wiring).

## Pasos (checklist)

- [x] **1. Scaffold Vite** sirviendo el monolito intacto. (commit `bbc6f87`)
- [x] **2. Extraer CSS** → `src/style.css`, cargado por `src/main.ts`. (CSS líneas 20-714 del original)
- [x] **3. Extraer TODO el JS** a `src/app.ts` (script principal + 3 MutationObserver inline),
      57 fns en window (try/catch por fn). `// @ts-nocheck`. **Punto de retorno seguro.** Verificado: 57/57 en window, mainLen=1791, 0 errores.
- [ ] 4. `src/state.ts` — objeto mutable `export const S = {...}` con todos los globals; reescribir refs `x` → `S.x` en app.ts. (Decisión: objeto S, no window — bindings claros.)
- [ ] 5. `src/util.ts` (hoja: getRange, normSt, skuSortKey, fARS, fUSD, talleSort…).
- [ ] 6. `src/core-ui.ts` (toggleSidebar, toast, nbadge, refreshHeaders, checkMobile, dz*).
- [ ] 7. `src/integrations-firebase.ts` + `src/integrations-gdrive.ts`.
- [ ] 8. Triángulo `src/costs.ts` → `src/matrices.ts` → `src/pricing.ts` (orden hoja→raíz, ciclos por window).
- [ ] 9. `src/dispatch-pdf.ts` (pdf.js sigue CDN; cuidar `pdfjsLib.GlobalWorkerOptions.workerSrc`).
- [ ] 10. `src/report.ts` (Chart.js CDN; handleFiles, buildAllCharts, rsmBuild2).
- [ ] 11. `src/history.ts` (historiales + VML_WEEKS v2/v3 + exportHubWithData).
- [ ] 12. `src/platforms.ts` + `src/sales-ml.ts`.
- [ ] 13. `src/nav.ts` + `src/core-state.ts` + `src/main.ts` final (reproduce los 4 DOMContentLoaded en orden,
      re-crea los 3 MutationObserver de secciones, resize→checkMobile). app.ts queda vacío.
- [ ] Posterior (fuera de "cero cambio"): apretar tsconfig, migrar libs a npm una por una.

## windowExposed (56)

toggleSidebar, nav, onXLDrop, onXLInput, onTNDrop, onTNInput, filterXL, gdSaveControlToDrive, gdOpenFolder,
gdSaveOrdersToDrive, filterManual, exportManualXL, gdSaveManualToDrive, openModal, preciosRender, matrizRender,
costosModeloRender, costosNuevoArticulo, costosImportXL, costosDescargarPlantilla, costosExportXL, fetchML,
periodToggle, fetchTN, filterPlat, exportPlatXL, onDrop, onFileInput, filterControlTable, clearControl,
confirmControlToHistorial, renderHCargas, clearHCargas, renderHistorial, clearHistorial, exportHistXL,
renderDespachos, clearDesFilters, exportDespachosXL, clearScan, exportScanXL, processScan, saveCfg, gdConnect,
gdDisconnect, gdPickFolder, gdClearFolder, clearAll, vmlDrop2, vmlLoad2, vmlDeleteSelected, vmlSyncFromCloud,
vmlClearAll2, exportHubWithData, vmlRender2, closeModal, saveOrder
