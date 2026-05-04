export interface Mission {
  id: string
  orchestratorSlug: string
  acpSessionId: string | null
  title: string | null
  status: 'open' | 'archived'
  createdAt: string
  lastMessageAt: string
}

export interface MissionMessage {
  id: number
  role: 'user' | 'assistant'
  content: string
  createdAt: string
  /** True while the assistant content is still streaming. */
  pending?: boolean
}

export interface CurrentTask {
  id: string
  title: string
  body: string | null
  assignee: string | null
  status: string
  priority: number
  workerPid: number | null
  startedAt: number | null
  claimExpires: number | null
  lastHeartbeatAt: number | null
  createdAt: number
  /** IDs of parent tasks (delegators). Empty for top-level tasks. */
  parentIds: string[]
  /** Set when the task's failure looks like Hermes' permission classifier
   *  auto-denied a tool call. Surfaces "PERMISO PENDIENTE" on the bubble. */
  pendingPermission?: boolean
}

/**
 * A task that has terminated — status `done` or `archived`. We don't carry
 * the live worker fields because they're meaningless after completion; we
 * expose `completedAt` so the history strip can sort and timestamp.
 */
export interface CompletedTask {
  id: string
  title: string
  body: string | null
  assignee: string | null
  status: 'done' | 'archived'
  priority: number
  createdAt: number
  startedAt: number | null
  completedAt: number | null
}

export type MissionEvent
  = | { type: 'chunk', delta: string, thought?: boolean }
    | { type: 'tool', title?: string, status?: string, raw: unknown }
    | { type: 'user', messageId: number, content: string }
    | { type: 'done', messageId: number, content: string, stopReason: string }
    | { type: 'error', message: string }
    | { type: 'state', streaming: boolean, messageId: number | null, content: string }
