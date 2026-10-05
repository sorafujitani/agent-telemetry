#!/usr/bin/env node
// Command-line entry point; recording and HTTP serving live in their own modules.
import { FILE } from "./config.js";
import { checkSource, hookConfig, recordHook } from "./hooks.js";
import { startServer } from "./http-server.js";
import { installSkill, setupAgent } from "./setup.js";
import { openViewer } from "./viewer.js";

const HELP = `Usage: panopticon
       panopticon setup <codex|claude>
       panopticon open
       panopticon install-skill
       panopticon hooks <codex|claude>
       panopticon hook <codex|claude>

Start the local telemetry viewer. Press Ctrl+C to stop.
"setup" merges recording Hooks and registers the selected agent's viewer skill.
Existing unrelated settings are preserved; changed settings are backed up.
"open" starts it in the background and opens the browser.
"install-skill" registers $panopticon in Codex and /panopticon in Claude Code.
"hooks" prints configuration to merge into your agent settings.
"hook" records one JSON hook payload from stdin without blocking the agent.

Environment:
  PANOPTICON_DIR   Log directory (default: ~/.local/share/panopticon; existing Pi directory reused)
  PANOPTICON_PORT  Viewer port (default: 7777)

Logs are local and may contain sensitive prompts, tool arguments, and results.`;

async function main(args) {
	if (args.includes("--help") || args.includes("-h")) {
		console.log(HELP);
		return;
	}
	const [command, source] = args;
	if (["setup", "hooks", "hook"].includes(command)) {
		if (args.length !== 2) throw new Error("Expected exactly one source: codex or claude");
		checkSource(source);
	} else if (args.length > 1) {
		throw new Error("Unknown argument. Run panopticon --help for usage.");
	}

	switch (command) {
		case undefined:
			startServer();
			return;
		case "open": {
			const ok = await openViewer((message, level) =>
				level === "info" ? console.log(message) : console.error(message),
			);
			if (!ok) process.exitCode = 1;
			return;
		}
		case "setup": {
			const result = setupAgent(source);
			console.log(
				`panopticon: ${source} setup ${result.changed ? "complete" : "already configured"}\nHooks: ${result.file}\nSkill: ${result.destinations.join(", ")}\nLogs: ${FILE}`,
			);
			if (result.backup) console.log(`Backup: ${result.backup}`);
			console.log(
				source === "codex"
					? "Restart Codex, review/trust Hooks when asked, then send a prompt and use $panopticon."
					: "Restart Claude Code, then send a prompt and use /panopticon.",
			);
			return;
		}
		case "install-skill":
			installSkill();
			console.log(
				"panopticon: skill registered. Restart Codex or Claude Code, then use $panopticon or /panopticon. Recording Hooks are configured separately.",
			);
			return;
		case "hooks":
			console.log(JSON.stringify(hookConfig(source), null, 2));
			return;
		case "hook":
			await recordHook(source);
			return;
		default:
			throw new Error("Unknown argument. Run panopticon --help for usage.");
	}
}

try {
	await main(process.argv.slice(2));
} catch (error) {
	console.error(`panopticon: ${error.message}`);
	process.exitCode = 1;
}
