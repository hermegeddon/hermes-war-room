<script setup lang="ts">
import type { Profile } from '~/types/profile'
import type { Mission, MissionMessage, CurrentTask, CompletedTask } from '~/types/mission'
import SlashCommandPicker, { type SlashCommand } from './SlashCommandPicker.vue'
import TriageDraftPanel from './TriageDraftPanel.vue'
// renderMarkdown / stripHarmonyTags / decorateTaskRefs are auto-imported
// from `~/composables/useMarkdown`.

interface Props {
  orchestrators: Profile[]
  /** Live kanban tasks polled by the parent (home page). Used to render the
   *  "Board" tab. */
  tasks?: CurrentTask[]
}
const props = withDefaults(defineProps<Props>(), { tasks: () => [] })

const emit = defineEmits<{
  /** Bubble a click on a board card (live or history) up to the parent so it
   *  can open the operative slideover. */
  selectTask: [task: CurrentTask | CompletedTask]
}>()

const { t } = useI18n()
const toast = useToast()
const { data: config } = await useFetch<{ missionsEnabled: boolean }>('/api/config')
const missionsEnabled = computed(() => config.value?.missionsEnabled ?? true)

type Tab = 'chat' | 'board'
const tab = ref<Tab>('chat')
// Default to board when missions are disabled
watch(missionsEnabled, (enabled) => {
  if (!enabled && tab.value === 'chat') {
    tab.value = 'board'
  }
}, { immediate: true })

const STORAGE_KEY = 'hermes-war-room.lastOrchestratorSlug'

const stream = useMissionStream()
const draft = ref('')
const sending = ref(false)
const dispatcherStale = defineModel<boolean>('dispatcherStale', { default: false })

const orchestratorOptions = computed(() => props.orchestrators.map(p => ({
  label: p.givenName ?? p.displayName,
  value: p.slug
})))

const selectedSlug = ref<string | null>(null)

function chooseInitialSlug() {
  const stored = typeof window !== 'undefined' ? localStorage.getItem(STORAGE_KEY) : null
  const candidates = props.orchestrators.map(p => p.slug)
  if (stored && candidates.includes(stored)) {
    selectedSlug.value = stored
    return
  }
  if (candidates.includes('lider')) {
    selectedSlug.value = 'lider'
    return
  }
  selectedSlug.value = candidates[0] ?? null
}

watch(() => props.orchestrators.length, () => {
  if (!selectedSlug.value) chooseInitialSlug()
}, { immediate: true })

watch(selectedSlug, (slug) => {
  if (typeof window !== 'undefined' && slug) {
    localStorage.setItem(STORAGE_KEY, slug)
  }
})

const selectedOrchestrator = computed(() =>
  props.orchestrators.find(p => p.slug === selectedSlug.value) ?? null
)

const orchestratorLabel = computed(() => selectedOrchestrator.value?.givenName ?? selectedOrchestrator.value?.displayName ?? '')

async function loadActive() {
  if (!selectedSlug.value) return
  try {
    const res = await $fetch<{ mission: Mission | null, messages: MissionMessage[] }>(
      `/api/missions/active?orchestrator=${encodeURIComponent(selectedSlug.value)}`
    )
    if (res.mission) {
      stream.attach(res.mission, res.messages)
    } else {
      stream.reset()
    }
  } catch (e) {
    console.error('loadActive failed', e)
  }
}

// Fire-and-forget pre-warm for the selected orchestrator's ACP child. Saves
// the ~5-15s Python+MCP cold start on the user's first prompt. We don't await
// nor surface errors — if it fails the regular send path will just hit the
// cold start as before.
const warming = ref(false)
function warmupOrchestrator(slug: string) {
  if (warming.value) return
  warming.value = true
  $fetch(`/api/orchestrators/${encodeURIComponent(slug)}/warmup`, { method: 'POST' })
    .catch((e) => {
      console.warn('orchestrator warmup failed', e)
    })
    .finally(() => {
      warming.value = false
    })
}

watch(selectedSlug, (slug) => {
  loadActive()
  if (slug) warmupOrchestrator(slug)
})
onMounted(() => {
  loadActive()
  if (selectedSlug.value) warmupOrchestrator(selectedSlug.value)
})

const TRIAGE_PREFIX_RE = /^\s*\/triage(?:\s+|$)/i

async function handleSend() {
  const rawText = draft.value
  const text = rawText.trim()
  if (!text || sending.value || !selectedSlug.value) return
  sending.value = true
  try {
    if (stream.mission.value) {
      /* Mid-mission: slash shortcuts are first-message only by design — if
         the user happens to type `/triage` after the mission is open, send
         it as plain text rather than re-triggering triage (which would
         hijack the conversation). */
      await stream.send(text)
    } else if (TRIAGE_PREFIX_RE.test(text)) {
      const prompt = text.replace(TRIAGE_PREFIX_RE, '').trim()
      if (!prompt) {
        toast.add({
          title: t('mission.failure'),
          description: t('mission.commands.triage.description'),
          color: 'warning'
        })
        return
      }
      await stream.start(selectedSlug.value, prompt, { mode: 'direct-triage' })
    } else {
      await stream.start(selectedSlug.value, text)
    }
    draft.value = ''
  } catch (e) {
    toast.add({
      title: t('mission.failure'),
      description: (e as Error).message,
      color: 'error'
    })
  } finally {
    sending.value = false
  }
}

/* Slash command picker — currently exposes only `/triage`. Visible while
   the composer holds an unsent `/<word>` and the mission hasn't started
   yet (per-mission, not per-turn). */
const slashCommands = computed<SlashCommand[]>(() => [
  {
    id: 'triage',
    label: t('mission.commands.triage.label'),
    description: t('mission.commands.triage.description')
  }
])
const slashPickerRef = ref<InstanceType<typeof SlashCommandPicker> | null>(null)
const slashCommandsEnabled = computed(() => !hasMission.value)

function onSlashCommandSelect(cmd: SlashCommand) {
  if (cmd.id === '__dismiss__') {
    draft.value = ''
    return
  }
  if (cmd.id === 'triage') {
    /* Pre-fill the buffer with `/triage ` and leave the caret after the
       space so the user types the prompt next; pressing Enter will trigger
       the direct-triage path in handleSend(). */
    draft.value = cmd.label + ' '
  }
}

function onComposerKeydown(e: KeyboardEvent) {
  if (slashPickerRef.value?.handleKeydown(e)) {
    e.preventDefault()
    e.stopPropagation()
    return
  }
  if (e.key === 'Enter' && !e.shiftKey && !e.altKey && !e.ctrlKey && !e.metaKey) {
    e.preventDefault()
    handleSend()
  }
}

/* Supervisor mode = the mission has been promoted into a triage task and
   the orchestrator is now watching subtasks complete. Drives placeholder
   text + a small badge above the composer. */
const isSupervisor = computed(() => !!stream.mission.value?.triageTaskId)

const composerPlaceholder = computed(() => {
  if (isSupervisor.value) return t('mission.input.supervisor')
  if (hasMission.value) return t('mission.input.followUp')
  return t('mission.empty.placeholder', { orch: orchestratorLabel.value })
})

async function onLaunchDraft(payload: { title: string, body: string }) {
  try {
    await stream.launchTriage(payload.title, payload.body)
  } catch (e) {
    toast.add({
      title: t('mission.triageDraft.launchFailed'),
      description: (e as Error).message,
      color: 'error'
    })
  }
}

function onDismissDraft() {
  /* Soft dismiss — clears the panel locally without telling the server.
     The orchestrator will re-emit the block on the next refinement turn
     if the user keeps refining; otherwise nothing happens. */
  stream.triageDraft.value = null
}

const transcriptRef = ref<HTMLElement | null>(null)

/* Auto-scroll to bottom on every transcript change — new messages, streaming
   chunks, mount. Forced rather than gated: the chat is a tailing surface, the
   user expects new tokens to stay visible. If they want to read scrollback
   they can switch tabs or pause the stream. */
function scrollTranscriptToBottom() {
  const el = transcriptRef.value
  if (!el) return
  el.scrollTop = el.scrollHeight
}

watch(() => stream.messages.value.length, () => {
  nextTick(() => scrollTranscriptToBottom())
})
watch(() => stream.messages.value[stream.messages.value.length - 1]?.content, () => {
  nextTick(() => scrollTranscriptToBottom())
})

const hasMission = computed(() => stream.mission.value !== null)

/* Task-id → metadata map. Drives the inline `t_xxxx · agent — title` chip
   that decorateTaskRefs() inserts into rendered orchestrator output. The
   chip's accent comes from the assignee's profile colour, so the text reads
   like "this task belongs to <agent>" at a glance. */
const taskRefLookup = computed(() => {
  const profileBySlug = new Map<string, Profile>()
  for (const p of props.orchestrators) profileBySlug.set(p.slug, p)
  const m = new Map<string, { id: string, title: string, assignee: string | null, color: string | null }>()
  for (const tk of props.tasks) {
    const profile = tk.assignee ? profileBySlug.get(tk.assignee) ?? null : null
    m.set(tk.id, {
      id: tk.id,
      title: tk.title,
      assignee: tk.assignee,
      color: profile?.backgroundColor ?? null
    })
  }
  return m
})

/* Strip channel-control tokens, render markdown, then decorate task IDs as
   coloured chips. Used for assistant turns; user turns only get the strip
   pass since they're plain text. */
function renderAssistantContent(content: string): string {
  const cleaned = stripHarmonyTags(content)
  const html = renderMarkdown(cleaned)
  return decorateTaskRefs(html, taskRefLookup.value)
}

/* True when the assistant message, once stripped of harmony tags and the
   TRIAGE_DRAFT block, still has visible prose. False positives here would
   render an empty bubble — exactly the bug we patch downstream by showing
   a "check the panel below" placeholder instead. */
function hasVisibleAssistantContent(content: string): boolean {
  return stripHarmonyTags(content).trim().length > 0
}

/* True when the raw content carries a triage-draft block in either shape
   — the current fenced `\`\`\`triage` block or the legacy `<<TRIAGE_DRAFT>>`
   wrapper. We strip both from the rendered bubble because the panel surfaces
   them; this helper decides whether an empty bubble means "model emitted
   only the draft" (show panel hint) vs. "model failed to emit anything
   visible" (no hint). Without this gate, every plain assistant turn that
   happens to strip down to empty (harmony-channel-only output, etc.) would
   incorrectly nudge the user toward the launch panel. */
const TRIAGE_DRAFT_RE = /```(?:triage(?:_draft|-draft)?)\s*\n[\s\S]*?```|<<TRIAGE_DRAFT>>[\s\S]*?<<\/TRIAGE_DRAFT>>/i
function hasTriageDraftBlock(content: string): boolean {
  return TRIAGE_DRAFT_RE.test(content)
}

/* Force one scroll-to-bottom the moment the transcript element mounts (i.e.
   when `hasMission` flips true and the v-if renders the container). Without
   this, opening the panel onto an existing long mission lands the user at the
   top of the history. */
watch(transcriptRef, (el) => {
  if (el) nextTick(() => scrollTranscriptToBottom())
})
</script>

<template>
  <section class="mission">
    <header
      v-if="missionsEnabled"
      class="mission-header"
    >
      <!-- MISIÓN on the left — the panel's quiet identity caption. Antonio
           bold uppercase with the hot-red target glyph; restrained so the
           eye reads it as a label, not a banner. -->
      <div class="mission-title">
        <UIcon
          name="i-lucide-target"
          class="mission-title-glyph"
        />
        {{ t('mission.title') }}
      </div>

      <!-- Orchestrator on the right: a small "Orquestador encargado:"
           eyebrow sits above the avatar + select so users know what the
           dropdown controls without needing to read the placeholder text. -->
      <div
        v-if="missionsEnabled"
        class="mission-orch"
      >
        <p class="mission-orch-label">
          {{ t('mission.orchestratorLabel') }}
        </p>
        <div class="mission-orch-row">
          <UAvatar
            v-if="selectedOrchestrator"
            :src="selectedOrchestrator.avatarUrl"
            size="sm"
          />
          <USelect
            :model-value="selectedSlug ?? undefined"
            :items="orchestratorOptions"
            value-key="value"
            variant="ghost"
            size="sm"
            class="mission-orch-select"
            @update:model-value="(v: string) => selectedSlug = v"
          >
            <template #leading>
              <UIcon
                name="i-lucide-radio"
                class="size-3.5"
              />
            </template>
          </USelect>
        </div>
      </div>
    </header>

    <div
      v-if="dispatcherStale"
      class="mission-warn"
    >
      <UIcon
        name="i-lucide-triangle-alert"
        class="size-3.5"
      />
      {{ t('mission.dispatcherWarning') }}
    </div>

    <!-- Tab strip — switches the body between the chat transcript and the
         live kanban board. The composer at the bottom stays mounted in
         both views so the user can keep talking to the orchestrator while
         watching the board. When missions are disabled, tabs are hidden. -->
    <div
      v-if="missionsEnabled"
      class="mission-tabs"
    >
      <button
        type="button"
        class="mission-tab"
        :class="{ 'is-active': tab === 'chat' }"
        @click="tab = 'chat'"
      >
        <UIcon
          name="i-lucide-message-square"
          class="mission-tab-glyph"
        />
        {{ t('mission.tabs.chat') }}
      </button>
      <button
        type="button"
        class="mission-tab"
        :class="{ 'is-active': tab === 'board' }"
        @click="tab = 'board'"
      >
        <UIcon
          name="i-lucide-kanban-square"
          class="mission-tab-glyph"
        />
        {{ t('mission.tabs.board') }}
        <span
          v-if="tasks.length"
          class="mission-tab-count"
        >{{ tasks.length }}</span>
      </button>
    </div>

    <MissionKanban
      v-if="tab === 'board' || !missionsEnabled"
      class="mission-board"
      :tasks="tasks"
      :profiles="orchestrators"
      @select="(task) => emit('selectTask', task)"
    />

    <div
      v-if="tab === 'chat' && hasMission"
      ref="transcriptRef"
      class="mission-transcript"
    >
      <div
        v-if="isSupervisor && stream.mission.value?.triageTaskId"
        class="mission-supervisor-banner"
      >
        <span class="mission-supervisor-badge">{{ t('mission.supervisor.badge') }}</span>
        <span class="mission-supervisor-note">
          {{ t('mission.supervisor.note', { id: stream.mission.value.triageTaskId }) }}
        </span>
      </div>
      <div
        v-if="stream.triageLaunching.value && !stream.triageDraft.value"
        class="mission-direct-triage"
      >
        <UIcon
          name="i-lucide-loader"
          class="size-4 mission-direct-triage-spin"
        />
        {{ t('mission.directTriage.launching') }}
      </div>
      <div
        v-for="m in stream.messages.value"
        :key="m.id"
        class="mission-msg"
        :class="`mission-msg-${m.role}`"
      >
        <div class="mission-bubble">
          <span
            v-if="m.pending && m.content === ''"
            class="mission-thinking"
          >
            <span class="mission-dot" />
            <span class="mission-dot" />
            <span class="mission-dot" />
          </span>
          <template v-else-if="m.role === 'assistant'">
            <template v-if="hasVisibleAssistantContent(m.content)">
              <!-- eslint-disable vue/no-v-html -->
              <div
                class="mission-md"
                v-html="renderAssistantContent(m.content)"
              />
              <!-- eslint-enable vue/no-v-html -->
            </template>
            <span
              v-else-if="hasTriageDraftBlock(m.content)"
              class="mission-draft-hint"
            >
              <UIcon
                name="i-lucide-arrow-down"
                class="mission-draft-hint-glyph"
              />
              {{ t('mission.triageDraft.checkPanel') }}
            </span>
            <span
              v-if="m.pending"
              class="mission-caret"
            >▍</span>
          </template>
          <template v-else>
            {{ stripHarmonyTags(m.content) }}<span
              v-if="m.pending"
              class="mission-caret"
            >▍</span>
          </template>
        </div>
      </div>
      <TriageDraftPanel
        v-if="stream.triageDraft.value && !isSupervisor"
        :draft="stream.triageDraft.value"
        :launching="stream.triageLaunching.value"
        @launch="onLaunchDraft"
        @dismiss="onDismissDraft"
      />
      <div
        v-if="stream.error.value"
        class="mission-error"
      >
        <UIcon
          name="i-lucide-circle-alert"
          class="size-3.5"
        />
        {{ stream.error.value }}
      </div>
    </div>

    <form
      v-if="missionsEnabled"
      class="mission-input"
      @submit.prevent="handleSend"
    >
      <p
        v-if="stream.streaming.value"
        class="mission-input-status"
      >
        <span class="mission-input-status-dot" />
        {{ t('mission.thinking', { orch: orchestratorLabel }) }}
      </p>
      <div class="mission-composer">
        <SlashCommandPicker
          ref="slashPickerRef"
          :value="draft"
          :commands="slashCommands"
          :enabled="slashCommandsEnabled"
          @select="onSlashCommandSelect"
        />
        <UTextarea
          v-model="draft"
          :placeholder="composerPlaceholder"
          :rows="2"
          autoresize
          :disabled="sending || !selectedSlug"
          class="mission-textarea"
          @keydown="onComposerKeydown"
        />
        <UButton
          type="submit"
          icon="i-lucide-send-horizontal"
          color="primary"
          size="sm"
          class="mission-send"
          :loading="sending || stream.streaming.value"
          :disabled="!draft.trim() || !selectedSlug"
          :aria-label="t('mission.send')"
        />
      </div>
    </form>
  </section>
</template>

<style scoped>
.mission {
  position: relative;
  display: flex;
  flex-direction: column;
  height: 100%;
  background: rgba(255, 252, 240, 0.85);
  border: 1px solid rgba(28, 26, 20, 0.18);
  border-radius: 4px;
  padding: 14px 18px 16px;
  font-family: 'IBM Plex Mono', ui-monospace, monospace;
  color: #2a261c;
  box-shadow: 0 1px 0 rgba(255, 255, 255, 0.6) inset, 0 6px 14px -10px rgba(28, 26, 20, 0.35);
  min-height: 0;
}

.mission-header {
  display: flex;
  align-items: flex-end;
  justify-content: space-between;
  gap: 16px;
  padding-bottom: 10px;
  border-bottom: 1px dashed rgba(28, 26, 20, 0.2);
  margin-bottom: 12px;
}

/* MISIÓN — quiet identity caption on the left, original treatment. */
.mission-title {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  font-family: 'Antonio', sans-serif;
  font-weight: 700;
  font-size: 12px;
  letter-spacing: 0.28em;
  text-transform: uppercase;
  color: #1c1a14;
  white-space: nowrap;
}
.mission-title-glyph {
  width: 14px;
  height: 14px;
  color: #c8421f;
}

/* Orchestrator cluster on the right: stacked "Orquestador encargado:" label
   over the avatar + select, both right-aligned so the cluster ends flush
   with the panel's right edge. */
.mission-orch {
  display: flex;
  flex-direction: column;
  align-items: flex-end;
  gap: 4px;
  min-width: 0;
}
.mission-orch-label {
  font-family: 'IBM Plex Mono', ui-monospace, monospace;
  font-size: 9px;
  font-weight: 500;
  letter-spacing: 0.22em;
  text-transform: uppercase;
  color: rgba(28, 26, 20, 0.55);
  margin: 0;
  line-height: 1;
}
.mission-orch-row {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
}
.mission-orch-select {
  min-width: 0;
}

.mission-warn {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 12px;
  margin-bottom: 12px;
  background: rgba(243, 169, 59, 0.18);
  border: 1px solid rgba(243, 169, 59, 0.45);
  border-radius: 3px;
  font-size: 11px;
  letter-spacing: 0.04em;
  color: #6b4a13;
}

/* Tab strip — Chat | Board switcher */
.mission-tabs {
  display: inline-flex;
  align-items: center;
  gap: 2px;
  padding: 3px;
  margin-bottom: 12px;
  background: rgba(28, 26, 20, 0.06);
  border: 1px solid rgba(28, 26, 20, 0.18);
  border-radius: 4px;
  align-self: flex-start;
}
.mission-tab {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 5px 11px;
  background: transparent;
  border: 0;
  font-family: 'IBM Plex Mono', monospace;
  font-size: 10.5px;
  font-weight: 500;
  letter-spacing: 0.18em;
  text-transform: uppercase;
  color: #4a4536;
  border-radius: 3px;
  cursor: pointer;
  transition: color 0.15s ease, background 0.15s ease;
}
.mission-tab:hover {
  color: #1c1a14;
}
.mission-tab.is-active {
  color: #f4efe2;
  background: #1c1a14;
}
.mission-tab-glyph {
  width: 12px;
  height: 12px;
}
.mission-tab-count {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-width: 18px;
  padding: 1px 5px;
  background: #c8421f;
  color: #f4efe2;
  border-radius: 999px;
  font-size: 9px;
  letter-spacing: 0.04em;
}
.mission-tab.is-active .mission-tab-count {
  background: rgba(255, 252, 240, 0.22);
}

.mission-board {
  flex: 1 1 auto;
  min-height: 0;
  margin-bottom: 10px;
}

.mission-transcript {
  flex: 1 1 auto;
  min-height: 0;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding: 4px 2px 12px;
  margin-bottom: 10px;
  scroll-behavior: smooth;
}

.mission-msg {
  display: flex;
}
.mission-msg-user {
  justify-content: flex-end;
}
.mission-msg-assistant {
  justify-content: flex-start;
}
.mission-bubble {
  max-width: 76%;
  padding: 8px 12px;
  border-radius: 4px;
  font-family: ui-sans-serif, system-ui, sans-serif;
  font-size: 13px;
  line-height: 1.45;
  white-space: pre-wrap;
  word-wrap: break-word;
}
.mission-msg-user .mission-bubble {
  background: #1c1a14;
  color: #f4efe2;
  border-bottom-right-radius: 1px;
}
.mission-msg-assistant .mission-bubble {
  background: rgba(28, 26, 20, 0.06);
  color: #1c1a14;
  border: 1px solid rgba(28, 26, 20, 0.12);
  border-bottom-left-radius: 1px;
}

/* Markdown rendering inside assistant bubbles. Scoped attr is added by Vue,
   but :deep() lets us style children produced by v-html. */
.mission-md :deep(p) { margin: 0 0 8px; }
.mission-md :deep(p:last-child) { margin-bottom: 0; }
.mission-md :deep(ul),
.mission-md :deep(ol) { margin: 0 0 8px; padding-left: 22px; }
.mission-md :deep(li) { margin: 2px 0; }
.mission-md :deep(strong) { font-weight: 600; }
.mission-md :deep(em) { font-style: italic; }
.mission-md :deep(a) {
  color: #c8421f;
  text-decoration: underline;
  text-underline-offset: 2px;
}
.mission-md :deep(h1),
.mission-md :deep(h2),
.mission-md :deep(h3),
.mission-md :deep(h4) {
  font-family: 'Antonio', sans-serif;
  font-weight: 700;
  margin: 10px 0 6px;
  letter-spacing: 0.04em;
}
.mission-md :deep(h1) { font-size: 16px; }
.mission-md :deep(h2) { font-size: 14px; }
.mission-md :deep(h3) { font-size: 13px; }
.mission-md :deep(h4) { font-size: 12px; }
.mission-md :deep(code) {
  font-family: 'IBM Plex Mono', monospace;
  font-size: 12px;
  background: rgba(28, 26, 20, 0.08);
  padding: 1px 5px;
  border-radius: 3px;
}

/* Task-reference chip — emitted by decorateTaskRefs(). Inline pill that
   carries the assignee's profile colour as `--accent`, so a sentence like
   "I delegated t_abc123 to legal — Search norms" renders the task as a
   single coloured entity instead of a raw id surrounded by prose. */
.mission-md :deep(.task-ref) {
  display: inline-flex;
  align-items: baseline;
  gap: 6px;
  padding: 2px 9px 2px 8px;
  background: color-mix(in srgb, var(--accent, #d4d4d4) 26%, #f4efe2);
  border: 1px solid color-mix(in srgb, var(--accent, #d4d4d4) 70%, #1c1a14);
  border-radius: 3px;
  /* 3 px stripe of pure accent tucked under the left edge — matches the
     workstation placard's unit-colour stripe so chips read as part of the
     same visual family. */
  box-shadow: inset 3px 0 0 0 var(--accent, #d4d4d4);
  padding-left: 11px;
  color: #1c1a14;
  font-family: 'IBM Plex Mono', ui-monospace, monospace;
  font-size: 0.92em;
  line-height: 1.35;
  text-decoration: none;
  white-space: nowrap;
  vertical-align: baseline;
  cursor: help;
  transition: transform 0.1s ease, background 0.12s ease;
}
.mission-md :deep(.task-ref:hover) {
  background: color-mix(in srgb, var(--accent, #d4d4d4) 50%, #f4efe2);
  transform: translateY(-1px);
}
.mission-md :deep(.task-ref-id) {
  font-weight: 600;
  letter-spacing: 0.02em;
}
.mission-md :deep(.task-ref-sep) {
  opacity: 0.5;
  font-size: 0.85em;
}
.mission-md :deep(.task-ref-agent) {
  font-family: 'Antonio', 'Bebas Neue', sans-serif;
  font-weight: 700;
  letter-spacing: 0.14em;
  text-transform: uppercase;
  font-size: 0.9em;
}
.mission-md :deep(.task-ref-title) {
  font-family: 'Instrument Serif', serif;
  font-style: italic;
  font-size: 0.98em;
  letter-spacing: 0;
  /* Long titles wrap inside the chip — drop nowrap on the rich variant. */
  white-space: normal;
}
.mission-md :deep(.task-ref--rich) {
  white-space: normal;
  max-width: 100%;
}
.mission-md :deep(pre) {
  background: #1c1a14;
  color: #f4efe2;
  padding: 10px 12px;
  border-radius: 4px;
  margin: 6px 0 10px;
  overflow-x: auto;
  font-size: 12px;
  line-height: 1.4;
}
.mission-md :deep(pre code) {
  background: transparent;
  color: inherit;
  padding: 0;
}
.mission-md :deep(blockquote) {
  border-left: 3px solid rgba(28, 26, 20, 0.25);
  padding-left: 10px;
  margin: 6px 0;
  color: rgba(28, 26, 20, 0.7);
  font-style: italic;
}
.mission-md :deep(table) {
  border-collapse: collapse;
  margin: 6px 0 10px;
  font-size: 12px;
}
.mission-md :deep(th),
.mission-md :deep(td) {
  border: 1px solid rgba(28, 26, 20, 0.2);
  padding: 4px 8px;
  text-align: left;
}
.mission-md :deep(th) {
  background: rgba(28, 26, 20, 0.08);
  font-weight: 600;
}
.mission-md :deep(hr) {
  border: none;
  border-top: 1px dashed rgba(28, 26, 20, 0.25);
  margin: 10px 0;
}

.mission-thinking {
  display: inline-flex;
  align-items: center;
  gap: 4px;
}
.mission-dot {
  width: 5px;
  height: 5px;
  border-radius: 50%;
  background: rgba(28, 26, 20, 0.4);
  animation: mission-dot 1.2s ease-in-out infinite;
}
.mission-dot:nth-child(2) { animation-delay: 0.2s; }
.mission-dot:nth-child(3) { animation-delay: 0.4s; }
@keyframes mission-dot {
  0%, 100% { opacity: 0.25; transform: translateY(0); }
  50%      { opacity: 1;    transform: translateY(-2px); }
}

.mission-caret {
  display: inline-block;
  margin-left: 1px;
  font-weight: 700;
  color: #c8421f;
  animation: caret 1s steps(2) infinite;
}
@keyframes caret {
  0%, 50% { opacity: 1; }
  51%, 100% { opacity: 0; }
}

.mission-error {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 6px 10px;
  background: rgba(200, 66, 31, 0.12);
  border: 1px solid rgba(200, 66, 31, 0.35);
  border-radius: 3px;
  font-size: 11px;
  color: #c8421f;
  align-self: flex-start;
}

/* Banner above the transcript that signals the mission has been promoted
   into a real triage task. The chat still works (the orchestrator now
   supervises) but the user should know they're no longer refining. */
.mission-supervisor-banner {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 10px;
  background: rgba(28, 26, 20, 0.06);
  border: 1px solid rgba(28, 26, 20, 0.18);
  border-left: 3px solid #c8421f;
  border-radius: 3px;
  font-size: 10px;
  letter-spacing: 0.04em;
  color: #1c1a14;
}
.mission-supervisor-badge {
  font-family: 'Antonio', sans-serif;
  font-weight: 700;
  font-size: 10px;
  letter-spacing: 0.22em;
  text-transform: uppercase;
  color: #c8421f;
  flex-shrink: 0;
}
.mission-supervisor-note { color: #4a4536; }

/* Inline progress indicator shown while the backend is spawning the
   direct-triage workflow (`/triage <prompt>` shortcut, no chat). */
.mission-direct-triage {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  padding: 7px 12px;
  background: rgba(243, 169, 59, 0.16);
  border: 1px solid rgba(243, 169, 59, 0.45);
  border-radius: 3px;
  color: #6b4a13;
  font-size: 11px;
  letter-spacing: 0.04em;
  align-self: flex-start;
}
.mission-direct-triage-spin { animation: mission-spin 1.4s linear infinite; }
@keyframes mission-spin { to { transform: rotate(360deg); } }

/* Fallback shown inside an assistant bubble when the model's reply boils
   down to the TRIAGE_DRAFT block alone (stripped from the visible chat by
   stripHarmonyTags). Without this, the user would see an empty bubble. */
.mission-draft-hint {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-family: 'Instrument Serif', serif;
  font-style: italic;
  font-size: 13px;
  color: #6b4a13;
}
.mission-draft-hint-glyph {
  width: 13px;
  height: 13px;
  color: #c8421f;
  flex-shrink: 0;
}

/* Input zone — always pinned to the bottom of the panel column thanks to
   `margin-top: auto`. Even when the transcript is short the composer stays
   anchored at the floor so the user always knows where to type. */
.mission-input {
  margin-top: auto;
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.mission-input-status {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding-left: 4px;
  font-size: 10px;
  letter-spacing: 0.18em;
  text-transform: uppercase;
  color: #1c1a14;
}
.mission-input-status-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: #c8421f;
  box-shadow: 0 0 6px rgba(200, 66, 31, 0.7);
  animation: caret 1.4s ease-in-out infinite;
}

/* Composer — textarea + send button stacked in the same box. The button
   sits absolute at the bottom-right corner so the icon hugs the input
   even as it grows with autoresize. */
.mission-composer {
  position: relative;
  width: 100%;
}
.mission-textarea {
  width: 100%;
}
/* Reserve space inside the textarea so the user's caret never collides
   with the absolute-positioned send button. */
.mission-textarea :deep(textarea) {
  padding-right: 52px;
  resize: none;
}
.mission-send {
  position: absolute;
  right: 8px;
  bottom: 8px;
  z-index: 2;
  border-radius: 3px;
  padding: 6px;
  min-width: 32px;
  min-height: 32px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
}
</style>
