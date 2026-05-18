<script setup lang="ts">
/**
 * Discreet banner that surfaces when a newer GitHub release exists than
 * the version recorded in the local CHANGELOG. Self-contained:
 *   - polls /api/version once on mount (the endpoint caches 6 h)
 *   - persists per-version dismissal in localStorage so the same release
 *     doesn't keep nagging after the user has acknowledged it
 *   - re-shows when a NEWER release arrives (different version → new key)
 */

interface VersionInfo {
  current: string | null
  latest: string | null
  hasUpdate: boolean
  releaseName: string | null
  releaseUrl: string | null
  publishedAt: string | null
}

const { t } = useI18n()

const info = ref<VersionInfo | null>(null)
const dismissedVersion = ref<string | null>(null)

const STORAGE_KEY = 'hermes-war-room.updateDismissed'

function readDismissed(): string | null {
  if (typeof window === 'undefined') return null
  try {
    return localStorage.getItem(STORAGE_KEY)
  } catch {
    return null
  }
}

function persistDismissed(version: string) {
  try {
    localStorage.setItem(STORAGE_KEY, version)
  } catch {
    /* private mode etc. — fall through, banner reappears next session */
  }
}

const visible = computed(() => {
  const i = info.value
  if (!i?.hasUpdate || !i.latest) return false
  /* Hide once the user has dismissed THIS specific version. A future
     release ships with a different `latest` value, which won't match the
     stored key, and the banner returns. */
  return dismissedVersion.value !== i.latest
})

function dismiss() {
  if (!info.value?.latest) return
  persistDismissed(info.value.latest)
  dismissedVersion.value = info.value.latest
}

onMounted(async () => {
  dismissedVersion.value = readDismissed()
  try {
    info.value = await $fetch<VersionInfo>('/api/version')
  } catch (e) {
    /* Silent — the banner is informational; a failed check shouldn't
       surface UI noise. Logged to the console for dev visibility. */
    console.warn('[update-banner] version check failed', e)
  }
})
</script>

<template>
  <Transition name="update-banner">
    <a
      v-if="visible && info"
      :href="info.releaseUrl ?? undefined"
      target="_blank"
      rel="noopener noreferrer"
      class="update-banner"
      :title="t('update.tooltip', {
        current: info.current ?? '?',
        latest: info.latest ?? '?'
      })"
    >
      <UIcon
        name="i-lucide-arrow-up-circle"
        class="update-banner-glyph"
      />
      <span class="update-banner-label">
        {{ t('update.available', { version: info.latest }) }}
      </span>
      <button
        type="button"
        class="update-banner-dismiss"
        :aria-label="t('update.dismiss')"
        @click.stop.prevent="dismiss"
      >
        <UIcon
          name="i-lucide-x"
          class="size-3"
        />
      </button>
    </a>
  </Transition>
</template>

<style scoped>
.update-banner {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  padding: 4px 6px 4px 10px;
  background: linear-gradient(180deg, #fff5d8 0%, #f9e8c1 100%);
  border: 1px solid #c8421f;
  border-radius: 999px;
  font-family: 'IBM Plex Mono', ui-monospace, monospace;
  font-size: 10px;
  font-weight: 600;
  letter-spacing: 0.1em;
  text-transform: uppercase;
  color: #1c1a14;
  text-decoration: none;
  cursor: pointer;
  transition: transform 0.12s ease, box-shadow 0.12s ease, background 0.12s ease;
  box-shadow: 0 2px 8px -3px rgba(200, 66, 31, 0.45);
}
.update-banner:hover {
  background: linear-gradient(180deg, #fff9e6 0%, #fcecc5 100%);
  transform: translateY(-1px);
  box-shadow: 0 4px 10px -3px rgba(200, 66, 31, 0.55);
}

.update-banner-glyph {
  width: 13px;
  height: 13px;
  color: #c8421f;
  flex-shrink: 0;
}

.update-banner-label {
  white-space: nowrap;
}

.update-banner-dismiss {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 18px;
  height: 18px;
  margin-left: 2px;
  background: transparent;
  border: 0;
  border-radius: 50%;
  color: #4a4536;
  cursor: pointer;
  transition: background 0.1s ease, color 0.1s ease;
}
.update-banner-dismiss:hover {
  background: rgba(28, 26, 20, 0.1);
  color: #1c1a14;
}

.update-banner-enter-active,
.update-banner-leave-active {
  transition: opacity 220ms ease, transform 220ms cubic-bezier(0.4, 1.3, 0.5, 1);
}
.update-banner-enter-from,
.update-banner-leave-to {
  opacity: 0;
  transform: translateY(-4px);
}
</style>
