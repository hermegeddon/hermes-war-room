import { useDb } from '../utils/db'
import { appendMessage, createMission, summarizeTitle, type MissionMode } from '../utils/mission'
import { runMissionTurn } from '../utils/mission-turn'
import { launchTriage } from '../utils/triage'
import { emit } from '../utils/mission-bus'
import { addWatchedTasks } from '../utils/auto-nudge'

interface PostBody {
  orchestratorSlug?: string
  message?: string
  mode?: MissionMode
}

const TRIAGE_PREFIX_RE = /^\s*\/triage\s+/i

export default defineEventHandler(async (event) => {
  const body = await readBody<PostBody>(event) || {}
  const slug = (body.orchestratorSlug ?? '').trim()
  const rawMessage = (body.message ?? '').trim()

  if (!slug) throw createError({ statusCode: 400, statusMessage: 'orchestratorSlug required' })
  if (!rawMessage) throw createError({ statusCode: 400, statusMessage: 'message required' })

  const db = useDb()
  const profile = db.prepare(
    'SELECT slug, active FROM profiles WHERE slug = ? AND present = 1'
  ).get(slug) as { slug: string, active: number } | undefined
  if (!profile) throw createError({ statusCode: 404, statusMessage: `Profile "${slug}" not found` })
  if (!profile.active) throw createError({ statusCode: 400, statusMessage: `Profile "${slug}" is inactive` })

  /* Auto-detect /triage prefix as a shorthand for mode='direct-triage' even
     when the frontend hasn't been updated to send `mode` explicitly. Strip
     the prefix so the persisted message is just the brief. */
  let mode: MissionMode = body.mode === 'direct-triage' ? 'direct-triage' : 'conversational'
  let message = rawMessage
  if (TRIAGE_PREFIX_RE.test(rawMessage)) {
    mode = 'direct-triage'
    message = rawMessage.replace(TRIAGE_PREFIX_RE, '').trim()
    if (!message) throw createError({ statusCode: 400, statusMessage: '/triage requires a prompt' })
  }

  const mission = createMission(slug, message, { mode })

  if (mode === 'direct-triage') {
    /* Persist the user's brief so it shows in the transcript / history,
       but DO NOT spawn an ACP session for the orchestrator — the war-room
       bypasses conversation and goes straight to the kanban triage. */
    appendMessage(mission.id, 'user', message)
    emit(mission.id, { type: 'user', messageId: -1, content: message })

    /* Fire-and-forget the triage launch so the POST returns fast; the
       client opens the SSE stream and observes `triage_launched`. */
    void (async () => {
      try {
        const title = summarizeTitle(message)
        const { triageTaskId, decompose } = await launchTriage({
          missionId: mission.id,
          title,
          body: message
        })
        if (decompose.childIds.length > 0) {
          addWatchedTasks(mission.id, decompose.childIds)
        }
        emit(mission.id, {
          type: 'triage_launched',
          triageTaskId,
          childIds: decompose.childIds
        })
      } catch (e) {
        const msg = (e as Error).message
        console.error(`[mission ${mission.id}] direct-triage launch failed:`, msg)
        emit(mission.id, { type: 'error', message: msg })
      }
    })()
  } else {
    // Fire and forget: turn streams via SSE bus. Caller opens the stream
    // before this POST returns, but the bus is durable across the gap thanks
    // to the in-memory EventEmitter living per-mission-id.
    runMissionTurn(mission.id, message).catch((e: Error) => {
      console.error(`[mission ${mission.id}] turn failed:`, e.message)
    })
  }

  setResponseStatus(event, 201)
  return {
    mission: {
      id: mission.id,
      orchestratorSlug: mission.orchestrator_slug,
      acpSessionId: mission.acp_session_id,
      title: mission.title,
      status: mission.status,
      createdAt: mission.created_at,
      lastMessageAt: mission.last_message_at,
      mode: mission.mode,
      triageTaskId: mission.triage_task_id,
      latestTriageDraft: mission.latest_triage_draft
        ? JSON.parse(mission.latest_triage_draft)
        : null
    }
  }
})
