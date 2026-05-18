<script setup lang="ts">
/**
 * Lightweight slash-command picker that anchors to a textarea. Opens when
 * the user types `/` at the start of the input and offers a small menu of
 * commands. Designed for the mission composer's `/triage` shortcut but
 * generic enough to grow with more commands later — pass `commands` and
 * listen for `select`.
 */

export interface SlashCommand {
  /** Identifier used by the parent in the `select` event. */
  id: string
  /** Visible name, e.g. "/triage". */
  label: string
  /** One-line caption shown under the label. */
  description: string
}

const props = defineProps<{
  /** Current value of the composer's textarea — picker watches this to
   *  decide whether to open and to filter the visible commands. */
  value: string
  commands: SlashCommand[]
  /** Set false to suppress the picker entirely (e.g. once a mission has
   *  already been started — slash commands are first-message only). */
  enabled?: boolean
}>()

const emit = defineEmits<{
  /** Fired when the user picks a command via mouse or keyboard. */
  select: [command: SlashCommand]
}>()

const { t } = useI18n()

const open = computed(() => {
  if (props.enabled === false) return false
  const v = props.value
  if (!v) return false
  // Open only when the buffer starts with `/` and we're still typing the
  // command word (no space yet means the user hasn't moved on to args).
  if (!v.startsWith('/')) return false
  const firstSpace = v.indexOf(' ')
  return firstSpace === -1 || firstSpace === v.length - 1
})

/** Filter by the typed prefix, case-insensitive. Empty filter (just `/`)
 *  shows every command so the user can browse. */
const filtered = computed<SlashCommand[]>(() => {
  if (!open.value) return []
  const after = props.value.slice(1).split(' ')[0] ?? ''
  if (!after) return props.commands
  const q = after.toLowerCase()
  return props.commands.filter(c => c.label.slice(1).toLowerCase().startsWith(q))
})

const activeIndex = ref(0)

/* Reset the highlight whenever the visible list changes — keeps the cursor
   on a valid row even after the filter shrinks. */
watch(filtered, (list) => {
  if (activeIndex.value >= list.length) activeIndex.value = 0
})

/**
 * Parent forwards textarea `@keydown` here. We claim Arrow/Tab/Enter/Esc
 * while open and return whether the event was handled (caller calls
 * `preventDefault()` based on the return value).
 */
function handleKeydown(e: KeyboardEvent): boolean {
  if (!open.value || filtered.value.length === 0) return false
  switch (e.key) {
    case 'ArrowDown':
      activeIndex.value = (activeIndex.value + 1) % filtered.value.length
      return true
    case 'ArrowUp':
      activeIndex.value = (activeIndex.value - 1 + filtered.value.length) % filtered.value.length
      return true
    case 'Enter':
    case 'Tab': {
      const cmd = filtered.value[activeIndex.value]
      if (cmd) emit('select', cmd)
      return true
    }
    case 'Escape':
      emit('select', { id: '__dismiss__', label: '', description: '' })
      return true
    default:
      return false
  }
}

defineExpose({ handleKeydown })
</script>

<template>
  <div
    v-if="open && filtered.length > 0"
    class="slash-picker"
    role="listbox"
    :aria-label="t('mission.commands.menuTitle')"
  >
    <p class="slash-picker-header">
      {{ t('mission.commands.menuTitle') }}
    </p>
    <ul class="slash-picker-list">
      <li
        v-for="(cmd, i) in filtered"
        :key="cmd.id"
        class="slash-picker-item"
        :class="{ 'is-active': i === activeIndex }"
        role="option"
        :aria-selected="i === activeIndex"
        @mousedown.prevent="emit('select', cmd)"
        @mouseenter="activeIndex = i"
      >
        <span class="slash-picker-label">{{ cmd.label }}</span>
        <span class="slash-picker-description">{{ cmd.description }}</span>
      </li>
    </ul>
  </div>
</template>

<style scoped>
.slash-picker {
  position: absolute;
  bottom: calc(100% + 6px);
  left: 0;
  right: 0;
  z-index: 12;
  display: flex;
  flex-direction: column;
  background: #1c1a14;
  color: #f4efe2;
  border: 1px solid rgba(244, 239, 226, 0.18);
  border-radius: 4px;
  box-shadow:
    0 10px 24px -8px rgba(28, 26, 20, 0.55),
    0 1px 0 rgba(255, 255, 255, 0.06) inset;
  font-family: 'IBM Plex Mono', ui-monospace, monospace;
  overflow: hidden;
}

.slash-picker-header {
  margin: 0;
  padding: 6px 12px;
  background: rgba(244, 239, 226, 0.06);
  border-bottom: 1px solid rgba(244, 239, 226, 0.12);
  font-size: 9px;
  font-weight: 600;
  letter-spacing: 0.24em;
  text-transform: uppercase;
  color: rgba(244, 239, 226, 0.62);
}

.slash-picker-list {
  list-style: none;
  margin: 0;
  padding: 4px;
  display: flex;
  flex-direction: column;
  gap: 2px;
  max-height: 240px;
  overflow-y: auto;
}

.slash-picker-item {
  display: flex;
  flex-direction: column;
  gap: 1px;
  padding: 7px 10px 8px;
  border-radius: 3px;
  cursor: pointer;
  transition: background 0.1s ease;
}

.slash-picker-item:hover,
.slash-picker-item.is-active {
  background: rgba(243, 169, 59, 0.18);
}

.slash-picker-label {
  font-family: 'Antonio', sans-serif;
  font-weight: 700;
  font-size: 12px;
  letter-spacing: 0.12em;
  color: #f3a93b;
}

.slash-picker-description {
  font-size: 10.5px;
  letter-spacing: 0.02em;
  color: rgba(244, 239, 226, 0.78);
  line-height: 1.3;
}
</style>
