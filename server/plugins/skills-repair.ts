import { discoverProfiles } from '../utils/hermes'
import { getDisabledSkills, setDisabledSkills } from '../utils/skills'

/**
 * Boot-time repair: any profile that currently has a Hermes-required skill
 * (e.g. `kanban-worker`) sitting in its `skills.disabled` list silently breaks
 * the kanban gateway — when the dispatcher spawns the worker it runs
 * `hermes -p <slug> --skills kanban-worker chat ...` and Hermes refuses with
 * `Unknown skill(s): kanban-worker`. This was caused by older preset hires
 * (and manual retrains) that didn't list `kanban-worker` in their enabled
 * set, so it ended up disabled by exclusion.
 *
 * `setDisabledSkills` now strips protected skills from the input, but that
 * only protects writes going FORWARD. This plugin runs once on boot and
 * rewrites any existing config.yaml that has the bad entries — idempotent,
 * no-op when nothing is wrong.
 */
const PROTECTED = new Set(['kanban-worker'])

export default defineNitroPlugin(() => {
  let fixed = 0
  for (const p of discoverProfiles()) {
    try {
      const disabled = getDisabledSkills(p.hermesDir)
      const offending = disabled.filter(s => PROTECTED.has(s))
      if (offending.length === 0) continue
      const cleaned = disabled.filter(s => !PROTECTED.has(s))
      setDisabledSkills(p.hermesDir, cleaned)
      console.log(`[skills-repair] ${p.slug}: re-enabled ${offending.join(', ')}`)
      fixed++
    } catch (e) {
      console.error(`[skills-repair] ${p.slug}: failed to repair:`, (e as Error).message)
    }
  }
  if (fixed === 0) return
  console.log(`[skills-repair] repaired ${fixed} profile(s)`)
})
