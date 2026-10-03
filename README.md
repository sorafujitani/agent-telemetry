# agenttel

Local telemetry and a live trace viewer for [Pi](https://pi.dev), Codex, and Claude Code.
View runs, turns, tool calls, nested calls, token usage, costs, errors, and timing in your browser. No external telemetry service or runtime dependencies are required.

## Install

Requires Node.js 22 or later. Pi recording needs a Pi installation; Codex and Claude Code recording needs a version that supports the configured Hooks (scripts run at agent lifecycle events).

After the package is published to npm:

```sh
npm install -g agenttel
# Only for Pi:
pi install npm:agenttel
```

The npm install provides the `agenttel` CLI. The Pi install enables event recording and the `/agenttel` command. Restart Pi after installing. For Codex and Claude Code, configure Hooks as shown below. Installing the CLI alone does not enable recording.

Before an npm release, install from a local checkout:

```sh
npm install -g .
# Only for Pi:
pi install /absolute/path/to/agent-telemetry
```

If you already have the standalone extension in `~/.pi/agent/extensions/agenttel`, move it outside the extensions directory before enabling this package to avoid duplicate event recording. Existing logs remain compatible.

## Codex and Claude Code

Register the bundled skill so it appears in the agent's command picker:

```sh
agenttel install-skill
```

Restart Codex to select **`$agenttel`**, or restart Claude Code to use **`/agenttel`**. The installer links the packaged skill into `~/.agents/skills/agenttel` and `~/.claude/skills/agenttel` without overwriting existing skills. The skill opens the viewer; it does not enable recording.

To enable recording, print command-hook configuration for your agent:

```sh
agenttel hooks codex
agenttel hooks claude
```

- **Codex:** merge the printed `hooks` entries into `~/.codex/hooks.json` (or the project's `.codex/hooks.json`). Review and trust the Hooks when Codex asks.
- **Claude Code:** merge the printed `hooks` entries into `~/.claude/settings.json` (or the project's `.claude/settings.json`).

Keep existing settings and append entries to any existing event arrays; do not overwrite other Hooks. The generated commands use absolute paths to Node.js and the installed package. Regenerate them if either installation moves. Hook commands are synchronous so recording order follows the agent lifecycle.

Restart the agent after changing its configuration, then open the viewer:

```sh
agenttel open
```

This starts the viewer in the background if needed and opens your browser. The `$agenttel` and `/agenttel` skills run the same command.

Open `http://127.0.0.1:7777` to view all three agents together. Sessions show their source, and Codex and Claude Code session IDs are namespaced to prevent collisions. Separate subagent IDs, when supplied by the agent, create separate timelines. The CLI also accepts one Hook JSON object on stdin with `agenttel hook codex` or `agenttel hook claude`; successful and failed recording both return a neutral `{}` response without blocking the agent.

### Recording limits

Hooks record prompts, tool arguments and results, compact events, and response completion or interruption. Durations are derived from Hook timestamps, which include command startup overhead. One **response** covers the full prompt-to-completion cycle, not each individual model call as Pi's **turns** do.

Hooks do not provide consistent token usage, costs, thinking, context size, or individual model-call timing. These values display as `–`; transcript import is not implemented. Codex may also omit tool terminal status; the viewer displays `?` instead of assuming success. Hosted Codex tools such as WebSearch do not emit tool Hooks, and nested parent-call relationships are shown only when recorded. Tool durations are summed and can exceed elapsed response time when calls overlap.

Official Hook references:
- https://developers.openai.com/codex/hooks
- https://code.claude.com/docs/en/hooks

## Use

Run `/agenttel` in Pi to start the viewer and open your browser. On systems without a browser launcher, open the URL shown by the command.

You can also run the server directly:

```sh
agenttel
```

Open `http://127.0.0.1:7777`. Select a session to inspect its timeline, tool arguments and results, or execution summary. The **clear** button permanently deletes all recorded events after confirmation.

The CLI stays in the foreground; press Ctrl+C to stop it. A viewer started by `/agenttel` runs in the background and remains available after Pi exits.

## Configuration

New installations store logs at `~/.local/share/agenttel/events.jsonl`. If `~/.pi/agent/agenttel` already exists, it is reused automatically to preserve Pi history. `AGENTTEL_DIR` overrides both locations. Set the same environment variables for the agents and the CLI when overriding these defaults.

| Variable | Purpose | Default |
| --- | --- | --- |
| `AGENTTEL_DIR` | Directory containing `events.jsonl` | `~/.local/share/agenttel`; existing Pi directory reused |
| `AGENTTEL_PORT` | Loopback port, from 1 to 65535 | `7777` |
| `PI_TRACE_PORT` | Legacy port alias | Used if `AGENTTEL_PORT` is unset |

```sh
AGENTTEL_DIR="$HOME/my-traces" AGENTTEL_PORT=7788 agenttel
```

Run `agenttel --help` for CLI usage.

## Privacy and limits

- Recording starts when the Pi extension or agent Hooks are enabled. Logs contain prompt excerpts, assistant text and thinking excerpts, tool arguments and results, session IDs, and working directories. Secrets are not redacted; do not share logs without reviewing them.
- Logs stay on your machine. The server binds only to `127.0.0.1` and rejects other hosts and cross-origin browser requests. Other local processes can access the viewer; it is not an authenticated service.
- Newly created log directories and files use owner-only permissions on systems that support POSIX modes. Existing permissions are not changed.
- Incoming Hook payloads over 8 MiB are skipped with a warning. Argument and result strings are capped at 32,000 characters each. Prompt excerpts are capped at 400 characters; assistant text and thinking excerpts at 2,000 characters each.
- The viewer replays only the latest 50 MiB. Older events remain in the file. Logs are not automatically rotated.

## Development and release

```sh
pnpm install
pnpm test
pnpm pack
```

The extension and CLI use plain JavaScript, so no build step is required. The package allowlist includes only the extension, shared recorder, Hook adapter, configuration, server, viewer, favicon, bundled skill, npm metadata, README, and license; local logs and tests are excluded. Development dependencies and the lockfile are managed with pnpm. Packing and publishing run the tests through `prepack`.

When ready to release, an npm maintainer can run:

```sh
pnpm publish --access public
```

Repository and support: https://github.com/sorafujitani/agent-telemetry

Maintained by [sorafujitani](https://github.com/sorafujitani). Licensed under [MIT](LICENSE).
