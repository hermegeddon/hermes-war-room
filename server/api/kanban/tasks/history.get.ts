import { listCompletedTasks, type CompletedTask } from '../../../utils/kanban'
import { useDb } from '../../../utils/db'

/**
 * Completed (done / archived) tasks for the history strip below the kanban
 * board. Cursor-paginated by `completed_at` (the column the SELECT orders by)
 * so the client can "Load more" without an offset that drifts as new tasks
 * finish in the meantime.
 *
 * Query params:
 *   - mission   Scope to tasks tied to this mission via `mission_watched_tasks`.
 *   - assignee  Filter by assignee slug.
 *   - before    Cursor — only tasks completed strictly before this Unix-second
 *               timestamp. Omit on the first page.
 *   - limit     1–100, default 20.
 */
export default defineEventHandler((event) => {
  const q = getQuery(event)
  const assignee = typeof q.assignee === 'string' ? q.assignee : undefined
  const mission = typeof q.mission === 'string' ? q.mission : undefined
  const beforeRaw = typeof q.before === 'string' ? Number(q.before) : undefined
  const before = beforeRaw && Number.isFinite(beforeRaw) ? beforeRaw : undefined
  const limitRaw = typeof q.limit === 'string' ? Number(q.limit) : undefined
  const limit = limitRaw && Number.isFinite(limitRaw) ? limitRaw : undefined

  let tasks: CompletedTask[] = listCompletedTasks({ assignee, before, limit })

  if (mission) {
    const rows = useDb()
      .prepare('SELECT task_id FROM mission_watched_tasks WHERE mission_id = ?')
      .all(mission) as { task_id: string }[]
    const allowed = new Set(rows.map(r => r.task_id))
    /* Mission scoping happens AFTER the SQL paginates. That means a page can
       come back partially empty if many of its rows belong to other missions
       — acceptable here because mission scoping is rare in practice and the
       alternative (joining `mission_watched_tasks` inside the kanban DB) is
       impossible: the watch list lives in `data/war-room.db` while the
       tasks live in `~/.hermes/kanban.db`. */
    tasks = tasks.filter(t => allowed.has(t.id))
  }

  /* Cursor for the next page is the lowest `completedAt` (or `createdAt` as
     fallback) we returned. Null when the page came back smaller than the
     requested limit, which we read as "no more rows". */
  const last = tasks[tasks.length - 1]
  const nextBefore = last
    ? (last.completedAt ?? last.createdAt)
    : null
  const hasMore = tasks.length > 0 && tasks.length === (limit ?? 20)

  return { tasks, nextBefore: hasMore ? nextBefore : null, hasMore }
})
