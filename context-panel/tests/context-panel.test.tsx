import { expect, mock, test } from 'claude-code/testing'
import type { ContextCategoryKind, On } from 'claude-code'

const PANE = {
  plugin: 'context-panel',
  component: 'Pane',
  requestId: 'context-panel',
  props: {
    title: 'Context',
    isFocused: false,
    bodyColumns: 80,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 40 },
    view: {},
  },
} as const

const cat = (name: string, tokens: number, kind: ContextCategoryKind) => ({
  name,
  tokens,
  color: 'claude',
  isDeferred: kind === 'deferred',
  kind,
})

// Stands for the engine beneath the mod: a session whose usage carries a breakdown.
const engine = (on: On) => {
  mock.clock(on)
  on('command.register', () => ({ value: { command: 'context-panel' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('session.measure', (_, e) => ({ changed: e.changed }))
  on('session.usage', () => ({
    value: {
      startedAt: 0,
      context: {
        tokens: 30000,
        window: 200000,
        percent: 15,
        breakdown: {
          categories: [
            cat('System prompt', 10000, 'used'),
            cat('Skills', 19000, 'used'),
            cat('MCP server instructions', 1000, 'used'),
            cat('Free space', 170000, 'free'),
            cat('MCP tools (deferred)', 5000, 'deferred'),
          ],
          totalTokens: 30000,
          maxTokens: 200000,
          rawMaxTokens: 200000,
          autocompactSource: 'model-default',
          percentage: 15,
          gridRows: [],
          model: 'm',
          memoryFiles: [],
          mcpTools: [{ name: 'mcp__canva__create', serverName: 'canva', tokens: 800, isLoaded: true }],
          agents: [],
          isAutoCompactEnabled: false,
          apiUsage: null,
          skills: {
            totalSkills: 3,
            includedSkills: 3,
            tokens: 19000,
            skillFrontmatter: [
              { name: 'shape-request', source: 'userSettings', tokens: 12000 },
              { name: 'brainstorming', source: 'plugin', pluginName: 'superpowers', tokens: 4000 },
              { name: 'docx', source: 'syncedSkills', tokens: 3000 },
            ],
          },
        },
      },
      rateLimits: [],
    },
  }))
}

test('the panel draws the fill and the limits from a measurement', async ($, on) => {
  engine(on)
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await $.session.measure({
    context: { tokens: 50000, window: 200000, percent: 25 },
    // The mocked clock reads 0, so each reset sits that far from now.
    rateLimits: [
      { kind: 'five_hour', percentUsed: 40, resetsAt: new Date((4 * 60 + 33) * 60000).toISOString() },
      { kind: 'seven_day', percentUsed: 10, resetsAt: new Date((62 * 60 + 5) * 60000).toISOString() },
      { kind: 'spend_limit', percentUsed: 5 },
    ],
    cost: { usd: 1.5 },
    changed: ['context', 'rateLimits', 'cost'],
  })

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })
    // The top line gives the share and the window, not a second token count.
    expect(await ui.find({ type: 'Text', text: /^25% of 200,000 tokens$/ })).toBeTruthy()
    // The time to reset sits beside the name, so the row ends with the share.
    expect(await ui.find({ type: 'Text', text: /^Usage limits \/ reset$/ })).toBeTruthy()
    if (surface === 'terminal') {
      expect(await ui.find({ type: 'Text', text: /^5h win - 4h 33m .* 40%$/ })).toBeTruthy()
      expect(await ui.find({ type: 'Text', text: /^7d win - 2d 14h .* 10%$/ })).toBeTruthy()
      expect(await ui.find({ type: 'Text', text: /^Spend limit .* 5%$/ })).toBeTruthy()
    } else {
      // The desktop draws label and figures as separate cells of a row.
      for (const [name, share] of [['5h win - 4h 33m', '40%'], ['7d win - 2d 14h', '10%'], ['Spend limit', '5%']]) {
        expect(await ui.find({ type: 'Text', text: new RegExp(`^${name}$`) })).toBeTruthy()
        expect(await ui.find({ type: 'Text', text: new RegExp(`^${share}$`) })).toBeTruthy()
      }
    }
    expect(await ui.find({ type: 'Text', text: /1\.50 USD/ })).toBeTruthy()
    await ui.unmount()
  }
})

test('the used rows get a subtotal and the rows open their composition', async ($, on) => {
  engine(on)
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await $.command.run({
    command: 'context-panel',
    args: '',
    origin: { kind: 'composer' },
    presentation: { isFullscreen: true, columns: 160 },
  })

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  // Deferred schemas stay out of the sum.
  expect(await ui.find({ type: 'Text', text: /Total used.*15% 30,000/ })).toBeTruthy()

  // One loaded tool reads in the singular.
  expect(await ui.find({ type: 'Text', text: /^canva .* 800 \(1 tool\)$/ })).toBeTruthy()

  // MCP server instructions have no breakdown, so the row is plain text.
  expect(await ui.find({ type: 'Text', text: /^  MCP server instructions / })).toBeTruthy()

  // Skills opens with a header and clearer notes, and closes on a second press.
  expect(await ui.find({ type: 'Text', text: /shape-request/ })).toBeFalsy()
  await ui.press({ key: 'cat-Skills' })
  expect(await ui.find({ type: 'Text', text: /Tokens of each skill's description/ })).toBeTruthy()
  expect(await ui.find({ type: 'Text', text: /shape-request.*12,000.*yours/ })).toBeTruthy()
  expect(await ui.find({ type: 'Text', text: /brainstorming.*plugin superpowers/ })).toBeTruthy()
  expect(await ui.find({ type: 'Text', text: /docx.*from your account/ })).toBeTruthy()
  await ui.press({ key: 'cat-Skills' })
  expect(await ui.find({ type: 'Text', text: /shape-request/ })).toBeFalsy()
  await ui.unmount()
})

test('a loaded skill is listed with its estimated tokens, every copy counted', async ($, on) => {
  engine(on)
  // The conversation before the pane opened holds one skill text already.
  const body = 'Base directory for this skill: C:/Users/x/.claude/skills/docx' + '\n\n' + 'a'.repeat(2988)
  const conversation = [{ role: 'user' as const, text: body, toolUses: [] }]
  on('session.messages', () => ({ value: conversation }))
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await $.command.run({
    command: 'context-panel',
    args: '',
    origin: { kind: 'composer' },
    presentation: { isFullscreen: true, columns: 160 },
  })

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.press({ key: 'cat-Skills' })
  expect(await ui.find({ type: 'Text', text: /Loaded this session/ })).toBeTruthy()
  // About 3,050 characters at 3 per token.
  expect(await ui.find({ type: 'Text', text: /^    docx .*~1,0\d\d$/ })).toBeTruthy()

  // The same skill arriving again puts its text in the window a second time.
  conversation.push({ role: 'user', text: body, toolUses: [] })
  const row = {
    type: 'user' as const,
    role: 'user' as const,
    isMeta: true as const,
    content: [{ type: 'text', text: body }],
  }
  await $.session.append({ message: row, door: 'tool-message', origin: { kind: 'tool', tool: 'Skill' }, uuid: 'u1' })
  // A subagent's rows are not the main conversation's.
  const other = 'Base directory for this skill: C:/x/pdf' + '\n' + 'b'.repeat(600)
  await $.session.append({
    message: { ...row, content: [{ type: 'text', text: other }] },
    door: 'tool-message',
    origin: { kind: 'tool', tool: 'Skill' },
    uuid: 'u2',
    agentId: 'a1',
  })

  expect(await ui.find({ type: 'Text', text: /^    docx .*~2,0\d\d loaded 2 times$/ })).toBeTruthy()
  expect(await ui.find({ type: 'Text', text: /pdf/ })).toBeFalsy()

  // A compaction drops the skill texts, so the list empties.
  await $.session.append({
    message: { type: 'user', role: 'user', content: [{ type: 'text', text: 'summary' }] },
    door: 'compaction',
    origin: { kind: 'composer' },
    uuid: 'u3',
  })
  expect(await ui.find({ type: 'Text', text: /Loaded this session/ })).toBeFalsy()
  await ui.unmount()
})

test('the desktop draws the breakdown and its rows open', async ($, on) => {
  engine(on)
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await $.command.run({
    command: 'context-panel',
    args: '',
    origin: { kind: 'composer' },
    presentation: { isFullscreen: true, columns: 160 },
  })

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  // A tree the surface refuses is not drawn at all, so finding the rows proves it was accepted.
  expect(await ui.find({ type: 'Text', text: /^Total used$/ })).toBeTruthy()
  expect(await ui.find({ type: 'Text', text: /shape-request/ })).toBeFalsy()
  await ui.press({ key: 'cat-Skills' })
  expect(await ui.find({ type: 'Text', text: /shape-request/ })).toBeTruthy()
  await ui.press({ key: 'cat-Skills' })
  expect(await ui.find({ type: 'Text', text: /shape-request/ })).toBeFalsy()
  await ui.unmount()
})

test('a measurement without limits keeps the last reading, marked as old', async ($, on) => {
  engine(on)
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  const five = { kind: 'five_hour', percentUsed: 40, resetsAt: new Date((4 * 60 + 33) * 60000).toISOString() }
  const measure = (rateLimits: (typeof five)[]) =>
    $.session.measure({
      context: { tokens: 50000, window: 200000, percent: 25 },
      rateLimits,
      changed: rateLimits.length ? ['context', 'rateLimits'] : ['context'],
    })
  const note = { type: 'Text', text: /^Last limits reported$/ } as const

  await measure([five])
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find(note)).toBeFalsy()

  // A response that reports no window leaves the old reading and says so.
  await measure([])
  expect(await ui.find({ type: 'Text', text: /^5h win - 4h 33m .* 40%$/ })).toBeTruthy()
  expect(await ui.find({ type: 'Text', text: /No limits reading/ })).toBeFalsy()
  expect(await ui.find(note)).toBeTruthy()

  // A new reading replaces it and the note goes.
  await measure([{ ...five, percentUsed: 55 }])
  expect(await ui.find({ type: 'Text', text: /^5h win - 4h 33m .* 55%$/ })).toBeTruthy()
  expect(await ui.find(note)).toBeFalsy()
  await ui.unmount()
})
