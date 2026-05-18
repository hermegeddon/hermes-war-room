import { readProfileDescription, setProfileDescription } from '../../../utils/profile-description'

interface PatchBody {
  text?: string
}

export default defineEventHandler(async (event) => {
  const slug = getRouterParam(event, 'slug')
  if (!slug) throw createError({ statusCode: 400, statusMessage: 'slug required' })
  const body = await readBody<PatchBody>(event) || {}
  const text = (body.text ?? '').trim()
  if (!text) throw createError({ statusCode: 400, statusMessage: 'text required' })

  await setProfileDescription(slug, text)
  return { description: await readProfileDescription(slug), source: 'manual' }
})
