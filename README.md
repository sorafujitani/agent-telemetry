# agenttel

Record local traces from Codex, Claude Code, or Pi and inspect them in your browser. See prompts, tool calls, results, errors, and timing without an external telemetry service.

**Not yet published to npm.** `npm install -g agenttel` is not available; install from a checkout as shown below.

## Before you start

- Requires **Node.js 22 or later** and an installed agent you can already send prompts to. Codex and Claude Code do not require Pi.
- Use a current agent version. Codex and Claude Code recording uses **Hooks**: scripts the agent runs at lifecycle events. Pi recording uses an extension.
- Setup needs permission to change your agent's local settings and register its viewer skill. Existing unrelated settings are preserved.
- Logs contain prompts and tool payloads **without secret redaction**. Recording is enabled only after configuring the chosen agent. Read [Privacy and limits](#privacy-and-limits) before enabling it.
- The viewer is localhost-only but unauthenticated; other local processes can access it.

| Agent | Recording detail | Tokens and costs | Open from the agent |
| --- | --- | --- | --- |
| Codex | Responses and supported tool calls | Unavailable | `$agenttel` skill |
| Claude Code | Responses and tool calls | Unavailable | `/agenttel` skill |
| Pi | Model turns and tool calls | When reported | `/agenttel` command |

Unavailable values appear as `–`, not zero. Codex may omit tool terminal status; `?` means unknown, not success.

## Quick start

### 1. Install the CLI

From an existing checkout, run `npm install -g .`. For a new checkout, Git is also required:

```sh
git clone https://github.com/sorafujitani/agent-telemetry.git
cd agent-telemetry
npm install -g .
agenttel --help
```

The CLI works independently of any agent. Installing it alone does not start recording. To view existing logs without enabling recording, skip agent setup and run `agenttel open`.

### 2. Set up the agent you use

Choose one of the following. You do not need to install or configure the other agents.

#### Codex

```sh
agenttel setup codex
```

This merges recording Hooks into `~/.codex/hooks.json` and registers the viewer skill in `~/.agents/skills/agenttel`. Restart Codex and review/trust the Hooks when asked. Use **`$agenttel`** to open the viewer.

#### Claude Code

```sh
agenttel setup claude
```

This merges recording Hooks into `~/.claude/settings.json` and registers the viewer skill in `~/.claude/skills/agenttel`. Restart Claude Code. Use **`/agenttel`** to open the viewer.

Both setup commands preserve other settings and Hooks and can be repeated without adding duplicate collector commands. They configure only the selected agent. Do not edit settings concurrently with setup. If user Hooks are disabled by agent policy, resolve that before recording.

#### Pi

From the checkout installed in step 1:

```sh
pi install "$PWD"
```

Restart Pi. The extension records events and provides **`/agenttel`**. No Codex or Claude Code skill registration is needed.

If the old standalone extension exists in `~/.pi/agent/extensions/agenttel`, move it outside the extensions directory before enabling this package to avoid duplicate recording. Stop its old viewer if it still occupies the viewer port. Keep the log directory; existing logs remain compatible.

### 3. Verify recording

1. Restart the configured agent and submit a new prompt that uses a tool.
2. Open the viewer with the agent command above, or from a terminal:

   ```sh
   agenttel open
   ```

3. Open the printed URL, normally `http://127.0.0.1:7777`. Select the new session and confirm its agent label, prompt, and tool events.

`agenttel open` starts the viewer in the background if needed and opens your browser. If browser launching is unavailable, open the printed URL yourself. The viewer remains running after the agent exits.

Opening the viewer alone does not prove recording works: the CLI and skill can open it without enabling Hooks or the Pi extension. Follow [Troubleshooting](#troubleshooting) if the new session does not appear.

## Commands

| Command | Purpose |
| --- | --- |
| `agenttel setup codex` | Install Codex recording Hooks and viewer skill |
| `agenttel setup claude` | Install Claude Code recording Hooks and viewer skill |
| `agenttel open` | Start the background viewer and open the browser |
| `agenttel` | Run the viewer in the foreground; Ctrl+C stops it |
| `agenttel install-skill` | Register both viewer skills without enabling recording |
| `agenttel hooks <source>` | Print recording Hook configuration for manual review |
| `agenttel hook <source>` | Record one Hook JSON object from stdin |

For the last two commands, `<source>` is `codex` or `claude`.

### Manual or project-scoped setup

Use `agenttel hooks codex` or `agenttel hooks claude` to inspect the generated configuration. Append the printed entries to the existing event arrays; do not replace unrelated Hooks or settings.

- Codex project Hooks use `.codex/hooks.json`; Claude Code project Hooks use `.claude/settings.json`.
- Configure each collector in only one scope. User, project, plugin, and Codex inline Hooks can all run; duplicate installations produce duplicate events.
- To register only the viewer commands, use `agenttel install-skill`. Skills open the viewer; they do not record events.
- Generated Hook commands and skill links refer to the installed package. If Node.js or the package moves, review/remove the old agenttel commands and stale links before setting it up again. Setup does not overwrite a different skill or guess how to migrate custom commands.

Official references:
- https://developers.openai.com/codex/hooks
- https://developers.openai.com/codex/skills
- https://code.claude.com/docs/en/hooks
- https://code.claude.com/docs/en/skills

## Log location and configuration

New installations use `~/.local/share/agenttel/events.jsonl`. If `~/.pi/agent/agenttel` already exists, it is reused to preserve history; this is compatibility behavior, not a Pi requirement. `AGENTTEL_DIR` overrides either location.

| Variable | Purpose | Default |
| --- | --- | --- |
| `AGENTTEL_DIR` | Directory containing `events.jsonl` | `~/.local/share/agenttel` |
| `AGENTTEL_PORT` | Loopback port, from 1 to 65535 | `7777` |
| `PI_TRACE_PORT` | Legacy port alias | Used if `AGENTTEL_PORT` is unset |

When overriding these values, set the same environment variables for the agent and the CLI. A one-off variable set during setup is not automatically added to future agent processes.

```sh
export AGENTTEL_DIR="$HOME/my-traces"
export AGENTTEL_PORT=7788
agenttel open
```

Launch the agent from the same environment. Hook setup prints the settings, skill, and log paths so you can check which installation is configured.

## Troubleshooting

- **`npm install -g agenttel` returns 404:** the npm package is not published. Install from a checkout with `npm install -g .`.
- **`agenttel` is not found:** check that your Node.js installation's global npm bin directory is on `PATH` and reopen the terminal.
- **`$agenttel` or `/agenttel` is missing:** run the relevant setup command and restart the agent. A conflicting existing skill is preserved; review it before removing or relinking it.
- **The viewer opens but no new traces appear:** restart the agent, check its Hook configuration and trust/policy settings, and confirm the agent and viewer use the same log directory. Claude Code's `disableAllHooks` setting and managed policies can prevent recording.
- **Setup refuses existing settings:** invalid JSON, unexpected Hook structures, old collector paths, and skill conflicts are not overwritten. Fix or review the reported item, then retry.
- **Setup reports a lock:** another setup may be running. Check it before removing a stale `<settings-file>.agenttel.lock` left by an interrupted process.
- **The port is busy or an old viewer is shown:** stop only the conflicting viewer process, or choose another `AGENTTEL_PORT` for both the agent and CLI. Do not clear logs to fix a port conflict.
- **Codex tokens, costs, or status show `–`/`?`:** those fields were not supplied by Hooks; this is not a failed recording.

## Privacy and limits

- Logs stay on your machine. They contain prompt excerpts, assistant text, available thinking excerpts, tool arguments/results, session IDs, and working directories. Review logs before sharing them; secrets are not redacted.
- The server binds only to `127.0.0.1`, rejects other hosts and cross-origin browser requests, and has no authentication. Other local processes can access it.
- Newly created log directories and files use owner-only permissions where POSIX modes are supported. Existing log permissions are not changed. New settings files use owner-only POSIX modes where supported; rewrites preserve existing settings-file permissions.
- The **clear** button permanently deletes recorded events after confirmation. It does not disable recording.
- Argument strings are capped at 32,000 characters each; results at 32,000 characters. Prompts are capped at 400 characters, and assistant text/thinking excerpts at 2,000. Hook payloads over 8 MiB are skipped with a warning.
- The viewer replays only the latest 50 MiB. Older events remain in the file; logs are not automatically rotated.
- Hook durations include command startup overhead. One response covers a full prompt-to-completion cycle, not an individual model call. Tool durations are summed and can exceed elapsed response time when calls overlap.
- Hooks do not consistently provide usage, cost, thinking, context size, model-call timing, or nested parent-call relationships. Transcript import is not implemented. Hosted Codex tools such as WebSearch do not emit tool Hooks. Separate subagent IDs create separate timelines only when supplied by the agent.

## Development and release

```sh
pnpm install
pnpm test
pnpm pack
```

Runtime code is plain JavaScript with no build step or runtime dependencies. Tests pack and install the distributable and exercise recording, safe setup, the viewer, and skill registration. Packing and publishing run tests through `prepack`; logs and tests are excluded from the package.

npm publication is a separate maintainer action; installation and setup do not publish anything. When ready:

```sh
pnpm publish --access public
```

Repository and support: https://github.com/sorafujitani/agent-telemetry

Maintained by [sorafujitani](https://github.com/sorafujitani). Licensed under [MIT](LICENSE).
