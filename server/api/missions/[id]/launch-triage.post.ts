import { getMission, setLatestTriageDraft, summarizeTitle } from '../../../utils/mission'
import { launchTriage } from '../../../utils/triage'
import { addWatchedTasks } from '../../../utils/auto-nudge'
import { emit } from '../../../utils/mission-bus'

interface PostBody {
  title?: string
  body?: string
}

/**
 * Promote a conversational mission into a real triage task. Called when the
 * user clicks "Launch as triage" on the TriageDraftPanel. The {title, body}
 * pair can be edited by the user before sending, so we accept whatever the
 * panel posts rather than re-reading from the latest_triage_draft cell.
 */
export default defineEventHandler(async (event) => {
  const missionId = getRouterParam(event, 'id')
  if (!missionId) throw createError({ statusCode: 400, statusMessage: 'mission id required' })

  const mission = getMission(missionId)
  if (!mission) throw createError({ statusCode: 404, statusMessage: 'Mission not found' })
  if (mission.triage_task_id) {
    throw createError({ statusCode: 409, statusMessage: 'Mission already launched as triage' })
  }

  const body = await readBody<PostBody>(event) || {}
  const title = (body.title ?? '').trim()
  const bodyText = (body.body ?? '').trim()
  if (!title) throw createError({ statusCode: 400, statusMessage: 'title required' })

  const { triageTaskId, decompose } = await launchTriage({
    missionId: mission.id,
    title: summarizeTitle(title),
    body: bodyText
  })

  /* The draft has been consumed — clear the cached snapshot so a reload
     doesn't re-show the panel. The orchestrator preamble switches to
     supervisor mode on the next turn (mission.triage_task_id is now set). */
  setLatestTriageDraft(mission.id, null)

  if (decompose.childIds.length > 0) {
    addWatchedTasks(mission.id, decompose.childIds)
  }

  emit(mission.id, {
    type: 'triage_launched',
    triageTaskId,
    childIds: decompose.childIds
  })

  return {
    triageTaskId,
    childIds: decompose.childIds,
    reason: decompose.reason,
    newTitle: decompose.newTitle
  }
})
