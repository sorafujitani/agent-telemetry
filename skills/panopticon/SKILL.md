---
name: panopticon
description: Open the local panopticon telemetry viewer for Codex, Claude Code, and Pi, or help configure its recording Hooks. Use when the user asks for panopticon, agent traces, or this local telemetry viewer.
---

# panopticon

## Open the viewer

Run:

```sh
panopticon open
```

This starts the viewer in the background if needed, opens the default browser, and prints its URL. Do not run bare `panopticon` in a blocking tool call or start a second server yourself. If opening the browser fails, give the user the printed URL.

This project has not been published to npm. If the CLI is missing, tell the user to run `npm install -g .` in a panopticon checkout. Do not suggest `npm install -g panopticon` or publish the package.

## Recording

Opening the viewer does not enable recording. Do not enable or change recording unless the user asks. When asked, run only the selected agent's setup command: `panopticon setup codex` or `panopticon setup claude`.

Setup preserves unrelated settings and Hooks, backs up changed settings, and registers the selected viewer skill. It does not overwrite conflicting skills, invalid settings, or stale collector commands. Codex uses `~/.codex/hooks.json`; Claude Code uses `~/.claude/settings.json`. Report the printed paths and ask the user to restart the agent; Codex may also require Hook trust approval.

For manual or project-scoped setup, use `panopticon hooks codex` or `panopticon hooks claude` and append entries without overwriting other settings. Do not install the same collector in multiple scopes.

Pi uses the panopticon extension and `/panopticon`. Hooks record full responses rather than individual model calls. Unavailable usage, costs, and context values show `–`; unknown tool terminal status shows `?`.

Logs are local but contain prompts and tool payloads without secret redaction. Do not upload or clear logs unless the user explicitly requests it.
