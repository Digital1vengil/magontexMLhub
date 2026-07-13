# ParkaHub — Frontend (Vite + TS)

App de gestión multicanal del seller PARKA (Mercado Libre + Tienda Nube): ventas, costos, históricos,
reclamos, y el módulo **Promos / Incongruencias / Edición**. Hosteada en **Cloudflare Pages**
(`https://parkahub.pages.dev`), detrás de **Cloudflare Access** (login con mail `@magontex.com.ar`).

## Arquitectura

- **Vanilla TS + Vite** (sin framework). Módulos en `src/` (un archivo por área: `promos.ts`, `sales-ml.ts`,
  `costs.ts`, `history.ts`, etc.). Las funciones se exponen en `window.*` para los `onclick` del HTML.
- **No le pega a ML directo**: todo va al BFF vía `src/api.ts` (`apiGet/apiPost/apiPut` → `/api/*`). En prod
  ese `/api/*` lo sirve la Pages Function same-origin (`functions/api/[[path]].ts`) que proxea al Worker
  detrás de Access. En dev, Vite proxea `/api` al Worker local (ver `vite.config.ts`).
- **Almacén compartido**: muchos datos (catálogo, ventas, precios) se leen del Worker (`/api/warehouse`),
  que los precomputa para todos. localStorage es solo cache de arranque; D1 (vía Worker) es la verdad.

## Desarrollo

```bash
npm install
npm run dev      # Vite dev server
npm run build    # build de prod (lo corre el CI)
```

Para pegarle al Worker local en dev, levantá también `parkahub-api` con `wrangler dev` y revisá el
proxy de `vite.config.ts`.

## Deploy

CI en `.github/workflows/deploy.yml`:
- **PR a master** → deploy de PREVIEW (URL única `pr-<n>.parkahub.pages.dev`, cubierta por Access).
  Ojo: los cambios de **backend** no se ven en el preview (pega al Worker de **producción**).
- **Push a master** → deploy a producción (branch `main` de Pages).

## Reglas duras (no romper)

- **Nada de diálogos del navegador** (`alert`/`confirm`/`prompt`): el Chrome de Martin los suprime y
  devuelven “cancelar” sin avisar. Las confirmaciones peligrosas (escribir en ML) van **en pantalla**
  con doble-clic (patrón `_armExec`/`_armLeave`: primer clic arma + warning, segundo ejecuta, timeout 12s).
- **Cupones NUNCA**: el módulo de promos solo toca promociones (el Worker saltea cupones igual, doble red).
- **Copy en español rioplatense**, natural (no poético).
- **Scans parciales no se comparten**: si un escaneo en vivo (ventas/precios) falló a mitad, queda en
  memoria para la sesión pero NO se cachea ni se sube al almacén compartido (no contaminar a Gonzalo).
- **item_id no es estable**: reutilizan publicaciones (misma publicación, otra campera adentro). El índice
  cacheado envejece → TTL corto + mostrar antigüedad + botón Reindexar. La verdad actual sale del resolve
  en vivo (título/imagen/MODEL).

## El backend

Ver `../parkahub-api/README.md` para endpoints, almacén, cron, re-auth de ML y migraciones.
