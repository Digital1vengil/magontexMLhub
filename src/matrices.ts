// @ts-nocheck
// ParkaHub — modulo MATRICES (matriz de precios por plan de financiacion).
// Funcion movida TAL CUAL desde app.ts. Cero cambio de logica.
// Estado compartido via S (./state). Helpers puros via ./util.
// Costeo (calcCostoARS / getPCParam) via ./costs.
import { S } from './state'
import { fARS, fUSD } from './util'
import { calcCostoARS, getPCParam } from './costs'

const MX_PARAMS=['mx-dolar','mx-iva','mx-iibb','mx-impdc','mx-plat','mx-c6','mx-c3','mx-ib','mx-envio'];
// Rehidratar los inputs desde PC_PARAMS (lo guardado en D1). Se llama SOLO al abrir la sección
// (matrizRender(true)) — NO en cada tecla, para no pisar lo que el usuario está tipeando. Sin esto,
// al refrescar el input carga el default del HTML y matrizRender lo lee/guarda pisando lo editado.
function matrizSyncInputs(){
  MX_PARAMS.forEach(function(k){ var el=document.getElementById(k); if(el && S.PC_PARAMS[k]!=null && S.PC_PARAMS[k]!=='') el.value=S.PC_PARAMS[k]; });
}
export function matrizRender(sync){
  var cont=document.getElementById('mx-content'), empty=document.getElementById('mx-empty');
  if(!cont) return;
  if(sync) matrizSyncInputs();   // al abrir: traer lo guardado ANTES de leer los inputs
  // leer inputs -> PC_PARAMS + persistir (D1 vía savePCParams)
  MX_PARAMS.forEach(function(k){ var el=document.getElementById(k); if(el){ S.PC_PARAMS[k]=parseFloat(el.value)||0; } });
  window.savePCParams?.();
  if(!S.PC_PRODUCTS.length){cont.innerHTML='';empty.style.display='';return;}
  empty.style.display='none';
  var dolar=getPCParam('mx-dolar',getPCParam('cv-dolar-bna',1510)),
      IVA=getPCParam('mx-iva',21)/100,
      iibb=getPCParam('mx-iibb',5)/100,
      impdc=getPCParam('mx-impdc',1.2)/100,
      plat=getPCParam('mx-plat',15.5)/100,
      envio=getPCParam('mx-envio',6500);
  var FEES={cuotas6:getPCParam('mx-c6',12.3)/100,cuotas3:getPCParam('mx-c3',8.4)/100,ib:getPCParam('mx-ib',5)/100,clasica:0};
  var ivaF=1+IVA;
  cont.innerHTML=S.PC_PRODUCTS.map(function(p){
    var costARS=calcCostoARS(p);
    var pvpBase=p.retailPriceFull||costARS*2;
    var planesHTML=S.MX_PLANES.map(function(plan){
      var disc=(p.planMargins&&p.planMargins[plan.id])||0;
      var pvpF=pvpBase*(1-disc/100);
      // Margen NETO de IVA (Responsable Inscripto): el precio se netea (/1.21) y la comisión, la
      // financiación (cuotas) y el envío TAMBIÉN — su IVA es crédito fiscal recuperable. IIBB e
      // Imp. déb/créd NO llevan IVA (impuestos sobre la operación) → se restan directos. Landed ya neto.
      var neto=pvpF/ivaF;
      var comisNet=pvpF*plat/ivaF;                 // comisión ML (base, sin cuotas)
      var finNet=pvpF*(FEES[plan.id]||0)/ivaF;      // costo de las cuotas del plan
      var envNet=envio/ivaF;
      var cIIBB=neto*iibb;                          // IIBB sobre la base neta (ingreso gravado)
      var cImpDC=pvpF*impdc;                        // Imp. déb/créd sobre el monto cobrado
      var util=neto-comisNet-finNet-envNet-cIIBB-cImpDC-costARS;
      var gI=costARS>0?(util/costARS*100):0, gF=pvpF>0?(util/pvpF*100):0, neg=util<0;
      return '<div style="padding:18px;background:var(--surface);border-right:1px solid var(--border);flex:1;min-width:180px">'
        +'<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:14px">'
          +'<span style="font-size:10px;font-weight:800;color:var(--text-muted);text-transform:uppercase;letter-spacing:.08em">'+plan.label+'</span>'
          +'<div style="height:3px;width:28px;border-radius:2px;background:'+plan.color+'"></div>'
        +'</div>'
        +'<div style="background:linear-gradient(135deg,var(--accent),var(--teal));padding:10px 14px;border-radius:8px;margin-bottom:12px;display:flex;justify-content:space-between;align-items:center">'
          +'<span style="color:rgba(255,255,255,.8);font-size:9px;font-weight:700;text-transform:uppercase">Precio Final</span>'
          +'<span style="color:#fff;font-weight:800;font-size:15px">'+fARS(pvpF)+'</span>'
        +'</div>'
        +'<div style="font-size:11px;color:var(--text-muted);display:flex;flex-direction:column;gap:3px;margin-bottom:12px">'
          +'<div style="display:flex;justify-content:space-between"><span>Comisión ML</span><span style="color:var(--text-soft)">-'+fARS(comisNet)+'</span></div>'
          +'<div style="display:flex;justify-content:space-between"><span>Cuotas</span><span style="color:var(--text-soft)">-'+fARS(finNet)+'</span></div>'
          +'<div style="display:flex;justify-content:space-between"><span>IIBB</span><span style="color:var(--text-soft)">-'+fARS(cIIBB)+'</span></div>'
          +'<div style="display:flex;justify-content:space-between"><span>Imp. déb/créd</span><span style="color:var(--text-soft)">-'+fARS(cImpDC)+'</span></div>'
          +'<div style="display:flex;justify-content:space-between"><span>Envío</span><span style="color:var(--text-soft)">-'+fARS(envNet)+'</span></div>'
          +'<div style="display:flex;justify-content:space-between;border-top:1px solid var(--border);padding-top:3px"><span>Costo (landed)</span><span style="color:var(--text-soft)">-'+fARS(costARS)+'</span></div>'
        +'</div>'
        +'<div style="text-align:center;margin-bottom:10px">'
          +'<div style="font-size:9px;font-weight:700;color:var(--text-muted);text-transform:uppercase;letter-spacing:.08em;margin-bottom:3px">Utilidad Neta (post-IVA)</div>'
          +'<div style="font-size:22px;font-weight:900;color:'+(neg?'#dc2626':'var(--accent)')+'">'+fARS(util)+'</div>'
        +'</div>'
        +'<div style="background:'+(neg?'#dc2626':'var(--accent)')+';color:#fff;padding:8px 12px;border-radius:7px;display:flex;justify-content:space-between;align-items:center;margin-bottom:5px">'
          +'<span style="font-size:9px;font-weight:700;opacity:.8;text-transform:uppercase">% G / Inversión</span>'
          +'<span style="font-weight:800;font-size:13px">'+gI.toFixed(1)+'%</span>'
        +'</div>'
        +'<div style="background:var(--surface2);padding:8px 12px;border-radius:7px;display:flex;justify-content:space-between;align-items:center">'
          +'<span style="font-size:9px;font-weight:700;color:var(--text-muted);text-transform:uppercase">% G / Facturación</span>'
          +'<span style="font-weight:800;font-size:13px;color:var(--teal)">'+gF.toFixed(1)+'%</span>'
        +'</div>'
        +'</div>';
    }).join('');
    var isML = p.canal==='ML';
    var canalBadge = isML
      ? '<span style="font-size:9px;font-weight:800;background:#FEF3C7;color:#92400E;padding:2px 8px;border-radius:6px">ML</span>'
      : '<span style="font-size:9px;font-weight:800;background:var(--teal-bg,#CFFAFE);color:var(--teal);padding:2px 8px;border-radius:6px">TN</span>';
    return '<div style="background:var(--surface);border-radius:var(--r);border:1px solid var(--border);overflow:hidden;margin-bottom:14px;box-shadow:var(--shadow-card)">'
      +'<div style="padding:16px 20px;border-bottom:1px solid var(--border);display:flex;align-items:center;gap:12px;background:var(--surface2)">'
        +'<div style="width:40px;height:40px;background:linear-gradient(135deg,var(--accent),var(--teal));border-radius:10px;display:flex;align-items:center;justify-content:center;font-size:18px">📦</div>'
        +'<div style="flex:1">'
          +'<div style="display:flex;align-items:center;gap:8px">'
            +'<span style="font-size:16px;font-weight:800;text-transform:uppercase;color:var(--text)">'+p.name+'</span>'
            +canalBadge
          +'</div>'
          +'<div style="display:flex;gap:10px;margin-top:3px;flex-wrap:wrap">'
            +'<span style="font-size:10px;font-weight:700;color:var(--accent);background:var(--accent-light);padding:2px 8px;border-radius:99px;font-family:monospace">'+p.sku+'</span>'
            +'<span style="font-size:10px;color:var(--text-muted)">Costo: '+fARS(costARS)+'</span>'
            +'<span style="font-size:10px;color:var(--text-muted)">FOB: '+fUSD(p.fob)+'</span>'
            +'<span style="font-size:10px;color:var(--text-muted)">PVP: '+fARS(p.retailPriceFull||costARS*2)+'</span>'
          +'</div>'
        +'</div>'
      +'</div><div style="display:flex;flex-wrap:wrap">'+planesHTML+'</div></div>';
  }).join('');
}

try{window.matrizRender=matrizRender;}catch(e){}
