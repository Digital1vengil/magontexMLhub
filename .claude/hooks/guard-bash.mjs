// ParkaHub — guardrail PreToolUse para comandos de shell (Bash y PowerShell). [PORTABLE — parkahub-vite]
// Versión portable (Fase 2, 2026-07-11): vive VERSIONADO en parkahub-vite/.claude/hooks/ y viaja con cada
// worktree/clon. Deriva la raíz del repo de import.meta.url (no rutas absolutas, no env vars para el cwd de
// los tests). Subset que aplica a vite (sin D1 → sin reglas de SQL destructivo ni de migraciones):
//   1) git push --force / refspec con '+' → NUNCA (pisa el trabajo del otro escritor).
//   2) pages deploy / npm run deploy (sin --dry-run) → deploy salteando push→tests→CI.
//   3) git push → GATE: corre `npm test` && `npm run build` en la raíz de ESTE repo; si falla, bloquea
//      (push a master = deploy a prod vía CI).
// ALCANCE (honesto): protege solo sesiones de Claude Code EN este repo. NO cubre a un colaborador humano con
// push ni un token robado — eso lo cubre la branch protection server-side (pendiente). String-matching no es
// hermético. FP conocido: un commit -m que MENCIONE estos comandos se bloquea (reformulá el mensaje).
// IMPORTANTE: si este hook FALLA AL LANZARSE, Claude Code NO bloquea la tool (fail-open) → verificá el registro
// del hook tras instalar. Silencio + exit 0 = permitir.
// Autorizado por Martin 2026-07-06 (v1), 2026-07-07 (v2), 2026-07-11 (v3 portable).
import { execSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..').replace(/\\/g, '/')

let input = ''
for await (const chunk of process.stdin) input += chunk
let cmd = ''
try { const j = JSON.parse(input); cmd = String((j.tool_input && j.tool_input.command) || '') } catch (e) { process.exit(0) }

const deny = reason => {
  console.log(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason } }))
  process.exit(0)
}

const isPush = /\bgit\b[^\n|;&]*\bpush\b/.test(cmd)

// (1) force-push.
if (isPush && (/(\s--force\b|\s-f\b|\s--force-with-lease\b)/.test(cmd) || /\bpush\b[^\n|;&]*\s\+[^\s]/.test(cmd)))
  deny('git push --force (bandera o refspec con "+") está PROHIBIDO (pisa el trabajo del otro agente). Si el push rebota (non-fast-forward): git pull y reintentá sin force.')

// (2) deploy directo.
if ((/wrangler[^\n|;&]*\b(deploy|pages\s+deploy)\b/.test(cmd) || /\b(npm|pnpm|yarn)\s+run\s+deploy\b/.test(cmd)) && !/--dry-run\b/.test(cmd))
  deny('Deploy directo a prod BLOQUEADO (pages deploy / wrangler deploy saltean push→tests→CI). El deploy va por `git push` a master (lo hace el CI). `--dry-run` sí está permitido.')

// (3) push-gate: tests + build de ESTE repo, en su raíz derivada.
if (isPush) {
  if (!existsSync(REPO_ROOT + '/node_modules'))
    deny('PUSH BLOQUEADO: falta node_modules en ' + REPO_ROOT + ' (worktree/clon sin dependencias). Corré `npm install` acá antes de pushear — el push-gate necesita correr tests y build.')
  const CHECKS = ['npm test', 'npm run build']
  for (const c of CHECKS) {
    try { execSync(c, { cwd: REPO_ROOT, stdio: 'pipe', timeout: 150000 }) }
    catch (e) {
      const out = (String(e.stdout || '') + '\n' + String(e.stderr || '')).slice(-2000)
      deny('PUSH BLOQUEADO: falló "' + c + '" en este repo (push a master = deploy a prod). Arreglá esto antes de pushear:\n' + out)
    }
  }
}
process.exit(0)
