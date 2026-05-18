import { getVersionInfo } from '../utils/version'

/**
 * Surface the local + latest published versions so the UI can render an
 * "update available" banner. `?force=1` skips the in-memory cache (useful
 * for the dev "check now" affordance).
 */
export default defineEventHandler(async (event) => {
  const q = getQuery(event)
  const force = q.force === '1' || q.force === 'true'
  return await getVersionInfo(force)
})
