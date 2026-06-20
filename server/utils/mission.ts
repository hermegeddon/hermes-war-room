import { randomUUID } from 'node:crypto'
import { useDb, type MissionRow, type MissionMessageRow } from './db'

const TITLE_MAX_LEN = 80

/**
 * Map an internal mission row to the shape the frontend consumes. Includes
 * the triage-related fields (mode, triageTaskId, latestTriageDraft) so the
 * UI can pick the right rendering branch — chat vs supervisor vs draft
 * panel — without a second roundtrip.
 */
export function serializeMission(m: MissionRow): {
  id: string
  orchestratorSlug: string
  acpSessionId: string | null
  title: string | null
  status: string
  createdAt: string
  lastMessageAt: string
  mode: string
  triageTaskId: string | null
  latestTriageDraft: { title: string, body: string, messageId: number | null } | null
} {
  let draft: { title: string, body: string, messageId: number | null } | null = null
  if (!m.triage_task_id && m.latest_triage_draft) {
    try {
      draft = JSON.parse(m.latest_triage_draft)
    } catch { /* corrupted row — surface as no-draft. */ }
  }
  return {
    id: m.id,
    orchestratorSlug: m.orchestrator_slug,
    acpSessionId: m.acp_session_id,
    title: m.title,
    status: m.status,
    createdAt: m.created_at,
    lastMessageAt: m.last_message_at,
    mode: m.mode ?? 'conversational',
    triageTaskId: m.triage_task_id,
    latestTriageDraft: draft
  }
}

export function summarizeTitle(text: string): string {
  const trimmed = text.replace(/\s+/g, ' ').trim()
  return trimmed.length > TITLE_MAX_LEN ? trimmed.slice(0, TITLE_MAX_LEN - 1) + '…' : trimmed
}

export function getActiveMission(orchestratorSlug: string): MissionRow | null {
  const db = useDb()
  const row = db.prepare(
    `SELECT * FROM missions
     WHERE orchestrator_slug = ? AND status = 'open'
     ORDER BY last_message_at DESC
     LIMIT 1`
  ).get(orchestratorSlug) as unknown as MissionRow | undefined
  return row ?? null
}

export function getMission(id: string): MissionRow | null {
  const db = useDb()
  const row = db.prepare('SELECT * FROM missions WHERE id = ?').get(id) as unknown as MissionRow | undefined
  return row ?? null
}

export function listMessages(missionId: string): MissionMessageRow[] {
  const db = useDb()
  return db.prepare(
    'SELECT * FROM mission_messages WHERE mission_id = ? ORDER BY id ASC'
  ).all(missionId) as unknown as MissionMessageRow[]
}

export type MissionMode = 'conversational' | 'direct-triage'

export function createMission(
  orchestratorSlug: string,
  firstMessage: string,
  opts: { mode?: MissionMode } = {}
): MissionRow {
  const db = useDb()
  const id = randomUUID()
  const now = new Date().toISOString()
  const title = summarizeTitle(firstMessage)
  const mode: MissionMode = opts.mode ?? 'conversational'

  /* Auto-archive any open mission this orchestrator already has. We only
     allow ONE open mission per orchestrator at a time — the alternative
     (multiple open missions silently coexisting) leaves orphan rows whose
     `mission_watched_tasks` never get cleaned and whose `acp_session_id`
     would mix contexts if the user reopened the old one.
     We collect the ids first so callers (auto-nudge, etc.) can react. */
  const orphans = db
    .prepare(`SELECT id FROM missions WHERE orchestrator_slug = ? AND status = 'open'`)
    .all(orchestratorSlug) as { id: string }[]
  if (orphans.length > 0) {
    db.prepare(
      `UPDATE missions SET status = 'archived' WHERE orchestrator_slug = ? AND status = 'open'`
    ).run(orchestratorSlug)
    /* Drop their watched tasks — those rows scoped the old mission's view,
       and the new mission starts with a clean slate. */
    const ids = orphans.map(o => o.id)
    const placeholders = ids.map(() => '?').join(',')
    db.prepare(
      `DELETE FROM mission_watched_tasks WHERE mission_id IN (${placeholders})`
    ).run(...ids)
  }

  db.prepare(
    `INSERT INTO missions (id, orchestrator_slug, title, status, mode, created_at, last_message_at)
     VALUES (?, ?, ?, 'open', ?, ?, ?)`
  ).run(id, orchestratorSlug, title, mode, now, now)
  return getMission(id)!
}

export function setAcpSessionId(id: string, acpSessionId: string): void {
  const db = useDb()
  db.prepare('UPDATE missions SET acp_session_id = ? WHERE id = ?').run(acpSessionId, id)
}

/**
 * Persist the latest TRIAGE_DRAFT block detected in an orchestrator turn so
 * a tab joining mid-conversation can re-render the launch panel without
 * waiting for a fresh chunk. Stored as JSON `{title, body, messageId}`.
 */
export function setLatestTriageDraft(
  missionId: string,
  draft: { title: string, body: string, messageId: number | null } | null
): void {
  const db = useDb()
  db.prepare('UPDATE missions SET latest_triage_draft = ? WHERE id = ?')
    .run(draft ? JSON.stringify(draft) : null, missionId)
}

/** Set the kanban triage_task_id this mission was promoted into. */
export function setTriageTaskId(missionId: string, triageTaskId: string | null): void {
  const db = useDb()
  db.prepare('UPDATE missions SET triage_task_id = ? WHERE id = ?')
    .run(triageTaskId, missionId)
}

export function appendMessage(missionId: string, role: 'user' | 'assistant', content: string): MissionMessageRow {
  const db = useDb()
  const now = new Date().toISOString()
  const result = db.prepare(
    `INSERT INTO mission_messages (mission_id, role, content, created_at)
     VALUES (?, ?, ?, ?)`
  ).run(missionId, role, content, now)
  db.prepare('UPDATE missions SET last_message_at = ? WHERE id = ?').run(now, missionId)
  const insertedId = Number(result.lastInsertRowid)
  return {
    id: insertedId,
    mission_id: missionId,
    role,
    content,
    created_at: now
  }
}

export function updateMessage(messageId: number, content: string): void {
  const db = useDb()
  db.prepare('UPDATE mission_messages SET content = ? WHERE id = ?').run(content, messageId)
}

export function archiveMission(id: string): void {
  const db = useDb()
  db.prepare(`UPDATE missions SET status = 'archived' WHERE id = ?`).run(id)
}

/**
 * List missions, newest first. Optional filters by status and orchestrator.
 * Used by the /missions browse page to show history.
 */
export function listMissions(opts: {
  status?: 'open' | 'archived'
  orchestratorSlug?: string
  limit?: number
  offset?: number
} = {}): MissionRow[] {
  const db = useDb()
  const conds: string[] = []
  const params: unknown[] = []
  if (opts.status) {
    conds.push('status = ?')
    params.push(opts.status)
  }
  if (opts.orchestratorSlug) {
    conds.push('orchestrator_slug = ?')
    params.push(opts.orchestratorSlug)
  }
  const where = conds.length ? `WHERE ${conds.join(' AND ')}` : ''
  const limit = Math.max(1, Math.min(opts.limit ?? 50, 200))
  const offset = Math.max(0, opts.offset ?? 0)
  return db.prepare(
    `SELECT * FROM missions ${where}
     ORDER BY last_message_at DESC
     LIMIT ? OFFSET ?`
  ).all(...params as never[], limit, offset) as unknown as MissionRow[]
}

/** Total mission count for pagination headers. Optionally filters by status. */
export function countMissions(opts: {
  status?: 'open' | 'archived'
  orchestratorSlug?: string
} = {}): number {
  const db = useDb()
  const conds: string[] = []
  const params: unknown[] = []
  if (opts.status) {
    conds.push('status = ?')
    params.push(opts.status)
  }
  if (opts.orchestratorSlug) {
    conds.push('orchestrator_slug = ?')
    params.push(opts.orchestratorSlug)
  }
  const where = conds.length ? `WHERE ${conds.join(' AND ')}` : ''
  return (db.prepare(`SELECT COUNT(*) as c FROM missions ${where}`).get(...params as never[]) as { c: number }).c
}
