import { autoProfileDescription } from '../../../utils/profile-description'

/**
 * Ask Hermes' auxiliary LLM to (re)generate this profile's description
 * based on the soul / agents / skills. `--overwrite` so an existing manual
 * description is replaced; the user clicked the Auto button on purpose.
 */
export default defineEventHandler(async (event) => {
  const slug = getRouterParam(event, 'slug')
  if (!slug) throw createError({ statusCode: 400, statusMessage: 'slug required' })
  try {
    const description = await autoProfileDescription(slug)
    return { description, source: 'auto' }
  } catch (e) {
    throw createError({ statusCode: 500, statusMessage: (e as Error).message })
  }
})
