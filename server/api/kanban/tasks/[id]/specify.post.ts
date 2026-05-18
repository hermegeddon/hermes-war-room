import { specifyTask } from '../../../../utils/triage'

/**
 * Re-write a single triage task's spec (without fan-out) and promote it to
 * `todo`. Useful when the decomposer would over-split a small task or when
 * the user wants a single specialist to handle the whole thing.
 */
export default defineEventHandler(async (event) => {
  const id = getRouterParam(event, 'id')
  if (!id) throw createError({ statusCode: 400, statusMessage: 'task id required' })
  try {
    const result = await specifyTask(id)
    return {
      taskId: result.taskId,
      reason: result.reason,
      newTitle: result.newTitle
    }
  } catch (e) {
    throw createError({ statusCode: 500, statusMessage: (e as Error).message })
  }
})
