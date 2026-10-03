# token-gauge

A Claude Code mod that shows how much you are using, in a band directly above the prompt:

```
Context: 16% (160k / 1M) • Weekly: 99% • Last: 45.4k in / 14.3k out (+4M cached) • Cache: 97% hit (session 95%)
```

| Segment | What it shows |
| --- | --- |
| **Context** | How full the context window is, with the token count and the window size. |
| **Weekly** | Your 7-day rate limit (Pro and Max plans), or your spend limit when you are behind a Claude apps gateway. |
| **Last** | Tokens used by your last prompt, summed over every API call in the turn: new input (uncached plus cache writes), output, and cache reads. Subagent turns are not counted. |
| **Cache** | Prompt cache hit rate of the last turn, and of the session since the mod loaded. |

Context, Weekly and Cache are colored from green (0%) through yellow (50%) to red (100%). For Cache, the color follows the miss rate, so a high hit rate is green. The band updates after every turn.

## Install

In Claude Code:

```
/plugin marketplace add NilsChr/token-gauge
/plugin install token-gauge@token-gauge
```

To collapse the band, press `ctrl+x ctrl+a` or click `[-]`.

## Requirements

- A Claude Code version with mod (function hook) support. The mod API is in early access and can change between releases.
- The band is drawn in the terminal and in the desktop app's Code tab.
- Weekly shows `--` when you are not on a subscription or gateway, and until the first response of the session.
- Last and Cache show `--` until the first turn finishes after the mod loads.

## Status line version

`statusline/token-gauge.mjs` is the same gauge as a classic [status line](https://code.claude.com/docs/en/statusline) script. Use it on Claude Code versions without mods. It needs Node 18 or newer.

1. Copy the script:

   ```bash
   mkdir -p ~/.claude/token-gauge
   curl -fsSL https://raw.githubusercontent.com/NilsChr/token-gauge/master/statusline/token-gauge.mjs \
     -o ~/.claude/token-gauge/token-gauge.mjs
   ```

2. Add it to `~/.claude/settings.json`:

   ```json
   "statusLine": { "type": "command", "command": "node ~/.claude/token-gauge/token-gauge.mjs" }
   ```

The status line version differs from the mod:

- Cache shows the session hit rate, the miss count, and whether the cache is warm or cold.
- Last is read from the session transcript.
- Colors use 24-bit RGB when `COLORTERM=truecolor` is set, and the 16 standard colors otherwise.

Environment variables for the status line version:

| Variable | Effect |
| --- | --- |
| `TOKEN_GAUGE_COLOR` | Forces the color mode: `truecolor`, `16` or `none`. |
| `TOKEN_GAUGE_WEEKLY_TOKENS` | A weekly token allowance. When Claude Code sends no rate limit data, Weekly is computed from your session logs of the last 7 days against this allowance. |
| `NO_COLOR` | Turns off all color. |

## Development

```bash
claude plugin validate plugins/token-gauge
claude plugin test plugins/token-gauge
claude --plugin-dir plugins/token-gauge
```

With `--plugin-dir`, the session loads the mod from this folder.
