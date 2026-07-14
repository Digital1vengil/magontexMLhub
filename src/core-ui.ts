// @ts-nocheck
// ParkaHub - core-ui: sidebar mobile, headers, badges, toasts, dropzone. Cero cambios de logica.
import { S } from './state'

// --- MOBILE SIDEBAR ----------------------------------------------------
export function toggleSidebar(){
  document.querySelector('.sidebar').classList.toggle('open');
  document.getElementById('sidebar-overlay').classList.toggle('open');
}

// Auto-show hamburger on mobile
export function checkMobile(){
  const isMob = window.innerWidth <= 768;
  const btn = document.getElementById('mob-menu-btn');
  if(btn) btn.style.display = isMob ? 'flex' : 'none';
}
window.addEventListener('resize', checkMobile);
document.addEventListener('DOMContentLoaded', checkMobile);

export function refreshHeaders(){const ml=S.platOrders.filter(o=>o.platform==='ml').length,tn=S.platOrders.filter(o=>o.platform==='tn').length,man=S.manualOrders.length;document.getElementById('h-ml').textContent=ml||'--';document.getElementById('h-tn').textContent=tn||'--';document.getElementById('h-man').textContent=man||'--';document.getElementById('h-total').textContent=(ml+tn+man)||'--';}
export function nbadge(id,n){const e=document.getElementById(id);if(e){e.style.display=n>0?'':'none';e.textContent=n;}}
export function toast(msg,type='info',ms=4000){const c=document.getElementById('toasts'),el=document.createElement('div');el.className=`toast ${type}`;el.innerHTML=`<span>${{success:'✓',error:'✕',info:'ℹ'}[type]||'->'}</span><span>${msg}</span>`;c.appendChild(el);setTimeout(()=>el.remove(),ms);}

// --- IN-PAGE CONFIRM (regla dura: NADA de confirm()/prompt() del navegador — el Chrome de Martin los
// suprime y devuelven "cancelar" sin avisar → los botones quedaban muertos). Doble-clic EN PANTALLA:
// 1er clic ARMA + avisa por toast, 2do clic (misma acción) dentro de 12s CONFIRMA. `key` identifica la
// acción; en botones por-fila incluí el id (ej. 'delOrder:'+i) para que armar una fila no dispare otra.
// Devuelve true SOLO en el 2do clic; en el 1ro devuelve false (el handler simplemente sale). 12s = mismo
// timeout que el doble-clic inline de promos.
let _armKey=''; let _armTimer=null;
export function confirm2(key,msg){
  if(_armKey===key){ clearTimeout(_armTimer); _armKey=''; return true; }
  if(_armTimer) clearTimeout(_armTimer);
  _armKey=key;
  toast('⚠️ '+msg+' Apretá de nuevo para confirmar.','error',12000);
  _armTimer=setTimeout(()=>{ _armKey=''; },12000);
  return false;
}

// --- IN-PAGE PROMPT (reemplaza window.prompt, suprimido en el Chrome de Martin). Modal simple con N
// inputs; resuelve a {key:value,...} (trim) o null si se cancela (Escape / clic afuera / Cancelar).
// fields: [{key, label, value?, type?, placeholder?}]. Enter = Guardar.
export function uiPrompt(title,fields,okLabel){
  const es=s=>String(s==null?'':s).replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
  return new Promise(resolve=>{
    const ov=document.createElement('div');
    ov.style.cssText='position:fixed;inset:0;background:rgba(0,0,0,.5);z-index:99999;display:flex;align-items:center;justify-content:center;padding:16px';
    const box=document.createElement('div');
    box.style.cssText='background:var(--card,#1a1a1a);color:var(--text,#eee);border:1px solid var(--border,#333);border-radius:12px;max-width:440px;width:100%;padding:20px;box-shadow:0 12px 48px rgba(0,0,0,.5)';
    box.innerHTML='<div style="font-weight:700;font-size:15px;margin-bottom:14px">'+es(title)+'</div>';
    const inputs={};
    (fields||[]).forEach(f=>{
      const wrap=document.createElement('label');
      wrap.style.cssText='display:block;margin-bottom:10px;font-size:12px;color:var(--text-soft,#aaa)';
      wrap.textContent=f.label||f.key;
      const inp=document.createElement('input');
      inp.type=f.type||'text'; inp.value=f.value||''; if(f.placeholder)inp.placeholder=f.placeholder;
      inp.style.cssText='width:100%;margin-top:4px;padding:8px 10px;border:1px solid var(--border,#444);border-radius:8px;font-size:14px;background:var(--bg,#111);color:var(--text,#eee);box-sizing:border-box';
      wrap.appendChild(inp); box.appendChild(wrap); inputs[f.key]=inp;
    });
    const rowb=document.createElement('div'); rowb.style.cssText='display:flex;gap:8px;justify-content:flex-end;margin-top:16px';
    const cancel=document.createElement('button'); cancel.className='btn btn-ghost btn-sm'; cancel.textContent='Cancelar';
    const ok=document.createElement('button'); ok.className='btn btn-primary btn-sm'; ok.textContent=okLabel||'Guardar';
    rowb.appendChild(cancel); rowb.appendChild(ok); box.appendChild(rowb); ov.appendChild(box); document.body.appendChild(ov);
    const done=val=>{ document.removeEventListener('keydown',onKey); ov.remove(); resolve(val); };
    const submit=()=>{ const out={}; for(const k in inputs) out[k]=(inputs[k].value||'').trim(); done(out); };
    const onKey=e=>{ if(e.key==='Escape'){ e.preventDefault(); done(null); } else if(e.key==='Enter'){ e.preventDefault(); submit(); } };
    cancel.onclick=()=>done(null); ok.onclick=submit;
    ov.onclick=e=>{ if(e.target===ov) done(null); };
    document.addEventListener('keydown',onKey);
    setTimeout(()=>{ const first=fields&&fields[0]&&inputs[fields[0].key]; if(first) first.focus(); },30);
  });
}

export function dzv(e,c){e.preventDefault();document.getElementById('dz').className='dz '+c;}
export function dzd(e){e.preventDefault();dzv(e,'');if(window.handleFiles)handleFiles(e.dataTransfer.files);}

try{window.toggleSidebar=toggleSidebar;}catch(e){}
