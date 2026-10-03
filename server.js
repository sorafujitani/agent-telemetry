#!/usr/bin/env node
// Serve the local trace viewer and stream events.jsonl over SSE.
import { createServer } from "node:http";
import { readFileSync, statSync, openSync, readSync, closeSync, watch, existsSync, truncateSync, mkdirSync, lstatSync, realpathSync, symlinkSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { openViewer } from "./viewer.js";
import { DIR, FILE, PORT, URL } from "./config.js";
import { hookConfig, recordHook, checkSource } from "./hooks.js";

if (process.argv.includes("--help") || process.argv.includes("-h")) {
	console.log(`Usage: agenttel
       agenttel open
       agenttel install-skill
       agenttel hooks <codex|claude>
       agenttel hook <codex|claude>

Start the local telemetry viewer. Press Ctrl+C to stop.
"open" starts it in the background and opens the browser.
"install-skill" registers $agenttel in Codex and /agenttel in Claude Code.
"hooks" prints configuration to merge into your agent settings.
"hook" records one JSON hook payload from stdin without blocking the agent.

Environment:
  AGENTTEL_DIR   Log directory (default: ~/.local/share/agenttel; existing Pi directory reused)
  AGENTTEL_PORT  Viewer port (default: 7777)
  PI_TRACE_PORT Legacy alias for AGENTTEL_PORT

Logs are local and may contain sensitive prompts, tool arguments, and results.`);
	process.exit(0);
}
if (process.argv[2] === "open" && process.argv.length === 3) {
	const ok = await openViewer((message, level) => level === "info" ? console.log(message) : console.error(message));
	process.exit(ok ? 0 : 1);
}
if (process.argv[2] === "install-skill" && process.argv.length === 3) {
	try {
		const skill = realpathSync(fileURLToPath(new globalThis.URL("./skills/agenttel", import.meta.url)));
		const destinations = [".agents", ".claude"].map(root => join(homedir(), root, "skills", "agenttel"));
		// Check all destinations first; never overwrite an existing skill or a broken link.
		for (const dest of destinations) {
			const stat = lstatSync(dest, { throwIfNoEntry: false });
			if (stat && (!stat.isSymbolicLink() || realpathSync(dest) !== skill)) throw new Error(`Skill already exists: ${dest}`);
		}
		for (const dest of destinations) if (!existsSync(dest)) {
			mkdirSync(dirname(dest), { recursive: true });
			symlinkSync(skill, dest, "junction");
		}
		console.log("agenttel: skill registered. Restart Codex or Claude Code, then use $agenttel or /agenttel. Recording Hooks are configured separately.");
	} catch (error) {
		console.error(`agenttel: ${error.message}`);
		process.exit(1);
	}
	process.exit(0);
}
if (process.argv[2] === "hooks" || process.argv[2] === "hook") {
	try {
		if (process.argv.length !== 4) throw new Error("Expected exactly one source: codex or claude");
		checkSource(process.argv[3]);
	} catch (error) {
		console.error(`agenttel: ${error.message}`);
		process.exit(1);
	}
	if (process.argv[2] === "hooks") console.log(JSON.stringify(hookConfig(process.argv[3]), null, 2));
	else await recordHook(process.argv[3]);
	process.exit(0);
}
if (process.argv.length > 2) {
	console.error("Unknown argument. Run agenttel --help for usage.");
	process.exit(1);
}

if (!Number.isInteger(PORT) || PORT < 1 || PORT > 65535) {
	console.error("AGENTTEL_PORT must be an integer between 1 and 65535");
	process.exit(1);
}

const HTML = fileURLToPath(new globalThis.URL("./index.html", import.meta.url));
const FAVICON = fileURLToPath(new globalThis.URL("./favicon.svg", import.meta.url));
const REPLAY_BYTES = 50 * 1024 * 1024; // ponytail: replay only the last 50MB; paginate if history matters
mkdirSync(DIR, { recursive: true, mode: 0o700 });
const clients = new Set();

const readFrom = (from, to) => {
	const fd = openSync(FILE, "r");
	try {
		const buf = Buffer.alloc(to - from);
		const bytes = readSync(fd, buf, 0, buf.length, from);
		return buf.subarray(0, bytes);
	} finally {
		closeSync(fd);
	}
};

// Keep the offset on a newline boundary, including an incomplete line from a previous process.
const size = existsSync(FILE) ? statSync(FILE).size : 0;
const start = Math.max(0, size - REPLAY_BYTES);
let offset = size ? start + readFrom(start, size).lastIndexOf(10) + 1 : 0;
const broadcast = (text) => {
	const data = text.split("\n").filter(Boolean).map((line) => `data: ${line}\n\n`).join("");
	if (data) for (const res of clients) res.write(data);
};
const clearClients = () => {
	for (const res of clients) res.write("event: clear\ndata: 1\n\n");
};
const poll = () => {
	if (!existsSync(FILE)) return;
	const size = statSync(FILE).size;
	if (size < offset) { offset = 0; clearClients(); }
	if (size > offset) {
		const buf = readFrom(offset, size);
		const end = buf.lastIndexOf(10) + 1;
		if (end) {
			broadcast(buf.subarray(0, end).toString("utf8"));
			offset += end;
		}
	}
};

const hosts = new Set([`127.0.0.1:${PORT}`, `localhost:${PORT}`]);
const server = createServer((req, res) => {
	// Block DNS rebinding and cross-origin requests to private traces.
	if (!hosts.has(req.headers.host) || (req.headers.origin && ![...hosts].some((host) => req.headers.origin === `http://${host}`))) {
		res.writeHead(403);
		return res.end("Forbidden");
	}
	res.setHeader("X-Content-Type-Options", "nosniff");
	res.setHeader("Cache-Control", "no-store");
	try {
		if (req.url === "/ping" && req.method === "GET") return res.end("agenttel");
		if (req.url === "/clear" && req.method === "POST") {
			if (existsSync(FILE)) truncateSync(FILE, 0);
			offset = 0;
			clearClients();
			return res.end("ok");
		}
		if (req.url === "/events" && req.method === "GET") {
			poll();
			res.writeHead(200, { "Content-Type": "text/event-stream", Connection: "keep-alive" });
			if (offset) {
				const start = Math.max(0, offset - REPLAY_BYTES);
				let text = readFrom(start, offset).toString("utf8");
				if (start > 0) text = text.slice(text.indexOf("\n") + 1);
				for (const line of text.split("\n")) if (line) res.write(`data: ${line}\n\n`);
			}
			res.write("event: ready\ndata: 1\n\n");
			clients.add(res);
			res.on("close", () => clients.delete(res));
			return;
		}
		if (req.url === "/favicon.svg" && req.method === "GET") {
			res.writeHead(200, { "Content-Type": "image/svg+xml; charset=utf-8" });
			return res.end(readFileSync(FAVICON));
		}
		if (req.url === "/" && req.method === "GET") {
			const html = readFileSync(HTML);
			res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Content-Security-Policy": "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'" });
			return res.end(html);
		}
		res.writeHead(404);
		res.end("Not found");
	} catch (error) {
		console.error(`agenttel: ${error.message}`);
		if (!res.headersSent) res.writeHead(500);
		res.end("Unable to read telemetry");
	}
});
server.on("error", (error) => {
	console.error(`agenttel: ${error.message}`);
	process.exit(1);
});
server.listen(PORT, "127.0.0.1", () => console.log(`agenttel: ${URL}\nLogs: ${FILE}\nPress Ctrl+C to stop.`));
watch(DIR, poll);
setInterval(poll, 1000); // fs.watch is unreliable on some mounts
