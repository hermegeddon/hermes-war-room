// https://nuxt.com/docs/api/configuration/nuxt-config
export default defineNuxtConfig({
  modules: [
    '@nuxt/eslint',
    '@nuxt/ui',
    '@nuxtjs/i18n'
  ],

  devtools: {
    enabled: true
  },

  css: ['~/assets/css/main.css'],

  /* No sourcemaps in production: Tailwind v4's Vite plugin doesn't emit
     sourcemaps for its CSS transformations, which floods the build log
     with hundreds of "Sourcemap is likely to be incorrect" warnings.
     Sourcemaps in production also bloat the deployed bundle without any
     real debugging benefit (we don't ship the original sources). */
  sourcemap: {
    server: false,
    client: false
  },

  compatibilityDate: '2025-01-15',

  eslint: {
    config: {
      stylistic: {
        commaDangle: 'never',
        braceStyle: '1tbs'
      }
    }
  },

  i18n: {
    strategy: 'no_prefix',
    defaultLocale: 'en',
    locales: [
      { code: 'en', name: 'English', file: 'en.json' },
      { code: 'es', name: 'Español', file: 'es.json' }
    ],
    detectBrowserLanguage: {
      useCookie: true,
      cookieKey: 'hermes_war_room_lang',
      redirectOn: 'root'
    }
  }
})
