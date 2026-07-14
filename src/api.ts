// @ts-nocheck
// ParkaHub -> BFF. En prod, /api/* lo sirve la Pages Function same-origin (proxy detras de
// Cloudflare Access); el browser NO manda credenciales (la API key salio del bundle por completo,
// la auth la pone la cookie de Access). En dev, vite proxea /api -> el Worker local (ver vite.config.ts).
export const API_BASE = import.meta.env.VITE_PARKA_API_BASE || ''

// --- Persistencia D1 via Worker -----------------------------------------
// _req devuelve {ok,status,body}: el status permite distinguir 4xx (error del request — no tiene sentido
// reintentar) de 5xx/red (transitorio — reintentable). Las variantes apiGet/Put/Post conservan el contrato
// histórico (body en ok, null en error) para no tocar las ~decenas de callers; las *Ex exponen el objeto
// completo para los pocos lugares que reintentan/avisan distinto según el tipo de error.
async function _req(method, path, body){
  try{
    const res = await fetch(API_BASE + path, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    let data = null; try{ data = await res.json(); }catch(e){}
    return { ok: res.ok, status: res.status, body: data };
  }catch(e){ return { ok:false, status:0, body:null, error:String(e&&e.message||e) }; }
}

export async function apiGet(path){ const r = await _req('GET', path, undefined); return r.ok ? r.body : null; }
export async function apiPut(path, body){ const r = await _req('PUT', path, body); return r.ok ? r.body : null; }
export async function apiPost(path, body){ const r = await _req('POST', path, body); return r.ok ? r.body : null; }

// Variantes con status: {ok, status, body}. status===0 = error de red/timeout; >=500 = servidor (transitorio);
// 4xx = error del request (ej. validación) → mostrar el motivo, NO reintentar.
export async function apiGetEx(path){ return _req('GET', path, undefined); }
export async function apiPutEx(path, body){ return _req('PUT', path, body); }
export async function apiPostEx(path, body){ return _req('POST', path, body); }
