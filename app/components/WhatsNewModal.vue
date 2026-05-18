<script setup lang="ts">
/**
 * One-shot "what's new" popup that explains the triage + decompose flow
 * we added on top of Hermes 0.14. Dismissal is persisted in localStorage
 * under a versioned key so a future onboarding can be triggered by simply
 * bumping the version — old keys remain (cheap, irrelevant) and the new
 * one fires once per browser.
 */

const STORAGE_KEY = 'hermes-war-room.whatsNew.triage-flow-v1'
const DOCS_URL = 'https://hermes-agent.nousresearch.com/docs/user-guide/features/kanban'

const { t } = useI18n()
const open = ref(false)

onMounted(() => {
  if (typeof window === 'undefined') return
  try {
    if (localStorage.getItem(STORAGE_KEY)) return
  } catch {
    /* localStorage blocked (private mode etc.) — fall through and show
       the popup. The dismiss handler will swallow the write failure too. */
  }
  // Defer one frame so the modal doesn't fight with the page's initial
  // suspense / data fetches for paint.
  nextTick(() => {
    open.value = true
  })
})

function dismiss() {
  open.value = false
  try {
    localStorage.setItem(STORAGE_KEY, new Date().toISOString())
  } catch {
    /* ignore — user will see it again next session if storage is blocked. */
  }
}

interface Feature {
  glyph: string
  title: string
  body: string
}
const features = computed<Feature[]>(() => [
  {
    glyph: 'i-lucide-zap',
    title: t('whatsNew.features.slash.title'),
    body: t('whatsNew.features.slash.body')
  },
  {
    glyph: 'i-lucide-message-square-text',
    title: t('whatsNew.features.refine.title'),
    body: t('whatsNew.features.refine.body')
  },
  {
    glyph: 'i-lucide-network',
    title: t('whatsNew.features.descriptions.title'),
    body: t('whatsNew.features.descriptions.body')
  },
  {
    glyph: 'i-lucide-kanban-square',
    title: t('whatsNew.features.kanban.title'),
    body: t('whatsNew.features.kanban.body')
  }
])
</script>

<template>
  <UModal
    :open="open"
    :ui="{
      content: 'max-w-2xl w-[min(92vw,720px)]',
      overlay: 'bg-[#1c1a14]/55 backdrop-blur-sm'
    }"
    @update:open="(v: boolean) => !v && dismiss()"
  >
    <template #content>
      <div class="whatsnew">
        <header class="whatsnew-head">
          <div class="whatsnew-eyebrow">
            <span class="whatsnew-pulse" />
            {{ t('whatsNew.eyebrow') }}
          </div>
          <h2 class="whatsnew-title">
            {{ t('whatsNew.title') }}
          </h2>
          <p class="whatsnew-lead">
            {{ t('whatsNew.lead') }}
          </p>
        </header>

        <ul class="whatsnew-list">
          <li
            v-for="f in features"
            :key="f.title"
            class="whatsnew-item"
          >
            <UIcon
              :name="f.glyph"
              class="whatsnew-item-glyph"
            />
            <div class="whatsnew-item-body">
              <h3 class="whatsnew-item-title">
                {{ f.title }}
              </h3>
              <p class="whatsnew-item-text">
                {{ f.body }}
              </p>
            </div>
          </li>
        </ul>

        <footer class="whatsnew-foot">
          <a
            :href="DOCS_URL"
            target="_blank"
            rel="noopener noreferrer"
            class="whatsnew-docs"
          >
            <UIcon
              name="i-lucide-book-open"
              class="size-3.5"
            />
            {{ t('whatsNew.docs') }}
          </a>
          <UButton
            color="primary"
            icon="i-lucide-check"
            size="md"
            @click="dismiss"
          >
            {{ t('whatsNew.dismiss') }}
          </UButton>
        </footer>
      </div>
    </template>
  </UModal>
</template>

<style scoped>
.whatsnew {
  display: flex;
  flex-direction: column;
  gap: 18px;
  padding: 24px 26px 22px;
  background: linear-gradient(180deg, #f9f3e3 0%, #f4efe2 100%);
  border-left: 4px solid #c8421f;
  font-family: 'IBM Plex Mono', ui-monospace, monospace;
  color: #1c1a14;
}

.whatsnew-head {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.whatsnew-eyebrow {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  font-size: 10px;
  font-weight: 600;
  letter-spacing: 0.28em;
  text-transform: uppercase;
  color: #c8421f;
}
.whatsnew-pulse {
  display: inline-block;
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: #c8421f;
  box-shadow: 0 0 6px rgba(200, 66, 31, 0.7);
  animation: whatsnew-pulse 1.8s ease-in-out infinite;
}
@keyframes whatsnew-pulse {
  0%, 100% { opacity: 1; }
  50%      { opacity: 0.35; }
}

.whatsnew-title {
  margin: 0;
  font-family: 'Antonio', 'Bebas Neue', sans-serif;
  font-weight: 700;
  font-size: 26px;
  letter-spacing: 0.06em;
  line-height: 1.05;
  color: #1c1a14;
}

.whatsnew-lead {
  margin: 0;
  font-family: 'Instrument Serif', serif;
  font-style: italic;
  font-size: 15px;
  line-height: 1.45;
  color: #4a4536;
}

.whatsnew-list {
  list-style: none;
  margin: 0;
  padding: 6px 0 0;
  display: flex;
  flex-direction: column;
  gap: 14px;
}

.whatsnew-item {
  display: grid;
  grid-template-columns: 28px 1fr;
  gap: 12px;
  align-items: start;
}

.whatsnew-item-glyph {
  width: 22px;
  height: 22px;
  color: #c8421f;
  margin-top: 1px;
  flex-shrink: 0;
}

.whatsnew-item-body {
  min-width: 0;
}

.whatsnew-item-title {
  margin: 0 0 3px;
  font-family: 'Antonio', sans-serif;
  font-weight: 700;
  font-size: 13px;
  letter-spacing: 0.16em;
  text-transform: uppercase;
  color: #1c1a14;
}

.whatsnew-item-text {
  margin: 0;
  font-size: 12px;
  line-height: 1.45;
  color: #4a4536;
}

.whatsnew-foot {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding-top: 14px;
  border-top: 1px dashed rgba(28, 26, 20, 0.2);
}

.whatsnew-docs {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: 11px;
  letter-spacing: 0.04em;
  color: #1c1a14;
  text-decoration: none;
  border-bottom: 1px solid rgba(28, 26, 20, 0.35);
  padding-bottom: 1px;
  transition: color 0.12s ease, border-color 0.12s ease;
}
.whatsnew-docs:hover {
  color: #c8421f;
  border-bottom-color: #c8421f;
}
</style>
