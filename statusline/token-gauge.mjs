#!/usr/bin/env node
// token-gauge: Claude Code status line showing context usage, weekly quota,
// tokens used by the last prompt turn and prompt cache stats.
// Reads the status line JSON from stdin, prints one colored line.
//
// Env:
//   TOKEN_GAUGE_COLOR          truecolor | 16 | none   (default: auto-detect)
//   TOKEN_GAUGE_WEEKLY_TOKENS  weekly token allowance for the log-based fallback,
//                              used only when Claude Code sends no rate_limits data
//   NO_COLOR                   disables color

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const WEEK_MS = 7 * 24 * 3600 * 1000;
const CACHE_TTL_MS = 60 * 1000;
const CLAUDE_DIR = path.join(os.homedir(), '.claude');
const CACHE_FILE = path.join(CLAUDE_DIR, 'token-gauge', 'weekly-cache.json');

function colorMode() {
  if (process.env.NO_COLOR) return 'none';
  const forced = process.env.TOKEN_GAUGE_COLOR;
  if (forced === 'truecolor' || forced === '16' || forced === 'none') return forced;
  return /truecolor|24bit/i.test(process.env.COLORTERM || '') ? 'truecolor' : '16';
}

// Green (0%) -> yellow (50%) -> red (100%), linear per channel.
function rgbFor(pct) {
  const t = Math.min(Math.max(pct, 0), 100) / 100;
  const green = [80, 200, 80], yellow = [230, 200, 40], red = [230, 60, 60];
  const [a, b, u] = t < 0.5 ? [green, yellow, t * 2] : [yellow, red, (t - 0.5) * 2];
  return a.map((c, i) => Math.round(c + (b[i] - c) * u));
}

function paint(text, pct, mode) {
  if (mode === 'none' || pct == null) return text;
  if (mode === 'truecolor') {
    const [r, g, b] = rgbFor(pct);
    return `\x1b[38;2;${r};${g};${b}m${text}\x1b[39m`;
  }
  const code = pct < 50 ? 32 : pct < 80 ? 33 : 31;
  return `\x1b[${code}m${text}\x1b[39m`;
}

function fmtTokens(n) {
  if (n >= 1e6) return `${+(n / 1e6).toFixed(1)}M`;
  if (n >= 1e3) return `${+(n / 1e3).toFixed(1)}k`;
  return String(n);
}

const fmtPct = (p) => `${+p.toFixed(1)}%`;
const fmtUsd = (n) => `$${n.toFixed(2)}`;

function contextSegment(cw, mode) {
  if (!cw) return 'Context: --';
  const size = cw.context_window_size || 200000;
  const u = cw.current_usage;
  // Same input-only formula Claude Code uses for used_percentage.
  const used = u
    ? (u.input_tokens || 0) + (u.cache_creation_input_tokens || 0) + (u.cache_read_input_tokens || 0)
    : 0;
  const pct = cw.used_percentage ?? (used / size) * 100;
  return paint(`Context: ${fmtPct(pct)} (${fmtTokens(used)} / ${fmtTokens(size)})`, pct, mode);
}

// Fallback: sum non-cache-read tokens from session transcripts in the last 7 days.
// Result is cached for a minute so the status line stays fast.
function weeklyTokensFromLogs() {
  try {
    const cached = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8'));
    if (Date.now() - cached.at < CACHE_TTL_MS) return cached.tokens;
  } catch {}

  const since = Date.now() - WEEK_MS;
  const seen = new Set();
  let tokens = 0;
  const projects = path.join(CLAUDE_DIR, 'projects');
  const walk = (dir) => {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) { walk(p); continue; }
      if (!e.name.endsWith('.jsonl')) continue;
      try { if (fs.statSync(p).mtimeMs < since) continue; } catch { continue; }
      for (const line of fs.readFileSync(p, 'utf8').split('\n')) {
        if (!line.includes('"usage"')) continue;
        let rec;
        try { rec = JSON.parse(line); } catch { continue; }
        const usage = rec.message?.usage;
        if (rec.type !== 'assistant' || !usage) continue;
        if (Date.parse(rec.timestamp) < since) continue;
        // Streamed responses log one entry per content block with the same usage.
        const key = `${rec.message.id}:${rec.requestId}`;
        if (seen.has(key)) continue;
        seen.add(key);
        tokens += (usage.input_tokens || 0) + (usage.output_tokens || 0) +
          (usage.cache_creation_input_tokens || 0);
      }
    }
  };
  walk(projects);

  try {
    fs.mkdirSync(path.dirname(CACHE_FILE), { recursive: true });
    fs.writeFileSync(CACHE_FILE, JSON.stringify({ at: Date.now(), tokens }));
  } catch {}
  return tokens;
}

function weeklySegment(rl, mode) {
  const spend = rl?.spend_limit;
  if (spend?.used_percentage != null && (!spend.period || spend.period === 'weekly')) {
    const usd = spend.used_usd != null && spend.limit_usd != null
      ? ` (${fmtUsd(spend.used_usd)} / ${fmtUsd(spend.limit_usd)})` : '';
    return paint(`Weekly: ${fmtPct(spend.used_percentage)}${usd}`, spend.used_percentage, mode);
  }
  const week = rl?.seven_day?.used_percentage;
  if (week != null) return paint(`Weekly: ${fmtPct(week)}`, week, mode);

  const allowance = Number(process.env.TOKEN_GAUGE_WEEKLY_TOKENS);
  if (allowance > 0) {
    const used = weeklyTokensFromLogs();
    const pct = (used / allowance) * 100;
    return paint(`Weekly: ${fmtPct(pct)} (${fmtTokens(used)} / ${fmtTokens(allowance)})`, pct, mode);
  }
  return 'Weekly: --';
}

// Tokens used by the latest prompt turn: every API call since the last real
// user prompt in the transcript. Transcripts can be tens of MB, so read
// backwards in chunks and stop at the prompt.
const CHUNK = 256 * 1024;

function isPrompt(rec) {
  if (rec.type !== 'user' || rec.isMeta || rec.isSidechain) return false;
  const c = rec.message?.content;
  return typeof c === 'string' || (Array.isArray(c) && !c.some((b) => b.type === 'tool_result'));
}

function turnTokens(transcriptPath) {
  let fd;
  try { fd = fs.openSync(transcriptPath, 'r'); } catch { return null; }
  try {
    let pos = fs.fstatSync(fd).size;
    let carry = '';
    const seen = new Set();
    const sum = { fresh: 0, cached: 0, out: 0 };
    while (pos > 0) {
      const len = Math.min(CHUNK, pos);
      pos -= len;
      const buf = Buffer.alloc(len);
      fs.readSync(fd, buf, 0, len, pos);
      const lines = (buf.toString('utf8') + carry).split('\n');
      // First piece may be a partial line unless we reached the file start.
      carry = pos > 0 ? lines.shift() : '';
      for (let i = lines.length - 1; i >= 0; i--) {
        if (!lines[i]) continue;
        let rec;
        try { rec = JSON.parse(lines[i]); } catch { continue; }
        if (isPrompt(rec)) return sum;
        const u = rec.message?.usage;
        if (rec.type !== 'assistant' || rec.isSidechain || !u) continue;
        // Streamed responses log one entry per content block with the same usage.
        if (seen.has(rec.message.id)) continue;
        seen.add(rec.message.id);
        sum.fresh += (u.input_tokens || 0) + (u.cache_creation_input_tokens || 0);
        sum.cached += u.cache_read_input_tokens || 0;
        sum.out += u.output_tokens || 0;
      }
    }
    return sum;
  } finally {
    fs.closeSync(fd);
  }
}

function turnSegment(data) {
  const t = data.transcript_path && turnTokens(data.transcript_path);
  if (!t || t.fresh + t.out + t.cached === 0) return null;
  return `Last: ${fmtTokens(t.fresh)} in / ${fmtTokens(t.out)} out (+${fmtTokens(t.cached)} cached)`;
}

// Colored by miss share: high hit ratio = green, low = red.
function cacheSegment(pc, mode) {
  if (!pc?.caching_observed) return null;
  const parts = [];
  if (pc.hit_ratio != null) parts.push(`${Math.round(pc.hit_ratio * 100)}% hit`);
  if (pc.misses) parts.push(`${pc.misses} miss${pc.misses === 1 ? '' : 'es'}`);
  const warm = pc.warm && (pc.expires_at == null || pc.expires_at * 1000 > Date.now());
  parts.push(warm ? `warm ${pc.ttl}` : 'cold');
  const pct = pc.hit_ratio == null ? null : (1 - pc.hit_ratio) * 100;
  return paint(`Cache: ${parts.join(', ')}`, warm ? pct : 100, mode);
}

let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (c) => (input += c));
process.stdin.on('end', () => {
  let data = {};
  try { data = JSON.parse(input); } catch {}
  const mode = colorMode();
  const segments = [
    contextSegment(data.context_window, mode),
    weeklySegment(data.rate_limits, mode),
    turnSegment(data),
    cacheSegment(data.prompt_cache, mode),
  ].filter(Boolean);
  process.stdout.write(segments.join(mode === 'none' ? ' • ' : ' \x1b[2m•\x1b[22m '));
});
