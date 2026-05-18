<script setup lang="ts">
import type { TriageDraft } from '~/types/mission'

/**
 * Inline launch panel that appears inside the mission chat whenever the
 * orchestrator emits a fresh <<TRIAGE_DRAFT>> block. Title and body are
 * pre-filled from the model's draft but fully editable — the user owns the
 * final brief before it hits the kanban.
 */

const props = defineProps<{
  draft: TriageDraft
  launching?: boolean
}>()

const emit = defineEmits<{
  launch: [payload: { title: string, body: string }]
  dismiss: []
}>()

const { t } = useI18n()

/* Local working copies so the user can edit without mutating the prop.
   When the orchestrator re-emits a new draft (model rewriting after the
   user asks for changes) we reset both fields to the new values. */
const localTitle = ref(props.draft.title)
const localBody = ref(props.draft.body)
watch(
  () => [props.draft.title, props.draft.body, props.draft.messageId] as const,
  () => {
    localTitle.value = props.draft.title
    localBody.value = props.draft.body
  }
)

const canLaunch = computed(() =>
  !props.launching && localTitle.value.trim().length > 0
)

function onLaunch() {
  if (!canLaunch.value) return
  emit('launch', {
    title: localTitle.value.trim(),
    body: localBody.value.trim()
  })
}
</script>

<template>
  <section class="triage-draft">
    <header class="triage-draft-head">
      <UIcon
        name="i-lucide-rocket"
        class="triage-draft-glyph"
      />
      <div class="triage-draft-meta">
        <h3 class="triage-draft-title">
          {{ t('mission.triageDraft.title') }}
        </h3>
        <p class="triage-draft-subtitle">
          {{ t('mission.triageDraft.subtitle') }}
        </p>
      </div>
      <button
        type="button"
        class="triage-draft-dismiss"
        :aria-label="t('mission.triageDraft.dismiss')"
        @click="emit('dismiss')"
      >
        <UIcon
          name="i-lucide-x"
          class="size-3.5"
        />
      </button>
    </header>

    <label class="triage-draft-field">
      <span class="triage-draft-label">{{ t('mission.triageDraft.titleLabel') }}</span>
      <UInput
        v-model="localTitle"
        size="sm"
        :disabled="launching"
        variant="subtle"
        class="triage-draft-input"
      />
    </label>

    <label class="triage-draft-field">
      <span class="triage-draft-label">{{ t('mission.triageDraft.bodyLabel') }}</span>
      <UTextarea
        v-model="localBody"
        :rows="6"
        autoresize
        :disabled="launching"
        variant="subtle"
        class="triage-draft-input"
      />
    </label>

    <div class="triage-draft-actions">
      <UButton
        size="sm"
        color="primary"
        icon="i-lucide-rocket"
        :loading="launching"
        :disabled="!canLaunch"
        @click="onLaunch"
      >
        {{ launching ? t('mission.triageDraft.launching') : t('mission.triageDraft.launch') }}
      </UButton>
    </div>
  </section>
</template>

<style scoped>
.triage-draft {
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding: 12px 14px 14px;
  margin: 8px 0 4px;
  background: linear-gradient(180deg, #f9e8c1 0%, #f4dca0 100%);
  border: 1px solid #c8421f;
  border-left: 3px solid #c8421f;
  border-radius: 4px;
  box-shadow: 0 6px 14px -8px rgba(28, 26, 20, 0.4);
  color: #1c1a14;
  font-family: 'IBM Plex Mono', ui-monospace, monospace;
}

.triage-draft-head {
  display: flex;
  align-items: flex-start;
  gap: 10px;
}

.triage-draft-glyph {
  width: 18px;
  height: 18px;
  color: #c8421f;
  flex-shrink: 0;
  margin-top: 1px;
}

.triage-draft-meta {
  flex: 1 1 auto;
  min-width: 0;
}

.triage-draft-title {
  margin: 0;
  font-family: 'Antonio', sans-serif;
  font-weight: 700;
  font-size: 13px;
  letter-spacing: 0.18em;
  text-transform: uppercase;
  color: #1c1a14;
}

.triage-draft-subtitle {
  margin: 2px 0 0;
  font-size: 11px;
  color: #4a4536;
  line-height: 1.35;
}

.triage-draft-dismiss {
  flex-shrink: 0;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 22px;
  height: 22px;
  background: transparent;
  border: 1px solid rgba(28, 26, 20, 0.2);
  border-radius: 3px;
  color: #1c1a14;
  cursor: pointer;
  transition: background 0.12s ease;
}
.triage-draft-dismiss:hover {
  background: rgba(28, 26, 20, 0.08);
}

.triage-draft-field {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.triage-draft-label {
  font-size: 9px;
  font-weight: 600;
  letter-spacing: 0.2em;
  text-transform: uppercase;
  color: #6b4a13;
}

.triage-draft-input {
  width: 100%;
}

.triage-draft-actions {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 8px;
  padding-top: 2px;
}
</style>
