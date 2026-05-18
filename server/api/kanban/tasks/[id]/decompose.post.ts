import { decomposeTask } from '../../../../utils/triage'

/**
 * Fan-out a single triage task into specialist children. Hermes' decomposer
 * uses the profiles' description fields to route. Surfaced as a per-card
 * action on the triage column in the war-room kanban view.
 */
export default defineEventHandler(async (event) => {
  const id = getRouterParam(event, 'id')
  if (!id) throw createError({ statusCode: 400, statusMessage: 'task id required' })
  try {
    const result = await decomposeTask(id)
    return {
      taskId: result.taskId,
      childIds: result.childIds,
      reason: result.reason,
      newTitle: result.newTitle
    }
  } catch (e) {
    throw createError({ statusCode: 500, statusMessage: (e as Error).message })
  }
})
