# parkahub-vite — frontend

Frontend de ParkaHub. **Vanilla TS + Vite, sin framework.** Hosteado en Cloudflare **Pages**
(`parkahub.pages.dev`), detrás de Cloudflare Access. Contexto estratégico + reglas que cruzan repos:
[`../CLAUDE.md`](../CLAUDE.md). Backend: [`../parkahub-api/CLAUDE.md`](../parkahub-api/CLAUDE.md).
Historia completa de cada feature: [`../_context/parkahub-project.md`](../_context/parkahub-project.md).
Plan/reglas del refactor: [`MODULARIZATION-PLAN.md`](MODULARIZATION-PLAN.md) (ojo: su checklist quedó
sin tildar pero la Fase 1 está COMPLETA).

## Cómo está armado

- **Estado global en el objeto `S`** (`src/state.ts`, `export const S = {...}`, `// @ts-nocheck`). TODOS
  los globals que antes eran `let/var` en el monolito viven ahí; las refs son **`S.x`**. Los módulos lo
  importan (`import { S } from './state'`). Incluye scanner, órdenes, excel/control, historial,
  PC_PRODUCTS/PC_PARAMS (costos), VML/VML_WEEKS (ventas ML por semana), reclamos, charts, Google Drive.
- **Módulos en `src/`** (~22 archivos, originalmente 16 de la Fase 1 + agregados en Fase 2): `state`,
  `util` (puros), `core-ui` (toast/sidebar/badges), `core-state` (clearAll/newReport), `nav` (router),
  `scan`, `platforms` (ML/TN/Excel), `sales-ml`, `dispatch-pdf` (parsea Control.pdf), `costs`, `pricing`,
  `matrices`, `history`, `report` (charts/dashboard/rsmBuild2), `integrations-gdrive`,
  `integrations-firebase` (legacy, casi vaciado), `api` (apiGet/Post/Put), `error-guard`, **`promos`**
  (1474 líneas — Promos + Incongruencias + Edición, el módulo más grande), `reclamos`, **`devoluciones`**
  (sección Análisis → Devoluciones: lee `/api/returns`, agrega por modelo reusando el resolver SKU↔modelo
  de `rsmBuild2`; clasifica motivos desde `reason_id` —grande/chico/guía/producto-distinto/arrepentido—,
  cruza con ventas de `VML_WEEKS` para la **tasa % talle s/ventas**, card de motivos con %, y tabla por
  modelo con **filas expandibles** = desglose por talle. Sync resumible `/api/ml/returns-sync`). Entry: `main.ts`.
- **`main.ts`** importa en orden: `style.css` → `error-guard` (PRIMERO, antes que nada) → `app`.
- **`app.ts`** (377 líneas) = wiring, NO lógica: un **MutationObserver por sección** que re-renderiza
  cuando la `.sec` toma `.active` (precios/matrices/costos/análisis/reclamos/devoluciones/promos); `bootstrapState()`
  (llama `/api/sync/tick` para gatillar el sync compartido y luego hidrata de D1); los `DOMContentLoaded` de
  init; las exposiciones residuales a `window`.
- **Ventas ML y Devoluciones se sincronizan SOLAS** (tick al abrir, ver `parkahub-api`). Se retiraron de
  la UI el botón "Sincronizar desde ML" + el drop-zone de Excel de Ventas ML, y el botón de sync de
  Devoluciones (quedan eliminar/exportar/estado). `vmlLoad2` (carga Excel de ventas) está neutralizado
  (early-return con toast). Reclamos SÍ conserva su carga Excel (la API no reproduce ese reporte).
- **`window`-expose**: las ~57 funciones que el HTML llama por `onclick`/`oninput` se exponen en `window`
  (`try{window.fn=fn}catch{}` o `Object.assign(window,{...})` al final del módulo). **Si agregás un
  handler nuevo que el HTML invoca, exponelo en `window` o el `onclick` tira ReferenceError tragado.**
- **Ciclos entre módulos se rompen vía `window.fn?.()`** (ej: `nav` y los re-render cruzados llaman por
  window, no por import; el triángulo costs↔pricing↔matrices comparte solo los puros por import).
- **Persistencia: `localStorage` = cache de arranque, D1 = fuente de verdad.** `bootstrapState()` hace
  migración one-time (flag `parka_d1_migrated`) + GET `/api/state` → hidrata `S` → re-render. Los `save*`
  escriben localStorage + PUT fire-and-forget. Si el backend no responde, queda el cache local.
- **`api.ts`**: `apiGet/apiPost/apiPut` → `/api/*`. En prod lo sirve la Pages Function same-origin
  (`functions/api/[[path]].ts`, reenvía el JWT de Access); en dev `vite.config.ts` proxea `/api` →
  `http://localhost:8787` (hay que levantar el Worker con `wrangler dev` y `DEV_MODE=true`).
- **Libs pesadas por CDN** en el `<head>` de `index.html` (Chart.js, xlsx-js-style, jszip, pdf.js).
  Firebase ya se sacó. Migrar a npm = fase posterior, una lib por commit (pdf.js worker es la riesgosa).
- **Menú** (nav-labels en el sidebar, cada apartado es una `sec-<x>`): Análisis (Resumen / Ventas ML /
  Reclamos / **Devoluciones**), **Incongruencias**
  (Stock / Caídas de stock / Guía de talles / Descripción / Precios), **Edición** (Descripción), Precios,
  Operaciones, Control, Sistema, + Promos y Reclamos. Cada grupo crece con nuevos apartados que pida Martin.

## Gotchas (costaron tiempo — no repetir)

- **Encoding UTF-8 SIN BOM, SIEMPRE**, al leer/escribir `index.html`. En PowerShell: `Get-Content -Encoding
  utf8` + `[IO.File]::WriteAllText(path, txt, (New-Object Text.UTF8Encoding($false)))`. Sin esto los emojis
  (🛍️🥇) se corrompen y **parse5 de Vite rechaza el HTML**.
- **Spreads `...X` que el refactor de estado NO reescribió a `...S.X`**: dejaron ~13 `ReferenceError`
  latentes que **`vite build` NO detecta** (solo explotan en runtime). Al tocar estado, verificar
  navegando las secciones reales.
- **`refreshDB()`**: bug PREEXISTENTE del baseline (se llamaba 8 veces, nunca se definía). **Ya está
  arreglado** (commit `17ff38e` — todos los `refreshDB` colgantes resueltos: clearAll/newReport/
  processXLFiles/tnMergeWithML/saveOrder/deleteOrder). No reintroducirlo.
- **NO usar diálogos del navegador** (`alert`/`confirm`/`prompt`): el Chrome de Martin los suprime →
  el flujo se rompe en silencio. Todo va **in-page**: confirmaciones peligrosas con **doble-clic**
  (1er clic arma botón rojo + warning, 2do ejecuta, timeout 12s); inputs in-page en vez de `prompt()`.
  Helpers reusables en `core-ui.ts` (usalos en vez de rodar el patrón a mano): **`confirm2(key,msg)`**
  = doble-clic con aviso por toast (12s; `key` distingue botones por-fila, ej. `'delOrder:'+i`) y
  **`uiPrompt(title,fields,okLabel)`** = modal de inputs → `Promise<{...}|null>`. El doble-clic inline
  que arma el PROPIO botón en rojo (promos/edición, paths de plata) sigue vivo para esos casos.
- **Verificación con Preview/headless NO sirve para el contenido**: Claude Preview **no renderiza el área
  de contenido** de parkahub (todas las `.sec` colapsan a altura 0 por el `display:flex`). Verificar por
  **estructura DOM** (`querySelector('#sec-x .sec-body #el')`), NO por screenshot ni `offsetHeight`. Y
  verificar el **flujo de nav REAL** (`nav('costos')` con la clase `.active`), no forzando `display:block`
  (oculta bugs de layout — pasó con el panel de Margen invisible).
- **Estado compartido `_items`/`_catalog`**: si Martin busca en Promos al mismo tiempo que vos al
  verificar, los resultados se mezclan → buscar/verificar uno a la vez.
- **Scans parciales NO se cachean ni se suben al almacén** (un batch caído contaminaría a Gonzalo): hay
  flag de completitud; un scan a medias queda solo en memoria de la sesión.

## Comandos y deploy

```bash
npm install
npm run dev      # Vite dev, puerto fijo 5183 (proxya /api -> localhost:8787)
npm run build    # build de prod (gatea el deploy en CI)
```

- **Deploy por CI** (`.github/workflows/deploy.yml`): PR a master → preview `pr-N.parkahub.pages.dev`
  (cubierto por Access; pega al backend de **prod**, no ve cambios de backend); push a master → prod.
- Deploy manual (si hace falta): `wrangler pages deploy dist --project-name parkahub --branch main
  --commit-dirty=true`. **GOTCHA: producción es branch `main`**; sin `--branch main` el deploy va a
  Preview (usa el branch git local, que suele ser `master`) y prod no cambia.
- **Fingerprint de verificación**: `nav('analisis')` → 12 `.sec`, ~19+ fns en window, **0 mensajes de
  consola** en la carga (`error-guard` muestra cualquier error no manejado como toast rojo).
