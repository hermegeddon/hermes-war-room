import {
  appendMessage,
  getMission,
  listMessages,
  setAcpSessionId,
  setLatestTriageDraft,
  updateMessage
} from './mission'
import { newSession, loadSession, startPrompt } from './orchestrator-acp'
import { emit } from './mission-bus'
import { tasksCreatedSince } from './kanban'
import { withMissionLock } from './mission-lock'
import { addWatchedTasks, registerCreatedTaskFromTool } from './auto-nudge'
import { startFlight, endFlight } from './mission-flight'
import { useDb } from './db'
import { buildRosterMarkdown } from './roster'
import { extractTriageDraft } from './triage'
import type { SessionNotification } from '@zed-industries/agent-client-protocol'

// Heuristic patterns that indicate the orchestrator is *claiming* it created
// tasks. Used as a safety net: under the new triage flow the orchestrator
// should never run `hermes kanban create` itself (the war-room backend does
// it after the user confirms), so a delegation claim with zero new tasks is
// a sign the model drifted from the preamble.
const DELEGATION_CLAIMS = [
  /\bt_[0-9a-f]{6,}\b/i, // fake-looking task ids
  /task[_ -]?id\s*[:=]/i,
  /tarea[_ -]?creada/i,
  /task[s]?\s+creada[s]?/i,
  /task[s]?\s+created/i,
  /he\s+creado\s+(?:la|el|las|los)?\s*tar/i,
  /he\s+asignado/i,
  /assigned\s+to\s+\w+/i,
  /kanban_create/i
]

function looksLikeDelegationClaim(text: string): boolean {
  return DELEGATION_CLAIMS.some(re => re.test(text))
}

interface AcpAgentMessageChunk {
  sessionUpdate: 'agent_message_chunk' | 'agent_thought_chunk'
  content: { type?: string, text?: string }
}

interface AcpToolCall {
  sessionUpdate: 'tool_call' | 'tool_call_update'
  toolCallId?: string
  title?: string
  status?: string
  kind?: string
  rawInput?: Record<string, unknown>
  rawOutput?: Record<string, unknown>
  content?: Array<{ type?: string, content?: { type?: string, text?: string } }>
}

/**
 * Pull a short text excerpt from a tool call's content/rawOutput so we can
 * log what the terminal actually returned. ACP serialises tool output as
 * either a `content` array of TextContentBlocks or a `rawOutput` map.
 */
function extractToolText(tool: AcpToolCall): string | null {
  if (Array.isArray(tool.content)) {
    const parts: string[] = []
    for (const block of tool.content) {
      const text = block?.content?.text
      if (typeof text === 'string') parts.push(text)
    }
    if (parts.length > 0) return parts.join('\n').trim()
  }
  const raw = tool.rawOutput
  if (raw && typeof raw === 'object') {
    if (typeof (raw as { stdout?: unknown }).stdout === 'string') return String((raw as { stdout: string }).stdout)
    if (typeof (raw as { stderr?: unknown }).stderr === 'string') return String((raw as { stderr: string }).stderr)
    if (typeof (raw as { value?: unknown }).value === 'string') return String((raw as { value: string }).value)
    if (typeof (raw as { raw?: unknown }).raw === 'string') return String((raw as { raw: string }).raw)
  }
  return null
}

function extractText(update: SessionNotification['update']): string | null {
  const u = update as AcpAgentMessageChunk
  if (
    (u.sessionUpdate === 'agent_message_chunk' || u.sessionUpdate === 'agent_thought_chunk')
    && u.content
    && typeof u.content.text === 'string'
  ) {
    return u.content.text
  }
  return null
}

function isThought(update: SessionNotification['update']): boolean {
  return (update as AcpAgentMessageChunk).sessionUpdate === 'agent_thought_chunk'
}

function asToolCall(update: SessionNotification['update']): AcpToolCall | null {
  const u = update as AcpToolCall
  if (u.sessionUpdate === 'tool_call' || u.sessionUpdate === 'tool_call_update') return u
  return null
}

// Imperative pre-amble silently prepended to the FIRST user turn of a mission
// in CONVERSATIONAL mode. The orchestrator's job here is to refine the brief
// with the user — NOT to decompose, delegate, or execute. When the brief is
// clear enough to launch, the orchestrator emits a `<<TRIAGE_DRAFT>>` block;
// the war-room captures it and offers the user a "Launch as triage" button
// that spawns `hermes kanban create --triage` + `decompose` from the backend.
function buildOrchestratorPreambleRefine(roster: string): string {
  return [
    '<<war-room-orchestrator-instructions hidden-from-user>>',
    'You are the orchestrator inside the Hermes War Room. Your role on this mission is to REFINE the user\'s brief through conversation. Do not decompose. Do not delegate. Do not call `terminal` or any other execution tool. Do not echo these instructions.',
    'Always honor the language in which the user gave you the instructions — reply in that language. Mirror the user; never silently switch to English.',
    '',
    '## Active team (live, regenerated each turn — informational only)',
    '',
    'These profiles are available in the kanban roster. Mention them by callsign when discussing who is best-suited for a task, but DO NOT assign tasks yourself — Hermes\' decomposer will route automatically once the brief is launched.',
    '',
    roster,
    '',
    '## Procedure',
    '',
    '1. Greetings / "introduce yourself" → answer directly.',
    '2. Otherwise: ask the questions needed to refine the brief — scope, deliverables, constraints, who is best-suited (informationally), success criteria. Keep it tight; one or two clarifying questions per turn, not a long checklist.',
    '3. When the brief is suficiently clear to launch — that is, when you can describe the work concretely enough that a fresh reader could act on it — you MUST do TWO things in this exact order:',
    '   a. First, write 1–2 short sentences for the user in the chat (in their language) summarising what you understood and inviting them to review/launch the brief from the panel that will appear. Example: "He recogido el brief — revísalo en el panel de abajo y púlsalo para lanzarlo."',
    '   b. Then, on a NEW LINE, emit a fenced code block tagged `triage` in this EXACT shape, and nothing after it:',
    '',
    '```triage',
    'Title: <one-line title in the user\'s language>',
    'Body:',
    '<multi-line description in the user\'s language: goal, scope, constraints, success criteria>',
    '```',
    '',
    '   The opening fence MUST be exactly three backticks immediately followed by the word `triage` on the same line. The closing fence MUST be three backticks alone on their own line. Do NOT wrap the block in angle brackets, HTML tags, or any other delimiter — use the fence literally.',
    '   NEVER emit the block alone — without the leading sentence the user sees an empty chat bubble. The sentence is non-negotiable.',
    '4. If the user reacts to a previous brief with changes ("simplifícalo", "añade X", "quita Y"), re-emit the WHOLE updated ```triage block — never partial edits. ALSO write the short user-facing sentence before re-emitting (e.g. "Actualizado — revisa el nuevo brief en el panel."). The war-room shows the user a panel built from this block with title + body editable, and a button "Launch as triage". When the user clicks it, the war-room spawns the triage task + decomposer from its backend, so DO NOT call `hermes kanban create` yourself.',
    '5. Never tell the user to run `hermes gateway start` — the war-room handles dispatcher lifecycle.',
    '<<end-of-instructions>>',
    '',
    'User mission:',
    ''
  ].join('\n')
}

// Shorter preamble for follow-up turns in CONVERSATIONAL refine mode. Full
// instructions are already loaded earlier in the ACP session; re-injecting
// them caused the model to "restart" the workflow on every turn — including
// verbatim re-emission of the previous draft on confirmation replies like
// "Si"/"ok". Roster is re-included so mid-mission membership changes still
// propagate even when the model wouldn't otherwise look up the team.
function buildOrchestratorPreambleRefineFollowup(roster: string): string {
  return [
    '<<war-room-orchestrator-followup hidden-from-user>>',
    'You are continuing to refine an in-progress brief. Full instructions are loaded earlier in this session — do not restate them.',
    'Treat the user input below as the next conversational turn.',
    'If the user confirms a draft you already proposed (replies like "sí", "ok", "dale", "adelante", "yes", "go"), DO NOT re-emit the ```triage block — the panel is already showing it and the user only needs to click "Launch as triage". Just acknowledge briefly in the user\'s language.',
    'If the user asks for changes, FIRST write 1–2 short sentences acknowledging the change in the user\'s language ("Actualizado — revisa el nuevo brief abajo."), THEN on a new line re-emit the COMPLETE updated ```triage block as your final lines (opening fence: three backticks + the word `triage`; closing fence: three backticks alone). NEVER emit the block alone — the user would see an empty bubble. Never wrap the fence in angle brackets or HTML tags.',
    'Honor the language the user originally used.',
    '',
    '## Active team (live, may have changed since turn 1)',
    '',
    roster,
    '',
    '<<end-of-followup>>',
    '',
    'User reply:',
    ''
  ].join('\n')
}

// Preamble used once the mission has been promoted into a real triage task
// (kanban_create --triage + decompose). The orchestrator is now a supervisor:
// it watches subtasks complete (re-engaged by auto-nudge with
// `<<war-room-task-update>>` blocks) and comments on progress in plain
// language. It MUST NOT emit TRIAGE_DRAFT again or spawn new kanban tasks
// directly — if the user wants more work, they create a new mission or ask
// for follow-up subtasks that the supervisor adds via `hermes kanban
// comment` (advisory only, no exec required).
function buildOrchestratorPreambleSupervisor(roster: string, triageTaskId: string): string {
  return [
    '<<war-room-orchestrator-supervisor hidden-from-user>>',
    `This mission has been launched as triage task \`${triageTaskId}\`. Hermes' decomposer has fanned it out into specialist subtasks (visible to you via the war-room task-update nudges that arrive between user turns).`,
    'Your role now is SUPERVISOR. Watch progress, comment on subtask completions in plain language for the user, and propose adjustments when something goes wrong. DO NOT emit TRIAGE_DRAFT blocks anymore. DO NOT call `hermes kanban create` or any other execution tool yourself — the war-room owns those operations.',
    'Honor the language the user originally used. Mirror the user; never silently switch to English.',
    '',
    '## Active team (informational)',
    '',
    roster,
    '',
    '<<end-of-supervisor>>',
    '',
    'User reply:',
    ''
  ].join('\n')
}

/**
 * Drive one user turn against the orchestrator: ensure session exists, append
 * the user message, kick off ACP prompt, fan chunks out to the mission bus,
 * persist the final assistant message. Resolves once the turn ends.
 *
 * Wrapped in `withMissionLock` so concurrent user requests + auto-nudge turns
 * never overlap on the same ACP session.
 */
export function runMissionTurn(missionId: string, userText: string): Promise<void> {
  return withMissionLock(missionId, () => runMissionTurnLocked(missionId, userText))
}

async function runMissionTurnLocked(missionId: string, userText: string): Promise<void> {
  const mission = getMission(missionId)
  if (!mission) throw new Error(`Mission ${missionId} not found`)
  if (mission.status !== 'open') throw new Error(`Mission ${missionId} is not open`)

  // First-turn detection: if there are no prior assistant messages persisted,
  // this is the opening turn and gets the full preamble. Subsequent turns get
  // the lighter follow-up preamble so the model doesn't re-run the whole
  // decompose/ask/delegate flow on each reply.
  const priorMessages = listMessages(missionId)
  const isFirstTurn = !priorMessages.some(m => m.role === 'assistant')

  // Persist user message + announce.
  const userMsg = appendMessage(missionId, 'user', userText)
  emit(missionId, { type: 'user', messageId: userMsg.id, content: userText })

  // ACP session cwd = the profile's hermes_dir, so Hermes auto-loads the
  // profile's local AGENTS.md / SOUL.md / .cursorrules from there. Without
  // this, sessions resolved AGENTS.md from the war-room's own cwd, so every
  // profile shared the global rules.
  const profileRow = useDb()
    .prepare('SELECT hermes_dir FROM profiles WHERE slug = ?')
    .get(mission.orchestrator_slug) as { hermes_dir: string } | undefined
  const sessionCwd = profileRow?.hermes_dir

  // Ensure ACP session exists.
  let sessionId = mission.acp_session_id
  if (!sessionId) {
    sessionId = await newSession(mission.orchestrator_slug, sessionCwd)
    setAcpSessionId(missionId, sessionId)
  } else {
    // Make sure the agent has the session loaded (it might have been a fresh process).
    try {
      await loadSession(mission.orchestrator_slug, sessionId, sessionCwd)
    } catch (e) {
      // If load fails (e.g. session was pruned), start fresh.
      console.error(`[mission ${missionId}] loadSession failed, starting new:`, (e as Error).message)
      sessionId = await newSession(mission.orchestrator_slug, sessionCwd)
      setAcpSessionId(missionId, sessionId)
    }
  }

  // Pre-create an empty assistant message so we have an id to deliver `done` on.
  const assistantMsg = appendMessage(missionId, 'assistant', '')
  let buffer = ''
  let terminalToolUsed = false
  const turnStartUnix = Math.floor(Date.now() / 1000)

  // Cache of `rawInput` keyed by toolCallId. ACP only includes rawInput in
  // the initial `tool_call` notification; subsequent `tool_call_update`
  // events only carry the delta (status + output). We need the original
  // command on the completion log line.
  const toolInputs = new Map<string, unknown>()

  // Track in-flight state so reconnecting SSE clients see the partial buffer.
  const flight = startFlight(missionId, assistantMsg.id)

  const roster = buildRosterMarkdown()
  /* Once a mission has been promoted into a real triage task, the orchestrator
     is a supervisor — different preamble, no TRIAGE_DRAFT emission. */
  const supervisorMode = !!mission.triage_task_id
  let preamble: string
  if (supervisorMode) {
    preamble = buildOrchestratorPreambleSupervisor(roster, mission.triage_task_id!)
  } else if (isFirstTurn) {
    preamble = buildOrchestratorPreambleRefine(roster)
  } else {
    preamble = buildOrchestratorPreambleRefineFollowup(roster)
  }
  const handle = startPrompt({
    slug: mission.orchestrator_slug,
    sessionId,
    text: preamble + userText
  })

  handle.emitter.on('update', (notification: SessionNotification) => {
    const text = extractText(notification.update)
    if (text !== null) {
      const thought = isThought(notification.update)
      if (!thought) {
        buffer += text
        flight.buffer = buffer
      }
      emit(missionId, { type: 'chunk', delta: text, thought })
      return
    }
    const tool = asToolCall(notification.update)
    if (tool) {
      const blob = `${tool.title ?? ''} ${tool.kind ?? ''}`.toLowerCase()
      const isTerminal = blob.includes('terminal')
        || blob.includes('execute')
        || blob.includes('shell')
        || blob.includes('hermes kanban')
      if (isTerminal) terminalToolUsed = true

      // Cache rawInput on the initial tool_call so we can recover the command
      // on the matching tool_call_update completion event (which only carries
      // the diff, not the original input).
      if (tool.toolCallId && tool.rawInput && !toolInputs.has(tool.toolCallId)) {
        toolInputs.set(tool.toolCallId, tool.rawInput)
      }

      // Mirror terminal tool calls to the dev server log so we can diagnose
      // failures without running ACP standalone. Only on status='completed'
      // or 'failed' to avoid spamming progressive updates. Use console.log
      // for completed (info level) and console.error only for failed so the
      // dev console doesn't paint successful runs in red.
      if (isTerminal && (tool.status === 'completed' || tool.status === 'failed')) {
        const cachedInput = tool.toolCallId ? toolInputs.get(tool.toolCallId) : tool.rawInput
        const cmd = (cachedInput as { command?: unknown } | undefined)?.command
        const cmdStr = typeof cmd === 'string'
          ? cmd
          : (cachedInput ? JSON.stringify(cachedInput) : '(input not captured)')
        const out = extractToolText(tool)
        const head = out ? out.slice(0, 600) : '(no output captured)'
        const log = tool.status === 'failed' ? console.error : console.log
        log(
          `[mission ${missionId}] terminal ${tool.status}:`,
          cmdStr,
          '\n  output:', head.replace(/\n/g, '\n    ')
        )
      }

      // Inline registration: as soon as a `hermes kanban create --json`
      // tool call completes, persist the new task id to the auto-nudge
      // watch list. Robust to turns that never reach `done` (long ReAct
      // loops, ACP hangs, server restarts) — those tasks would otherwise
      // be invisible to the watcher because addWatchedTasks runs in the
      // try block AFTER `await handle.done` below.
      if (tool.status === 'completed') {
        const cachedInput = tool.toolCallId ? toolInputs.get(tool.toolCallId) : tool.rawInput
        registerCreatedTaskFromTool(missionId, {
          status: tool.status,
          rawInput: cachedInput as Record<string, unknown> | undefined,
          rawOutput: tool.rawOutput,
          content: tool.content
        })
      }

      emit(missionId, {
        type: 'tool',
        title: tool.title,
        status: tool.status,
        raw: tool
      })
    }
  })

  try {
    const { stopReason } = await handle.done

    // Hallucination check: did the orchestrator claim it delegated, but the
    // kanban DB show zero new tasks since this turn began? If so, append a
    // dashboard-side correction so the user knows they were lied to and the
    // model knows to retry on the next turn (the correction lives in the
    // session history and feeds the model on subsequent prompts).
    let finalContent = buffer
    if (looksLikeDelegationClaim(buffer)) {
      const created = tasksCreatedSince(turnStartUnix)
      if (created.length === 0) {
        const reason = terminalToolUsed
          ? 'You invoked `terminal` but the `hermes kanban create` commands failed (probably bad syntax — remember: `title` is POSITIONAL, not `--title`). Re-issue with the correct syntax: `hermes kanban create "<title>" --assignee <slug> --body "<body>" --json`'
          : 'No `terminal` tool call invoked `hermes kanban create`. The reply above is a hallucination.'
        finalContent = buffer + [
          '',
          '',
          '---',
          '',
          `> ⚠️ **Orchestration War Room verification failed.** The orchestrator claimed delegation but the kanban DB shows **0 new tasks** were created during this turn. ${reason}`,
          ''
        ].join('\n')
      } else {
        // Truth-check the claimed task ids against what was actually created.
        // If the response mentions ids that don't match any of the new rows,
        // call out the mismatch so the model corrects itself next turn.
        const claimedIds = Array.from(buffer.matchAll(/\bt_[0-9a-f]{6,}\b/gi)).map(m => m[0])
        const realIds = new Set(created.map(t => t.id))
        const fake = claimedIds.filter(id => !realIds.has(id))
        if (fake.length > 0) {
          finalContent = buffer + [
            '',
            '',
            '---',
            '',
            `> ⚠️ **Orchestration War Room verification:** the kanban DB created **${created.length}** new task(s) during this turn (real ids: ${created.map(t => `\`${t.id}\``).join(', ')}), but the reply above mentions ids that do not exist (${fake.map(id => `\`${id}\``).join(', ')}). Use the real ids on next reply.`,
            ''
          ].join('\n')
        }
      }
    }

    updateMessage(assistantMsg.id, finalContent)

    /* Triage draft detection — only meaningful in refine mode (the
       supervisor preamble explicitly forbids TRIAGE_DRAFT emission). When
       the orchestrator's final reply contains a block, persist it and emit
       an SSE event so the launch panel pops up in the UI. */
    if (!supervisorMode) {
      const draft = extractTriageDraft(finalContent)
      if (draft) {
        setLatestTriageDraft(missionId, {
          title: draft.title,
          body: draft.body,
          messageId: assistantMsg.id
        })
        emit(missionId, {
          type: 'triage_draft',
          draft: { ...draft, messageId: assistantMsg.id }
        })
      }
    }

    emit(missionId, {
      type: 'done',
      messageId: assistantMsg.id,
      content: finalContent,
      stopReason
    })

    // Hand any tasks created during this turn off to the auto-nudge watcher
    // so the orchestrator gets re-engaged when they finish. Under the new
    // flow the orchestrator shouldn't create kanban tasks directly, but if
    // it does anyway (drift) or if the user launched a triage from the
    // panel mid-turn, the watcher still picks them up.
    const created = tasksCreatedSince(turnStartUnix)
    if (created.length > 0) {
      addWatchedTasks(missionId, created.map(t => t.id))
    }
  } catch (e) {
    const msg = (e as Error).message
    updateMessage(assistantMsg.id, buffer || `[error: ${msg}]`)
    emit(missionId, { type: 'error', message: msg })
    throw e
  } finally {
    endFlight(missionId)
  }
}
