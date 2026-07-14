import { defineConfig } from 'vite'

// ParkaHub — modularizacion Fase 1. Puerto fijo para no chocar con otros dev servers del workspace.
// En dev, /api se proxea al Worker LOCAL (corré `wrangler dev` en parkahub-api; usa .dev.vars con
// DEV_MODE=true, que saltea la validación de JWT de Access para desarrollo).
// En prod, API_BASE='' -> /api lo sirve la Pages Function (functions/api/[[path]].ts) detrás de Access.
export default defineConfig({
  base: './',
  server: {
    port: 5183,
    strictPort: true,
    proxy: { '/api': { target: 'http://localhost:8787', changeOrigin: true } },
  },
  preview: { port: 5183 },
})
