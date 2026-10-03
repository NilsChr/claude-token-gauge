import { atom, read, update } from 'claude-code'
import type { ModelUsage, Register, SessionMeasureInput } from 'claude-code'

import type { Gauge, Tokens } from '../types'

const EMPTY: Tokens = { fresh: 0, cached: 0, out: 0 }

const gauge = atom({ plugin: 'token-gauge', key: 'gauge' } as const, {
  startedAt: 0,
  context: null,
  weekly: null,
  last: null,
  session: EMPTY,
} as Gauge)

// Green (0%) -> yellow (50%) -> red (100%), linear per channel.
function colorFor(pct: number): string {
  const t = Math.min(Math.max(pct, 0), 100) / 100
  type Rgb = [number, number, number]
  const green: Rgb = [80, 200, 80]
  const yellow: Rgb = [230, 200, 40]
  const red: Rgb = [230, 60, 60]
  const [a, b, u]: [Rgb, Rgb, number] = t < 0.5 ? [green, yellow, t * 2] : [yellow, red, (t - 0.5) * 2]
  const mix = (i: 0 | 1 | 2) => Math.round(a[i] + (b[i] - a[i]) * u).toString(16).padStart(2, '0')
  return `#${mix(0)}${mix(1)}${mix(2)}`
}

function fmtTokens(n: number): string {
  if (n >= 1e6) return `${+(n / 1e6).toFixed(1)}M`
  if (n >= 1e3) return `${+(n / 1e3).toFixed(1)}k`
  return String(n)
}

const fmtPct = (p: number) => `${+p.toFixed(1)}%`

function toTokens(u: ModelUsage): Tokens {
  return {
    fresh: u.input_tokens + u.cache_creation_input_tokens,
    cached: u.cache_read_input_tokens,
    out: u.output_tokens,
  }
}

const hitPct = (t: Tokens) => (t.fresh + t.cached > 0 ? (t.cached / (t.fresh + t.cached)) * 100 : null)

function measured(m: Pick<SessionMeasureInput, 'context' | 'rateLimits'>): Pick<Gauge, 'context' | 'weekly'> {
  // A gateway's spend limit is the binding one when present; else the 7-day window.
  const week =
    m.rateLimits.find(r => r.kind === 'spend_limit') ?? m.rateLimits.find(r => r.kind === 'seven_day')
  const { tokens, window, percent } = m.context
  return {
    context: { tokens, window, percent },
    weekly: week ? { percent: week.percentUsed } : null,
  }
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const result = await next(e)
    const usage = await $.session.usage()
    // A hot reload fires session.start again in the same session: keep its turns.
    await update($, gauge, g =>
      g.startedAt === usage.startedAt
        ? { ...g, ...measured(usage) }
        : { ...measured(usage), startedAt: usage.startedAt, last: null, session: EMPTY },
    )
    return result
  })

  on('session.measure', async ($, e, next) => {
    await update($, gauge, g => ({ ...g, ...measured(e) }))
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    // Main loop only: a subagent's turns are not the prompt the person sent.
    if (!e.agentId && e.usage) {
      const last = toTokens(e.usage)
      await update($, gauge, g => ({
        ...g,
        last,
        session: {
          fresh: g.session.fresh + last.fresh,
          cached: g.session.cached + last.cached,
          out: g.session.out + last.out,
        },
      }))
    }
    return next(e)
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey) return next(e)
    const g = await read($, gauge)
    const { Box, Text } = $.ui.resolve(e)

    const segments: { key: string; text: string; pct: number | null }[] = []

    if (g.context) {
      const { tokens = 0, window, percent } = g.context
      const pct = percent ?? (tokens / window) * 100
      segments.push({
        key: 'context',
        text: `Context: ${fmtPct(pct)} (${fmtTokens(tokens)} / ${fmtTokens(window)})`,
        pct,
      })
    }

    segments.push(
      g.weekly
        ? { key: 'weekly', text: `Weekly: ${fmtPct(g.weekly.percent)}`, pct: g.weekly.percent }
        : { key: 'weekly', text: 'Weekly: --', pct: null },
    )

    const last = g.last
    segments.push({
      key: 'last',
      text: last
        ? `Last: ${fmtTokens(last.fresh)} in / ${fmtTokens(last.out)} out (+${fmtTokens(last.cached)} cached)`
        : 'Last: --',
      pct: null,
    })

    const lastHit = last && hitPct(last)
    const sessionHit = hitPct(g.session)
    segments.push(
      lastHit != null && sessionHit != null
        ? {
            key: 'cache',
            text: `Cache: ${Math.round(lastHit)}% hit (session ${Math.round(sessionHit)}%)`,
            // Colored by miss share: high hit ratio = green.
            pct: 100 - lastHit,
          }
        : { key: 'cache', text: 'Cache: --', pct: null },
    )

    return (
      <Box>
        {segments.map((s, i) => (
          <Text key={s.key} color={s.pct == null ? undefined : colorFor(s.pct)} wrap="truncate">
            {i > 0 ? <Text dimColor> • </Text> : null}
            {s.text}
          </Text>
        ))}
      </Box>
    )
  })
}
