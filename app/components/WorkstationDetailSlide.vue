<script setup lang="ts">
import type { Profile } from '~/types/profile'
import type { CurrentTask } from '~/types/mission'

const { t } = useI18n()

const props = defineProps<{
  open: boolean
  profile: Profile | null
  /** All currently active tasks. Used to find this operative's task graph. */
  tasks: CurrentTask[]
  /** All operatives on the floor — for resolving parent task assignees. */
  profiles: Profile[]
}>()

const emit = defineEmits<{
  'update:open': [value: boolean]
}>()

// Mission stream is a singleton — calling the composable here gives us the
// SAME refs that MissionPanel uses, so the thread + steps update in real time
// without any explicit subscription.
const missionStream = useMissionStream()

/** True iff the operative we're inspecting is the active orchestrator. */
const isOrchestrator = computed(() => {
  return !!props.profile
    && missionStream.mission.value?.orchestratorSlug === props.profile.slug
})

const isStreaming = computed(() => isOrchestrator.value && missionStream.streaming.value)

const callsign = computed(() =>
  props.profile ? (props.profile.givenName || props.profile.displayName).toUpperCase() : ''
)

const profileBySlug = computed(() => {
  const m = new Map<string, Profile>()
  for (const p of props.profiles) m.set(p.slug, p)
  return m
})

const taskById = computed(() => {
  const m = new Map<string, CurrentTask>()
  for (const t of props.tasks) m.set(t.id, t)
  return m
})

/** All tasks currently assigned to this operative, ordered by status. */
const myTasks = computed<CurrentTask[]>(() => {
  if (!props.profile) return []
  return props.tasks.filter(t => t.assignee === props.profile!.slug)
})

/** Top task = first running, otherwise first by status order from the API. */
const currentTask = computed(() => myTasks.value[0] ?? null)

/** Tasks this operative has delegated (children of any task they own). */
const delegatedTasks = computed<CurrentTask[]>(() => {
  if (!props.profile) return []
  const myIds = new Set(myTasks.value.map(t => t.id))
  return props.tasks.filter(t => t.parentIds.some(pid => myIds.has(pid)))
})

/** Parents of currentTask whose assignee is also on the floor. */
const delegatedBy = computed(() => {
  if (!currentTask.value) return [] as { task: CurrentTask, profile: Profile | null }[]
  return currentTask.value.parentIds
    .map(id => taskById.value.get(id))
    .filter((t): t is CurrentTask => !!t)
    .map(t => ({
      task: t,
      profile: t.assignee ? profileBySlug.value.get(t.assignee) ?? null : null
    }))
})

function formatTime(unix: number): string {
  return new Date(unix * 1000).toLocaleTimeString()
}

function ageS(unix: number): number {
  return Math.max(0, Math.floor(Date.now() / 1000) - unix)
}

function statusColor(status: string): 'primary' | 'error' | 'warning' | 'neutral' {
  switch (status) {
    case 'running': return 'primary'
    case 'blocked': return 'error'
    case 'ready':
    case 'todo': return 'warning'
    default: return 'neutral'
  }
}

function shortTime(unixMs: number): string {
  const d = new Date(unixMs)
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}:${String(d.getSeconds()).padStart(2, '0')}`
}

// Task feed: pull the worker's full conversation (messages + reasoning) for
// the current task. Polls while the task is still live; one-shot on done.
const feedTaskId = computed(() => (props.open ? currentTask.value?.id ?? null : null))
const feedLive = computed(() => {
  const s = currentTask.value?.status
  return props.open && (s === 'running' || s === 'blocked' || s === 'ready' || s === 'todo')
})
const { feed: taskFeed, loading: taskFeedLoading, refresh: refreshFeed } = useTaskFeed(feedTaskId, feedLive)

interface FullLog {
  taskId: string
  exists: boolean
  bytes: number | null
  startedAt: number | null
  lastActivityAt: number | null
  truncated: boolean
  content: string | null
}
const fullLog = ref<FullLog | null>(null)
const fullLogLoading = ref(false)
/* Heartbeat for the auto-poll indicator: bumps on every successful refresh so
   the terminal header can flash a "fetched at" pulse. */
const lastLogFetchAt = ref<number | null>(null)

async function loadFullLog() {
  if (!feedTaskId.value) return
  fullLogLoading.value = true
  try {
    fullLog.value = await $fetch<FullLog>(`/api/kanban/tasks/${feedTaskId.value}/log`)
    lastLogFetchAt.value = Date.now()
  } catch (e) {
    console.error('full log load failed', e)
  } finally {
    fullLogLoading.value = false
  }
}

/* Right-column terminal auto-refresh — every 5 s while the modal is open and
   we have a current task. Cleared on close, task switch, or unmount. */
const LOG_POLL_MS = 5000
let logTimer: ReturnType<typeof setInterval> | null = null
function stopLogPoll() {
  if (logTimer) {
    clearInterval(logTimer)
    logTimer = null
  }
}
function startLogPoll() {
  stopLogPoll()
  if (!feedTaskId.value) return
  // Fetch once immediately so the terminal isn't empty for the first 5 s.
  loadFullLog()
  logTimer = setInterval(() => {
    if (!props.open || !feedTaskId.value) {
      stopLogPoll()
      return
    }
    loadFullLog()
  }, LOG_POLL_MS)
}

watch(
  [() => props.open, feedTaskId],
  ([open, id], [, prevId]) => {
    if (id !== prevId) {
      // Task switched — drop the previous log so we don't show stale content
      // under the new task's header.
      fullLog.value = null
      lastLogFetchAt.value = null
    }
    if (open && id) {
      startLogPoll()
    } else {
      stopLogPoll()
    }
  },
  { immediate: true }
)

onBeforeUnmount(() => stopLogPoll())

const logTailEl = ref<HTMLPreElement | null>(null)
/* Auto-stick to the bottom of the log on every refresh — the terminal is a
   tail-style view, the user expects new lines to stay visible. Forced rather
   than gated: the 5 s auto-poll would otherwise leave the viewport stuck at
   the start of a long log. */
function scrollLogToBottom() {
  const el = logTailEl.value
  if (!el) return
  el.scrollTop = el.scrollHeight
}
watch(
  () => fullLog.value?.content ?? taskFeed.value?.logTail ?? '',
  () => nextTick(() => scrollLogToBottom())
)
/* Stick to bottom on modal-open and on the <pre> element first mounting, so
   opening the dossier onto an already-long log lands the user at the latest
   output instead of scrolled to the top. */
watch(() => props.open, (open) => {
  if (open) nextTick(() => scrollLogToBottom())
})
watch(logTailEl, (el) => {
  if (el) nextTick(() => scrollLogToBottom())
})

const toast = useToast()
const killing = ref(false)
const confirmKill = ref(false)

interface TaskFailure {
  taskId: string
  status: string | null
  assignee: string | null
  reason: string
  permissionDenial: boolean
  suggestedLabel: string | null
}
const failure = ref<TaskFailure | null>(null)
const failureLoading = ref(false)
async function loadFailure() {
  if (!feedTaskId.value) {
    failure.value = null
    return
  }
  failureLoading.value = true
  try {
    failure.value = await $fetch<TaskFailure>(`/api/kanban/tasks/${feedTaskId.value}/failure`)
  } catch {
    failure.value = null
  } finally {
    failureLoading.value = false
  }
}
/* Refetch whenever the task or its status changes. We poll status via the
   feed loop already; piggybacking off that keeps the call cadence sane. */
watch(
  () => [feedTaskId.value, currentTask.value?.status] as const,
  () => loadFailure(),
  { immediate: true }
)

const approving = ref(false)
const approveLabel = ref('')
const showApprove = computed(() => !!failure.value?.permissionDenial)
watch(failure, (f) => {
  if (f?.suggestedLabel && !approveLabel.value) {
    approveLabel.value = f.suggestedLabel
  }
}, { immediate: true })

async function approveAndRetry() {
  if (!feedTaskId.value || !approveLabel.value.trim()) return
  approving.value = true
  try {
    const res = await $fetch<{ added: boolean, dispatched: boolean, unblocked: boolean }>(
      `/api/kanban/tasks/${feedTaskId.value}/approve-and-retry`,
      { method: 'POST', body: { label: approveLabel.value.trim() } }
    )
    toast.add({
      title: t('warRoom.detail.approveSuccess'),
      description: `${approveLabel.value.trim()} · added=${res.added} · dispatched=${res.dispatched}`,
      color: 'primary',
      icon: 'i-lucide-shield-check'
    })
    approveLabel.value = ''
    failure.value = null
    await refreshFeed()
  } catch (e) {
    const err = e as { data?: { message?: string }, message?: string }
    toast.add({
      title: t('warRoom.detail.approveFailed'),
      description: err.data?.message ?? err.message,
      color: 'error'
    })
  } finally {
    approving.value = false
  }
}

async function killTask() {
  if (!currentTask.value) return
  killing.value = true
  try {
    const id = currentTask.value.id
    const res = await $fetch<{ workersKilled: number[], archived: boolean }>(
      `/api/kanban/tasks/${id}/kill`,
      { method: 'POST', body: { reason: 'killed via war-room' } }
    )
    toast.add({
      title: t('warRoom.detail.taskKilled'),
      description: `pids: ${res.workersKilled.join(', ') || '—'} · archived: ${res.archived}`,
      color: 'primary',
      icon: 'i-lucide-skull'
    })
    confirmKill.value = false
    /* The kanban poll picks up the new status within a tick; nudge the feed
       endpoint too so token totals settle. */
    await refreshFeed()
  } catch (e) {
    const err = e as { data?: { message?: string }, message?: string }
    toast.add({
      title: t('warRoom.detail.taskKillFailed'),
      description: err.data?.message ?? err.message,
      color: 'error'
    })
  } finally {
    killing.value = false
  }
}

const visibleMessages = computed(() =>
  (taskFeed.value?.messages ?? []).filter(m => m.role !== 'system')
)

function roleVariant(role: string): 'user' | 'assistant' | 'tool' | 'other' {
  if (role === 'user' || role === 'assistant' || role === 'tool') return role
  return 'other'
}

function roleGlyph(role: string): string {
  if (role === 'user') return 'i-lucide-user'
  if (role === 'assistant') return 'i-lucide-sparkles'
  if (role === 'tool') return 'i-lucide-wrench'
  return 'i-lucide-circle'
}

function summarizeToolCalls(calls: unknown): string | null {
  if (!Array.isArray(calls) || calls.length === 0) return null
  return calls
    .map(c => (c as { function?: { name?: string }, name?: string }).function?.name
      ?? (c as { name?: string }).name
      ?? '?')
    .join(', ')
}

function fmt(n: number): string {
  return n.toLocaleString()
}

function shortTimeFromSec(unixSec: number | null): string {
  if (unixSec === null) return ''
  return shortTime(unixSec * 1000)
}

/** Human-readable duration since a unix-ms timestamp. */
function humanDuration(unixMs: number): string {
  const totalS = Math.max(0, Math.floor((Date.now() - unixMs) / 1000))
  if (totalS < 60) return `${totalS}s`
  const m = Math.floor(totalS / 60)
  if (m < 60) return `${m}m ${totalS % 60}s`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h ${m % 60}m`
  const d = Math.floor(h / 24)
  return `${d}d ${h % 24}h`
}

const fmtCost = (n: number) => n < 0.01 ? `$${n.toFixed(4)}` : `$${n.toFixed(2)}`

/* Reactive "X s ago" indicator under the auto-refresh ticker. Recomputes once
   per second so the user can see the cadence at a glance. */
const nowMs = ref(Date.now())
let nowTimer: ReturnType<typeof setInterval> | null = null
onMounted(() => {
  nowTimer = setInterval(() => {
    nowMs.value = Date.now()
  }, 1000)
})
onBeforeUnmount(() => {
  if (nowTimer) clearInterval(nowTimer)
})
const logFetchAgo = computed(() => {
  if (!lastLogFetchAt.value) return null
  const s = Math.max(0, Math.floor((nowMs.value - lastLogFetchAt.value) / 1000))
  return s
})
</script>

<template>
  <UModal
    :open="open"
    :ui="{
      content: 'max-w-7xl w-[min(96vw,1280px)] h-[min(92vh,900px)]',
      overlay: 'bg-[#1c1a14]/55 backdrop-blur-sm'
    }"
    @update:open="(v: boolean) => emit('update:open', v)"
  >
    <template #content>
      <div
        v-if="profile"
        class="dossier"
        :style="{ '--accent': '#' + profile.backgroundColor }"
      >
        <!-- Header — same elements as the prior slideover (portrait, eyebrow,
             callsign, slug) but the gradient now showcases the operative's
             colour as the dominant tone instead of a barely-there 28 % wash.
             A hot stripe of pure accent runs along the bottom edge as a unit
             marker, and a faint paper-grain layer keeps the war-room aesthetic. -->
        <header class="dossier-header">
          <div class="dossier-header-grain" />

          <!-- Identity cluster pinned to the left: avatar + callsign + slug
               read as one unit. The flex parent below stretches a flexible
               gap to push the actions group to the right. -->
          <div class="header-identity">
            <div class="header-portrait">
              <div class="header-disc" />
              <img
                :src="profile.avatarPortraitUrl"
                :alt="callsign"
                class="header-character"
              >
            </div>
            <div class="header-meta">
              <h2 class="header-callsign">
                {{ callsign }}
              </h2>
              <p class="header-slug">
                <span class="header-slug-mark">/</span>
                {{ profile.displayName }}
              </p>
            </div>
          </div>

          <!-- Actions cluster on the right: at-a-glance task vitals + close. -->
          <div class="header-actions">
            <div
              v-if="currentTask"
              class="header-vitals"
            >
              <span
                class="header-vitals-status"
                :class="`vitals-status--${currentTask.status}`"
              >
                <span class="vitals-status-dot" />
                {{ currentTask.status }}
              </span>
              <span
                v-if="taskFeed?.startedAt"
                class="header-vitals-duration"
              >
                <UIcon
                  name="i-lucide-timer"
                  class="size-3"
                />
                {{ humanDuration(taskFeed.startedAt) }}
              </span>
              <span
                v-if="taskFeed?.totals && (taskFeed.totals.inputTokens + taskFeed.totals.outputTokens) > 0"
                class="header-vitals-tokens"
                :title="t('warRoom.detail.taskFeedTotalsTitle', {
                  input: fmt(taskFeed.totals.inputTokens),
                  output: fmt(taskFeed.totals.outputTokens)
                })"
              >
                <UIcon
                  name="i-lucide-circle-gauge"
                  class="size-3"
                />
                {{ fmt(taskFeed.totals.inputTokens + taskFeed.totals.outputTokens) }}
              </span>
            </div>

            <button
              type="button"
              class="header-close"
              :aria-label="t('common.cancel')"
              @click="emit('update:open', false)"
            >
              <UIcon
                name="i-lucide-x"
                class="size-4"
              />
            </button>
          </div>
        </header>

        <!-- Body: two columns. Left holds the task structure + structured
             action stream (read-only worker conversation). Right is a dark
             "model terminal" auto-refreshing every 5 s. Each column owns its
             own scroll so a long log on the right doesn't push the task card
             out of view on the left. -->
        <div class="dossier-body">
          <section
            class="col col--left"
            :aria-label="t('warRoom.detail.currentTask')"
          >
            <!-- ══════════ Current task ══════════ -->
            <div class="block">
              <h3 class="block-title">
                {{ t('warRoom.detail.currentTask') }}
              </h3>
              <div
                v-if="currentTask"
                class="task-card"
              >
                <div class="task-card-head">
                  <UBadge
                    :color="statusColor(currentTask.status)"
                    variant="subtle"
                    size="sm"
                  >
                    {{ currentTask.status }}
                  </UBadge>
                  <span class="task-id">{{ currentTask.id }}</span>
                </div>
                <h4 class="task-title">
                  {{ currentTask.title }}
                </h4>
                <p
                  v-if="currentTask.body"
                  class="task-body"
                >
                  {{ currentTask.body }}
                </p>
                <ul class="task-meta">
                  <li v-if="currentTask.startedAt">
                    {{ t('warRoom.detail.started', { time: formatTime(currentTask.startedAt) }) }}
                  </li>
                  <li v-if="currentTask.lastHeartbeatAt">
                    {{ t('warRoom.detail.heartbeat', { ago: ageS(currentTask.lastHeartbeatAt) }) }}
                  </li>
                </ul>

                <div
                  v-if="delegatedBy.length"
                  class="delegators"
                >
                  <p class="delegators-title">
                    {{ t('warRoom.detail.delegatedBy') }}
                  </p>
                  <ul>
                    <li
                      v-for="(d, i) in delegatedBy"
                      :key="i"
                      class="delegator"
                    >
                      <span
                        v-if="d.profile"
                        class="delegator-dot"
                        :style="{ background: '#' + d.profile.backgroundColor }"
                      />
                      <span class="delegator-name">
                        {{ d.profile?.givenName || d.profile?.displayName || d.task.assignee || '—' }}
                      </span>
                      <span class="delegator-task">{{ d.task.title }}</span>
                    </li>
                  </ul>
                </div>
              </div>
              <p
                v-else
                class="empty"
              >
                {{ t('warRoom.detail.noTask') }}
              </p>
            </div>

            <!-- ══════════ Permission approval / kill controls ══════════ -->
            <div
              v-if="showApprove || (currentTask && currentTask.status !== 'completed' && currentTask.status !== 'archived')"
              class="block"
            >
              <div
                v-if="showApprove"
                class="feed-approve"
              >
                <div class="feed-approve-head">
                  <UIcon
                    name="i-lucide-shield-alert"
                    class="size-3.5"
                  />
                  <span class="feed-approve-title">{{ t('warRoom.detail.approveTitle') }}</span>
                </div>
                <p class="feed-approve-body">
                  {{ t('warRoom.detail.approveBody') }}
                </p>
                <pre
                  v-if="failure?.reason"
                  class="feed-approve-reason"
                >{{ failure.reason }}</pre>
                <UInput
                  v-model="approveLabel"
                  :placeholder="failure?.suggestedLabel ?? t('warRoom.detail.approveNoLabel')"
                  spellcheck="false"
                  autocomplete="off"
                  class="w-full font-mono feed-approve-input"
                />
                <p class="feed-approve-hint">
                  {{ t('warRoom.detail.approveLabelHint') }}
                </p>
                <button
                  type="button"
                  class="feed-approve-btn"
                  :disabled="approving || !approveLabel.trim()"
                  @click="approveAndRetry"
                >
                  <UIcon
                    v-if="approving"
                    name="i-lucide-loader"
                    class="size-3.5 spin"
                  />
                  <UIcon
                    v-else
                    name="i-lucide-shield-check"
                    class="size-3.5"
                  />
                  <span>{{ approving ? t('warRoom.detail.approving') : t('warRoom.detail.approveAction') }}</span>
                </button>
              </div>

              <div
                v-if="currentTask && currentTask.status !== 'completed' && currentTask.status !== 'archived'"
                class="feed-kill"
              >
                <button
                  v-if="!confirmKill"
                  type="button"
                  class="feed-kill-btn"
                  :disabled="killing"
                  @click="confirmKill = true"
                >
                  <UIcon
                    name="i-lucide-skull"
                    class="size-3.5"
                  />
                  <span>{{ t('warRoom.detail.taskKill') }}</span>
                </button>
                <div
                  v-else
                  class="feed-kill-confirm"
                >
                  <p class="feed-kill-title">
                    {{ t('warRoom.detail.taskKillConfirmTitle', { id: currentTask.id }) }}
                  </p>
                  <p class="feed-kill-body">
                    {{ t('warRoom.detail.taskKillConfirmBody') }}
                  </p>
                  <div class="feed-kill-actions">
                    <button
                      type="button"
                      class="feed-kill-cancel"
                      :disabled="killing"
                      @click="confirmKill = false"
                    >
                      {{ t('common.cancel') }}
                    </button>
                    <button
                      type="button"
                      class="feed-kill-confirm-btn"
                      :disabled="killing"
                      @click="killTask"
                    >
                      <UIcon
                        v-if="killing"
                        name="i-lucide-loader"
                        class="size-3.5 spin"
                      />
                      <UIcon
                        v-else
                        name="i-lucide-skull"
                        class="size-3.5"
                      />
                      <span>{{ killing ? t('warRoom.detail.taskKilling') : t('warRoom.detail.taskKillConfirmAction') }}</span>
                    </button>
                  </div>
                </div>
              </div>
            </div>

            <!-- ══════════ Subtasks ══════════ -->
            <div class="block">
              <h3 class="block-title">
                {{ t('warRoom.detail.subtasks') }}
                <span
                  v-if="delegatedTasks.length"
                  class="block-count"
                >{{ delegatedTasks.length }}</span>
              </h3>
              <ul
                v-if="delegatedTasks.length"
                class="subtask-list"
              >
                <li
                  v-for="sub in delegatedTasks"
                  :key="sub.id"
                  class="subtask"
                >
                  <UBadge
                    :color="statusColor(sub.status)"
                    variant="subtle"
                    size="xs"
                  >
                    {{ sub.status }}
                  </UBadge>
                  <div class="subtask-body">
                    <p class="subtask-title">
                      {{ sub.title }}
                    </p>
                    <p class="subtask-meta">
                      {{ sub.assignee ?? '—' }} · {{ sub.id }}
                    </p>
                  </div>
                </li>
              </ul>
              <p
                v-else
                class="empty"
              >
                {{ t('warRoom.detail.noSubtasks') }}
              </p>
            </div>

            <!-- ══════════ Stream of actions ══════════ -->
            <div
              v-if="feedTaskId"
              class="block"
            >
              <h3 class="block-title">
                {{ t('warRoom.detail.taskFeed') }}
                <span
                  v-if="feedLive"
                  class="live-pip"
                >
                  <span class="live-pip-dot" />
                  {{ t('warRoom.detail.live') }}
                </span>
                <span
                  v-if="visibleMessages.length"
                  class="block-count"
                >{{ visibleMessages.length }}</span>
              </h3>

              <p
                v-if="taskFeedLoading && !taskFeed"
                class="empty"
              >
                {{ t('warRoom.detail.taskFeedLoading') }}
              </p>
              <p
                v-else-if="!taskFeed?.started"
                class="empty"
              >
                {{ t('warRoom.detail.taskFeedNotStarted') }}
              </p>
              <ul
                v-else-if="visibleMessages.length"
                class="feed-list"
              >
                <li
                  v-for="m in visibleMessages"
                  :key="m.id"
                  class="feed-msg"
                  :class="`feed-msg--${roleVariant(m.role)}`"
                >
                  <div class="feed-msg-head">
                    <UIcon
                      :name="roleGlyph(m.role)"
                      class="feed-msg-glyph"
                    />
                    <span class="feed-msg-role">{{ m.role }}</span>
                    <span
                      v-if="m.toolName"
                      class="feed-msg-tool"
                    >· {{ m.toolName }}</span>
                    <span
                      v-else-if="summarizeToolCalls(m.toolCalls)"
                      class="feed-msg-tool"
                    >· {{ summarizeToolCalls(m.toolCalls) }}</span>
                    <span
                      v-if="m.timestamp"
                      class="feed-msg-time"
                    >{{ shortTimeFromSec(m.timestamp) }}</span>
                  </div>
                  <details
                    v-if="m.reasoning"
                    class="feed-msg-reasoning"
                  >
                    <summary>{{ t('warRoom.detail.taskFeedReasoning') }}</summary>
                    <pre>{{ m.reasoning }}</pre>
                  </details>
                  <pre
                    v-if="m.content"
                    class="feed-msg-content"
                  >{{ m.content }}</pre>
                </li>
              </ul>
              <p
                v-else-if="taskFeed && !taskFeed.sessionId && !taskFeed.logTail"
                class="empty"
              >
                {{ t('warRoom.detail.taskFeedNoSession') }}
              </p>
              <p
                v-else
                class="empty"
              >
                {{ t('warRoom.detail.taskFeedEmpty') }}
              </p>
            </div>

            <!-- ══════════ Orchestrator extras ══════════ -->
            <div
              v-if="isOrchestrator"
              class="block"
            >
              <h3 class="block-title">
                {{ t('warRoom.detail.lastSteps') }}
                <span
                  v-if="isStreaming"
                  class="live-pip"
                >
                  <span class="live-pip-dot" />
                  {{ t('warRoom.detail.live') }}
                </span>
              </h3>
              <ul
                v-if="missionStream.recentSteps.value.length"
                class="step-list"
              >
                <li
                  v-for="(step, i) in missionStream.recentSteps.value"
                  :key="`${step.ts}-${i}`"
                  class="step"
                  :class="`step--${step.kind}`"
                >
                  <span class="step-time">{{ shortTime(step.ts) }}</span>
                  <UIcon
                    :name="step.kind === 'tool' ? 'i-lucide-arrow-right' : 'i-lucide-brain'"
                    class="step-glyph"
                  />
                  <div class="step-body">
                    <span class="step-label">
                      <span
                        v-if="step.tool"
                        class="step-tool"
                      >{{ step.tool }}</span>
                      <span class="step-text">{{ step.label }}</span>
                    </span>
                    <pre
                      v-if="step.detail"
                      class="step-detail"
                    >{{ step.detail }}</pre>
                  </div>
                </li>
              </ul>
              <p
                v-else
                class="empty"
              >
                {{ t('warRoom.detail.noSteps') }}
              </p>
            </div>

            <div
              v-if="isOrchestrator"
              class="block"
            >
              <h3 class="block-title">
                {{ t('warRoom.detail.missionThread') }}
              </h3>
              <ul
                v-if="missionStream.messages.value.length"
                class="thread"
              >
                <li
                  v-for="msg in missionStream.messages.value"
                  :key="`${msg.id}-${msg.createdAt}`"
                  class="msg"
                  :class="`msg--${msg.role}`"
                >
                  <span class="msg-role">{{ msg.role }}</span>
                  <p
                    class="msg-body"
                    :class="{ 'msg-body--pending': msg.pending }"
                  >
                    {{ msg.content }}
                    <span
                      v-if="msg.pending"
                      class="msg-cursor"
                    >▍</span>
                  </p>
                </li>
              </ul>
              <p
                v-else
                class="empty"
              >
                {{ t('warRoom.detail.noMission') }}
              </p>
            </div>
          </section>

          <!-- Right column: model terminal. Single full-height pane with a
               dark background, monospace log content, auto-refreshing every 5 s.
               Token chips + duration + session id sit in the terminal's title
               bar so all "session-level" telemetry is in one place. -->
          <section
            class="col col--right"
            :aria-label="t('warRoom.detail.taskFeedLog')"
          >
            <div class="terminal">
              <header class="terminal-bar">
                <div class="terminal-bar-traffic">
                  <span class="terminal-dot terminal-dot--r" />
                  <span class="terminal-dot terminal-dot--y" />
                  <span class="terminal-dot terminal-dot--g" />
                </div>
                <div class="terminal-bar-title">
                  <UIcon
                    name="i-lucide-terminal"
                    class="size-3.5"
                  />
                  <span>{{ t('warRoom.detail.taskFeedLog') }}</span>
                  <span
                    v-if="taskFeed?.sessionId"
                    class="terminal-bar-sess"
                    :title="t('warRoom.detail.taskFeedSession') + ': ' + taskFeed.sessionId"
                  >· {{ taskFeed.sessionId.slice(-12) }}</span>
                </div>
                <div class="terminal-bar-tools">
                  <span
                    v-if="(fullLog?.bytes ?? taskFeed?.logBytes)"
                    class="terminal-bar-size"
                  >{{ fmt(Math.round(((fullLog?.bytes ?? taskFeed?.logBytes) as number) / 1024)) }} KB</span>
                  <span class="terminal-bar-poll">
                    <span
                      class="terminal-poll-dot"
                      :class="{ 'terminal-poll-dot--active': fullLogLoading }"
                    />
                    <span class="terminal-poll-text">
                      <template v-if="fullLogLoading">
                        {{ t('warRoom.detail.taskFeedLogLoading') }}
                      </template>
                      <template v-else-if="logFetchAgo !== null">
                        {{ logFetchAgo }}s · 5s
                      </template>
                      <template v-else>
                        —
                      </template>
                    </span>
                  </span>
                  <button
                    type="button"
                    class="terminal-bar-reload"
                    :disabled="fullLogLoading"
                    :title="t('warRoom.detail.taskFeedLogReload')"
                    @click="loadFullLog"
                  >
                    <UIcon
                      name="i-lucide-refresh-cw"
                      class="size-3.5"
                      :class="{ spin: fullLogLoading }"
                    />
                  </button>
                </div>
              </header>

              <!-- Token meters strip — input / output / cache / cost. Sits
                   between the terminal title bar and the log body so the
                   user always knows the cost of what they're watching scroll. -->
              <div
                v-if="taskFeed?.totals"
                class="terminal-meters"
              >
                <span class="terminal-meter terminal-meter--in">
                  <span class="terminal-meter-label">{{ t('warRoom.detail.tokenInput') }}</span>
                  <span class="terminal-meter-value">{{ fmt(taskFeed.totals.inputTokens) }}</span>
                </span>
                <span class="terminal-meter terminal-meter--out">
                  <span class="terminal-meter-label">{{ t('warRoom.detail.tokenOutput') }}</span>
                  <span class="terminal-meter-value">{{ fmt(taskFeed.totals.outputTokens) }}</span>
                </span>
                <span
                  v-if="taskFeed.totals.cacheReadTokens"
                  class="terminal-meter terminal-meter--cache"
                >
                  <span class="terminal-meter-label">{{ t('warRoom.detail.tokenCacheRead') }}</span>
                  <span class="terminal-meter-value">{{ fmt(taskFeed.totals.cacheReadTokens) }}</span>
                </span>
                <span
                  v-if="taskFeed.totals.cacheWriteTokens"
                  class="terminal-meter terminal-meter--cache"
                >
                  <span class="terminal-meter-label">{{ t('warRoom.detail.tokenCacheWrite') }}</span>
                  <span class="terminal-meter-value">{{ fmt(taskFeed.totals.cacheWriteTokens) }}</span>
                </span>
                <span
                  v-if="taskFeed.totals.estimatedCostUsd > 0"
                  class="terminal-meter terminal-meter--cost"
                >
                  <span class="terminal-meter-label">{{ t('warRoom.detail.tokenCost') }}</span>
                  <span class="terminal-meter-value">{{ fmtCost(taskFeed.totals.estimatedCostUsd) }}</span>
                </span>
              </div>

              <!-- Truncated-log notice + log body. -->
              <p
                v-if="fullLog?.truncated && fullLog?.bytes"
                class="terminal-notice"
              >
                {{ t('warRoom.detail.taskFeedLogTruncated', {
                  bytes: fmt(Math.round((fullLog.content?.length ?? 0) / 1024)) + ' KB',
                  total: fmt(Math.round(fullLog.bytes / 1024)) + ' KB'
                }) }}
              </p>

              <pre
                ref="logTailEl"
                class="terminal-body"
              >{{ fullLog?.content ?? taskFeed?.logTail ?? (feedTaskId ? t('warRoom.detail.taskFeedLogLoading') : t('warRoom.detail.noTask')) }}</pre>

              <!-- Bottom prompt line — purely cosmetic but cements the
                   "you're watching a live shell" feel. The cursor blinks while
                   we have a poll cycle going. -->
              <div class="terminal-prompt">
                <span class="terminal-prompt-glyph">▌</span>
                <span class="terminal-prompt-path">~/.hermes</span>
                <span class="terminal-prompt-arrow">▸</span>
                <span class="terminal-prompt-cmd">tail -f session.log</span>
                <span
                  class="terminal-prompt-cursor"
                  :class="{ 'terminal-prompt-cursor--active': fullLogLoading }"
                />
              </div>
            </div>
          </section>
        </div>
      </div>
    </template>
  </UModal>
</template>

<style scoped>
/* ────────────────────────────────────────────────────────────────────────
   Layout shell — modal frame, header, two-column body.
   ──────────────────────────────────────────────────────────────────────── */

.dossier {
  --accent: #d4d4d4;
  --paper: #f4efe2;
  --paper-edge: #d8d0b8;
  --ink: #1c1a14;
  --ink-soft: #4a4536;
  --ink-faint: #6b6555;
  --amber: #f3a93b;
  --terminal: #0d0c08;

  position: relative;
  height: 100%;
  background: var(--paper);
  color: var(--ink);
  border-radius: 6px;
  overflow: hidden;
  display: flex;
  flex-direction: column;
  font-family: 'IBM Plex Mono', ui-monospace, monospace;
  box-shadow:
    0 0 0 1px var(--paper-edge),
    0 32px 70px -28px rgba(28, 26, 20, 0.6);
}

/* ────────────────────────────────────────────────────────────────────────
   Header — bold operative-colour gradient. The accent owns the left third
   then fades diagonally into paper. A radial halo behind the portrait makes
   the operative feel like the centre of gravity. The bottom edge carries a
   3-px stripe of pure accent as the "unit colour".
   ──────────────────────────────────────────────────────────────────────── */
.dossier-header {
  position: relative;
  flex-shrink: 0;
  display: flex;
  align-items: center;
  gap: 18px;
  padding: 24px 28px 26px;
  background:
    radial-gradient(circle at 12% 65%,
      color-mix(in srgb, var(--accent) 78%, transparent) 0%,
      transparent 50%),
    radial-gradient(circle at 95% -10%,
      color-mix(in srgb, var(--accent) 42%, white) 0%,
      transparent 55%),
    linear-gradient(120deg,
      color-mix(in srgb, var(--accent) 60%, var(--paper)) 0%,
      color-mix(in srgb, var(--accent) 26%, var(--paper)) 48%,
      color-mix(in srgb, var(--accent) 12%, var(--paper)) 100%);
  /* Hot accent stripe along the bottom — the "unit colour" tag from the
     operative's placard, scaled up. */
  border-bottom: 3px solid var(--accent);
  isolation: isolate;
}
/* Subtle grain overlay so the gradient doesn't look like a CSS demo. Tiny
   SVG noise tiled over the accent layer at low opacity — keeps the
   architectural-paper texture present even when the accent dominates. */
.dossier-header-grain {
  position: absolute;
  inset: 0;
  z-index: 0;
  pointer-events: none;
  opacity: 0.26;
  background-image: url("data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='180' height='180'><filter id='n'><feTurbulence type='fractalNoise' baseFrequency='1.4' numOctaves='2' stitchTiles='stitch'/><feColorMatrix type='matrix' values='0 0 0 0 0.16  0 0 0 0 0.15  0 0 0 0 0.08  0 0 0 0.55 0'/></filter><rect width='100%' height='100%' filter='url(%23n)'/></svg>");
  mix-blend-mode: multiply;
}
.dossier-header > * { position: relative; z-index: 1; }

/* Identity cluster: avatar + name + slug, locked together on the left. */
.header-identity {
  display: flex;
  align-items: center;
  gap: 18px;
  min-width: 0;
}
/* Actions cluster: vitals + close, pinned to the right. The auto-margin
   pushes everything else (the identity + the flexible whitespace) to the
   left, so the avatar and name end up flush against the modal's left edge. */
.header-actions {
  display: flex;
  align-items: center;
  gap: 14px;
  margin-left: auto;
  flex-shrink: 0;
}

.header-portrait {
  position: relative;
  width: 92px;
  aspect-ratio: 1 / 1;
  flex-shrink: 0;
}
.header-disc {
  position: absolute;
  inset: 0;
  border-radius: 50%;
  background:
    radial-gradient(circle at 50% 32%,
      color-mix(in srgb, var(--accent) 96%, white) 0%,
      var(--accent) 60%,
      color-mix(in srgb, var(--accent) 70%, var(--ink)) 100%);
  border: 1px solid color-mix(in srgb, var(--accent) 50%, var(--ink));
  box-shadow:
    0 8px 18px -6px rgba(28, 26, 20, 0.45),
    inset 0 1px 0 rgba(255, 255, 255, 0.55);
}
.header-character {
  position: absolute;
  bottom: 0;
  left: 50%;
  transform: translateX(-50%);
  width: 140%;
  aspect-ratio: 1 / 1;
  height: auto;
  object-fit: contain;
  object-position: bottom center;
  -webkit-mask:
    linear-gradient(#000, #000) top / 100% 64.3% no-repeat,
    radial-gradient(ellipse 35.7% 35.7% at 50% 64.3%, #000 99%, transparent 100%) no-repeat;
  mask:
    linear-gradient(#000, #000) top / 100% 64.3% no-repeat,
    radial-gradient(ellipse 35.7% 35.7% at 50% 64.3%, #000 99%, transparent 100%) no-repeat;
  filter: drop-shadow(0 4px 6px rgba(28, 26, 20, 0.32));
}

.header-meta {
  min-width: 0;
  display: flex;
  flex-direction: column;
  justify-content: center;
}
.header-callsign {
  font-family: 'Antonio', 'Bebas Neue', sans-serif;
  font-weight: 700;
  font-size: 36px;
  letter-spacing: 0.05em;
  line-height: 0.92;
  color: var(--ink);
  /* Tiny ink shadow for that engraved-on-paper feel. */
  text-shadow: 0 1px 0 rgba(255, 252, 240, 0.32);
}
.header-slug {
  display: inline-flex;
  align-items: center;
  gap: 7px;
  font-family: 'IBM Plex Mono', monospace;
  font-size: 12px;
  color: rgba(28, 26, 20, 0.72);
  margin-top: 7px;
  letter-spacing: 0.1em;
}
.header-slug-mark {
  display: inline-block;
  font-family: 'Antonio', sans-serif;
  font-size: 14px;
  font-weight: 700;
  color: var(--ink);
  background: color-mix(in srgb, var(--accent) 88%, white);
  border: 1px solid color-mix(in srgb, var(--accent) 70%, var(--ink));
  border-radius: 2px;
  width: 16px;
  height: 16px;
  line-height: 14px;
  text-align: center;
  letter-spacing: 0;
}

.header-vitals {
  display: flex;
  flex-direction: column;
  align-items: flex-end;
  gap: 6px;
  font-family: 'IBM Plex Mono', monospace;
  font-size: 10px;
  letter-spacing: 0.1em;
  text-transform: uppercase;
  color: rgba(28, 26, 20, 0.78);
}
.header-vitals-status {
  display: inline-flex;
  align-items: center;
  gap: 7px;
  padding: 4px 10px;
  background: rgba(28, 26, 20, 0.85);
  color: var(--paper);
  border-radius: 2px;
  font-weight: 700;
  letter-spacing: 0.18em;
}
.vitals-status-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--amber);
  box-shadow: 0 0 6px rgba(243, 169, 59, 0.6);
}
.vitals-status--running .vitals-status-dot {
  background: #6ad06a;
  box-shadow: 0 0 6px rgba(106, 208, 106, 0.7);
  animation: pulse 1.6s ease-in-out infinite;
}
.vitals-status--blocked .vitals-status-dot {
  background: #ff7a55;
  box-shadow: 0 0 6px rgba(255, 122, 85, 0.7);
}
.vitals-status--running { background: #2f5a2f; }
.vitals-status--blocked { background: #5a1f12; }
.header-vitals-duration,
.header-vitals-tokens {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  padding: 3px 8px;
  background: rgba(255, 252, 240, 0.55);
  border: 1px solid rgba(28, 26, 20, 0.18);
  border-radius: 2px;
}

.header-close {
  width: 32px;
  height: 32px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  background: rgba(255, 252, 240, 0.4);
  border: 1px solid rgba(28, 26, 20, 0.22);
  color: var(--ink);
  border-radius: 3px;
  cursor: pointer;
  transition: background 0.12s ease, border-color 0.12s ease;
  align-self: start;
}
.header-close:hover {
  background: rgba(28, 26, 20, 0.92);
  color: var(--paper);
  border-color: var(--ink);
}

/* ────────────────────────────────────────────────────────────────────────
   Body — two columns, each independently scrollable.
   ──────────────────────────────────────────────────────────────────────── */
.dossier-body {
  flex: 1 1 auto;
  min-height: 0;
  display: grid;
  grid-template-columns: 1fr 1.05fr;
  /* Body's *base* tone — cream with a 4% accent wash. Same color world as the
     header, just way calmer. The paper variable still drives every interior
     surface (cards, subtasks, etc.) so individual blocks read as paper-on-tint. */
  background: color-mix(in srgb, var(--accent) 4%, var(--paper));
}
/* Left column gets the architectural-plan grid + a fading accent halo at the
   top edge so the header's vibrant gradient bleeds gently into the working
   surface instead of cutting off at a hard line. The right column owns its
   own dark terminal canvas — it doesn't need this treatment. */
.col--left {
  background-image:
    /* Header-to-body bridge: stronger accent right under the header stripe,
       fading out by ~140 px so the eye reads it as a single continuous color
       atmosphere rather than two stacked sheets. */
    linear-gradient(180deg,
      color-mix(in srgb, var(--accent) 22%, transparent) 0,
      color-mix(in srgb, var(--accent) 6%, transparent) 90px,
      transparent 180px),
    /* Architectural plan-paper grid: 24-px grid + 96-px accent grid, faint. */
    linear-gradient(rgba(28, 26, 20, 0.045) 1px, transparent 1px),
    linear-gradient(90deg, rgba(28, 26, 20, 0.045) 1px, transparent 1px),
    linear-gradient(rgba(28, 26, 20, 0.025) 1px, transparent 1px),
    linear-gradient(90deg, rgba(28, 26, 20, 0.025) 1px, transparent 1px);
  background-size: auto, 96px 96px, 96px 96px, 24px 24px, 24px 24px;
  background-repeat: no-repeat, repeat, repeat, repeat, repeat;
  background-attachment: local, local, local, local, local;
}
.col {
  min-width: 0;
  min-height: 0;
  overflow-y: auto;
  scrollbar-color: rgba(28, 26, 20, 0.32) transparent;
  scrollbar-width: thin;
}
.col::-webkit-scrollbar { width: 8px; }
.col::-webkit-scrollbar-thumb {
  background: rgba(28, 26, 20, 0.28);
  border-radius: 4px;
}
.col--left {
  border-right: 1px solid rgba(28, 26, 20, 0.12);
  padding: 22px 26px 28px;
  display: flex;
  flex-direction: column;
  gap: 20px;
}
.col--right {
  padding: 0;
  background: var(--terminal);
  display: flex;
  flex-direction: column;
}

@media (max-width: 1024px) {
  .dossier-body {
    grid-template-columns: 1fr;
  }
  .col--left {
    border-right: 0;
    border-bottom: 1px solid rgba(28, 26, 20, 0.12);
  }
  .col--right {
    min-height: 360px;
  }
}

/* ────────────────────────────────────────────────────────────────────────
   Block titles — replace the old .section-title, drop the bottom border so
   blocks don't drift apart visually.
   ──────────────────────────────────────────────────────────────────────── */
.block { display: flex; flex-direction: column; gap: 12px; }
/* Block titles read like military section markers: Antonio bold, dark ink,
   bumped size, a solid leading bar in the operative's accent so the title
   gets a hit of colour even on the tinted paper. Was 9.5 px @ 62 % ink which
   disappeared into the accent-washed background. */
.block-title {
  display: flex;
  align-items: center;
  gap: 10px;
  font-family: 'Antonio', 'Bebas Neue', sans-serif;
  font-weight: 700;
  font-size: 13px;
  letter-spacing: 0.22em;
  text-transform: uppercase;
  color: var(--ink);
  margin: 0;
  /* Subtle ink halo so the type punches against the accent-washed paper
     instead of dissolving into it. */
  text-shadow: 0 1px 0 rgba(255, 252, 240, 0.45);
}
.block-title::before {
  content: '';
  display: inline-block;
  width: 22px;
  height: 3px;
  background: var(--ink);
  /* Accent shadow under the bar adds a sliver of operative colour. */
  box-shadow: 0 4px 0 -2px var(--accent);
  flex-shrink: 0;
}
.block-count {
  font-family: 'IBM Plex Mono', monospace;
  font-size: 10.5px;
  font-weight: 600;
  letter-spacing: 0.06em;
  color: var(--ink);
  background: color-mix(in srgb, var(--accent) 70%, var(--paper));
  padding: 2px 9px;
  border-radius: 999px;
  border: 1px solid color-mix(in srgb, var(--accent) 70%, var(--ink));
  margin-left: auto;
  text-transform: none;
}

.empty {
  font-family: 'Instrument Serif', serif;
  font-style: italic;
  font-size: 13px;
  color: rgba(28, 26, 20, 0.5);
}

/* ────────────────────────────────────────────────────────────────────────
   Current task card.
   ──────────────────────────────────────────────────────────────────────── */
.task-card {
  background: rgba(255, 252, 240, 0.92);
  border: 1px solid rgba(28, 26, 20, 0.16);
  border-left: 3px solid var(--accent);
  border-radius: 4px;
  padding: 14px 16px 16px;
  display: flex;
  flex-direction: column;
  gap: 10px;
  box-shadow: 0 2px 6px -3px rgba(28, 26, 20, 0.18);
}
.task-card-head {
  display: flex;
  align-items: center;
  gap: 8px;
  justify-content: space-between;
}
.task-id {
  font-family: 'IBM Plex Mono', monospace;
  font-size: 10px;
  color: rgba(28, 26, 20, 0.45);
  letter-spacing: 0.04em;
  word-break: break-all;
}
.task-title {
  font-family: 'Instrument Serif', serif;
  font-style: italic;
  font-size: 22px;
  line-height: 1.18;
  color: var(--ink);
}
.task-body {
  font-family: 'IBM Plex Mono', monospace;
  font-size: 12px;
  line-height: 1.5;
  color: rgba(28, 26, 20, 0.78);
  white-space: pre-wrap;
  max-height: 14em;
  overflow-y: auto;
}
.task-meta {
  list-style: none;
  padding: 0;
  margin: 0;
  display: flex;
  flex-wrap: wrap;
  gap: 14px;
  font-size: 10px;
  letter-spacing: 0.1em;
  color: rgba(28, 26, 20, 0.55);
  text-transform: uppercase;
}

.delegators {
  margin-top: 4px;
  padding-top: 12px;
  border-top: 1px dashed rgba(28, 26, 20, 0.22);
}
.delegators-title {
  font-size: 9px;
  letter-spacing: 0.26em;
  text-transform: uppercase;
  color: rgba(28, 26, 20, 0.55);
  margin-bottom: 6px;
}
.delegators ul {
  list-style: none;
  padding: 0;
  margin: 0;
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.delegator {
  display: grid;
  grid-template-columns: 12px auto 1fr;
  align-items: center;
  gap: 8px;
  font-size: 12px;
}
.delegator-dot {
  width: 9px;
  height: 9px;
  border-radius: 50%;
  border: 1px solid rgba(28, 26, 20, 0.4);
}
.delegator-name {
  font-weight: 600;
  color: var(--ink);
}
.delegator-task {
  color: rgba(28, 26, 20, 0.6);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

/* ────────────────────────────────────────────────────────────────────────
   Subtasks.
   ──────────────────────────────────────────────────────────────────────── */
.subtask-list {
  list-style: none;
  padding: 0;
  margin: 0;
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.subtask {
  display: grid;
  grid-template-columns: auto 1fr;
  gap: 10px;
  align-items: start;
  padding: 8px 12px;
  background: rgba(255, 252, 240, 0.85);
  border: 1px solid rgba(28, 26, 20, 0.12);
  border-radius: 3px;
}
.subtask-body { min-width: 0; }
.subtask-title {
  font-size: 12.5px;
  line-height: 1.3;
  color: var(--ink);
}
.subtask-meta {
  font-family: 'IBM Plex Mono', monospace;
  font-size: 9.5px;
  letter-spacing: 0.06em;
  color: rgba(28, 26, 20, 0.55);
  margin-top: 2px;
  word-break: break-all;
}

/* ────────────────────────────────────────────────────────────────────────
   Live pip — appears next to block titles when SSE is streaming.
   ──────────────────────────────────────────────────────────────────────── */
.live-pip {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 1px 7px;
  background: rgba(200, 66, 31, 0.14);
  color: #c8421f;
  border-radius: 999px;
  font-size: 8.5px;
  letter-spacing: 0.22em;
}
.live-pip-dot {
  width: 5px;
  height: 5px;
  border-radius: 50%;
  background: #c8421f;
  box-shadow: 0 0 4px rgba(200, 66, 31, 0.7);
  animation: pulse 1.6s ease-in-out infinite;
}
@keyframes pulse {
  0%, 100% { opacity: 1; }
  50%      { opacity: 0.45; }
}

/* ────────────────────────────────────────────────────────────────────────
   Stream of actions (worker feed) — left column.
   ──────────────────────────────────────────────────────────────────────── */
.feed-list {
  list-style: none;
  padding: 0;
  margin: 0;
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.feed-msg {
  border-left: 2px solid rgba(28, 26, 20, 0.18);
  padding: 4px 0 4px 12px;
}
.feed-msg-head {
  display: flex;
  align-items: center;
  gap: 6px;
  font-family: 'IBM Plex Mono', monospace;
  font-size: 9.5px;
  letter-spacing: 0.14em;
  text-transform: uppercase;
  color: rgba(40, 36, 26, 0.65);
  margin-bottom: 4px;
}
.feed-msg-glyph { width: 11px; height: 11px; flex-shrink: 0; }
.feed-msg-role { font-weight: 700; }
.feed-msg-tool { text-transform: none; letter-spacing: 0.04em; font-weight: 500; }
.feed-msg-time { margin-left: auto; opacity: 0.65; }
.feed-msg-content {
  font-family: ui-sans-serif, system-ui, sans-serif;
  font-size: 12px;
  line-height: 1.45;
  white-space: pre-wrap;
  word-wrap: break-word;
  margin: 0;
  color: var(--ink);
  max-height: 14em;
  overflow-y: auto;
  background: rgba(28, 26, 20, 0.05);
  padding: 7px 10px;
  border-radius: 3px;
}
.feed-msg--user { border-left-color: rgba(200, 66, 31, 0.5); }
.feed-msg--user .feed-msg-content { background: rgba(200, 66, 31, 0.08); }
.feed-msg--tool { border-left-color: rgba(40, 36, 26, 0.32); }
.feed-msg--tool .feed-msg-content {
  font-family: 'IBM Plex Mono', monospace;
  font-size: 10.5px;
  background: rgba(28, 26, 20, 0.08);
  color: #2a261c;
}
.feed-msg-reasoning {
  margin-bottom: 6px;
  font-size: 10.5px;
}
.feed-msg-reasoning summary {
  cursor: pointer;
  color: rgba(40, 36, 26, 0.55);
  font-family: 'IBM Plex Mono', monospace;
  font-size: 9px;
  letter-spacing: 0.18em;
  text-transform: uppercase;
  user-select: none;
}
.feed-msg-reasoning summary:hover { color: var(--ink); }
.feed-msg-reasoning pre {
  font-family: ui-sans-serif, system-ui, sans-serif;
  font-size: 11px;
  line-height: 1.45;
  white-space: pre-wrap;
  margin: 6px 0 0;
  padding: 7px 10px;
  background: rgba(243, 169, 59, 0.1);
  border-left: 2px solid rgba(243, 169, 59, 0.5);
  color: #4a3a14;
  max-height: 12em;
  overflow-y: auto;
}

/* ────────────────────────────────────────────────────────────────────────
   Permission approval / kill controls.
   ──────────────────────────────────────────────────────────────────────── */
.feed-approve {
  background: rgba(200, 66, 31, 0.06);
  border: 1px solid rgba(200, 66, 31, 0.55);
  border-left: 3px solid #c8421f;
  border-radius: 3px;
  padding: 12px 14px;
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.feed-approve-head {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  color: #c8421f;
  font-family: 'Antonio', sans-serif;
  font-weight: 700;
  font-size: 11px;
  letter-spacing: 0.2em;
  text-transform: uppercase;
}
.feed-approve-title { flex: 1 1 auto; }
.feed-approve-body {
  margin: 0;
  font-family: 'Instrument Serif', serif;
  font-style: italic;
  font-size: 13px;
  line-height: 1.4;
  color: rgba(40, 36, 26, 0.78);
}
.feed-approve-reason {
  margin: 0;
  padding: 7px 10px;
  background: var(--ink);
  color: #e6dfc8;
  border-radius: 2px;
  font-family: 'IBM Plex Mono', monospace;
  font-size: 10.5px;
  line-height: 1.4;
  white-space: pre-wrap;
  word-break: break-word;
  max-height: 120px;
  overflow-y: auto;
}
.feed-approve-input :deep(input) {
  background: rgba(255, 252, 240, 0.92) !important;
  border-color: rgba(40, 36, 26, 0.32) !important;
  font-size: 12px !important;
}
.feed-approve-hint {
  margin: 0;
  font-family: ui-sans-serif, system-ui, sans-serif;
  font-size: 10.5px;
  color: rgba(40, 36, 26, 0.62);
  line-height: 1.4;
}
.feed-approve-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  padding: 8px 16px;
  background: #c8421f;
  border: 2px solid #c8421f;
  border-radius: 2px;
  font-family: 'Antonio', sans-serif;
  font-weight: 700;
  font-size: 12px;
  letter-spacing: 0.2em;
  text-transform: uppercase;
  color: var(--paper);
  cursor: pointer;
  transition: transform 0.1s ease, background 0.12s ease;
  align-self: flex-end;
}
.feed-approve-btn:hover:not(:disabled) {
  background: #a83716;
  transform: translateY(-1px);
}
.feed-approve-btn:disabled { opacity: 0.5; cursor: not-allowed; }
.feed-kill { margin-top: 6px; }
.feed-kill-btn {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 6px 12px;
  background: transparent;
  border: 1px solid rgba(40, 36, 26, 0.22);
  border-radius: 2px;
  font-family: 'IBM Plex Mono', monospace;
  font-size: 10.5px;
  letter-spacing: 0.2em;
  text-transform: uppercase;
  color: rgba(40, 36, 26, 0.65);
  cursor: pointer;
  transition: background 0.12s ease, border-color 0.12s ease, color 0.12s ease;
}
.feed-kill-btn:hover:not(:disabled) {
  background: rgba(200, 66, 31, 0.08);
  border-color: rgba(200, 66, 31, 0.6);
  color: #c8421f;
}
.feed-kill-confirm {
  background: rgba(200, 66, 31, 0.08);
  border: 1px solid rgba(200, 66, 31, 0.5);
  border-radius: 3px;
  padding: 12px 14px;
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.feed-kill-title {
  margin: 0;
  font-family: 'Antonio', sans-serif;
  font-weight: 700;
  font-size: 11px;
  letter-spacing: 0.2em;
  text-transform: uppercase;
  color: #c8421f;
}
.feed-kill-body {
  margin: 0;
  font-family: 'Instrument Serif', serif;
  font-style: italic;
  font-size: 13px;
  line-height: 1.4;
  color: rgba(40, 36, 26, 0.78);
}
.feed-kill-actions { display: flex; justify-content: flex-end; gap: 8px; }
.feed-kill-cancel,
.feed-kill-confirm-btn {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  padding: 6px 14px;
  border-radius: 2px;
  font-family: 'IBM Plex Mono', monospace;
  font-size: 10.5px;
  letter-spacing: 0.2em;
  text-transform: uppercase;
  cursor: pointer;
}
.feed-kill-cancel {
  background: transparent;
  border: 1px solid rgba(40, 36, 26, 0.22);
  color: rgba(40, 36, 26, 0.65);
}
.feed-kill-confirm-btn {
  background: #c8421f;
  border: 1px solid #c8421f;
  color: var(--paper);
  font-weight: 600;
}
.feed-kill-confirm-btn:hover:not(:disabled) { background: #a83716; }
.feed-kill-cancel:disabled, .feed-kill-confirm-btn:disabled { opacity: 0.5; cursor: not-allowed; }

/* ────────────────────────────────────────────────────────────────────────
   Orchestrator step list + mission thread.
   ──────────────────────────────────────────────────────────────────────── */
.step-list {
  list-style: none;
  padding: 0;
  margin: 0;
  display: flex;
  flex-direction: column;
  gap: 5px;
}
.step {
  display: grid;
  grid-template-columns: auto auto 1fr;
  align-items: start;
  gap: 8px;
  padding: 5px 9px;
  background: rgba(255, 252, 240, 0.7);
  border-left: 2px solid rgba(28, 26, 20, 0.2);
  font-size: 11.5px;
  line-height: 1.35;
}
.step--tool { border-left-color: var(--amber); }
.step--thought { border-left-color: rgba(28, 26, 20, 0.36); }
.step-time {
  font-family: 'IBM Plex Mono', monospace;
  font-size: 9.5px;
  color: rgba(28, 26, 20, 0.45);
  letter-spacing: 0.04em;
  padding-top: 2px;
}
.step-glyph {
  width: 11px;
  height: 11px;
  color: rgba(28, 26, 20, 0.55);
  flex-shrink: 0;
  margin-top: 2px;
}
.step--tool .step-glyph { color: #c47b1c; }
.step-body {
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.step-label {
  display: inline-flex;
  align-items: baseline;
  gap: 6px;
  min-width: 0;
}
.step-tool {
  flex-shrink: 0;
  padding: 1px 6px;
  background: rgba(40, 36, 26, 0.08);
  border: 1px solid rgba(40, 36, 26, 0.18);
  border-radius: 2px;
  font-family: 'IBM Plex Mono', monospace;
  font-size: 9px;
  letter-spacing: 0.18em;
  text-transform: uppercase;
  color: rgba(28, 26, 20, 0.7);
}
.step--tool .step-tool {
  background: rgba(243, 169, 59, 0.16);
  border-color: rgba(243, 169, 59, 0.45);
  color: #8a5a14;
}
.step-text {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.step:hover .step-text { white-space: normal; overflow: visible; }
.step-detail {
  margin: 0;
  padding: 6px 9px;
  background: var(--ink);
  color: #e6dfc8;
  border-radius: 2px;
  font-family: 'IBM Plex Mono', monospace;
  font-size: 10.5px;
  line-height: 1.4;
  white-space: pre-wrap;
  word-break: break-word;
  max-height: 240px;
  overflow-y: auto;
}

.thread {
  list-style: none;
  padding: 0;
  margin: 0;
  display: flex;
  flex-direction: column;
  gap: 12px;
}
.msg {
  display: flex;
  flex-direction: column;
  gap: 3px;
  padding: 9px 13px 11px;
  background: rgba(255, 252, 240, 0.8);
  border: 1px solid rgba(28, 26, 20, 0.12);
  border-radius: 4px;
}
.msg--user {
  background: rgba(28, 26, 20, 0.92);
  color: var(--paper);
  border-color: transparent;
}
.msg-role {
  font-size: 8.5px;
  letter-spacing: 0.26em;
  text-transform: uppercase;
  opacity: 0.55;
}
.msg-body {
  font-family: 'IBM Plex Mono', monospace;
  font-size: 12px;
  line-height: 1.55;
  white-space: pre-wrap;
  word-break: break-word;
}
.msg-body--pending { color: rgba(28, 26, 20, 0.7); }
.msg--user .msg-body--pending { color: rgba(244, 239, 226, 0.85); }
.msg-cursor {
  display: inline-block;
  margin-left: 1px;
  animation: cursor-blink 1s steps(2, start) infinite;
}
@keyframes cursor-blink { to { visibility: hidden; } }

/* ────────────────────────────────────────────────────────────────────────
   Right column — model terminal.
   Dark TTY-style pane with title bar (traffic dots, session id, auto-poll
   indicator), token meters, log body, prompt line.
   ──────────────────────────────────────────────────────────────────────── */
.terminal {
  flex: 1 1 auto;
  min-height: 0;
  display: flex;
  flex-direction: column;
  background: var(--terminal);
  color: #e6dfc8;
  font-family: 'IBM Plex Mono', ui-monospace, monospace;
  position: relative;
}
/* Subtle CRT scanline overlay — barely there but adds character. */
.terminal::before {
  content: '';
  position: absolute;
  inset: 0;
  pointer-events: none;
  background:
    repeating-linear-gradient(180deg,
      rgba(255, 255, 255, 0.02) 0,
      rgba(255, 255, 255, 0.02) 1px,
      transparent 1px,
      transparent 3px);
  z-index: 1;
  opacity: 0.7;
  mix-blend-mode: overlay;
}
.terminal > * { position: relative; z-index: 2; }

.terminal-bar {
  display: grid;
  grid-template-columns: auto 1fr auto;
  align-items: center;
  gap: 14px;
  padding: 10px 14px;
  background: linear-gradient(180deg, #1a1812 0%, #14110b 100%);
  border-bottom: 1px solid rgba(243, 169, 59, 0.18);
  flex-shrink: 0;
}
.terminal-bar-traffic {
  display: inline-flex;
  align-items: center;
  gap: 6px;
}
.terminal-dot {
  width: 10px;
  height: 10px;
  border-radius: 50%;
  border: 1px solid rgba(0, 0, 0, 0.4);
}
.terminal-dot--r { background: #ec5b56; }
.terminal-dot--y { background: #f3bc4f; }
.terminal-dot--g { background: #66c45a; }

.terminal-bar-title {
  display: inline-flex;
  align-items: center;
  gap: 7px;
  color: #e6dfc8;
  font-size: 10.5px;
  letter-spacing: 0.18em;
  text-transform: uppercase;
  min-width: 0;
}
.terminal-bar-sess {
  color: rgba(243, 169, 59, 0.78);
  letter-spacing: 0.06em;
  text-transform: none;
  font-size: 10px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.terminal-bar-tools {
  display: inline-flex;
  align-items: center;
  gap: 10px;
  color: rgba(230, 223, 200, 0.65);
  font-size: 9.5px;
  letter-spacing: 0.06em;
}
.terminal-bar-size {
  font-family: 'IBM Plex Mono', monospace;
  letter-spacing: 0.1em;
  color: rgba(243, 169, 59, 0.78);
}
.terminal-bar-poll {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  padding: 2px 7px;
  background: rgba(243, 169, 59, 0.08);
  border: 1px solid rgba(243, 169, 59, 0.28);
  border-radius: 999px;
  color: #f3a93b;
  font-family: 'IBM Plex Mono', monospace;
  font-size: 9px;
  letter-spacing: 0.12em;
  text-transform: uppercase;
}
.terminal-poll-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: #f3a93b;
  box-shadow: 0 0 6px rgba(243, 169, 59, 0.7);
  animation: pulse 2.4s ease-in-out infinite;
}
.terminal-poll-dot--active {
  animation: pulse 0.5s ease-in-out infinite;
  background: #6ad06a;
  box-shadow: 0 0 8px rgba(106, 208, 106, 0.8);
}
.terminal-poll-text { white-space: nowrap; }
.terminal-bar-reload {
  width: 26px;
  height: 26px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  background: transparent;
  border: 1px solid rgba(243, 169, 59, 0.32);
  border-radius: 3px;
  color: #f3a93b;
  cursor: pointer;
  transition: background 0.12s ease, border-color 0.12s ease;
}
.terminal-bar-reload:hover:not(:disabled) {
  background: rgba(243, 169, 59, 0.12);
  border-color: rgba(243, 169, 59, 0.6);
}
.terminal-bar-reload:disabled { opacity: 0.6; cursor: not-allowed; }

.terminal-meters {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(96px, 1fr));
  gap: 0;
  padding: 0;
  border-bottom: 1px solid rgba(243, 169, 59, 0.14);
  background: rgba(255, 255, 255, 0.02);
}
.terminal-meter {
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding: 9px 12px;
  border-right: 1px solid rgba(243, 169, 59, 0.12);
  font-family: 'IBM Plex Mono', monospace;
  min-width: 0;
}
.terminal-meter:last-child { border-right: 0; }
.terminal-meter-label {
  font-size: 8.5px;
  letter-spacing: 0.22em;
  text-transform: uppercase;
  color: rgba(230, 223, 200, 0.5);
}
.terminal-meter-value {
  font-size: 13px;
  font-weight: 600;
  color: #e6dfc8;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.terminal-meter--in    .terminal-meter-value { color: #a4d8a4; }
.terminal-meter--out   .terminal-meter-value { color: #ff9a76; }
.terminal-meter--cache .terminal-meter-value { color: rgba(230, 223, 200, 0.85); }
.terminal-meter--cost  .terminal-meter-value { color: #f3a93b; }

.terminal-notice {
  margin: 0;
  padding: 8px 14px;
  background: rgba(243, 169, 59, 0.08);
  border-bottom: 1px solid rgba(243, 169, 59, 0.18);
  font-family: 'Instrument Serif', serif;
  font-style: italic;
  font-size: 11.5px;
  color: rgba(243, 169, 59, 0.85);
}

.terminal-body {
  flex: 1 1 auto;
  min-height: 0;
  margin: 0;
  padding: 14px 18px 8px;
  overflow-y: auto;
  background: transparent;
  color: #e6dfc8;
  font-family: 'IBM Plex Mono', ui-monospace, monospace;
  font-size: 11.5px;
  line-height: 1.55;
  white-space: pre-wrap;
  word-break: break-word;
  scrollbar-color: rgba(243, 169, 59, 0.28) transparent;
  scrollbar-width: thin;
}
.terminal-body::-webkit-scrollbar { width: 8px; }
.terminal-body::-webkit-scrollbar-thumb {
  background: rgba(243, 169, 59, 0.28);
  border-radius: 4px;
}

.terminal-prompt {
  flex-shrink: 0;
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 10px 18px 14px;
  border-top: 1px solid rgba(243, 169, 59, 0.14);
  background: rgba(0, 0, 0, 0.28);
  font-family: 'IBM Plex Mono', monospace;
  font-size: 11px;
  color: rgba(230, 223, 200, 0.62);
  letter-spacing: 0.04em;
}
.terminal-prompt-glyph { color: #6ad06a; }
.terminal-prompt-path { color: #f3a93b; }
.terminal-prompt-arrow { color: rgba(230, 223, 200, 0.55); }
.terminal-prompt-cmd { color: rgba(230, 223, 200, 0.78); }
.terminal-prompt-cursor {
  display: inline-block;
  width: 8px;
  height: 14px;
  background: #e6dfc8;
  margin-left: auto;
  animation: cursor-blink 1.05s steps(2, start) infinite;
}
.terminal-prompt-cursor--active {
  background: #6ad06a;
  box-shadow: 0 0 8px rgba(106, 208, 106, 0.6);
  animation: pulse 0.5s ease-in-out infinite;
}

/* Spin utility (used by both reload icons and inline loaders). */
.spin { animation: spin 1s linear infinite; }
@keyframes spin { to { transform: rotate(360deg); } }
</style>
