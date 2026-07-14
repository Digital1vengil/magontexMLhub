// ParkaHub — entry point (modularizacion Fase 1).
// Paso 2: por ahora solo carga los estilos. El JS de la app sigue inline en index.html
// y se ira extrayendo a modulos en los pasos siguientes (3..13).
import './style.css'
import './error-guard' // fail-loud: registrar handlers globales ANTES de cualquier init de la app
import './app'
