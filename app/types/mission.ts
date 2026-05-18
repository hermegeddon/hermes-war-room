export type MissionMode = 'conversational' | 'direct-triage'

export interface TriageDraft {
  title: string
  body: string
  /** The assistant message that produced this draft. Used by the panel to
   *  invalidate itself when a newer draft supersedes it. */
  messageId: number | null
}

export interface Mission {
  id: string
  orchestratorSlug: string
  acpSessionId: string | null
  title: string | null
  status: 'open' | 'archived'
  createdAt: string
  lastMessageAt: string
  mode: MissionMode
  /** When non-null, the mission has already been promoted from a triage
   *  draft into a real kanban triage task (and its decomposed children).
   *  Switches the orchestrator into supervisor mode on subsequent turns. */
  triageTaskId: string | null
  /** Server-persisted snapshot of the latest TRIAGE_DRAFT block emitted by
   *  the orchestrator in conversational mode. Lets clients joining
   *  mid-conversation render the launch panel without waiting for a new
   *  stream chunk. */
  latestTriageDraft: TriageDraft | null
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
    /** Emitted whenever the orchestrator's reply contains a TRIAGE_DRAFT
     *  block. Frontend uses it to show the "Launch as triage" panel. Pass
     *  `null` content (no event) when no block is present. */
    | { type: 'triage_draft', draft: TriageDraft }
    /** Emitted once the backend has spawned `kanban create --triage` +
     *  `kanban decompose` for this mission. Frontend uses it to dismiss the
     *  draft panel and flip the chat into supervisor mode. */
    | { type: 'triage_launched', triageTaskId: string, childIds: string[] }
