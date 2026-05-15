<script setup lang="ts">
const route = useRoute()
const { t, locale, locales, setLocale } = useI18n()
const { data: config } = await useFetch<{ missionsEnabled: boolean }>('/api/config')
const missionsEnabled = computed(() => config.value?.missionsEnabled ?? true)

useHead({
  meta: [
    { name: 'viewport', content: 'width=device-width, initial-scale=1' }
  ],
  link: [
    { rel: 'icon', href: '/favicon.ico' },
    /* Pre-connect speeds up the actual fetch by warming TLS to Google's CDN
       before the stylesheet request fires. */
    { rel: 'preconnect', href: 'https://fonts.googleapis.com' },
    { rel: 'preconnect', href: 'https://fonts.gstatic.com', crossorigin: '' },
    /* Custom font triplet for the war-room aesthetic. Loaded at runtime so
       the build never has to reach the network. */
    {
      rel: 'stylesheet',
      href: 'https://fonts.googleapis.com/css2?family=Antonio:wght@600;700&family=IBM+Plex+Mono:wght@400;500&family=Instrument+Serif:ital@0;1&display=swap'
    }
  ],
  htmlAttrs: {
    lang: locale
  }
})

useSeoMeta({
  title: () => t('app.title'),
  description: () => t('app.description'),
  ogTitle: () => t('app.title'),
  ogDescription: () => t('app.description'),
  twitterCard: 'summary_large_image'
})

interface TopTab {
  to: string
  icon: string
  label: string
}

const tabs = computed<TopTab[]>(() => {
  const allTabs = [
    { to: '/', icon: 'i-lucide-radar', label: t('nav.warRoom') },
    { to: '/team', icon: 'i-lucide-users-round', label: t('nav.team') },
    { to: '/missions', icon: 'i-lucide-folder-clock', label: t('nav.missions') }
  ]
  return missionsEnabled.value ? allTabs : allTabs.filter(tab => tab.to !== '/missions')
})

const localeOptions = computed(() =>
  (locales.value as { code: string, name: string }[]).map(l => ({
    label: l.name,
    value: l.code
  }))
)

function isActive(to: string): boolean {
  if (to === '/') return route.path === '/'
  return route.path === to || route.path.startsWith(to + '/')
}
</script>

<template>
  <UApp>
    <div class="hwr-shell">
      <header class="hwr-topbar">
        <NuxtLink
          to="/"
          class="hwr-brand"
        >
          <span class="hwr-brand-mark">
            <UIcon
              name="i-lucide-radio-tower"
              class="size-4"
            />
            <span class="hwr-brand-pulse" />
          </span>
          <span class="hwr-brand-name">
            <span class="hwr-brand-eyebrow">Hermes</span>
            <span class="hwr-brand-title">Orchestration War Room</span>
          </span>
        </NuxtLink>

        <nav
          class="hwr-tabs"
          aria-label="Primary"
        >
          <NuxtLink
            v-for="tab in tabs"
            v-show="tab.to !== '/missions' || missionsEnabled"
            :key="tab.to"
            :to="tab.to"
            class="hwr-tab"
            :class="{ 'is-active': isActive(tab.to) }"
          >
            <UIcon
              :name="tab.icon"
              class="hwr-tab-icon"
            />
            <span>{{ tab.label }}</span>
          </NuxtLink>
        </nav>

        <div class="hwr-actions">
          <USelect
            :model-value="locale"
            :items="localeOptions"
            size="sm"
            variant="ghost"
            icon="i-lucide-languages"
            :aria-label="t('common.language')"
            class="hwr-lang"
            @update:model-value="(v: string) => setLocale(v as 'en' | 'es' | 'id')"
          />
        </div>
      </header>

      <main class="hwr-main">
        <NuxtPage />
      </main>
    </div>
  </UApp>
</template>

<style>
.hwr-shell {
  display: flex;
  flex-direction: column;
  /* Default: shell grows with its content. `min-height: 100vh` keeps the
     topbar at the top of the viewport but lets pages like /team and
     /missions extend the shell and use the page-level scrollbar. */
  min-height: 100vh;
  background: #f4efe2;
  color: #1c1a14;
}
/* The home page (operations floor + mission chat) is the only screen that
   wants to LOCK to the viewport so its inner panes scroll independently.
   When the rendered page sets `.page--locked`, the shell flips to a
   definite-height column and clips any overflow — this is what makes the
   mission transcript scroll internally instead of pushing the whole page.
   Other routes don't set this class → shell stays growable. */
.hwr-shell:has(.page--locked) {
  height: 100dvh;
  min-height: 0;
  overflow: hidden;
}

/* === Top bar — dark console band, contrasts with the cream paper below === */
.hwr-topbar {
  display: grid;
  grid-template-columns: auto 1fr auto;
  align-items: center;
  gap: 28px;
  padding: 10px 22px;
  background:
    repeating-linear-gradient(
      135deg,
      rgba(244, 239, 226, 0.04) 0,
      rgba(244, 239, 226, 0.04) 1px,
      transparent 1px,
      transparent 7px
    ),
    #1c1a14;
  border-bottom: 1.5px solid #0f0d08;
  color: #f4efe2;
}
.hwr-topbar::after {
  /* engineered tick rule below the divider — cream dashes on the dark band */
  content: '';
  position: absolute;
  left: 0;
  right: 0;
  bottom: -5px;
  height: 3px;
  background-image:
    repeating-linear-gradient(
      to right,
      #f4efe2 0,
      #f4efe2 6px,
      transparent 6px,
      transparent 14px
    );
  opacity: 0.35;
  pointer-events: none;
}

/* === Brand === */
.hwr-brand {
  display: inline-flex;
  align-items: center;
  gap: 12px;
  text-decoration: none;
  color: inherit;
  padding: 2px 4px;
}
.hwr-brand-mark {
  position: relative;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 32px;
  height: 32px;
  border-radius: 4px;
  background: #f4efe2;
  color: #1c1a14;
  box-shadow: 0 2px 0 rgba(0, 0, 0, 0.45);
}
.hwr-brand-pulse {
  position: absolute;
  top: -3px;
  right: -3px;
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: #c8421f;
  box-shadow:
    0 0 0 2px #1c1a14,
    0 0 8px rgba(200, 66, 31, 0.85);
  animation: hwr-pulse 1.6s ease-in-out infinite;
}
@keyframes hwr-pulse {
  0%, 100% { opacity: 1; }
  55%      { opacity: 0.4; }
}
.hwr-brand-name {
  display: inline-flex;
  flex-direction: column;
  gap: 1px;
  line-height: 1;
}
.hwr-brand-eyebrow {
  font-family: 'IBM Plex Mono', monospace;
  font-size: 9px;
  letter-spacing: 0.32em;
  text-transform: uppercase;
  /* Lifted from #a39a83 (~6.6:1) to #c8bea3 (~9.5:1). The stronger ratio
     compensates for the heavy tracking + tiny size of the eyebrow, where the
     glyphs are mostly thin-stroke negative space and visually drop back. */
  color: #c8bea3;
}
.hwr-brand-title {
  font-family: 'Antonio', sans-serif;
  font-weight: 700;
  font-size: 15px;
  letter-spacing: 0.16em;
  text-transform: uppercase;
  color: #f4efe2;
}

/* === Tabs === */
.hwr-tabs {
  justify-self: center;
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 3px;
  background: rgba(244, 239, 226, 0.06);
  border-radius: 6px;
  border: 1px solid rgba(244, 239, 226, 0.14);
}
.hwr-tab {
  position: relative;
  display: inline-flex;
  align-items: center;
  gap: 8px;
  padding: 7px 14px 8px;
  font-family: 'IBM Plex Mono', monospace;
  font-size: 11px;
  font-weight: 500;
  letter-spacing: 0.16em;
  text-transform: uppercase;
  /* Same lift as the eyebrow — at 11px tracked-out the old #a39a83 read as
     "disabled" rather than "inactive". #c8bea3 sits clearly above the noise
     while staying obviously secondary to the cream pill of the active tab. */
  color: #c8bea3;
  text-decoration: none;
  border-radius: 4px;
  transition: color 0.15s ease, background 0.15s ease;
}
.hwr-tab:hover {
  color: #f4efe2;
  background: rgba(244, 239, 226, 0.08);
}
.hwr-tab-icon {
  width: 13px;
  height: 13px;
}
.hwr-tab.is-active {
  color: #1c1a14;
  background: #f4efe2;
  box-shadow: 0 2px 0 rgba(0, 0, 0, 0.45);
}
.hwr-tab.is-active::after {
  /* vermilion underline accent on the active tab */
  content: '';
  position: absolute;
  left: 14px;
  right: 14px;
  bottom: 3px;
  height: 1.5px;
  background: #c8421f;
  border-radius: 1px;
}

/* === Right actions === */
.hwr-actions {
  display: inline-flex;
  align-items: center;
  gap: 6px;
}
/* `.hwr-lang` IS the rendered <button> for the USelect — Nuxt UI doesn't
   wrap it. So we target the element itself (and its descendant icon/label
   spans, which the component paints with `text-highlighted` /
   `text-toned` utility classes that resolve to dark oklch values and would
   otherwise be invisible on this dark band). */
.hwr-lang {
  font-family: 'IBM Plex Mono', monospace !important;
  font-size: 11px !important;
  letter-spacing: 0.1em !important;
  background: transparent !important;
  color: #c8bea3 !important;
}
.hwr-lang * {
  color: #c8bea3 !important;
}
.hwr-lang:hover,
.hwr-lang:focus,
.hwr-lang:focus-visible {
  color: #f4efe2 !important;
  background: rgba(244, 239, 226, 0.08) !important;
}
.hwr-lang:hover *,
.hwr-lang:focus *,
.hwr-lang:focus-visible * {
  color: #f4efe2 !important;
}

/* === Main content === */
.hwr-main {
  flex: 1 1 auto;
  display: flex;
  flex-direction: column;
  min-width: 0;
  /* Without min-height:0, a flex item's default min-height:auto refuses to
     shrink below its content's min-content size. On short viewports that
     made .hwr-main grow past the shell, .page--war-room inflate past
     100dvh, and the inner overflow-y:auto panes never gained a scrollbar
     because their grid row was already as tall as their content. */
  min-height: 0;
}
.hwr-main > * {
  flex: 1 1 auto;
  min-height: 0;
}

/* === Mobile === */
@media (max-width: 640px) {
  .hwr-topbar {
    grid-template-columns: auto 1fr;
    gap: 10px;
  }
  .hwr-tabs {
    grid-column: 1 / -1;
    justify-self: stretch;
    overflow-x: auto;
    scrollbar-width: none;
  }
  .hwr-tabs::-webkit-scrollbar {
    display: none;
  }
  .hwr-actions {
    justify-self: end;
  }
  .hwr-brand-eyebrow {
    display: none;
  }
}
</style>
