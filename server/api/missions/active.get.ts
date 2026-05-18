import { getActiveMission, listMessages, serializeMission } from '../../utils/mission'

export default defineEventHandler((event) => {
  const orchestrator = getQuery(event).orchestrator
  if (typeof orchestrator !== 'string' || !orchestrator) {
    throw createError({ statusCode: 400, statusMessage: '`orchestrator` query param required' })
  }

  const mission = getActiveMission(orchestrator)
  if (!mission) return { mission: null, messages: [] }

  const messages = listMessages(mission.id)
  return {
    mission: serializeMission(mission),
    messages: messages.map(m => ({
      id: m.id,
      role: m.role,
      content: m.content,
      createdAt: m.created_at
    }))
  }
})
