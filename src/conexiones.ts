// @ts-nocheck
// ParkaHub — módulo CONEXIONES: centraliza los links de Apps Script (Drive) del
// Scanner y del Inventario, las carpetas de Drive, y la conexión OAuth de ParkaHub.
// Todo vive en localStorage del MISMO origen (github.io), así que editar acá
// actualiza de verdad la config que leen el scanner y el inventario.
import { toast, confirm2 } from './core-ui'

// --- claves que usan las apps (mismas del scanner e inventario) ---
const K_SCANNER = 'parka_gdrive_url'        // scanner: URL Apps Script (texto plano)
const K_INV     = 'inv_drive_v2'            // inventario: URL Apps Script (JSON)
const K_FLEX    = 'parka_gd_flex_id'        // carpeta Flex (override)
const K_COLECTA = 'parka_gd_colecta_id'     // carpeta Colecta (override)
const K_CLIENT  = 'parka_gd_client_id'      // OAuth Client ID de ParkaHub

const DEF_SCANNER = 'https://script.google.com/macros/s/AKfycbwP_qnW67-sO-EMCyZSVStCkRXCXtNT7mDE-l-z6vqGFbmZVumhMf7KBTxMiXfZeu-X/exec'
const DEF_FLEX    = '1dhCrQ7mYCv5HqweRDaF_y4TPPGAPegOl'
const DEF_COLECTA = '1injla5TUawsfmCYcJsPA83xkoqF3r-Ng'

const val = id => { const e = document.getElementById(id); return e ? String(e.value||'').trim() : '' }
const setv = (id,v) => { const e = document.getElementById(id); if(e) e.value = (v==null?'':v) }

function readInvUrl(){ try{ return JSON.parse(localStorage.getItem(K_INV)||'""') || '' }catch(e){ return localStorage.getItem(K_INV)||'' } }

// Rellena todos los campos del panel desde localStorage
export function conxInit(){
  if(!document.getElementById('conx-scanner-url')) return
  const sc = localStorage.getItem(K_SCANNER)
  setv('conx-scanner-url', (sc && sc !== '__DISABLED__') ? sc : (sc === '__DISABLED__' ? '' : DEF_SCANNER))
  setv('conx-inv-url', readInvUrl())
  setv('conx-flex', localStorage.getItem(K_FLEX) || DEF_FLEX)
  setv('conx-colecta', localStorage.getItem(K_COLECTA) || DEF_COLECTA)
  setv('conx-clientid', localStorage.getItem(K_CLIENT) || '')
}

export function conxSaveScanner(){
  const u = val('conx-scanner-url')
  if(u && !/^https:\/\/script\.google\.com\/.*\/exec/.test(u)){ toast('La URL debería ser https://script.google.com/.../exec','error'); return }
  localStorage.setItem(K_SCANNER, u || '__DISABLED__')
  toast(u ? 'Link del Scanner guardado' : 'Scanner: Drive desactivado (queda solo local)', 'success')
}
export function conxResetScanner(){
  localStorage.setItem(K_SCANNER, DEF_SCANNER); setv('conx-scanner-url', DEF_SCANNER)
  toast('Link del Scanner restaurado al valor por defecto', 'success')
}
export function conxSaveInv(){
  const u = val('conx-inv-url')
  if(u && !/^https:\/\/script\.google\.com\/.*\/exec/.test(u)){ toast('La URL debería ser https://script.google.com/.../exec','error'); return }
  localStorage.setItem(K_INV, JSON.stringify(u))
  toast(u ? 'Link del Inventario guardado' : 'Inventario: Drive sin configurar', 'success')
}
export function conxSaveFolders(){
  localStorage.setItem(K_FLEX,    val('conx-flex')    || DEF_FLEX)
  localStorage.setItem(K_COLECTA, val('conx-colecta') || DEF_COLECTA)
  toast('Carpetas guardadas. Toman efecto al recargar la app.', 'success')
}
export function conxSaveClientId(){
  const c = val('conx-clientid')
  if(c) localStorage.setItem(K_CLIENT, c); else localStorage.removeItem(K_CLIENT)
  toast('Client ID guardado', 'success')
}

// Probar: Apps Script no permite leer la respuesta por CORS, así que hacemos un
// POST no-cors (igual que las apps) y avisamos que hay que verificar en Drive.
export async function conxTest(which){
  const u = which === 'scanner' ? val('conx-scanner-url') : val('conx-inv-url')
  if(!u){ toast('Primero pegá y guardá la URL','error'); return }
  try{
    await fetch(u, { method:'POST', mode:'no-cors', headers:{'Content-Type':'text/plain;charset=utf-8'}, body: JSON.stringify({test:true, from:'parkahub'}) })
    toast('✓ Solicitud enviada. Apps Script no deja leer la respuesta (CORS): verificá en tu Drive que llegó el registro de prueba.', 'info', 7000)
  }catch(e){ toast('No se pudo contactar la URL. Revisá que sea la /exec correcta.', 'error') }
}
export function conxOpen(which){
  const u = which === 'scanner' ? val('conx-scanner-url') : val('conx-inv-url')
  if(u) window.open(u, '_blank', 'noopener')
}
export function conxCopy(id){
  const v = val(id); if(!v){ return }
  try{ navigator.clipboard.writeText(v); toast('Copiado', 'success') }catch(e){ toast('No se pudo copiar', 'error') }
}
export function conxOpenFolderId(id){
  const v = val(id); if(v) window.open('https://drive.google.com/drive/folders/'+v, '_blank', 'noopener')
}

try{
  window.conxInit = conxInit
  window.conxSaveScanner = conxSaveScanner
  window.conxResetScanner = conxResetScanner
  window.conxSaveInv = conxSaveInv
  window.conxSaveFolders = conxSaveFolders
  window.conxSaveClientId = conxSaveClientId
  window.conxTest = conxTest
  window.conxOpen = conxOpen
  window.conxCopy = conxCopy
  window.conxOpenFolderId = conxOpenFolderId
}catch(e){}
