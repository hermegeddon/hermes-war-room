import { marked } from 'marked'
import DOMPurify from 'dompurify'

const renderer = new marked.Renderer()
const baseLink = renderer.link.bind(renderer)
renderer.link = (...args) => {
  const html = baseLink(...args)
  return html.replace(/^<a /, '<a target="_blank" rel="noopener noreferrer" ')
}

marked.setOptions({
  gfm: true,
  breaks: true,
  renderer
})

/**
 * Render trusted-but-not-blindly-trusted markdown to safe HTML. Used for the
 * orchestrator's chat output: it's an LLM, so we run the result through
 * DOMPurify before mounting it via `v-html`.
 *
 * SSR fallback: DOMPurify needs a DOM. When called during SSR we just escape
 * the content; the client will re-render with full markdown on hydration.
 */
export function renderMarkdown(input: string): string {
  if (!input) return ''
  const html = marked.parse(input, { async: false }) as string
  if (typeof window === 'undefined') {
    return escapeHtml(input)
  }
  return DOMPurify.sanitize(html, {
    ADD_ATTR: ['target', 'rel']
  })
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

/**
 * Drop OpenAI-Harmony / channel control tokens from streamed model output.
 *
 * Some Anthropic + OpenAI-style chat completions leak internal channel
 * markers (`<|channel|>analysis<|message|>…<|end|>`) when the worker's
 * reasoning is not properly stripped server-side. We don't want those
 * showing up verbatim in the chat — they're not for the user. The reasoning
 * channel itself (analysis / thought) is dropped along with its content;
 * any other stray markers are removed but their content kept.
 *
 * Patterns handled:
 *  - `<|channel|>analysis<|message|>…<|end|>` → drop the whole reasoning
 *    block AND the trailing `<|message|>` so we don't lose content.
 *  - `<|channel>thought<channel|>` (the variant the user reported) → drop.
 *  - Bare `<|...|>` / `<|...>` / `<...|>` control tokens → strip.
 */
export function stripHarmonyTags(input: string): string {
  if (!input) return ''
  let out = input
  // Reasoning-channel block: <|channel|>analysis<|message|>...<|end|>
  // (and the analysis/thought name variants). Drop content up to and
  // including the closing <|end|>.
  out = out.replace(
    /<\|channel\|>\s*(?:analysis|thought|reasoning)[\s\S]*?<\|end\|>/gi,
    ''
  )
  // Looser variant where the channel block has the form
  // <|channel>thought<channel|> wrapping its body.
  out = out.replace(/<\|channel>[\s\S]*?<channel\|>/gi, '')
  // Generic <|...|> and <|...> / <...|> tokens that survived.
  out = out.replace(/<\|[^|<>]*\|>/g, '')
  out = out.replace(/<\|[^|<>]*>/g, '')
  out = out.replace(/<[^|<>]*\|>/g, '')
  return out
}

export interface TaskRefMeta {
  id: string
  title: string
  assignee: string | null
  /** Hex string without the leading `#`, matching `Profile.backgroundColor`. */
  color: string | null
}
export type TaskRefLookup = Map<string, TaskRefMeta>

/**
 * Walk the rendered markdown HTML and replace bare task-ID mentions
 * (`t_2b542ab7`) with a styled inline pill carrying the operative's colour.
 *
 * Operates on text nodes so we don't accidentally rewrite the inside of a
 * `<code>` / `<pre>` block (where a literal `t_xxx` should stay literal).
 * SSR fallback: skip — we'll re-render on hydration.
 *
 * If the surrounding text matches the canonical `t_xxx: assignee — title`
 * shape, the chip absorbs the assignee and title too so the whole entity
 * reads as one unit instead of "id pill + plain text tail".
 */
export function decorateTaskRefs(html: string, lookup: TaskRefLookup): string {
  if (typeof window === 'undefined' || !html) return html
  if (lookup.size === 0 && !/\bt_[a-f0-9]{6,}\b/.test(html)) return html

  const tpl = document.createElement('template')
  tpl.innerHTML = html
  const skipTags = new Set(['CODE', 'PRE'])

  const walker = document.createTreeWalker(tpl.content, NodeFilter.SHOW_TEXT)
  const targets: Text[] = []
  while (walker.nextNode()) targets.push(walker.currentNode as Text)

  for (const node of targets) {
    let p: Node | null = node.parentNode
    let skip = false
    while (p) {
      if (p.nodeType === 1 && skipTags.has((p as Element).tagName)) {
        skip = true
        break
      }
      p = p.parentNode
    }
    if (skip) continue
    const text = node.nodeValue ?? ''
    if (!text || !/\bt_[a-f0-9]{6,}\b/.test(text)) continue

    /* Match either the full canonical form (id + ':' + assignee + '—' + title)
       or a bare id. The richer match is preferred — note the optional group
       lets us absorb a trailing assignee/title clause when the orchestrator
       formats the line that way. */
    const re = /(\bt_[a-f0-9]{6,}\b)(?:\s*:\s*([a-z0-9_-]+)\s*[—–-]\s*([^\n.;]{1,160}?)(?=[.;\n]|$))?/gi
    const frag = document.createDocumentFragment()
    let last = 0
    let m: RegExpExecArray | null
    while ((m = re.exec(text)) !== null) {
      if (m.index > last) {
        frag.appendChild(document.createTextNode(text.slice(last, m.index)))
      }
      const whole = m[0]
      // Group 1 is the mandatory id capture; TS can't infer that from the
      // regex so we assert it exists.
      const id = m[1] as string
      const assigneeFromText = m[2]
      const titleFromText = m[3]
      const meta = lookup.get(id)
      const assignee = (assigneeFromText ?? meta?.assignee ?? '').trim()
      const title = (titleFromText ?? meta?.title ?? '').trim()
      const color: string | null = meta?.color ?? null

      const pill = document.createElement('span')
      pill.className = title ? 'task-ref task-ref--rich' : 'task-ref'
      if (color) pill.style.setProperty('--accent', '#' + color)
      pill.dataset.taskId = id
      pill.title = `${id}${assignee ? ' · ' + assignee : ''}${title ? ' — ' + title : ''}`

      const idEl = document.createElement('span')
      idEl.className = 'task-ref-id'
      idEl.textContent = id
      pill.appendChild(idEl)

      if (assignee) {
        const sep = document.createElement('span')
        sep.className = 'task-ref-sep'
        sep.textContent = '·'
        pill.appendChild(sep)
        const ag = document.createElement('span')
        ag.className = 'task-ref-agent'
        ag.textContent = assignee
        pill.appendChild(ag)
      }
      if (title) {
        const sep2 = document.createElement('span')
        sep2.className = 'task-ref-sep'
        sep2.textContent = '—'
        pill.appendChild(sep2)
        const ti = document.createElement('span')
        ti.className = 'task-ref-title'
        ti.textContent = title
        pill.appendChild(ti)
      }

      frag.appendChild(pill)
      last = m.index + whole.length
    }
    if (last < text.length) {
      frag.appendChild(document.createTextNode(text.slice(last)))
    }
    node.parentNode?.replaceChild(frag, node)
  }

  return tpl.innerHTML
}
