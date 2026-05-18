import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'

/**
 * Repo coordinates the release checker hits on GitHub. Overrideable via
 * env var for forks / private mirrors. Hardcoded fallback is the upstream
 * the war-room ships from.
 */
const REPO = process.env.WAR_ROOM_RELEASE_REPO || 'Naroh091/hermes-war-room'
const RELEASE_API = `https://api.github.com/repos/${REPO}/releases/latest`
/** GitHub anon rate limit is 60/h. Six hours is plenty — the version
 *  rarely changes within a working session, and a fresh dev restart is the
 *  natural cache bust. */
const TTL_MS = 6 * 60 * 60 * 1000

let cached: { value: VersionInfo, expiresAt: number } | null = null
let inFlight: Promise<VersionInfo> | null = null

export interface VersionInfo {
  /** Local war-room version read from CHANGELOG.md (e.g. "1.4.1"). */
  current: string | null
  /** Latest published GitHub release tag, stripped of the leading "v". */
  latest: string | null
  /** True iff `latest` is strictly newer than `current`. */
  hasUpdate: boolean
  /** Human title of the release ("v1.4.2" or whatever release.name is). */
  releaseName: string | null
  /** URL to the release notes on GitHub. */
  releaseUrl: string | null
  /** ISO date the release was published. */
  publishedAt: string | null
  /** When the GitHub API check happened. Used to surface staleness in dev. */
  checkedAt: string
  /** Repo owner/name used for the check — handy when debugging. */
  repo: string
}

/* --- helpers ------------------------------------------------------------ */

/**
 * Read CHANGELOG.md's top entry to determine the local version. Auto-
 * maintained by semantic-release, so it's the authoritative "what's
 * installed" signal. Returns null when the file doesn't exist or has no
 * version header — version banner just won't render in that case.
 */
async function readLocalVersion(): Promise<string | null> {
  try {
    const path = resolve(process.cwd(), 'CHANGELOG.md')
    const text = await readFile(path, 'utf8')
    const m = /^##\s*\[(\d+\.\d+\.\d+)\]/m.exec(text)
    return m?.[1] ?? null
  } catch {
    return null
  }
}

/**
 * Compare two semver strings. Returns true when `a` is strictly less than
 * `b`. Tolerates missing parts (e.g. "1.4" → "1.4.0"). Pre-release suffixes
 * are stripped (treated as equal to the base version) — keeps the banner
 * from screaming about an rc bump.
 */
function versionLessThan(a: string, b: string): boolean {
  const norm = (v: string) => v.split('-')[0]!.split('.').map(n => parseInt(n, 10) || 0)
  const A = norm(a)
  const B = norm(b)
  const len = Math.max(A.length, B.length, 3)
  for (let i = 0; i < len; i++) {
    const x = A[i] ?? 0
    const y = B[i] ?? 0
    if (x !== y) return x < y
  }
  return false
}

interface GithubRelease {
  tag_name?: string
  name?: string
  html_url?: string
  published_at?: string
  draft?: boolean
  prerelease?: boolean
}

async function fetchLatestRelease(): Promise<GithubRelease | null> {
  const res = await fetch(RELEASE_API, {
    headers: {
      'Accept': 'application/vnd.github+json',
      /* GitHub asks every UA-less request to identify itself — sending a
         descriptive UA keeps us out of their generic anti-abuse path. */
      'User-Agent': 'hermes-war-room/release-checker'
    },
    /* Short timeout so a flaky GitHub doesn't stall the banner. The cached
       result keeps the UI snappy on subsequent calls. */
    signal: AbortSignal.timeout(8000)
  })
  if (!res.ok) {
    console.warn(`[version] GitHub releases ${REPO} → HTTP ${res.status}`)
    return null
  }
  return await res.json() as GithubRelease
}

/* --- public API --------------------------------------------------------- */

/**
 * Cached read of the version pair. Concurrent callers piggyback on a single
 * in-flight fetch via `inFlight`. Stale cache is served while a refresh is
 * running (no flicker on the banner).
 */
export async function getVersionInfo(force = false): Promise<VersionInfo> {
  const now = Date.now()
  if (!force && cached && cached.expiresAt > now) return cached.value
  if (inFlight) return await inFlight

  inFlight = (async () => {
    const [current, release] = await Promise.all([
      readLocalVersion(),
      fetchLatestRelease().catch((e) => {
        console.warn('[version] fetch failed:', (e as Error).message)
        return null
      })
    ])

    const latestRaw = release?.tag_name ?? null
    const latest = latestRaw ? latestRaw.replace(/^v/, '') : null
    const hasUpdate = !!(current && latest && versionLessThan(current, latest))

    const info: VersionInfo = {
      current,
      latest,
      hasUpdate,
      releaseName: release?.name ?? latestRaw ?? null,
      releaseUrl: release?.html_url ?? null,
      publishedAt: release?.published_at ?? null,
      checkedAt: new Date().toISOString(),
      repo: REPO
    }
    cached = { value: info, expiresAt: now + TTL_MS }
    return info
  })()

  try {
    return await inFlight
  } finally {
    inFlight = null
  }
}
