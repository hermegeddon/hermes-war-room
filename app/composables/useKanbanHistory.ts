import type { CompletedTask } from '~/types/mission'

const PAGE_SIZE = 20
/* Auto-refresh cadence when the section is open. Slower than the live board's
   3 s tick because completed tasks don't change once archived — we only need
   to pick up newly-completed ones, which happen at most every few seconds. */
const POLL_MS = 15000

interface HistoryResponse {
  tasks: CompletedTask[]
  nextBefore: number | null
  hasMore: boolean
}

/**
 * Lazy + paginated history of done/archived tasks for the strip below the
 * kanban board. Doesn't fetch until `enable()` is called (i.e. user expands
 * the section), so collapsed boards don't pay the cost.
 *
 * @param missionIdRef Optional mission scope. When the value flips, the
 *   history resets and refetches the first page.
 */
export function useKanbanHistory(missionIdRef?: Ref<string | null>) {
  const tasks = ref<CompletedTask[]>([])
  const enabled = ref(false)
  const loading = ref(false)
  const loadingMore = ref(false)
  const hasMore = ref(false)
  const error = ref<string | null>(null)
  const nextBefore = ref<number | null>(null)

  let pollTimer: ReturnType<typeof setTimeout> | null = null
  let stopped = false

  function url(before?: number): string {
    const params = new URLSearchParams()
    const missionId = missionIdRef?.value
    if (missionId) params.set('mission', missionId)
    if (typeof before === 'number') params.set('before', String(before))
    params.set('limit', String(PAGE_SIZE))
    return `/api/kanban/tasks/history?${params.toString()}`
  }

  async function fetchFirstPage() {
    loading.value = true
    try {
      const res = await $fetch<HistoryResponse>(url())
      tasks.value = res.tasks
      nextBefore.value = res.nextBefore
      hasMore.value = res.hasMore
      error.value = null
    } catch (e) {
      error.value = (e as Error).message
    } finally {
      loading.value = false
    }
  }

  async function loadMore() {
    if (!hasMore.value || loadingMore.value || nextBefore.value == null) return
    loadingMore.value = true
    try {
      const res = await $fetch<HistoryResponse>(url(nextBefore.value))
      tasks.value = [...tasks.value, ...res.tasks]
      nextBefore.value = res.nextBefore
      hasMore.value = res.hasMore
      error.value = null
    } catch (e) {
      error.value = (e as Error).message
    } finally {
      loadingMore.value = false
    }
  }

  /* Re-poll the FIRST page only — newly-completed tasks slot in at the top.
     Older pages already loaded stay where they are; if a row's status flips
     from `done` to `archived` it'll silently get a stale label until the
     section is collapsed and reopened, which is fine for our use case. */
  async function refreshHead() {
    try {
      const res = await $fetch<HistoryResponse>(url())
      const known = new Set(tasks.value.map(t => t.id))
      const fresh = res.tasks.filter(t => !known.has(t.id))
      if (fresh.length > 0) {
        tasks.value = [...fresh, ...tasks.value]
      }
      error.value = null
    } catch (e) {
      error.value = (e as Error).message
    }
  }

  function schedulePoll() {
    if (pollTimer) clearTimeout(pollTimer)
    pollTimer = setTimeout(async () => {
      if (stopped || !enabled.value) return
      await refreshHead()
      schedulePoll()
    }, POLL_MS)
  }

  async function enable() {
    if (enabled.value) return
    enabled.value = true
    await fetchFirstPage()
    schedulePoll()
  }

  function disable() {
    enabled.value = false
    if (pollTimer) clearTimeout(pollTimer)
    pollTimer = null
  }

  /* When the mission scope flips, drop everything we cached and refetch from
     scratch — cached page-2 tasks could belong to a different scope now. */
  if (missionIdRef) {
    watch(missionIdRef, () => {
      tasks.value = []
      nextBefore.value = null
      hasMore.value = false
      if (enabled.value) fetchFirstPage()
    })
  }

  onBeforeUnmount(() => {
    stopped = true
    if (pollTimer) clearTimeout(pollTimer)
  })

  return { tasks, enabled, loading, loadingMore, hasMore, error, enable, disable, loadMore, refreshHead }
}
