import { expect, test } from 'claude-code/testing'

const BAND = {
  hasSurvey: false,
  isWorking: false,
  maxRows: 10,
  bodyColumns: 200,
  scroll: { offset: 0, bodyRows: 10 },
  view: {},
}

for (const surface of ['terminal', 'desktop'] as const) {
  test(`draws context, weekly, last turn and cache on ${surface}`, async ($, on) => {
    on('session.measure', (_$, e) => ({ changed: e.changed }))
    on('turn.complete', (_$, e) => ({ text: e.answer }))

    await $.session.measure({
      context: { tokens: 134400, window: 200000, percent: 67.2 },
      rateLimits: [
        { kind: 'five_hour', percentUsed: 10 },
        { kind: 'seven_day', percentUsed: 42 },
      ],
      changed: ['context', 'rateLimits'],
    })
    const turn = { answer: '', durationMs: 1, isAborted: false, reason: 'answer' } as const
    await $.turn.complete({
      ...turn,
      turnId: 't1',
      usage: { model: 'm', input_tokens: 1000, cache_creation_input_tokens: 0, cache_read_input_tokens: 9000, output_tokens: 500 },
    })
    await $.turn.complete({
      ...turn,
      turnId: 't2',
      usage: { model: 'm', input_tokens: 400, cache_creation_input_tokens: 1500, cache_read_input_tokens: 100000, output_tokens: 1200 },
    })
    // A subagent's turn leaves the gauge alone.
    await $.turn.complete({
      ...turn,
      turnId: 't3',
      agentId: 'a1',
      usage: { model: 'm', input_tokens: 99999, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 99999 },
    })

    const ui = await $.ui.mount({ plugin: 'token-gauge', surface, component: 'AbovePrompt', props: BAND })

    const drawn = JSON.stringify(await ui.drawn())
    for (const text of [
      'Context: 67.2% (134.4k / 200k)',
      'Weekly: 42%',
      'Last: 1.9k in / 1.2k out (+100k cached)',
      'Cache: 98% hit (session 97%)',
    ]) {
      expect(drawn).toContain(text)
    }
    // 67% context is past yellow toward red; a 98% cache hit is near green.
    expect(drawn).toContain('"color":"#e6982f"')
    expect(drawn).toContain('"color":"#56c84f"')
  })
}

test('shows placeholders before the first turn and keeps turns across a reload', async ($, on) => {
  on('session.measure', (_$, e) => ({ changed: e.changed }))
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('turn.complete', (_$, e) => ({ text: e.answer }))
  on('session.usage', () => ({
    value: {
      startedAt: 1000,
      context: { tokens: 160000, window: 1000000, percent: 16 },
      rateLimits: [{ kind: 'seven_day', percentUsed: 99 }],
    },
  }))

  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  const ui = await $.ui.mount({ plugin: 'token-gauge', surface: 'terminal', component: 'AbovePrompt', props: BAND })
  let drawn = JSON.stringify(await ui.drawn())
  for (const text of ['Context: 16% (160k / 1M)', 'Weekly: 99%', 'Last: --', 'Cache: --']) expect(drawn).toContain(text)

  await $.turn.complete({
    answer: '', durationMs: 1, isAborted: false, reason: 'answer', turnId: 't1',
    usage: { model: 'm', input_tokens: 100, cache_creation_input_tokens: 0, cache_read_input_tokens: 900, output_tokens: 50 },
  })
  // What a hot reload does: session.start again, same session.
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  drawn = JSON.stringify(await ui.drawn())
  expect(drawn).toContain('Last: 100 in / 50 out (+900 cached)')
  expect(drawn).toContain('Cache: 90% hit (session 90%)')
})

