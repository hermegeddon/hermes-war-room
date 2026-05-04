<script setup lang="ts">
import type { Profile } from '~/types/profile'
import type { CompletedTask, CurrentTask } from '~/types/mission'

const { t } = useI18n()

const props = defineProps<{
  tasks: CurrentTask[]
  profiles: Profile[]
}>()

const emit = defineEmits<{
  select: [task: CurrentTask | CompletedTask]
}>()

/* Same shared key the home page writes — reading it here keeps the history
   strip in sync with the page-level mission scope without threading a prop
   through MissionPanel. `useState` returns the same ref across components. */
const scopeMissionId = useState<string | null>('warroom.scopeMissionId', () => null)
const history = useKanbanHistory(scopeMissionId)
const historyOpen = ref(false)
function toggleHistory() {
  historyOpen.value = !historyOpen.value
  if (historyOpen.value) {
    history.enable()
  } else {
    history.disable()
  }
}

interface Column {
  status: 'todo' | 'ready' | 'running' | 'blocked'
  label: string
  tone: 'todo' | 'ready' | 'running' | 'blocked'
}

const columns = computed<Column[]>(() => [
  { status: 'todo', label: t('mission.board.col.todo'), tone: 'todo' },
  { status: 'ready', label: t('mission.board.col.ready'), tone: 'ready' },
  { status: 'running', label: t('mission.board.col.running'), tone: 'running' },
  { status: 'blocked', label: t('mission.board.col.blocked'), tone: 'blocked' }
])

const tasksByStatus = computed(() => {
  const map = new Map<string, CurrentTask[]>()
  for (const c of columns.value) map.set(c.status, [])
  for (const task of props.tasks) {
    const arr = map.get(task.status)
    if (arr) arr.push(task)
  }
  // Stable order: priority desc, then created asc.
  for (const arr of map.values()) {
    arr.sort((a, b) => (b.priority - a.priority) || (a.createdAt - b.createdAt))
  }
  return map
})

const profileBySlug = computed(() => {
  const m = new Map<string, Profile>()
  for (const p of props.profiles) m.set(p.slug, p)
  return m
})

function callsign(slug: string | null): string {
  if (!slug) return '—'
  const p = profileBySlug.value.get(slug)
  return (p?.givenName || p?.displayName || slug).toUpperCase()
}

function accent(slug: string | null): string {
  if (!slug) return '#9a9485'
  const p = profileBySlug.value.get(slug)
  return p ? '#' + p.backgroundColor : '#9a9485'
}

function shortAgo(unixSec: number | null): string | null {
  if (!unixSec) return null
  const diff = Math.max(0, Math.floor(Date.now() / 1000) - unixSec)
  if (diff < 60) return `${diff}s`
  if (diff < 3600) return `${Math.floor(diff / 60)}m`
  if (diff < 86400) return `${Math.floor(diff / 3600)}h`
  return `${Math.floor(diff / 86400)}d`
}

function timeLine(task: CurrentTask): string | null {
  if (task.startedAt) {
    return t('mission.board.started', { ago: shortAgo(task.startedAt) })
  }
  return t('mission.board.waiting', { ago: shortAgo(task.createdAt) })
}

function completedLine(task: CompletedTask): string {
  const when = task.completedAt ?? task.createdAt
  return t('mission.board.completedAgo', { ago: shortAgo(when) })
}

const totalTasks = computed(() => props.tasks.length)
</script>

<template>
  <div class="board-wrap">
    <div
      v-if="totalTasks > 0"
      class="board"
    >
      <div
        v-for="col in columns"
        :key="col.status"
        class="col"
        :class="`col--${col.tone}`"
      >
        <header class="col-head">
          <span class="col-label">{{ col.label }}</span>
          <span class="col-count">{{ tasksByStatus.get(col.status)?.length ?? 0 }}</span>
        </header>
        <ul
          v-if="(tasksByStatus.get(col.status)?.length ?? 0) > 0"
          class="card-list"
        >
          <li
            v-for="task in tasksByStatus.get(col.status)"
            :key="task.id"
            class="card"
            :class="`card--${col.tone}`"
            :style="{ '--accent': accent(task.assignee) }"
            @click="emit('select', task)"
          >
            <span class="card-stripe" />
            <div class="card-head">
              <span class="card-callsign">{{ callsign(task.assignee) }}</span>
            </div>
            <p class="card-title">
              {{ task.title || '—' }}
            </p>
            <div class="card-foot">
              <span
                v-if="timeLine(task)"
                class="card-time"
              >
                {{ timeLine(task) }}
              </span>
              <span class="card-id">{{ task.id }}</span>
            </div>
          </li>
        </ul>
        <p
          v-else
          class="col-empty"
        >
          {{ t('mission.board.empty') }}
        </p>
      </div>
    </div>
    <div
      v-else
      class="board-empty"
    >
      {{ t('mission.board.boardEmpty') }}
    </div>

    <!-- Collapsible history strip — done + archived tasks for the current
         mission scope (or globally when scope=Todas). Lazy: hits the API only
         after the user opens it; polls the head every 15s while open. -->
    <section
      class="history"
      :class="{ 'is-open': historyOpen }"
    >
      <button
        type="button"
        class="history-head"
        :aria-expanded="historyOpen"
        @click="toggleHistory"
      >
        <UIcon
          :name="historyOpen ? 'i-lucide-chevron-down' : 'i-lucide-chevron-right'"
          class="history-glyph"
        />
        <span class="history-label">{{ t('mission.board.completedTitle') }}</span>
        <span
          v-if="historyOpen && history.tasks.value.length > 0"
          class="history-count"
        >
          {{ history.tasks.value.length }}{{ history.hasMore.value ? '+' : '' }}
        </span>
      </button>

      <div
        v-if="historyOpen"
        class="history-body"
      >
        <p
          v-if="history.loading.value && history.tasks.value.length === 0"
          class="history-state"
        >
          {{ t('mission.board.completedLoading') }}
        </p>
        <p
          v-else-if="history.error.value"
          class="history-state history-state--error"
        >
          {{ history.error.value }}
        </p>
        <p
          v-else-if="history.tasks.value.length === 0"
          class="history-state"
        >
          {{ t('mission.board.completedEmpty') }}
        </p>
        <ul
          v-else
          class="history-list"
        >
          <li
            v-for="task in history.tasks.value"
            :key="task.id"
            class="history-item"
            :class="`history-item--${task.status}`"
            :style="{ '--accent': accent(task.assignee) }"
            @click="emit('select', task)"
          >
            <span class="history-stripe" />
            <span class="history-callsign">{{ callsign(task.assignee) }}</span>
            <span class="history-title">{{ task.title || '—' }}</span>
            <span class="history-time">{{ completedLine(task) }}</span>
            <span class="history-id">{{ task.id }}</span>
          </li>
        </ul>
        <button
          v-if="history.hasMore.value"
          type="button"
          class="history-more"
          :disabled="history.loadingMore.value"
          @click="history.loadMore()"
        >
          {{ history.loadingMore.value ? t('mission.board.completedLoading') : t('mission.board.completedMore') }}
        </button>
      </div>
    </section>
  </div>
</template>

<style scoped>
/* Wrapper that stacks the live 4-column board on top of the collapsible
   history strip. The board grows to fill available height; the history is
   auto-height (collapsed: just the header row; expanded: capped list with
   internal scroll). */
.board-wrap {
  display: flex;
  flex-direction: column;
  gap: 10px;
  height: 100%;
  min-height: 0;
}

.board {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: 8px;
  flex: 1 1 auto;
  min-height: 0;
  font-family: 'IBM Plex Mono', ui-monospace, monospace;
}

.col {
  display: flex;
  flex-direction: column;
  min-height: 0;
  background: rgba(255, 252, 240, 0.55);
  border: 1px solid rgba(28, 26, 20, 0.16);
  border-radius: 3px;
  overflow: hidden;
}

.col-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 7px 10px;
  background: rgba(28, 26, 20, 0.06);
  border-bottom: 1px solid rgba(28, 26, 20, 0.12);
  font-size: 9px;
  font-weight: 600;
  letter-spacing: 0.22em;
  text-transform: uppercase;
}
.col-label {
  color: #1c1a14;
}
.col-count {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-width: 18px;
  padding: 1px 6px;
  background: #1c1a14;
  color: #f4efe2;
  border-radius: 999px;
  font-size: 9px;
  letter-spacing: 0.04em;
}

/* Column accents — top stripe matching the same colour the bubble + status
   pill use, so the "running tasks" column reads green at a glance. */
.col--running .col-head { background: rgba(47, 90, 47, 0.12); border-bottom-color: rgba(47, 90, 47, 0.4); }
.col--running .col-count { background: #2f5a2f; }
.col--blocked .col-head { background: rgba(90, 31, 18, 0.12); border-bottom-color: rgba(90, 31, 18, 0.4); }
.col--blocked .col-count { background: #5a1f12; }
.col--ready .col-head { background: rgba(138, 90, 20, 0.12); border-bottom-color: rgba(138, 90, 20, 0.4); }
.col--ready .col-count { background: #8a5a14; }

.card-list {
  list-style: none;
  padding: 8px;
  margin: 0;
  display: flex;
  flex-direction: column;
  gap: 6px;
  overflow-y: auto;
  flex: 1 1 auto;
  min-height: 0;
}

.card {
  --accent: #9a9485;
  position: relative;
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding: 8px 10px 9px 14px;
  background: #fffaef;
  border: 1px solid rgba(28, 26, 20, 0.18);
  border-radius: 2px;
  cursor: pointer;
  transition: transform 0.12s ease, border-color 0.12s ease, background 0.12s ease;
}
.card:hover {
  transform: translateX(1px);
  border-color: rgba(28, 26, 20, 0.42);
  background: #fffefa;
}
.card-stripe {
  position: absolute;
  left: 0;
  top: 0;
  bottom: 0;
  width: 3px;
  background: var(--accent);
  border-radius: 2px 0 0 2px;
}
.card--running { border-color: rgba(47, 90, 47, 0.32); }
.card--blocked { border-color: rgba(90, 31, 18, 0.32); }

.card-head {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 8.5px;
  letter-spacing: 0.18em;
  text-transform: uppercase;
}
.card-callsign {
  flex: 1 1 auto;
  min-width: 0;
  font-family: 'Antonio', sans-serif;
  font-weight: 700;
  font-size: 10px;
  letter-spacing: 0.14em;
  color: #1c1a14;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.card-title {
  font-family: 'Instrument Serif', serif;
  font-style: italic;
  font-size: 13px;
  line-height: 1.2;
  color: #1c1a14;
  /* Clamp to 3 lines so cards stay roughly uniform height. */
  display: -webkit-box;
  -webkit-line-clamp: 3;
  -webkit-box-orient: vertical;
  overflow: hidden;
}

/* Footer row: time on the left, task id on the right. The id keeps the
   monospace mini-font; we let it wrap below if the time line is long. */
.card-foot {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 8px;
  margin-top: 4px;
  padding-top: 4px;
  border-top: 1px dashed rgba(28, 26, 20, 0.14);
  font-family: 'IBM Plex Mono', monospace;
}
.card-time {
  font-size: 8.5px;
  letter-spacing: 0.06em;
  color: #6b6555;
  text-transform: uppercase;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.card-id {
  font-size: 8px;
  letter-spacing: 0.08em;
  font-weight: 500;
  color: #8a8473;
  white-space: nowrap;
  flex-shrink: 0;
  user-select: all;
}

.col-empty {
  padding: 18px 10px;
  text-align: center;
  color: #8a8473;
  font-size: 9.5px;
  letter-spacing: 0.16em;
  text-transform: uppercase;
  font-style: italic;
}

.board-empty {
  display: flex;
  align-items: center;
  justify-content: center;
  flex: 1 1 auto;
  min-height: 120px;
  padding: 24px;
  text-align: center;
  color: #6b6555;
  font-family: 'IBM Plex Mono', monospace;
  font-size: 11px;
  letter-spacing: 0.12em;
}

/* === History strip (done + archived tasks) === */
.history {
  flex: 0 0 auto;
  display: flex;
  flex-direction: column;
  border: 1px solid rgba(28, 26, 20, 0.16);
  border-radius: 3px;
  background: rgba(255, 252, 240, 0.55);
  font-family: 'IBM Plex Mono', ui-monospace, monospace;
  overflow: hidden;
}
.history.is-open {
  /* Cap the strip so it never bullies the live board. The list inside
     scrolls when there are more rows than fit. */
  max-height: 260px;
}

.history-head {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  padding: 8px 12px;
  background: rgba(28, 26, 20, 0.06);
  border: 0;
  border-bottom: 1px solid rgba(28, 26, 20, 0.12);
  font: inherit;
  font-size: 9.5px;
  font-weight: 600;
  letter-spacing: 0.22em;
  text-transform: uppercase;
  color: #1c1a14;
  cursor: pointer;
  transition: background 0.12s ease;
}
.history-head:hover { background: rgba(28, 26, 20, 0.1); }
.history.is-open .history-head { border-bottom-color: rgba(28, 26, 20, 0.2); }
.history-glyph {
  width: 12px;
  height: 12px;
  flex-shrink: 0;
  opacity: 0.7;
}
.history-label { flex: 1 1 auto; text-align: left; }
.history-count {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-width: 22px;
  padding: 1px 7px;
  background: #1c1a14;
  color: #f4efe2;
  border-radius: 999px;
  font-size: 9px;
  letter-spacing: 0.04em;
  font-weight: 500;
}

.history-body {
  flex: 1 1 auto;
  min-height: 0;
  display: flex;
  flex-direction: column;
  overflow-y: auto;
  padding: 6px 0;
}
.history-state {
  margin: 0;
  padding: 16px 14px;
  text-align: center;
  color: #8a8473;
  font-size: 10px;
  letter-spacing: 0.14em;
  text-transform: uppercase;
  font-style: italic;
}
.history-state--error { color: #5a1f12; font-style: normal; }

.history-list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
}
.history-item {
  --accent: #9a9485;
  position: relative;
  display: grid;
  grid-template-columns: 88px minmax(0, 1fr) auto auto;
  align-items: center;
  gap: 10px;
  padding: 7px 14px 7px 18px;
  border-bottom: 1px dashed rgba(28, 26, 20, 0.1);
  cursor: pointer;
  transition: background 0.1s ease;
}
.history-item:last-child { border-bottom: 0; }
.history-item:hover { background: rgba(28, 26, 20, 0.04); }
.history-stripe {
  position: absolute;
  left: 0;
  top: 6px;
  bottom: 6px;
  width: 3px;
  background: var(--accent);
  border-radius: 0 2px 2px 0;
  opacity: 0.7;
}
.history-item--archived .history-stripe { opacity: 0.35; }

.history-callsign {
  font-family: 'Antonio', sans-serif;
  font-weight: 700;
  font-size: 10px;
  letter-spacing: 0.14em;
  color: #1c1a14;
  text-transform: uppercase;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.history-title {
  font-family: 'Instrument Serif', serif;
  font-style: italic;
  font-size: 13px;
  line-height: 1.25;
  color: #1c1a14;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.history-item--archived .history-title { color: #6b6555; }

.history-time {
  font-size: 8.5px;
  letter-spacing: 0.12em;
  text-transform: uppercase;
  color: #6b6555;
  white-space: nowrap;
}
.history-id {
  font-size: 8px;
  letter-spacing: 0.08em;
  color: #8a8473;
  white-space: nowrap;
  user-select: all;
}

.history-more {
  margin: 8px auto 6px;
  padding: 6px 14px;
  background: transparent;
  border: 1px solid rgba(28, 26, 20, 0.2);
  border-radius: 2px;
  font: inherit;
  font-size: 9.5px;
  letter-spacing: 0.18em;
  text-transform: uppercase;
  color: #1c1a14;
  cursor: pointer;
  transition: background 0.12s ease, border-color 0.12s ease;
}
.history-more:hover {
  background: rgba(28, 26, 20, 0.06);
  border-color: rgba(28, 26, 20, 0.4);
}
.history-more:disabled { opacity: 0.55; cursor: progress; }

/* Narrow viewports — drop the leading callsign column to keep titles legible. */
@media (max-width: 720px) {
  .history-item {
    grid-template-columns: minmax(0, 1fr) auto;
    grid-template-areas:
      "callsign id"
      "title    time";
    gap: 4px 10px;
  }
  .history-callsign { grid-area: callsign; }
  .history-id { grid-area: id; }
  .history-title { grid-area: title; }
  .history-time { grid-area: time; }
}
</style>
