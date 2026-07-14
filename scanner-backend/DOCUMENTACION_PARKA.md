# PARKA · Despacho — Documentación Técnica

> Sistema de control de despachos para Mercado Libre con backend en Google Drive/Sheets

---

## Índice

1. [Arquitectura general](#1-arquitectura-general)
2. [PWA — index.html](#2-pwa--indexhtml)
3. [Google Apps Script — Backend](#3-google-apps-script--backend)
4. [Flujo Iniciar / Finalizar Despacho](#4-flujo-iniciar--finalizar-despacho)
5. [Soporte multi-archivo](#5-soporte-multi-archivo)
6. [Estructura de carpetas en Drive](#6-estructura-de-carpetas-en-drive)
7. [Instalación paso a paso](#7-instalación-paso-a-paso)
8. [Referencia de funciones JS](#8-referencia-de-funciones-js)
9. [Referencia de endpoints Apps Script](#9-referencia-de-endpoints-apps-script)
10. [Notas importantes](#10-notas-importantes)

---

## 1. Arquitectura general

```
┌──────────────────────────────────────────────────────────────┐
│                        USUARIO                               │
│   Celular / PC — GitHub Pages (HTTPS)                        │
└────────────────────────┬─────────────────────────────────────┘
                         │
                    index.html (PWA)
                         │
          ┌──────────────┴──────────────┐
          │                             │
   localStorage                 Google Apps Script
   (offline fallback)           (Web App /exec — fetch POST/GET)
                                        │
                         ┌──────────────┴──────────────┐
                         │                             │
                  Google Sheets                  Google Drive
                  (Session / History)            (PARKA Despacho/)
                                                       │
                                            ┌──────────┴──────────┐
                                            │                     │
                                       2026-07-02/           2026-07-03/
                                            │
                                    Despacho_2026-07-02_10-30.xlsx
```

**Nota sobre `google.script.run`:** esta función solo funciona cuando el HTML es servido por Google Apps Script (HTML Service). Como la app está en GitHub Pages, toda la comunicación con el backend se hace mediante `fetch()` al endpoint `/exec`.

---

## 2. PWA — index.html

### Pantallas

```
┌─────────────────────┐    ┌─────────────────────────────┐
│   SETUP / INICIO    │    │          ESCANER             │
│                     │    │  Total|Pend.|Desp.|Avance%  │
│  Archivos Drive     │    │  [Barras]  [QR]              │
│  > archivo.txt      │───>│  ┌─────────────────────────┐│
│  > archivo2.xlsx    │    │  │       CAMARA             ││
│                     │    │  └─────────────────────────┘│
│  [Iniciar Despacho] │    │  [banner estado]             │
│                     │    │  [entrada manual]            │
│  Google Drive Sync  │    │  [Pendientes] [Despachados]  │
│  Conectado          │    │  ─────────────────────────  │
└─────────────────────┘    │  FAB: teclado, pistola      │
                           │       + Agregar archivos     │
                           │       Iniciar Despacho       │
                           │       Finalizar Despacho     │
                           │       Exportar               │
                           └─────────────────────────────┘
```

### Paleta de colores (modo pruebas)

| Elemento | Color |
|---|---|
| Fondo principal | `#020f0f` |
| Cards / paneles | zinc-800 / zinc-900 |
| Acento principal | teal-600 |
| Marco del escaner | `#2dd4bf` / `#0f766e` |
| Pendientes | amber-400 |
| Despachados | emerald-400 |
| Avance % | teal-400 |

### Archivos del proyecto

| Archivo | Descripcion |
|---|---|
| `index.html` | App completa (HTML + CSS Tailwind CDN + JS inline) |
| `google_apps_script.js` | Backend Google Apps Script |
| `manifest.json` | Config PWA (iconos, nombre, colores) |
| `sw.js` | Service Worker para offline |
| `DOCUMENTACION_PARKA.md` | Este archivo |

---

## 3. Google Apps Script — Backend

### Configuracion del deployment

```
Ejecutar como:      Yo (tu cuenta de Google)
Quien tiene acceso: Cualquier persona   <- CRITICO
```

Cada vez que se agrega codigo nuevo que usa servicios adicionales de Google (Drive, Sheets, UrlFetchApp, etc.) hay que re-autorizar ejecutando `testPing` manualmente y crear una **nueva version** del deployment.

### Scopes requeridos

- `DriveApp` — leer/crear archivos y carpetas en Drive
- `SpreadsheetApp` — leer/escribir sesion e historial; crear Sheets temporales
- `UrlFetchApp` — exportar Sheet a .xlsx via URL interna
- `ScriptApp.getOAuthToken()` — autenticar la llamada de exportacion

---

## 4. Flujo Iniciar / Finalizar Despacho

Este es el flujo principal de trabajo diario.

### Estados de los botones

| Estado | Iniciar | Finalizar |
|---|---|---|
| Sin despacho activo (`idle`) | Habilitado | Deshabilitado (opaco) |
| Despacho activo (`active`) | Deshabilitado — muestra "Despacho activo" | Habilitado |
| Guardando (`saving`) | Deshabilitado | Deshabilitado — muestra "Guardando" |

### Flujo completo

```
1. Cargar archivos desde Drive (setup screen)
2. Tocar "Iniciar Despacho" en setup -> va al escaner
3. En el escaner: tocar "Iniciar Despacho" (FAB)
   -> currentDespacho = []
   -> despachoActive = true
4. Escanear paquetes
   -> cada scan exitoso agrega al array currentDespacho[]
5. Tocar "Finalizar Despacho"
   -> POST /exec con action=procesarExcel
   -> Apps Script: crea Sheet temporal -> exporta .xlsx -> guarda en Drive -> borra Sheet
   -> Toast: "Despacho_2026-07-02_10-30.xlsx guardado (N paquetes)"
   -> Fallback offline: descarga el .xlsx localmente si Drive no responde
```

### Estructura de cada paquete en `currentDespacho[]`

```javascript
{
  'Paquetes Despachados': 1,           // numero secuencial en este despacho
  'Numero de Etiqueta':   '123456789', // trackingId
  'Nombre de la Persona': 'Juan Perez',
  'Cantidad de Prendas':  1,
  'SKU Despachados':      'M112-NEGRO-XL',
}
```

### Lo que crea `procesarYGuardarExcel` en Drive

```
PARKA Despacho/
└── 2026-07-02/
    └── Despacho_2026-07-02_10-30.xlsx   <- archivo final
```

El Sheet temporal `Despacho_2026-07-02` se crea, se usa para generar el .xlsx y luego se mueve a la papelera automaticamente.

---

## 5. Soporte multi-archivo

### Carga desde Drive (pantalla de setup)

- El panel "Archivos en Google Drive" muestra los archivos agrupados por fecha.
- Si hay 2+ archivos en el mismo dia, aparece el boton **"Cargar todos (N archivos)"** que los descarga y fusiona en una sola sesion.
- Un link **"Ver carpeta PARKA Despacho en Drive"** permite verificar que el script apunta a la carpeta correcta.

### Agregar archivos durante el despacho

- En el escaner, el boton FAB **"Agregar archivos"** permite anadir mas ZPL/CSV a la sesion activa sin perder los escaneos ya realizados.
- Los duplicados (mismo `trackingId`) se omiten automaticamente.
- El header muestra `archivo.txt +2 mas` cuando hay multiples fuentes cargadas.

### `mergePackages(newPkgs)` — logica de deduplicacion

```javascript
function mergePackages(newPkgs) {
  const existingIds = new Set(state.packages.map(p => p.trackingId));
  let added = 0;
  for (const p of newPkgs) {
    if (!existingIds.has(p.trackingId)) {
      state.packages.push(p);
      added++;
    }
  }
  return added; // cantidad realmente agregada
}
```

---

## 6. Estructura de carpetas en Drive

```
Mi Drive/
└── PARKA Despacho/              <- carpeta raiz (auto-creada)
    ├── 2026-07-01/
    │   ├── Etiqueta_envio.txt   <- archivos ZPL/CSV subidos manualmente desde la PC
    │   └── Despacho_2026-07-01_09-15.xlsx
    ├── 2026-07-02/
    │   ├── etiquetas.txt
    │   └── Despacho_2026-07-02_10-30.xlsx
    └── ...
```

Los archivos ZPL/CSV deben subirse **manualmente** a la carpeta del dia desde la PC. La app los lee desde ahi pero no los sube.

---

## 7. Instalacion paso a paso

### A. Google Apps Script (primera vez)

1. Abri [sheets.google.com](https://sheets.google.com) y crea una hoja nueva
2. **Extensiones → Apps Script**
3. Borra el codigo existente y pega `google_apps_script.js` completo
4. Guarda con **Ctrl+S**
5. Selecciona la funcion `testPing` → **Ejecutar** → autoriza todos los permisos
6. **Implementar → Nueva implementacion**
   - Tipo: Aplicacion web
   - Ejecutar como: **Yo**
   - Acceso: **Cualquier persona**
7. Copia la URL `/exec`
8. En la PWA: Google Drive Sync → pega la URL → **Conectar**

### B. Actualizar el script (cambios de codigo)

1. Modifica el codigo en el editor de Apps Script
2. Ejecuta `testPing` manualmente para re-autorizar si hay nuevos scopes
3. **Implementar → Administrar implementaciones → editar → Nueva version → Actualizar**

### C. GitHub Pages (hosting HTTPS)

1. Subi `index.html`, `manifest.json`, `sw.js` al repositorio GitHub
2. Settings → Pages → Branch: main → Root → Save
3. URL resultante: `https://tuusuario.github.io/nombrerepo/`

La camara **solo funciona desde HTTPS**. No funciona desde archivos locales.

### D. Uso diario

```
1. Desde la PC: subir archivos ZPL/CSV a "PARKA Despacho / YYYY-MM-DD" en Google Drive
2. Abrir la app en el celular → "Actualizar" en el panel de Drive
3. Tocar el archivo (o "Cargar todos") → pantalla de setup
4. Tocar "Iniciar Despacho" → va al escaner
5. En el escaner: tocar "Iniciar Despacho" (FAB) para comenzar el tracking
6. Escanear paquetes con camara (modo Barras o QR) o pistola laser USB
7. Al terminar: tocar "Finalizar Despacho" → el .xlsx se guarda en Drive
```

---

## 8. Referencia de funciones JS

| Funcion | Descripcion |
|---|---|
| `startScanner(fromGesture)` | Inicia la camara. Requiere gesto de usuario en mobile |
| `processScan(raw)` | Procesa codigo escaneado o manual. Si `despachoActive`, agrega a `currentDespacho[]` |
| `refreshUI()` | Actualiza stats bar, listas, badges y notificacion de completado |
| `startDispatch()` | Valida archivo cargado, crea state, va al escaner |
| `iniciarDespacho()` | Limpia `currentDespacho[]`, activa `despachoActive`, actualiza botones |
| `finalizarDespacho()` | Envia `currentDespacho[]` al backend via POST, guarda .xlsx en Drive |
| `setDespachoUI(phase)` | Actualiza estado visual de botones (`idle` / `active` / `saving`) |
| `mergePackages(newPkgs)` | Agrega paquetes nuevos a sesion activa, deduplicando por `trackingId` |
| `addFilesToSession(files)` | Procesa array de File objects y los fusiona en la sesion activa |
| `loadAllDriveFiles(btn)` | Descarga y carga todos los archivos de un grupo de Drive |
| `exportReport()` | Genera y descarga el XLSX completo de sesion localmente |
| `beginDay()` | Crea la carpeta del dia actual en Drive |
| `saveState()` | Guarda estado en localStorage + Drive |
| `gdriveGet(action, params)` | GET al Apps Script |
| `gdrivePost(action, data)` | POST al Apps Script (devuelve true/false segun HTTP status) |
| `testGDriveUrl(url)` | Verifica que la URL responda. Devuelve `{ok, reason}` |
| `loadDriveFiles()` | Carga y renderiza los archivos disponibles en Drive |
| `toast(msg, type, dur)` | Muestra notificacion temporal (`ok` / `warn` / `error` / `info`) |

---

## 9. Referencia de endpoints Apps Script

### GET `?action=`

| action | Descripcion | Respuesta |
|---|---|---|
| `ping` | Verifica que el script este activo | `{ok:true, version:2}` |
| `session` | Lee la sesion activa (Sheet "Session") | objeto session o null |
| `history` | Lee el historial (Sheet "History", max 50) | array de sesiones |
| `listFiles` | Lista archivos en Drive agrupados por dia | `{rootFolderUrl, groups:[]}` |
| `getFile?fileId=ID` | Devuelve contenido de archivo | `{type, name, content}` |
| `beginDay` | Crea carpeta del dia y devuelve nombre e ID | `{ok, folderName, folderId}` |

### POST (body `{action, data}`)

| action | Descripcion | Respuesta |
|---|---|---|
| `saveSession` | Guarda sesion activa en Sheet "Session" | `{ok:true}` |
| `clearSession` | Archiva sesion al historial y limpia | `{ok:true}` |
| `clearHistory` | Borra todas las filas del historial | `{ok:true}` |
| `saveReport` | Guarda XLSX base64 en subcarpeta `fin del dia` | `{ok:true}` |
| `procesarExcel` | Crea .xlsx desde array de paquetes y guarda en Drive | `{ok, fileName, fileUrl, count}` |

### `procesarExcel` — body de ejemplo

```json
{
  "action": "procesarExcel",
  "data": {
    "fecha": "2026-07-02",
    "datos": [
      {
        "Paquetes Despachados": 1,
        "Numero de Etiqueta": "123456789",
        "Nombre de la Persona": "Juan Perez",
        "Cantidad de Prendas": 1,
        "SKU Despachados": "M112-NEGRO-XL"
      }
    ]
  }
}
```

### `procesarExcel` — logica interna paso a paso

```
1. SpreadsheetApp.create("Despacho_YYYY-MM-DD")   -> Sheet temporal
2. Escribe headers + filas de datos
3. SpreadsheetApp.flush()
4. UrlFetchApp.fetch(url/export?format=xlsx, Bearer token) -> blob .xlsx
5. getTodayFolder().createFile(blob)              -> guarda en Drive
6. DriveApp.getFileById(ssId).setTrashed(true)    -> borra Sheet temporal
7. return { ok, fileName, fileUrl, count }
```

---

## 10. Notas importantes

**Camara en mobile:** la app debe abrirse desde HTTPS (GitHub Pages). No funciona desde `file://` ni localhost sin certificado SSL.

**CORS en Apps Script:** para evitar preflight, usar siempre `Content-Type: text/plain;charset=utf-8` en peticiones POST desde el frontend.

**Re-autorizacion del script:** al agregar codigo con nuevos servicios (`UrlFetchApp`, `ScriptApp`, etc.) ejecutar `testPing` manualmente y crear nueva version del deployment.

**`google.script.run` no compatible:** esa API solo funciona en HTML servido por Google Apps Script (HTML Service). Esta app usa `fetch()` al endpoint `/exec` como equivalente compatible con GitHub Pages.

**Drive URL por dispositivo:** la URL del Apps Script se guarda en `localStorage`. Si se accede desde un navegador o dispositivo nuevo, hay que configurarla de nuevo en la app.

**Fallback offline:** sin conexion o sin Drive configurado, la app funciona con `localStorage`. Al finalizar un despacho sin Drive disponible, el .xlsx se descarga localmente.

**Html5Qrcode "already under transition":** bug del estado interno de la libreria. Fix aplicado: recrear el elemento DOM `#qr-reader` completamente + delay de 500ms antes de reinicializar + retry con nueva instancia si el error persiste.

**Truncacion de archivos:** al editar archivos grandes con herramientas de edicion directa pueden quedar cortados. Usar scripts Python con `str.replace()` para parches criticos en lugar de edicion directa de bloques grandes.
