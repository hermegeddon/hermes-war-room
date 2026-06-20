import { spawn } from 'node:child_process'
import { useDb } from './db'
import { getKanbanDb } from './kanban'

export interface RunResult {
  code: number
  stdout: string
  stderr: string
}

/**
 * Spawn the `hermes` CLI with the given args. Single shared helper so we
 * don't sprinkle ad-hoc child_process plumbing across api/util files. The
 * shape mirrors `server/utils/tools.ts`'s private runHermes() — extracted
 * here because both `tools.ts` and the new triage flow need it.
 */
export function runHermes(args: string[]): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn('hermes', args, { stdio: ['ignore', 'pipe', 'pipe'] })
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (d: string) => {
      stdout += d
    })
    child.stderr.on('data', (d: string) => {
      stderr += d
    })
    child.on('error', reject)
    child.on('close', (code: number | null) => resolve({ code: code ?? -1, stdout, stderr }))
  })
}

/**
 * Hermes' --json output sometimes precedes the JSON with warnings or banner
 * lines. Find the first `{` and parse from there, returning null on any
 * malformed input. Generic over the expected shape so callers can narrow.
 */
export function parseKanbanJson<T = Record<string, unknown>>(text: string | null | undefined): T | null {
  if (!text) return null
  const start = text.indexOf('{')
  if (start < 0) return null
  try {
    return JSON.parse(text.slice(start)) as T
  } catch {
    return null
  }
}

export interface TriageCreateResult {
  taskId: string
  raw: Record<string, unknown>
}

export interface DecomposeResult {
  taskId: string
  childIds: string[]
  reason?: string
  newTitle?: string
  raw: Record<string, unknown>
}

interface KanbanTaskStateRow {
  id: string
  title: string
  status: string
}

interface KanbanTaskEventRow {
  kind: string
  payload: string | null
  created_at: number
}

function normalizeTaskIds(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value
    .map(c => typeof c === 'string'
      ? c
      : (typeof c === 'object' && c && typeof (c as { id?: unknown }).id === 'string'
          ? (c as { id: string }).id
          : null))
    .filter((c): c is string => typeof c === 'string' && /^t_/.test(c))
}

function extractChildIdsFromDecomposedEvent(payload: string | null): string[] {
  if (!payload) return []
  try {
    const parsed = JSON.parse(payload) as { child_ids?: unknown }
    return normalizeTaskIds(parsed.child_ids)
  } catch {
    return []
  }
}

export function decomposeResultFromParsed(
  taskId: string,
  parsed: {
    task_id?: unknown
    fanout?: unknown
    child_ids?: unknown
    children?: unknown
    reason?: unknown
    new_title?: unknown
  }
): DecomposeResult {
  const rawChildIds = Array.isArray(parsed.child_ids)
    ? parsed.child_ids
    : (Array.isArray(parsed.children) ? parsed.children : [])
  return {
    taskId,
    childIds: normalizeTaskIds(rawChildIds),
    reason: typeof parsed.reason === 'string' ? parsed.reason : undefined,
    newTitle: typeof parsed.new_title === 'string' ? parsed.new_title : undefined,
    raw: parsed as Record<string, unknown>
  }
}

/**
 * `hermes kanban decompose <id> --json` is expected to print a JSON object,
 * but the CLI has occasionally completed the DB mutation while producing an
 * empty stdout pipe under the Nuxt child-process path. Do not strand the War
 * Room in that already-mutated state: if the command exited 0 but stdout was
 * empty/malformed, read the canonical Kanban DB and reconstruct the launch
 * result from the task's persisted status/decomposition event.
 */
export function recoverDecomposeFromKanbanState(taskId: string): DecomposeResult | null {
  const db = getKanbanDb()
  if (!db) return null

  const task = db.prepare(
    'SELECT id, title, status FROM tasks WHERE id = ?'
  ).get(taskId) as unknown as KanbanTaskStateRow | undefined
  if (!task) return null

  const events = db.prepare(
    `SELECT kind, payload, created_at FROM task_events
     WHERE task_id = ?
     ORDER BY created_at DESC, id DESC
     LIMIT 20`
  ).all(taskId) as unknown as KanbanTaskEventRow[]

  let childIds: string[] = []
  for (const event of events) {
    if (event.kind !== 'decomposed') continue
    childIds = extractChildIdsFromDecomposedEvent(event.payload)
    if (childIds.length > 0) break
  }

  if (childIds.length === 0) {
    const links = db.prepare(
      'SELECT parent_id FROM task_links WHERE child_id = ? ORDER BY parent_id'
    ).all(taskId) as unknown as { parent_id: string }[]
    childIds = normalizeTaskIds(links.map(l => l.parent_id))
  }

  // No evidence of a successful decompose/specify-style promotion yet.
  if (task.status === 'triage' && childIds.length === 0) return null

  return {
    taskId,
    childIds,
    raw: {
      task_id: taskId,
      ok: true,
      recovered_from: 'kanban_state_after_empty_decompose_stdout',
      fanout: childIds.length > 0,
      child_ids: childIds,
      task_status: task.status,
      task_title: task.title
    }
  }
}

export interface SpecifyResult {
  taskId: string
  reason?: string
  newTitle?: string
  raw: Record<string, unknown>
}

/**
 * Create a task in the `triage` column. The task waits for `decompose` or
 * `specify` to take it to the next status. Uses `--idempotency-key` so
 * accidental retries (frontend double-click, network hiccup) return the same
 * task id instead of spawning duplicates.
 */
export async function createTriageTask(opts: {
  title: string
  body?: string
  idempotencyKey?: string
}): Promise<TriageCreateResult> {
  const title = opts.title.trim()
  if (!title) throw new Error('createTriageTask: title required')

  const args = ['kanban', 'create', title, '--triage', '--json']
  if (opts.body && opts.body.trim()) {
    args.push('--body', opts.body)
  }
  if (opts.idempotencyKey) {
    args.push('--idempotency-key', opts.idempotencyKey)
  }

  const { code, stdout, stderr } = await runHermes(args)
  if (code !== 0) {
    throw new Error(stderr.trim() || `hermes kanban create exited ${code}`)
  }

  const parsed = parseKanbanJson<{ id?: unknown }>(stdout)
  const id = parsed?.id
  if (typeof id !== 'string' || !/^t_/.test(id)) {
    throw new Error(`hermes kanban create returned no task id (stdout: ${stdout.slice(0, 200)})`)
  }
  return { taskId: id, raw: parsed as Record<string, unknown> }
}

/**
 * Run the decomposer on a triage task. Produces a small graph of child
 * tasks routed to the best-fit profiles (per their descriptions).
 */
export async function decomposeTask(taskId: string): Promise<DecomposeResult> {
  if (!taskId) throw new Error('decomposeTask: taskId required')
  const { code, stdout, stderr } = await runHermes(['kanban', 'decompose', taskId, '--json'])
  if (code !== 0) {
    throw new Error(stderr.trim() || `hermes kanban decompose exited ${code}`)
  }
  const parsed = parseKanbanJson<{
    task_id?: unknown
    fanout?: unknown
    child_ids?: unknown
    children?: unknown
    reason?: unknown
    new_title?: unknown
  }>(stdout)
  if (parsed) return decomposeResultFromParsed(taskId, parsed)

  const recovered = recoverDecomposeFromKanbanState(taskId)
  if (recovered) {
    console.warn(`[triage] recovered ${taskId} from Kanban state after empty/malformed decompose stdout`)
    return recovered
  }

  const stderrPart = stderr.trim() ? `, stderr: ${stderr.slice(0, 200)}` : ''
  throw new Error(`hermes kanban decompose returned no JSON (stdout: ${stdout.slice(0, 200)}${stderrPart})`)
}

/**
 * Single-task specifier rewrite (no fan-out). Promotes the task to `todo`
 * with a fleshed-out body but does not split it into children.
 */
export async function specifyTask(taskId: string): Promise<SpecifyResult> {
  if (!taskId) throw new Error('specifyTask: taskId required')
  const { code, stdout, stderr } = await runHermes(['kanban', 'specify', taskId, '--json'])
  if (code !== 0) {
    throw new Error(stderr.trim() || `hermes kanban specify exited ${code}`)
  }
  const parsed = parseKanbanJson<{
    task_id?: unknown
    reason?: unknown
    new_title?: unknown
  }>(stdout)
  if (!parsed) {
    throw new Error(`hermes kanban specify returned no JSON (stdout: ${stdout.slice(0, 200)})`)
  }
  return {
    taskId,
    reason: typeof parsed.reason === 'string' ? parsed.reason : undefined,
    newTitle: typeof parsed.new_title === 'string' ? parsed.new_title : undefined,
    raw: parsed as Record<string, unknown>
  }
}

/**
 * Full triage launch: create the parking task, then immediately decompose
 * it. Persists the resulting triage_task_id back to the mission row so
 * subsequent reads know this mission is in supervisor mode.
 */
export async function launchTriage(opts: {
  missionId: string
  title: string
  body?: string
}): Promise<{ triageTaskId: string, decompose: DecomposeResult }> {
  const created = await createTriageTask({
    title: opts.title,
    body: opts.body,
    idempotencyKey: `mission:${opts.missionId}`
  })

  let decomposed: DecomposeResult
  try {
    decomposed = await decomposeTask(created.taskId)
  } catch (e) {
    /* Stash the triage_task_id anyway so the supervisor preamble can take
       over even if the decomposer failed — the user can hit "Decompose"
       manually on the kanban card. */
    persistTriageTaskId(opts.missionId, created.taskId)
    throw e
  }

  persistTriageTaskId(opts.missionId, created.taskId)
  return { triageTaskId: created.taskId, decompose: decomposed }
}

function persistTriageTaskId(missionId: string, triageTaskId: string): void {
  useDb()
    .prepare('UPDATE missions SET triage_task_id = ?, latest_triage_draft = NULL WHERE id = ?')
    .run(triageTaskId, missionId)
}

/* ---------- TRIAGE_DRAFT block detection in orchestrator output ----------

   Two accepted shapes, listed in detection order:

     1. Fenced code block (current, robust against markdown rendering and
        models that strip HTML-looking tags):
            ```triage
            Title: …
            Body:
            …
            ```
        Also accepts ```triage_draft and ```triage-draft.

     2. Legacy double-angle marker (kept so historical messages still parse,
        but new preambles tell the model to use the fence):
            <<TRIAGE_DRAFT>>
            Title: …
            Body:
            …
            <</TRIAGE_DRAFT>>

   The original `<<TRIAGE_DRAFT>>` was deceptively HTML-like — qwen3.6
   stripped the inner tag content and emitted only `<>…<>`, which never
   matched the regex and left users with a draft visible in the bubble but
   no panel + no launch button.                                            */

const TRIAGE_FENCE_RE = /```(?:triage(?:_draft|-draft)?)\s*\n([\s\S]*?)```/i
const TRIAGE_LEGACY_RE = /<<TRIAGE_DRAFT>>([\s\S]*?)<<\/TRIAGE_DRAFT>>/

/**
 * Combined regex used by frontend strippers / detectors to remove either
 * shape from the rendered chat bubble. Exported so the markdown layer and
 * the MissionPanel keep a single source of truth on what counts as a draft
 * block.
 */
export const TRIAGE_DRAFT_BLOCK_RE = new RegExp(
  `${TRIAGE_FENCE_RE.source}|${TRIAGE_LEGACY_RE.source}`,
  'gi'
)

export interface TriageDraft {
  title: string
  body: string
}

export function extractTriageDraft(text: string): TriageDraft | null {
  /* Prefer the most recent block, regardless of which shape — if the model
     emits both (rewrite mid-turn) we want the last word. */
  let lastInner: string | null = null
  const combined = new RegExp(
    `${TRIAGE_FENCE_RE.source}|${TRIAGE_LEGACY_RE.source}`,
    'gi'
  )
  for (const m of text.matchAll(combined)) {
    /* Capture group 1 is the fence payload; group 2 is the legacy payload.
       Pick whichever one matched. */
    lastInner = (m[1] ?? m[2] ?? '').trim() || lastInner
  }
  if (lastInner === null) return null
  let title = ''
  let body = ''
  let mode: 'title' | 'body' = 'title'
  const bodyLines: string[] = []
  for (const rawLine of lastInner.split('\n')) {
    const line = rawLine.replace(/\r$/, '')
    const titleMatch = /^\s*Title:\s*(.*)$/i.exec(line)
    if (titleMatch && mode === 'title') {
      title = titleMatch[1]!.trim()
      continue
    }
    if (/^\s*Body:\s*(.*)$/i.test(line)) {
      mode = 'body'
      const after = line.replace(/^\s*Body:\s*/i, '')
      if (after.trim()) bodyLines.push(after)
      continue
    }
    if (mode === 'body') {
      bodyLines.push(line)
    }
  }
  body = bodyLines.join('\n').trim()
  if (!title && !body) return null
  return { title, body }
}
