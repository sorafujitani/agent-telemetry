---
name: agenttel
description: Open the local agenttel telemetry viewer for Pi, Codex, and Claude Code, or help configure its recording Hooks. Use when the user asks for agenttel, agent traces, or this local telemetry viewer.
---

# agenttel

## Open the viewer

Run:

```sh
agenttel open
```

This starts the viewer in the background if needed, opens the default browser, and prints its URL. Do not run bare `agenttel` in a blocking tool call or start a second server yourself. If opening the browser fails, give the user the printed URL.

If the CLI is missing, tell the user to install `agenttel` from npm, or run `npm install -g .` in its local checkout before an npm release. Do not publish the package.

## Recording

Opening the viewer does not enable recording. For Codex or Claude Code, generate the appropriate configuration:

```sh
agenttel hooks codex
agenttel hooks claude
```

Merge only the requested agent's `hooks` entries into its existing settings, preserving all other settings and event arrays. Codex uses `~/.codex/hooks.json`; Claude Code uses `~/.claude/settings.json`. Restart the agent after changing settings. Do not enable or change recording unless the user asks.

Pi uses the agenttel extension and `/agenttel`. Hooks record full responses rather than individual model calls. Unavailable usage, costs, and context values show `–`; unknown tool terminal status shows `?`.

Logs are local but contain prompts and tool payloads without secret redaction. Do not upload or clear logs unless the user explicitly requests it.
