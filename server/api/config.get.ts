export default defineEventHandler(() => {
  return {
    missionsEnabled: process.env.WAR_ROOM_MISSIONS_ENABLED !== 'false'
  }
})
