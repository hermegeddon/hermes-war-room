import { runHermes } from './triage'

const NO_DESC_RE = /^\s*\(no description set for/i

/** In-memory TTL cache so a single GET /api/profiles burst doesn't fork
 *  one `hermes profile describe` per profile every time the page polls. */
interface CacheEntry {
  value: string | null
  expiresAt: number
}
const cache = new Map<string, CacheEntry>()
const TTL_MS = 10_000

export async function readProfileDescription(slug: string): Promise<string | null> {
  const cached = cache.get(slug)
  if (cached && cached.expiresAt > Date.now()) return cached.value

  const { code, stdout, stderr } = await runHermes(['profile', 'describe', slug])
  if (code !== 0) {
    /* Don't blow up the whole roster fetch for one bad profile — log and
       cache null briefly so we don't retry on every request. */
    console.warn(`[profile-description] ${slug}: ${stderr.trim() || `exit ${code}`}`)
    cache.set(slug, { value: null, expiresAt: Date.now() + TTL_MS })
    return null
  }
  const text = stdout.trim()
  const value = !text || NO_DESC_RE.test(text) ? null : text
  cache.set(slug, { value, expiresAt: Date.now() + TTL_MS })
  return value
}

export function invalidateProfileDescription(slug: string): void {
  cache.delete(slug)
}

export async function setProfileDescription(slug: string, text: string): Promise<void> {
  const args = ['profile', 'describe', slug, '--text', text, '--overwrite']
  const { code, stderr } = await runHermes(args)
  if (code !== 0) {
    throw new Error(stderr.trim() || `hermes profile describe --text exited ${code}`)
  }
  invalidateProfileDescription(slug)
}

export async function autoProfileDescription(slug: string): Promise<string | null> {
  const { code, stderr } = await runHermes(['profile', 'describe', slug, '--auto', '--overwrite'])
  if (code !== 0) {
    throw new Error(stderr.trim() || `hermes profile describe --auto exited ${code}`)
  }
  invalidateProfileDescription(slug)
  return await readProfileDescription(slug)
}
