# agenttel

Local telemetry and a live trace viewer for the [Pi coding agent](https://pi.dev).
View runs, turns, tool calls, nested calls, token usage, costs, errors, and timing in your browser. No external telemetry service or runtime dependencies are required.

## Install

Requires Node.js 22 or later and an existing Pi installation.

After the package is published to npm:

```sh
npm install -g agenttel
pi install npm:agenttel
```

The npm install provides the `agenttel` CLI. The Pi install enables event recording and the `/agenttel` command. Restart Pi after installing. Installing the CLI alone does not enable recording.

Before an npm release, install from a local checkout:

```sh
npm install -g .
pi install /absolute/path/to/agent-telemetry
```

If you already have the standalone extension in `~/.pi/agent/extensions/agenttel`, move it outside the extensions directory before enabling this package to avoid duplicate event recording. Existing logs remain compatible.

## Use

Run `/agenttel` in Pi to start the viewer and open your browser. On systems without a browser launcher, open the URL shown by the command.

You can also run the server directly:

```sh
agenttel
```

Open `http://127.0.0.1:7777`. Select a session to inspect its timeline, tool arguments and results, or execution summary. The **clear** button permanently deletes all recorded events after confirmation.

The CLI stays in the foreground; press Ctrl+C to stop it. A viewer started by `/agenttel` runs in the background and remains available after Pi exits.

## Configuration

Logs default to `~/.pi/agent/agenttel/events.jsonl`. Set the same environment variables for Pi and the CLI when overriding these defaults.

| Variable | Purpose | Default |
| --- | --- | --- |
| `AGENTTEL_DIR` | Directory containing `events.jsonl` | `~/.pi/agent/agenttel` |
| `AGENTTEL_PORT` | Loopback port, from 1 to 65535 | `7777` |
| `PI_TRACE_PORT` | Legacy port alias | Used if `AGENTTEL_PORT` is unset |

```sh
AGENTTEL_DIR="$HOME/my-traces" AGENTTEL_PORT=7788 agenttel
```

Run `agenttel --help` for CLI usage.

## Privacy and limits

- Recording starts when the extension is enabled. Logs contain prompt excerpts, assistant text and thinking excerpts, tool arguments and results, session IDs, and working directories. Secrets are not redacted; do not share logs without reviewing them.
- Logs stay on your machine. The server binds only to `127.0.0.1` and rejects other hosts and cross-origin browser requests. Other local processes can access the viewer; it is not an authenticated service.
- Newly created log directories and files use owner-only permissions on systems that support POSIX modes. Existing permissions are not changed.
- Argument and result strings are capped at 32,000 characters each. Prompt excerpts are capped at 400 characters; assistant text and thinking excerpts at 2,000 characters each.
- The viewer replays only the latest 50 MiB. Older events remain in the file. Logs are not automatically rotated.

## Development and release

```sh
pnpm install
pnpm test
pnpm pack
```

The extension and CLI use plain JavaScript, so no build step is required. The package allowlist includes only the extension, configuration, server, viewer, npm metadata, README, and license; local logs and tests are excluded. Development dependencies and the lockfile are managed with pnpm. Packing and publishing run the tests through `prepack`.

When ready to release, an npm maintainer can run:

```sh
pnpm publish --access public
```

Repository and support: https://github.com/sorafujitani/agent-telemetry

Maintained by [sorafujitani](https://github.com/sorafujitani). Licensed under [MIT](LICENSE).
