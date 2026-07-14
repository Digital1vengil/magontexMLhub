// ParkaHub — guardrail PreToolUse para Edit/Write. [PORTABLE — parkahub-vite]
// Versión portable (Fase 2, 2026-07-11): vive VERSIONADO en parkahub-vite/.claude/hooks/. Deriva la raíz del
// repo de import.meta.url y ancla los matchers a esa raíz. Subset que aplica a vite (sin D1 → sin regla de
// migraciones):
//   1) AUTOPROTECCIÓN (SIN anclar, a propósito): no editar NINGÚN .claude/hooks/* ni settings.json — ni el de
//      este repo ni el de otro repo abierto en la sesión. Un agente no neutraliza defensas; cambiarlas = acción
//      de Martin con OK explícito (los .mjs se re-ejecutan en caliente).
//   2) Ediciones que tocan líneas COUPON|CUPON en src/ de ESTE repo → ask (3ra red de "los cupones NUNCA se
//      tocan"; las otras dos viven en el Worker). Cubre Edit (old_string) Y Write (content).
// Silencio + exit 0 = permitir. Autorizado por Martin 2026-07-06 (v1), 2026-07-07 (v2), 2026-07-11 (v3 portable).
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..').replace(/\\/g, '/')

let input = ''
for await (const chunk of process.stdin) input += chunk
let j = null
try { j = JSON.parse(input) } catch (e) { process.exit(0) }
const tool = j.tool_name || ''
const ti = j.tool_input || {}
const fp = String(ti.file_path || '').replace(/\\/g, '/')
const inRepo = fp.toLowerCase().startsWith(REPO_ROOT.toLowerCase())

const out = (decision, reason) => {
  console.log(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: decision, permissionDecisionReason: reason } }))
  process.exit(0)
}

// (1) Autoprotección de la propia capa de guardrails — SIN anclar (cualquier .claude/hooks/ o settings.json).
if (/\.claude\/hooks\/|\.claude\/settings\.json$/i.test(fp))
  out('deny', 'Editar los hooks de guardrail o settings.json está bloqueado (un agente no neutraliza sus propias defensas). Si hay que cambiarlos, lo hace Martin con OK explícito.')

// (2) Cupones: Edit (old_string) o Write (content) que toquen esas líneas en src/ de ESTE repo.
const coupTxt = tool === 'Edit' ? String(ti.old_string || '') : (tool === 'Write' ? String(ti.content || '') : '')
if (inRepo && /\/src\//.test(fp) && /COUPON|CUPON/i.test(coupTxt))
  out('ask', 'Esta edición toca líneas del código de CUPONES (regla dura: los cupones NUNCA se tocan; doble red en el Worker + esta). Aprobá SOLO si Martin lo pidió explícitamente.')

process.exit(0)
