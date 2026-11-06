# PinUp

A crit coach for architecture students: rehearse with a friendly AI jury that reads your boards, turn real crit notes into a to-do list, and track every comment across iterations.

## What is in this folder

| File | What it does |
|---|---|
| `index.html` | The whole app (screens, styles, logic). Projects are saved in each visitor's own browser. |
| `api/claude.js` | The only server code. It keeps your Anthropic API key secret and forwards the app's requests to Claude. |
| `package.json`, `vercel.json` | Settings Vercel uses to run it. |

## Settings on Vercel (Environment Variables)

| Name | Required | Value |
|---|---|---|
| `ANTHROPIC_API_KEY` | Yes | Your key from console.anthropic.com (starts with `sk-ant-`) |
| `PINUP_HOURLY_LIMIT` | No | Max AI requests per visitor per hour (default 80) |
| `PINUP_MODEL` | No | Claude model to use (default `claude-opus-5-5`) |

## Costs

Each AI request is billed to your Anthropic account. A full rehearsal (presentation help, about 6 questions, results) is roughly 10 requests. Set a monthly spend limit in the Anthropic Console (Settings → Limits) so a busy week can never surprise you.
