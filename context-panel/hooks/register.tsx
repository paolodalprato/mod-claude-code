import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Breakdown, DetailKey, DetailRow, LoadedSkill, Measure, ServerRow } from '../types'

const PANE = 'context-panel'
const TITLE = 'Context'

const measure = atom({ plugin: 'context-panel', key: 'measure' } as const, null)
const breakdown = atom({ plugin: 'context-panel', key: 'breakdown' } as const, null)
const busy = atom({ plugin: 'context-panel', key: 'busy' } as const, false)
const expanded = atom({ plugin: 'context-panel', key: 'expanded' } as const, null)
const loaded = atom({ plugin: 'context-panel', key: 'loaded' } as const, [])

// Rough ratio for skill texts (measured on Italian ones); the engine gives no per-text token count.
const CHARS_PER_TOKEN = 3

// A skill's full text opens with this line, both from the Skill tool and from
// a slash command; the skill's name is the folder the line names.
const SKILL_MARKER = /^Base directory for this skill:\s*(.+)$/m

const textsOf = (content: { type: string; [field: string]: unknown }[]) => {
  const out: string[] = []
  for (const block of content) {
    if (block.type === 'text' && typeof block.text === 'string') out.push(block.text)
    if (block.type === 'tool_result') {
      const inner = block.content
      if (typeof inner === 'string') out.push(inner)
      else if (Array.isArray(inner))
        for (const part of inner)
          if (part && typeof part === 'object' && typeof (part as { text?: unknown }).text === 'string')
            out.push((part as { text: string }).text)
    }
  }
  return out
}

const skillNameOf = (text: string) => {
  const found = SKILL_MARKER.exec(text.slice(0, 2000))
  const path = found?.[1]?.trim()
  return path ? path.split(/[\\/]/).filter(Boolean).pop() : undefined
}

// Rebuilds the list from the conversation as it stands. Every copy of a
// skill's text counts, since each one occupies the window; skills loaded
// before the mod was on, or before a reload, are found too.
const scanConversation = async ($: EngineInterface) => {
  try {
    const rows = await $.session.messages()
    if (!Array.isArray(rows)) return
    const found = new Map<string, LoadedSkill>()
    for (const row of rows) {
      if (row.role !== 'user' || !row.text) continue
      const name = skillNameOf(row.text)
      if (!name) continue
      const seen = found.get(name) ?? { name, chars: 0, times: 0 }
      found.set(name, { name, chars: seen.chars + row.text.length, times: seen.times + 1 })
    }
    await update($, loaded, () => [...found.values()])
  } catch {
    // The list stays as it was.
  }
}

// The breakdown carries a composition for these categories only. Rows are
// matched by name, which the engine may change: an unmatched row stays plain.
const detailKeyOf = (name: string): DetailKey | undefined => {
  if (/skill/i.test(name)) return 'skills'
  // Tool schemas only: "MCP server instructions" has no per-server breakdown.
  if (/mcp tool/i.test(name)) return 'mcp'
  if (/memory/i.test(name)) return 'memory'
  if (/agent/i.test(name)) return 'agents'
  return undefined
}

const SOURCE_NAMES: Record<string, string> = {
  userSettings: 'yours',
  projectSettings: 'project',
  plugin: 'plugin',
  'built-in': 'built-in',
  mcp: 'from an MCP server',
  syncedSkills: 'from your account',
}

// A line above an open list, saying what its numbers count.
const DETAIL_HEADERS: Partial<Record<DetailKey, string>> = {
  skills: "Tokens of each skill's description in the list Claude receives every session",
}

// Last two path segments, enough to tell CLAUDE.md files apart.
const shortPath = (p: string) => p.split(/[\\/]/).filter(Boolean).slice(-2).join('/')

const byTokens = (rows: DetailRow[]) => rows.sort((a, z) => z.tokens - a.tokens)

const toolCount = (n: number) => `${n} ${n === 1 ? 'tool' : 'tools'}`

// English number format (comma as thousands separator) without relying on Intl.
const num = (n: number) => String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ',')

const pct = (part: number, whole: number) => (whole > 0 ? Math.round((part / whole) * 100) : 0)

// A bar of `width` cells, filled in proportion; at least one cell for any non-zero share.
const bar = (part: number, whole: number, width: number) => {
  const w = Math.max(1, width)
  const filled = whole > 0 ? Math.min(w, Math.max(part > 0 ? 1 : 0, Math.round((part / whole) * w))) : 0
  return { on: '█'.repeat(filled), off: '░'.repeat(w - filled) }
}

const pad = (text: string, width: number) =>
  text.length > width ? text.slice(0, Math.max(1, width - 1)) + '…' : text.padEnd(width)

// Short names: the time to reset shares the name column, so the row fits one line.
const LIMIT_NAMES: Record<string, string> = {
  five_hour: '5h win',
  seven_day: '7d win',
  spend_limit: 'Spend limit',
}

const untilReset = (iso: string | undefined, now: number) => {
  if (!iso) return ''
  const ms = Date.parse(iso) - now
  if (!Number.isFinite(ms) || ms <= 0) return 'now'
  const min = Math.round(ms / 60000)
  if (min < 60) return `${min}m`
  const h = Math.floor(min / 60)
  if (h < 48) return `${h}h ${min % 60}m`
  return `${Math.floor(h / 24)}d ${h % 24}h`
}

const limitLabel = (kind: string, iso: string | undefined, now: number) => {
  const name = LIMIT_NAMES[kind] ?? kind
  const reset = untilReset(iso, now)
  return reset ? `${name} - ${reset}` : name
}

// The engine draws System prompt and Free space in greys that fade into the
// track of the bars, so the panel gives these two rows colours of their own.
const PROMPT_COLOR = '#e879a8'
const FREE_COLOR = '#a3e635'
// The fill of the window, on the top bar and on Total used: neutral until the
// window runs short, then the warning colour, then red close to auto-compaction.
const fillColor = (percent: number) => (percent >= 95 ? '#ef4444' : percent >= 80 ? 'warning' : '#f3f4f6')
const categoryColor = (c: { name: string; color: string; kind: string }) =>
  c.kind === 'free' ? FREE_COLOR : /^system prompt$/i.test(c.name) ? PROMPT_COLOR : c.color

const toMeasure = (u: {
  context: { tokens?: number; window: number; percent?: number }
  rateLimits: { kind: string; percentUsed: number; resetsAt?: string }[]
  cost?: { usd: number }
}): Measure => ({
  tokens: u.context.tokens,
  window: u.context.window,
  percent: u.context.percent,
  limits: u.rateLimits.map(l => ({ kind: l.kind, percentUsed: l.percentUsed, resetsAt: l.resetsAt })),
  costUsd: u.cost?.usd,
})

// A response that reports no limit window must not wipe the last reading: the
// previous windows stay, marked as old, until a response reports them again.
const keepLimits = (previous: Measure | null, next: Measure): Measure =>
  next.limits.length > 0 || !previous || previous.limits.length === 0
    ? next
    : { ...next, limits: previous.limits, limitsAreOld: true }

// Takes a breakdown of the window. 'summary' is a free local estimate;
// 'full' sends token-count requests as /context does, so it runs only on request.
const takeBreakdown = async ($: EngineInterface, detail: 'summary' | 'full') => {
  if (await read($, busy)) return
  await update($, busy, () => true)
  try {
    const u = await $.session.usage({ breakdown: detail })
    await update($, measure, cur => keepLimits(cur, toMeasure(u)))
    const b = u.context.breakdown
    if (!b) return
    // MCP tool schemas grouped by server, only those loaded in the window.
    const byServer = new Map<string, ServerRow>()
    for (const t of b.mcpTools) {
      if (!t.isLoaded) continue
      const row = byServer.get(t.serverName) ?? { name: t.serverName, tokens: 0, tools: 0 }
      row.tokens += t.tokens
      row.tools += 1
      byServer.set(t.serverName, row)
    }
    const snapshot: Breakdown = {
      detail,
      takenAt: await $.clock.now(),
      tokensAtTake: u.context.tokens,
      totalTokens: b.totalTokens,
      maxTokens: b.rawMaxTokens,
      autoCompactThreshold: b.autoCompactThreshold,
      categories: b.categories.map(c => ({ name: c.name, tokens: c.tokens, color: categoryColor(c), kind: c.kind })),
      servers: [...byServer.values()].sort((a, z) => z.tokens - a.tokens),
      skillsTokens: b.skills?.tokens,
      memoryTokens: b.memoryFiles.reduce((s, f) => s + f.tokens, 0),
      details: {
        skills: byTokens(
          (b.skills?.skillFrontmatter ?? []).map(s => ({
            name: s.name,
            tokens: s.tokens,
            note: s.pluginName ? `plugin ${s.pluginName}` : (SOURCE_NAMES[s.source] ?? s.source),
          })),
        ),
        mcp: [...byServer.values()]
          .sort((a, z) => z.tokens - a.tokens)
          .map(s => ({ name: s.name, tokens: s.tokens, note: toolCount(s.tools) })),
        memory: byTokens(b.memoryFiles.map(f => ({ name: shortPath(f.path), tokens: f.tokens, note: f.type }))),
        agents: byTokens(
          b.agents.map(a => ({ name: a.agentType, tokens: a.tokens, note: SOURCE_NAMES[a.source] ?? a.source })),
        ),
      },
    }
    await update($, breakdown, () => snapshot)
  } catch (err) {
    $.ui.toast(`context-panel: could not read the context (${String(err)})`)
  } finally {
    await update($, busy, () => false)
  }
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'context-panel',
      description: 'Opens the panel with the context window fill and usage limits',
    })
    try {
      const first = toMeasure(await $.session.usage())
      await update($, measure, cur => keepLimits(cur, first))
    } catch {
      // No reading yet: the first session.measure fills it.
    }
    return next(e)
  })

  on('command.run', { command: 'context-panel' }, async $ => {
    const opened = await $.ui.open({ id: PANE, title: TITLE })
    void scanConversation($)
    void takeBreakdown($, 'summary')
    return {
      text: opened.isPlaced
        ? 'Context panel opened.'
        : `Context panel waiting for room (${opened.reason}).`,
    }
  })

  // A skill text entering the main conversation, or a compaction that drops
  // the texts, rebuilds the list from the conversation itself.
  on('session.append', async ($, e, next) => {
    const stored = await next(e)
    if (e.agentId) return stored
    try {
      if (e.door === 'compaction') {
        await update($, loaded, () => [])
        return stored
      }
      if (textsOf(e.message.content).some(t => skillNameOf(t))) await scanConversation($)
    } catch {
      // Observing only: a failure here must never touch the row.
    }
    return stored
  })

  // Every new reading of fill, limits or cost redraws the panel.
  on('session.measure', async ($, e, next) => {
    await update($, measure, cur => keepLimits(cur, toMeasure(e)))
    return next(e)
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button } = $.ui.resolve(e)
    const m = await read($, measure)
    const b = await read($, breakdown)
    const isBusy = await read($, busy)
    const open = await read($, expanded)
    const loadedSkills = await read($, loaded)
    const now = await $.clock.now()

    const cols = Math.max(30, e.props.bodyColumns)
    const label = Math.min(26, Math.floor(cols * 0.35))
    const barW = Math.max(8, cols - label - 16)

    // The desktop app draws proportional text, where padded spaces and █░
    // characters cannot line up. There the columns are fixed-width Boxes and
    // the bars are filled Boxes; every other surface keeps the text layout.
    const isDesktop = e.surface === 'desktop'
    const FIG_W = 20
    const gBarW = Math.max(8, cols - label - FIG_W - 4)
    const TRACK = '#3a3a3a'
    const gBar = (part: number, whole: number, width: number, color: string) => {
      const g = bar(part, whole, width)
      return (
        <Box width={width} height={1} flexShrink={0}>
          <Box width={g.on.length} height={1} backgroundColor={color} />
          <Box width={g.off.length} height={1} backgroundColor={TRACK} />
        </Box>
      )
    }
    // One aligned row: a mark column, the label, the bar and the right-aligned figures.
    // A Button takes only strings and Text as children, so a pressable row puts
    // the mark and the name inside one Button and leaves the bar and figures outside it.
    const gRow = (
      mark: string,
      name: string,
      barNode: unknown,
      figures: string,
      indent = 0,
      note?: string,
      press?: { key: string; onPress: () => void },
    ) => (
      <Box flexDirection="row" gap={1} marginLeft={indent}>
        {press ? (
          <Box width={label + 2} flexShrink={0}>
            <Button key={press.key} plain onPress={press.onPress}>
              {mark} {name}
            </Button>
          </Box>
        ) : (
          <Box width={label + 2} flexShrink={0} flexDirection="row" gap={1}>
            <Box width={1} flexShrink={0}>
              <Text>{mark}</Text>
            </Box>
            <Text wrap="truncate-end">{name}</Text>
          </Box>
        )}
        {barNode}
        <Box width={FIG_W} flexShrink={0} justifyContent="flex-end">
          <Text>{figures}</Text>
        </Box>
        {note ? <Text dimColor>{note}</Text> : null}
      </Box>
    )

    const total = m?.tokens
    const win = m?.window ?? b?.maxTokens ?? 0
    const totalBar = bar(total ?? 0, win, cols - 2)
    const isStale = !!b && b.tokensAtTake !== total

    // Rows that occupy the window come first and get a subtotal; free space
    // and the compaction buffer follow it. Deferred schemas never count.
    const shown = (b?.categories ?? []).filter(c => c.kind !== 'deferred' && c.tokens > 0)
    const used = shown.filter(c => c.kind === 'used')
    const rest = shown.filter(c => c.kind !== 'used')
    const usedTokens = used.reduce((s, c) => s + c.tokens, 0)
    const usedColor = fillColor(pct(usedTokens, b?.maxTokens ?? 0))
    // A row with a composition is a Button that opens or closes it below.
    const categoryRow = (c: (typeof shown)[number]) => {
      const cb = bar(c.tokens, b?.maxTokens ?? 0, barW)
      const key = detailKeyOf(c.name)
      const items = key ? (b?.details?.[key] ?? []) : []
      // Loaded skills are shown beside the listing, never added to the row:
      // their tokens are an estimate and the engine counts them in Messages.
      const extra: DetailRow[] =
        key === 'skills'
          ? byTokens(
              loadedSkills.map(s => ({
                name: s.name,
                tokens: s.chars / CHARS_PER_TOKEN,
                note: s.times > 1 ? `loaded ${s.times} times` : undefined,
              })),
            )
          : []
      const isOpen = open === c.name && items.length + extra.length > 0
      const tail = (
        <Text>
          {' '}
          <Text color={c.color}>{cb.on}</Text>
          <Text dimColor>{cb.off}</Text> {pct(c.tokens, b?.maxTokens ?? 0)}% {num(c.tokens)}
        </Text>
      )
      const figures = `${pct(c.tokens, b?.maxTokens ?? 0)}% ${num(c.tokens)}`
      const toggle = () => void update($, expanded, cur => (cur === c.name ? null : c.name))
      const gCategory = (mark: string, press?: { key: string; onPress: () => void }) =>
        gRow(mark, c.name, gBar(c.tokens, b?.maxTokens ?? 0, gBarW, c.color), figures, 0, undefined, press)
      if (items.length + extra.length === 0) {
        if (isDesktop) return gCategory(' ')
        return (
          <Text>
            {'  '}
            {pad(c.name, label - 2)}
            {tail}
          </Text>
        )
      }
      const top = items[0]?.tokens ?? 0
      const itemBarW = Math.max(6, Math.floor((isDesktop ? gBarW : barW) / 2))
      return (
        <Box flexDirection="column">
          {isDesktop ? (
            gCategory(isOpen ? '▾' : '▸', { key: `cat-${c.name}`, onPress: toggle })
          ) : (
            <Button key={`cat-${c.name}`} plain onPress={toggle}>
              {isOpen ? '▾ ' : '▸ '}
              {pad(c.name, label - 2)}
              {tail}
            </Button>
          )}
          {isOpen && extra.length > 0 && (
            <Box flexDirection="column">
              <Text dimColor>
                {'    '}Loaded this session: full text, estimated, counted in Messages
              </Text>
              {extra.map(it => {
                const eb = bar(it.tokens, extra[0]?.tokens ?? it.tokens, itemBarW)
                if (isDesktop)
                  return gRow(
                    ' ',
                    it.name,
                    gBar(it.tokens, extra[0]?.tokens ?? it.tokens, itemBarW, 'suggestion'),
                    `~${num(it.tokens)}`,
                    2,
                    it.note,
                  )
                return (
                  <Text>
                    {'    '}
                    {pad(it.name, label)} <Text color="suggestion">{eb.on}</Text>
                    <Text dimColor>{eb.off}</Text> ~{num(it.tokens)}
                    {it.note ? <Text dimColor> {it.note}</Text> : ''}
                  </Text>
                )
              })}
              <Text> </Text>
            </Box>
          )}
          {isOpen && key && DETAIL_HEADERS[key] && (
            <Text dimColor>
              {'    '}
              {DETAIL_HEADERS[key]}
            </Text>
          )}
          {isOpen &&
            items.map(it => {
              const ib = bar(it.tokens, top, itemBarW)
              if (isDesktop)
                return gRow(' ', it.name, gBar(it.tokens, top, itemBarW, c.color), num(it.tokens), 2, it.note)
              return (
                <Text>
                  {'    '}
                  {pad(it.name, label)} <Text color={c.color}>{ib.on}</Text>
                  <Text dimColor>{ib.off}</Text> {num(it.tokens)}
                  {it.note ? <Text dimColor> {it.note}</Text> : ''}
                </Text>
              )
            })}
        </Box>
      )
    }

    return (
      <Box flexDirection="column">
        <Text weight="bold">Context window fill</Text>
        {total === undefined ? (
          <Text dimColor>No reading yet. It arrives after the next response.</Text>
        ) : (
          <Box flexDirection="column">
            {isDesktop ? (
              gBar(total, win, cols - 2, fillColor(m?.percent ?? pct(total, win)))
            ) : (
              <Text>
                <Text color={fillColor(m?.percent ?? pct(total, win))}>{totalBar.on}</Text>
                <Text dimColor>{totalBar.off}</Text>
              </Text>
            )}
            <Text>
              {m?.percent ?? pct(total, win)}% of {num(win)} tokens
            </Text>
          </Box>
        )}

        <Text> </Text>
        <Text weight="bold">What fills it</Text>
        {!b && <Text dimColor>{isBusy ? 'Calculating…' : 'No breakdown yet. Press Refresh estimate.'}</Text>}
        {b && (
          <Box flexDirection="column">
            {used.map(categoryRow)}
            {used.length > 0 && isDesktop && (
              <Box flexDirection="row" gap={1}>
                <Box width={1} flexShrink={0} />
                <Box width={label} flexShrink={0}>
                  <Text weight="bold" color={usedColor}>
                    Total used
                  </Text>
                </Box>
                {gBar(usedTokens, b.maxTokens, gBarW, usedColor)}
                <Box width={FIG_W} flexShrink={0} justifyContent="flex-end">
                  <Text weight="bold" color={usedColor}>
                    {pct(usedTokens, b.maxTokens)}% {num(usedTokens)}
                  </Text>
                </Box>
              </Box>
            )}
            {used.length > 0 && !isDesktop && (
              <Text weight="bold" color={usedColor}>
                {'  '}
                {pad('Total used', label - 2)} <Text color={usedColor}>{bar(usedTokens, b.maxTokens, barW).on}</Text>
                <Text dimColor>{bar(usedTokens, b.maxTokens, barW).off}</Text> {pct(usedTokens, b.maxTokens)}%{' '}
                {num(usedTokens)}
              </Text>
            )}
            {rest.map(categoryRow)}
            {b.autoCompactThreshold !== undefined && (
              <Text dimColor>
                Auto-compaction at {num(b.autoCompactThreshold)} tokens ({pct(b.autoCompactThreshold, b.maxTokens)}%)
              </Text>
            )}
            <Text dimColor>
              {b.detail === 'full' ? 'Precise count' : 'Local estimate'}
              {isStale ? ', the context has changed since' : ''}
            </Text>
          </Box>
        )}

        {b && b.servers.length > 0 && (
          <Box flexDirection="column">
            <Text> </Text>
            <Text weight="bold">Loaded MCP servers, largest first</Text>
            {b.servers.slice(0, 6).map(s => {
              const sb = bar(s.tokens, b.servers[0]?.tokens ?? s.tokens, barW)
              if (isDesktop)
                return gRow(
                  ' ',
                  s.name,
                  gBar(s.tokens, b.servers[0]?.tokens ?? s.tokens, gBarW, 'ide'),
                  `${num(s.tokens)} (${toolCount(s.tools)})`,
                )
              return (
                <Text>
                  {pad(s.name, label)} <Text color="ide">{sb.on}</Text>
                  <Text dimColor>{sb.off}</Text> {num(s.tokens)} ({toolCount(s.tools)})
                </Text>
              )
            })}
          </Box>
        )}

        <Text> </Text>
        <Text weight="bold">Usage limits / reset</Text>
        {(!m || m.limits.length === 0) && <Text dimColor>No limits reading.</Text>}
        {m?.limits.map(l => {
          const lb = bar(l.percentUsed, 100, barW)
          if (isDesktop)
            return gRow(
              ' ',
              limitLabel(l.kind, l.resetsAt, now),
              gBar(l.percentUsed, 100, gBarW, l.percentUsed >= 80 ? 'warning' : 'success'),
              `${l.percentUsed}%`,
            )
          return (
            <Text>
              {pad(limitLabel(l.kind, l.resetsAt, now), label)}{' '}
              <Text color={l.percentUsed >= 80 ? 'warning' : 'success'}>{lb.on}</Text>
              <Text dimColor>{lb.off}</Text> {l.percentUsed}%
            </Text>
          )
        })}
        {m?.limitsAreOld && <Text dimColor>Last limits reported</Text>}
        {m?.costUsd !== undefined && (
          <Text dimColor>Session cost: {m.costUsd.toFixed(2)} USD</Text>
        )}

        <Text> </Text>
        <Box flexDirection="row" gap={1}>
          <Button
            key="stima"
            hotkey="s"
            onPress={() => {
              void scanConversation($)
              void takeBreakdown($, 'summary')
            }}
          >
            Refresh estimate
          </Button>
          <Button key="preciso" hotkey="p" onPress={() => void takeBreakdown($, 'full')}>
            Precise count
          </Button>
        </Box>
      </Box>
    )
  })
}
